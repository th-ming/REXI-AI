const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { safeExec } = require('../utils/safeExec');
const db = require('../config/db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');
const { GUEST_USER_ID } = require('../ensure-admin');
const { logActivity } = require('../utils/activityLog');
const { Shell } = require('node-powershell');
const { isPrivateHostname, assertPublicUrlAsync } = require('../utils/urlSafety');
const { rateLimit } = require('../middleware/rateLimit');
const { decryptKey } = require('../utils/cryptoKeys');
const multer = require('multer');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateEdgeTTSNode, listEdgeVoices, localeFromVoice } = require('../services/edgeTTS');
const { searchVideos, getVideoStream, downloadAudio } = require('../services/ytdlpService');
const ytdlp = require('../services/ytdlpService');
const { PDFParse } = require('pdf-parse');
const ragService = require('../services/ragService');
const videoRenderer = require('../services/videoRenderer');

// QA 18/9: táº¡o áº£nh qua OpenRouter (models image-output:free) â€” chen giá»¯a Gemini vÃ 
// provider miá»…n phÃ­ trong chain cá»§a /generate-image. Tráº£ { success, image, provider }.
async function generateImageOpenRouter(prompt) {
  try {
    const keyRows = await new Promise((resolve) => {
      db.all("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'openrouter' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> ''", [], (e, rows) => resolve(rows || []));
    });
    if (!keyRows.length) return { success: false, error: 'KhÃ´ng cÃ³ key OpenRouter trong DB' };
    let orKey = '';
    try { orKey = decryptKey(keyRows[0].gia_tri_khoa).trim(); } catch (e) { orKey = ''; }
    if (!orKey) return { success: false, error: 'Giáº£i mÃ£ key OpenRouter tháº¥t báº¡i' };
    const MODELS = ['google/gemini-2.5-flash-image-preview:free', 'qwen/qwen-2.5-vl-72b-instruct:free'];
    let lastErr = '';
    for (const model of MODELS) {
      try {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: `Generate an image: ${prompt}` }] }),
          signal: AbortSignal.timeout(120000)
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) { lastErr = `HTTP ${resp.status}: ${String(data?.error?.message || '').slice(0, 120)}`; continue; }
        const msg = data?.choices?.[0]?.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const imgPart = content.find(p => (p.type === 'image_url' && p.image_url?.url));
        const b64 = msg.images?.[0]?.image_url?.url || imgPart?.image_url?.url || null;
        if (b64 && /^data:image\//.test(b64)) {
          return { success: true, image: b64, mimeType: b64.slice(5, b64.indexOf(';')), provider: 'openrouter' };
        }
        lastErr = `${model} khÃ´ng tráº£ áº£nh${typeof msg.content === 'string' ? ' (tráº£ text)' : ''}`;
      } catch (e) { lastErr = e.message; }
    }
    return { success: false, error: lastErr || 'OpenRouter khÃ´ng tráº£ áº£nh' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Multer: LÆ°u file audio táº¡m thá»i vÃ o thÆ° má»¥c temp
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'temp')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.webm';
      cb(null, `caption_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // P2-20(5): 50MB â†’ 25MB max (multer nÃ y chá»‰ dÃ¹ng cho /transcribe)
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/webm', 'audio/mp3', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/x-wav', 'audio/x-m4a'];
    // P2-audit: nhiá»u client (curl, upload tá»« app láº¡) gá»­i file audio vá»›i Content-Type
    // application/octet-stream â†’ bá»‹ cháº·n á»Ÿ Ä‘Ã¢y trÆ°á»›c khi handler ká»‹p sniff theo Ä‘uÃ´i file.
    // Cháº¥p nháº­n octet-stream khi ÄUÃ”I file lÃ  audio â€” handler sáº½ map mimetype theo Ä‘uÃ´i.
    const AUDIO_EXT = ['.wav', '.mp3', '.webm', '.m4a', '.mp4', '.ogg', '.opus', '.oga', '.flac', '.amr', '.aac'];
    if (allowedTypes.includes(file.mimetype)
      || file.mimetype.startsWith('audio/')
      || (file.mimetype === 'application/octet-stream' && AUDIO_EXT.includes(path.extname(file.originalname || '').toLowerCase()))) {
      cb(null, true);
    } else {
      cb(new Error('Chá»‰ cháº¥p nháº­n file audio (mp3, wav, webm, m4a, ogg, mp4)'), false);
    }
  }
});

// Khá»Ÿi táº¡o Groq client
// NOTE FOR AI AGENTS & DEVELOPERS: API Key cá»§a Groq Ä‘Æ°á»£c lÆ°u trá»¯ trá»±c tiáº¿p trong CÆ¡ sá»Ÿ dá»¯ liá»‡u SQLite
// á»Ÿ báº£ng `khoa_api` (cá»™t `ten_nha_cung_cap` = 'groq', Ä‘Ã£ mÃ£ hÃ³a). HÃ m getGroqClient() sáº½ Æ°u tiÃªn láº¥y tá»« DB
// náº¿u file .env khÃ´ng cÃ³ `GROQ_API_KEY`. VÃ¬ váº­y key Ä‘Ã£ sáºµn cÃ³ trong DB mÃ  khÃ´ng cáº§n khai bÃ¡o trong .env!
const getGroqClient = async () => {
  let key = process.env.GROQ_API_KEY;
  if (!key || key === 'YOUR_GROQ_API_KEY_HERE') {
    key = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'groq'", [], (err, row) => {
        if (err || !row || !row.gia_tri_khoa) return resolve(null);
        resolve(decryptKey(row.gia_tri_khoa).trim());
      });
    });
  }
  if (!key) return null;
  return new Groq({ apiKey: key });
};

// P2-20(5): bá»c promise thÃªm timeout (Groq SDK khÃ´ng pháº£i lÃºc nÃ o cÅ©ng nháº­n AbortSignal)
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'YÃªu cáº§u') + ` quÃ¡ thá»i gian (${Math.round(ms / 1000)}s). Vui lÃ²ng thá»­ láº¡i vá»›i file ngáº¯n hÆ¡n.`)), ms)),
  ]);
}

// Khá»Ÿi táº¡o Gemini client (key tá»« DB â€” báº£ng khoa_api, ten_nha_cung_cap = 'gemini')
// DÃ¹ng lÃ m FALLBACK khi Groq háº¿t quota/lá»—i â€” Ä‘áº£m báº£o TÃ³m táº¯t AI luÃ´n hoáº¡t Ä‘á»™ng.
const getGeminiClient = async () => {
  let key = process.env.GEMINI_API_KEY;
  if (!key || key === 'YOUR_GEMINI_API_KEY_HERE') {
    key = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'gemini'", [], (err, row) => {
        if (err || !row || !row.gia_tri_khoa) return resolve(null);
        resolve(decryptKey(row.gia_tri_khoa).trim());
      });
    });
  }
  if (!key) return null;
  return new GoogleGenerativeAI(key);
};

// Dá»‹ch báº¥t ká»³ ngÃ´n ngá»¯ â†’ tiáº¿ng Viá»‡t.
// Google Translate free bá»‹ CHáº¶N tá»« IP datacenter (Render tráº£ HTML consent) â†’ fallback
// LLM dÃ¹ng key sáºµn trong khoa_api (Groq â†’ Gemini). Náº¿u vÄƒn báº£n Ä‘Ã£ lÃ  tiáº¿ng Viá»‡t thÃ¬ tráº£ y nguyÃªn.
async function translateToVietnamese(text, srcLang = 'auto') {
  const t = String(text || '').trim();
  if (!t) return '';
  try {
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcLang === 'auto' ? 'auto' : srcLang}&tl=vi&dt=t&q=${encodeURIComponent(t)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const raw = await res.text();
    if (raw.trim().startsWith('[')) {
      const data = JSON.parse(raw);
      const out = (data[0] || []).map(s => (s && s[0]) || '').join('').trim();
      if (out) return out;
    }
  } catch (e) { /* Google cháº·n/khÃ´ng JSON â†’ rÆ¡i xuá»‘ng LLM */ }
  const prompt = `Dá»‹ch Ä‘oáº¡n vÄƒn báº£n sau sang tiáº¿ng Viá»‡t tá»± nhiÃªn, giá»¯ nguyÃªn Ã½ nghÄ©a. Náº¿u vÄƒn báº£n ÄÃƒ LÃ€ tiáº¿ng Viá»‡t thÃ¬ tráº£ láº¡i y nguyÃªn. CHá»ˆ tráº£ vá» báº£n dá»‹ch, khÃ´ng giáº£i thÃ­ch, khÃ´ng thÃªm báº¥t ká»³ chá»¯ nÃ o khÃ¡c:\n\n${t}`;
  try {
    const groq = await getGroqClient();
    if (groq) {
      const model = process.env.GROQ_TRANSLATE_MODEL || process.env.GROSS_SUMMARY_MODEL || 'openai/gpt-oss-20b';
      const r = await withTimeout(groq.chat.completions.create({
        model, temperature: 0.2, max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }), 60000, 'Dá»‹ch');
      const out = String((r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '').trim();
      if (out) return out;
    }
  } catch (e) { console.log('[Translate] Groq error:', e.message); }
  try {
    const genAI = await getGeminiClient();
    if (genAI) {
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_TRANSLATE_MODEL || 'gemini-2.5-flash' });
      const r = await withTimeout(model.generateContent(prompt), 60000, 'Dá»‹ch');
      const out = String((r && r.response && r.response.text && r.response.text()) || '').trim();
      if (out) return out;
    }
  } catch (e) { console.log('[Translate] Gemini error:', e.message); }
  return t;
}

// Office packages
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const PptxGenJS = require('pptxgenjs');
const { PDFDocument } = require('pdf-lib');

// â”€â”€â”€ P1-09: kiá»ƒm tra chá»§ sá»Ÿ há»¯u cuá»™c há»™i thoáº¡i (admin bypass) â”€â”€â”€
// Tráº£ null náº¿u Ä‘Æ°á»£c phÃ©p; tráº£ { status, error } náº¿u bá»‹ cháº·n (404/403/500).
function assertConvOwner(maHoiThoai, req) {
  return new Promise((resolve) => {
    if (req.user && (req.user.role === 'admin' || req.user.phan_quyen === 'admin')) return resolve(null);
    const expectedOwner = req.user ? req.user.id : GUEST_USER_ID;
    db.get("SELECT ma_nguoi_dung FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ? AND ngay_xoa IS NULL", [maHoiThoai], (err, row) => {
      if (err) return resolve({ status: 500, error: err.message });
      if (!row) return resolve({ status: 404, error: 'KhÃ´ng tÃ¬m tháº¥y cuá»™c há»™i thoáº¡i.' });
      if (row.ma_nguoi_dung !== expectedOwner) return resolve({ status: 403, error: 'KhÃ´ng cÃ³ quyá»n truy cáº­p cuá»™c há»™i thoáº¡i nÃ y.' });
      resolve(null);
    });
  });
}

// Skills API â€” Láº¥y skills Ä‘ang kÃ­ch hoáº¡t (public dÃ nh cho chat)
router.get('/skills', authMiddleware, (req, res) => {
  db.all("SELECT * FROM ky_nang WHERE trang_thai = 'kich_hoat'", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Skills API â€” Láº¥y Táº¤T Cáº¢ skills (ká»ƒ cáº£ bá»‹ táº¯t) â€” dÃ nh cho Admin quáº£n lÃ½
router.get('/skills/all', authMiddleware, (req, res) => {
  db.all("SELECT * FROM ky_nang ORDER BY trang_thai DESC, ten_ky_nang ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Skills API â€” Toggle báº­t/táº¯t má»™t skill (Admin only)
router.put('/skills/:id/toggle', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  const { trang_thai } = req.body;
  if (!trang_thai || !['kich_hoat', 'vo_hieu'].includes(trang_thai)) {
    return res.status(400).json({ success: false, error: 'trang_thai pháº£i lÃ  "kich_hoat" hoáº·c "vo_hieu"' });
  }
  db.run('UPDATE ky_nang SET trang_thai = ? WHERE ma_ky_nang = ?', [trang_thai, id], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'KhÃ´ng tÃ¬m tháº¥y ká»¹ nÄƒng' });
    // P1-13: ghi nháº­t kÃ½ ai toggle skill nÃ o
    logActivity(req.user && req.user.id, 'toggle_skill', `${id} -> ${trang_thai}`);
    res.json({ success: true, message: `ÄÃ£ ${trang_thai === 'kich_hoat' ? 'báº­t' : 'táº¯t'} ká»¹ nÄƒng`, trang_thai });
  });
});

// Live Desktop API - Cho má»i user Ä‘Ã£ Ä‘Äƒng nháº­p (Tá»I Æ¯U HIá»†U NÄ‚NG)
// Live Desktop API - Cho má»i user Ä‘Ã£ Ä‘Äƒng nháº­p (Tá»I Æ¯U HIá»†U NÄ‚NG)
const DESKTOP_ONLY_LOCAL = (res) => {
  if (process.platform !== 'win32') {
    res.status(501).json({ success: false, error: 'Remote Desktop chá»‰ kháº£ dá»¥ng khi backend cháº¡y trÃªn Windows local â€” trÃªn server web tÃ­nh nÄƒng nÃ y táº¯t.' });
    return true;
  }
  return false;
};
router.get('/desktop/screenshot', [authMiddleware, adminMiddleware], async (req, res) => {
  if (DESKTOP_ONLY_LOCAL(res)) return;
  const { spawnSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $bitmap.Size)
$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bytes = $ms.ToArray()
$graphics.Dispose()
$bitmap.Dispose()
$ms.Dispose()
[System.Convert]::ToBase64String($bytes)
`;

  try {
    const tempScript = path.join(require('os').tmpdir(), 'screenshot_' + Date.now() + '.ps1');
    fs.writeFileSync(tempScript, psScript, 'utf8');

    const result = spawnSync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', tempScript
    ], { encoding: 'utf8', timeout: 10000 });

    try { fs.unlinkSync(tempScript); } catch {}

    if (result.error) {
      throw new Error(result.error.message);
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || 'PowerShell exit code: ' + result.status);
    }

    const base64Image = result.stdout.trim();
    if (!base64Image) {
      throw new Error('Empty screenshot data');
    }

    const imgBuffer = Buffer.from(base64Image, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgBuffer.length });
    res.end(imgBuffer);
  } catch (error) {
    res.status(500).json({ error: 'Lá»—i chá»¥p mÃ n hÃ¬nh: ' + error.message });
  }
});

router.post('/desktop/click', [authMiddleware, adminMiddleware], (req, res) => {
  if (DESKTOP_ONLY_LOCAL(res)) return;
  const { x_percent, y_percent } = req.body;
  
  // VALIDATE LINH HOáº T: cháº¥p nháº­n cáº£ sá»‘ vÃ  string number, cháº·n string chá»¯
  const x = Number(x_percent);
  const y = Number(y_percent);
  
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x_percent vÃ  y_percent pháº£i lÃ  sá»‘ (vÃ­ dá»¥: 0.5)' });
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return res.status(400).json({ error: 'GiÃ¡ trá»‹ percent pháº£i tá»« 0.0 Ä‘áº¿n 1.0' });
  }
  
  const psClick = `
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $targetX = [int]($screen.Width * ${x})
    $targetY = [int]($screen.Height * ${y})
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($targetX, $targetY)
    $signature = '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);'
    $type = Add-Type -MemberDefinition $signature -Name "Win32MouseEvent" -Namespace "Win32Functions" -PassThru
    $type::mouse_event(0x0002, 0, 0, 0, 0)
    $type::mouse_event(0x0004, 0, 0, 0, 0)
  `;

  exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psClick.replace(/\n/g, ' ')}"`, { timeout: 3000 }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'KhÃ´ng thá»ƒ Ä‘iá»u khiá»ƒn chuá»™t: ' + err.message });
    }
    res.json({ success: true, x_percent, y_percent });
  });
});

// Weather API
router.get('/external/weather', authMiddleware, async (req, res) => {
  const city = req.query.city || 'Hanoi';
  try {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.current_condition || !data.current_condition[0]) {
      throw new Error('Invalid response format');
    }
    const current = data.current_condition[0];
    res.json({
      success: true,
      city: city,
      temp_C: current.temp_C || 'N/A',
      humidity: current.humidity || 'N/A',
      windspeedKmph: current.windspeedKmph || 'N/A',
      weatherDesc: (current.weatherDesc && current.weatherDesc[0]?.value) || 'N/A',
      uvIndex: current.uvIndex || 'N/A',
      source: 'wttr.in'
    });
  } catch (err) {
    res.json({
      success: false,
      error: 'KhÃ´ng thá»ƒ láº¥y dá»¯ liá»‡u thá»i tiáº¿t: ' + err.message,
      source: 'error'
    });
  }
});

// Stocks API
router.get('/external/stocks/:symbol', authMiddleware, async (req, res) => {
  const { symbol } = req.params;
  try {
    const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=1mo`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.chart?.result?.[0]) {
      throw new Error('No data available');
    }
    const result = data.chart.result[0];
    const quote = result.indicators.quote[0];
    const prices = quote.close.filter(p => p !== null);
    
    if (prices.length < 2) {
      return res.json({ success: true, symbol: symbol.toUpperCase(), currentPrice: prices[0]?.toFixed(2) || 'N/A', change: '0', changePercent: '0', prices, recommendation: 'FLAT âž¡ï¸', source: 'Yahoo Finance' });
    }
    
    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2];
    const change = currentPrice - prevPrice;
    const changePercent = ((change / prevPrice) * 100).toFixed(2);
    
    res.json({
      success: true,
      symbol: symbol.toUpperCase(),
      currentPrice: currentPrice.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent,
      prices: prices.slice(-15),
      recommendation: currentPrice > prevPrice ? 'UP ðŸ“ˆ' : (currentPrice < prevPrice ? 'DOWN ðŸ“‰' : 'FLAT âž¡ï¸'),
      source: 'Yahoo Finance'
    });
  } catch (err) {
    res.json({
      success: false,
      error: 'KhÃ´ng thá»ƒ láº¥y dá»¯ liá»‡u chá»©ng khoÃ¡n: ' + err.message,
      symbol: symbol.toUpperCase(),
      source: 'error'
    });
  }
});

// Vietnamese TTS API - Edge TTS WebSocket thuáº§n Node (khÃ´ng cáº§n Python)
// FIX 24/9/2026 (user bÃ¡o tÃªn giá»ng "áº£o"): danh sÃ¡ch giá»ng KHÃ”NG hardcode ná»¯a â€” láº¥y
// Äá»˜NG tá»« voices/list tháº­t cá»§a Microsoft (xem edgeTTS.listEdgeVoices). Verify 24/9:
// engine tráº£ ÄÃšNG 2 giá»ng vi-VN (id tháº­t): vi-VN-HoaiMyNeural (Female) vÃ 
// vi-VN-NamMinhNeural (Male), FriendlyName "Microsoft HoaiMy/NamMinh Online (Natural)".
// KhÃ´ng bá»‹a vÃ¹ng miá»n/giá»›i tÃ­nh; label láº¥y tá»« dá»¯ liá»‡u engine.
const EDGE_VOICE_FALLBACK_VI = [
  { id: 'vi-VN-HoaiMyNeural', name: 'HoaiMy', gender: 'Ná»¯', locale: 'vi-VN', language: 'vi',
    friendlyName: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)' },
  { id: 'vi-VN-NamMinhNeural', name: 'NamMinh', gender: 'Nam', locale: 'vi-VN', language: 'vi',
    friendlyName: 'Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)' },
];
const DEFAULT_TTS_VOICE = 'vi-VN-HoaiMyNeural';
const isEdgeVoiceId = (v) => /^[a-z]{2,3}-[A-Z]{2}-[\w]+Neural$/.test(String(v || ''));

// Chuáº©n hÃ³a 1 voice engine â†’ shape FE dÃ¹ng (id/label/gender/locale). Label láº¥y tá»«
// dá»¯ liá»‡u THáº¬T cá»§a engine (name + giá»›i tÃ­nh + locale), khÃ´ng thÃªm thÃ´ng tin bá»‹a.
function toVoiceEntry(v) {
  const label = v.friendlyName
    ? `${v.name || v.id} (${v.gender || '?'}) Â· ${v.locale}`
    : (v.label || v.id);
  return {
    id: v.id,
    label,
    gender: v.gender || '',
    locale: v.locale || '',
    language: v.language || '',
    friendlyName: v.friendlyName || '',
    engine: 'edge-tts',
  };
}

// Láº¥y danh sÃ¡ch giá»ng Edge (tháº­t náº¿u gá»i Ä‘Æ°á»£c, fallback static náº¿u máº¡ng lá»—i).
// langFilter: '' | 'vi' | 'all' | '<prefix>' (vd 'en', 'ja-JP')
async function getEdgeVoices(langFilter) {
  const real = await listEdgeVoices();
  const source = real ? 'live' : 'fallback';
  const base = (real || EDGE_VOICE_FALLBACK_VI).map(toVoiceEntry);
  const f = String(langFilter || '').trim().toLowerCase();
  let list = base;
  if (!f || f === 'vi' || f === 'vi-vn') list = base.filter(v => v.language === 'vi');
  else if (f !== 'all') list = base.filter(v => v.language === f || v.locale.toLowerCase() === f || v.locale.toLowerCase().startsWith(f + '-'));
  return { list, source, total: base.length };
}

// â”€â”€ VieNeu-TTS v3 Turbo (20/9/2026) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Engine OpenAI-compatible tá»± host (mÃ¡y local cÃ³ model): VIENEU_BASE_URL trá» tá»›i
// `python -m apps.openai_speech` (port 8000). 25 preset giá»ng Viá»‡t 48kHz + cloning.
// KhÃ´ng cáº¥u hÃ¬nh env â†’ app tá»± dÃ¹ng edge-tts nhÆ° cÅ©. Render free khÃ´ng cháº¡y ná»•i model.
// Nguá»“n Æ°u tiÃªn: VIENEU_BASE_URL_CLOUD (GH Actions runner cloud ghi) â†’ authoritative.
// VIENEU_BASE_URL chá»‰ lÃ  fallback (vd tunnel local manager ghi) Ä‘á»ƒ khÃ´ng phÃ¡ khi cloud há»¥t.
const VIENEU_BASE_URL = ((process.env.VIENEU_BASE_URL_CLOUD || process.env.VIENEU_BASE_URL) || '').trim().replace(/\/$/, '');
const VIENEU_API_KEY = (process.env.VIENEU_API_KEY || 'not-needed').trim();
const VIENEU_TIMEOUT_MS = Number(process.env.VIENEU_TIMEOUT_MS || 9000);
// Circuit breaker: Vieneu há»ng liÃªn tiáº¿p -> bá» qua 5 phÃºt, Ä‘i tháº³ng Edge TTS (300ms)
let VIENEU_FAIL_UNTIL = 0;
let VIENEU_FAIL_COUNT = 0;

// Preset voices cá»§a VieNeu v3 Turbo (GET /v1/voices) â€” dÃ¹ng khi server khÃ´ng gá»i Ä‘Æ°á»£c /v1/voices
const VIENEU_PRESET_VOICES = [
  'Adam bá»±a', 'TrÃºc Ly', 'Anh KhÃ´i', 'Mai Anh', 'Minh QuÃ¢n Pro', 'ThÃ¹y Dung', 'Thiá»n TÃ¢m Äá»©c',
  'Ngá»c Huyá»n', 'Quang SÆ¡n', 'Ngá»c TrÃ¢n',
  'Minh Äá»©c', 'Pháº¡m TuyÃªn', 'XuÃ¢n VÄ©nh', 'Thanh BÃ¬nh', 'Ngá»c Linh', 'Äoan Trang', 'Quá»³nh Anh', 'Máº¡nh DÅ©ng',
  'ThÃ¡i SÆ¡n', 'Thá»¥c Äoan', 'Minh Triáº¿t', 'Má»¹ DuyÃªn', 'Äá»©c TrÃ­', 'Kim Thanh', 'Adam'
];
const VIENEU_DEFAULT_VOICE = 'Minh QuÃ¢n Pro';

async function fetchVieNeuVoices() {
  try {
    const res = await fetch(`${VIENEU_BASE_URL}/v1/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.data) && data.data.length) return data.data.map(v => String(v.id || v.name));
  } catch {}
  return null;
}

// Gá»i VieNeu OpenAI-compatible POST /v1/audio/speech â†’ Buffer WAV
async function generateVieNeuTTS(text, voice, { sampleRate } = {}) {
  const body = {
    model: 'vieneu-v3-turbo',
    voice: voice || VIENEU_DEFAULT_VOICE,
    input: String(text || ''),
    response_format: 'wav',
  };
  if (sampleRate) body.sample_rate = sampleRate;
  let res;
  try {
    res = await fetch(`${VIENEU_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(VIENEU_API_KEY && VIENEU_API_KEY !== 'not-needed' ? { Authorization: `Bearer ${VIENEU_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VIENEU_TIMEOUT_MS),
    });
  } catch (e) {
    const c = e && e.cause;
    throw new Error(`fetch failed (${c ? (c.code || c.message || c.name || 'cause-unknown') : 'no-cause'}${c && c.address ? ` addr=${c.address}` : ''}) -> ${VIENEU_BASE_URL}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`VieNeu HTTP ${res.status}${detail ? ': ' + detail.substring(0, 200) : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('VieNeu tráº£ vá» audio rá»—ng');
  return buf;
}

// Map voice Edge cÅ© (user Ä‘Ã£ lÆ°u trong localStorage) â†’ giá»ng VieNeu gáº§n tÆ°Æ¡ng Ä‘Æ°Æ¡ng
const VIENEU_VOICE_ALIAS = {
  'vi-VN-HoaiMyNeural': 'TrÃºc Ly',
  'vi-VN-NamMinhNeural': 'Minh QuÃ¢n Pro',
};

// â”€â”€ ahm7xmakki TTS (provider TTS free, khÃ´ng cáº§n key â€” CHá»ˆ dÃ¹ng lÃ m chá»‘t cháº·n
//    cuá»‘i khi Edge TTS/VieNeu Ä‘á»u lá»—i) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// QA 28/9: POST https://ahm7xmakki.com/api/tts {text, voiceIndex} â†’ audio/mpeg (MP3).
// /api/voices tráº£ 583 giá»ng; giá»ng Viá»‡t: index 314 HoaiMy (Ná»¯), 315 NamMinh (Nam).
const AHM_TTS_VOICE_INDEX = { 'vi-VN-HoaiMyNeural': 314, 'vi-VN-NamMinhNeural': 315 };
const AHM_TTS_DEFAULT_INDEX = 314;
async function generateAhmTTS(text, voiceIndex) {
  const r = await fetch('https://ahm7xmakki.com/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text || '').slice(0, 1000), voiceIndex: Number(voiceIndex) || AHM_TTS_DEFAULT_INDEX }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`ahm HTTP ${r.status}${detail ? ': ' + detail.substring(0, 120) : ''}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('ahm tráº£ vá» audio rá»—ng');
  return buf;
}

// â”€â”€ AuK (Tencent-Hunyuan) â€” 1.5B foundation model speech generation/editing â”€â”€
// Research 1/10/2026 (repo Tencent-Hunyuan/AuK, MIT weights â€” nhÆ°ng encoder
// Qwen2.5-Omni-3B theo Qwen Research License = non-commercial; paper train
// bilingual EN+ZH, tiáº¿ng Viá»‡t KHÃ”NG Ä‘Æ°á»£c Ä‘áº£m báº£o). Gá»i qua Hugging Face Space
// gradio_api (ZeroGPU); anonymous bá»‹ space tá»« chá»‘i (event error null â€” verified
// 1/10) nÃªn Báº®T BUá»˜C cáº¥u hÃ¬nh AUK_HF_TOKEN. Instruct TTS: mÃ´ táº£ giá»ng, khÃ´ng
// cáº§n audio tham chiáº¿u.
const AUK_SPACE_BASE = (process.env.AUK_SPACE_BASE || 'https://tencent-auk.hf.space').trim().replace(/\/$/, '');
const AUK_HF_TOKEN = (process.env.AUK_HF_TOKEN || '').trim();
const AUK_TIMEOUT_MS = Number(process.env.AUK_TIMEOUT_MS || 180000);

// "Giá»ng" cá»§a AuK = mÃ´ táº£ giá»ng tá»± nhiÃªn (Instruct TTS). desc giá»¯ tiáº¿ng Anh vÃ¬
// model tá»‘i Æ°u EN/ZH â€” mÃ´ táº£ tiáº¿ng Viá»‡t cÃ³ thá»ƒ bá»‹ hiá»ƒu sai.
const AUK_VOICE_PRESETS = [
  { id: 'nu-am-diu', label: 'Ná»¯ áº¥m dá»‹u (warm female)', desc: 'a warm, gentle female voice, calm and clear' },
  { id: 'nam-tram', label: 'Nam tráº§m chá»¯ng (deep male)', desc: 'a deep, confident male voice, professional and steady' },
  { id: 'nu-tre-vui', label: 'Ná»¯ tráº» vui (cheerful female)', desc: 'a cheerful young female voice, energetic and bright' },
  { id: 'nam-ke-chuyen', label: 'Nam ká»ƒ chuyá»‡n (storyteller)', desc: 'a calm elderly male storyteller voice, warm and expressive' },
  { id: 'nu-thi-tham', label: 'Ná»¯ thÃ¬ tháº§m (whisper)', desc: 'a soft whispering female voice, intimate and quiet' },
];

// Gá»i HF Space gradio_api: enqueue â†’ poll SSE â†’ táº£i file audio â†’ Buffer.
async function aukGenerate(instruction, { variant = 'AuK (Base)', genSeconds = 0, nfe = 32, cfg = 2, seed = 42 } = {}) {
  if (!AUK_HF_TOKEN) {
    const e = new Error('thieu AUK_HF_TOKEN');
    e.code = 'AUK_NO_TOKEN';
    throw e;
  }
  const auth = { Authorization: `Bearer ${AUK_HF_TOKEN}` };
  // 1. enqueue job
  const callRes = await fetch(`${AUK_SPACE_BASE}/gradio_api/call/run_generate_with_pe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      data: [true, variant, null, String(instruction || ''),
        Number(genSeconds) || 0, Number(nfe) || 32, Number(cfg) || 0, Number(seed) || 42],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!callRes.ok) throw new Error(`enqueue HTTP ${callRes.status}`);
  const { event_id } = await callRes.json();
  if (!event_id) throw new Error('khÃ´ng nháº­n Ä‘Æ°á»£c event_id');
  // 2. poll SSE (ZeroGPU queue cÃ³ thá»ƒ chá» lÃ¢u â†’ timeout rá»™ng)
  const pollRes = await fetch(`${AUK_SPACE_BASE}/gradio_api/call/run_generate_with_pe/${event_id}`, {
    headers: { ...auth, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(AUK_TIMEOUT_MS),
  });
  if (!pollRes.ok) throw new Error(`poll HTTP ${pollRes.status}`);
  const sse = await pollRes.text();
  let completeData = null;
  for (const block of sse.split('\n\n')) {
    const lines = block.split('\n');
    const ev = (lines.find(l => l.startsWith('event:')) || '').replace('event:', '').trim();
    const dv = (lines.find(l => l.startsWith('data:')) || '').replace('data:', '').trim();
    if (ev === 'error') {
      throw new Error(`space bÃ¡o lá»—i${dv && dv !== '{"error": null}' ? ': ' + dv.substring(0, 160) : ' (kiá»ƒm tra token/quota ZeroGPU)'}`);
    }
    if (ev === 'complete') completeData = dv;
  }
  if (!completeData) throw new Error('khÃ´ng cÃ³ event complete');
  const out = JSON.parse(completeData);
  // 3. tÃ¬m FileData audio trong máº£ng output (shape cÃ³ thá»ƒ Ä‘á»•i theo space â†’ dÃ² phÃ²ng thá»§)
  const isFile = (o) => o && typeof o === 'object' && !Array.isArray(o)
    && (typeof o.url === 'string' || (typeof o.path === 'string' && /\.(wav|mp3|flac|ogg|m4a)$/i.test(o.path)));
  let file = null;
  const scan = (o) => {
    if (file || !o) return;
    if (isFile(o)) { file = o; return; }
    if (Array.isArray(o)) o.forEach(scan);
    else if (typeof o === 'object') Object.values(o).forEach(scan);
  };
  scan(out);
  if (!file) throw new Error('khÃ´ng tÃ¬m tháº¥y file audio trong káº¿t quáº£');
  const url = file.url
    ? (file.url.startsWith('http') ? file.url : AUK_SPACE_BASE + file.url)
    : `${AUK_SPACE_BASE}/gradio_api/file=${file.path}`;
  // 4. táº£i audio
  const audioRes = await fetch(url, { headers: auth, signal: AbortSignal.timeout(60000) });
  if (!audioRes.ok) throw new Error(`táº£i audio HTTP ${audioRes.status}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  if (!buf.length) throw new Error('audio rá»—ng');
  return buf;
}

// GET: Láº¥y danh sÃ¡ch giá»ng nÃ³i TTS tiáº¿ng Viá»‡t
// VieNeu active (env VIENEU_BASE_URL) â†’ tráº£ 25 preset giá»ng v3 Turbo; ngÆ°á»£c láº¡i 2 giá»ng Edge.
router.get('/tts/voices', async (req, res) => {
  const { lang, engine: engineQuery } = req.query;
  // FE cÃ³ thá»ƒ yÃªu cáº§u rÃµ engine: ?engine=edge-tts buá»™c tráº£ danh sÃ¡ch Edge dÃ¹ Ä‘Ã£ cáº¥u hÃ¬nh VieNeu.
  const wantEdge = String(engineQuery || '').trim().toLowerCase() === 'edge-tts';
  const wantAuk = String(engineQuery || '').trim().toLowerCase() === 'auk';
  const wantAhm = String(engineQuery || '').trim().toLowerCase() === 'ahm';
  // Engine ahm7xmakki â€” TTS free (khÃ´ng key), giá»ng Viá»‡t (583 giá»ng, vi: index 314/315).
  if (wantAhm) {
    return res.json({
      success: true,
      engine: 'ahm',
      provider: 'ahm7xmakki (free TTS)',
      voice_clone: false,
      voices: [
        { id: 'vi-VN-HoaiMyNeural', label: 'HoaiMy (Ná»¯) Â· ahm', engine: 'ahm', gender: 'Ná»¯' },
        { id: 'vi-VN-NamMinhNeural', label: 'NamMinh (Nam) Â· ahm', engine: 'ahm', gender: 'Nam' },
      ],
      count: 2,
      default: 'vi-VN-HoaiMyNeural',
    });
  }
  // Engine AuK (Tencent-Hunyuan 1.5B): "giá»ng" = mÃ´ táº£ giá»ng (Instruct TTS).
  if (wantAuk) {
    return res.json({
      success: true,
      engine: 'auk',
      provider: 'AuK (Tencent-Hunyuan, 1.5B)',
      voice_clone: false,
      voices: AUK_VOICE_PRESETS.map(v => ({ id: v.id, label: v.label, engine: 'auk', desc: v.desc })),
      count: AUK_VOICE_PRESETS.length,
      default: AUK_VOICE_PRESETS[0].id,
      configured: !!AUK_HF_TOKEN,
      note: 'AuK (Tencent) tá»‘i Æ°u cho tiáº¿ng Anh/Trung â€” tiáº¿ng Viá»‡t cÃ³ thá»ƒ chÆ°a á»•n Ä‘á»‹nh.',
    });
  }
  if (VIENEU_BASE_URL && !wantEdge) {
    const ids = (await fetchVieNeuVoices()) || VIENEU_PRESET_VOICES;
    return res.json({
      success: true,
      engine: 'vieneu',
      provider: 'VieNeu (self-hosted)',
      voice_clone: true,
      voices: ids.map(id => ({ id, label: id, engine: 'vieneu' })),
      count: ids.length,
      default: ids.includes(VIENEU_DEFAULT_VOICE) ? VIENEU_DEFAULT_VOICE : ids[0],
    });
  }
  const { list, source, total } = await getEdgeVoices(lang);
  return res.json({
    success: true,
    engine: 'edge-tts',
    provider: 'Microsoft Edge TTS',
    voice_clone: false,
    source,                 // 'live' = láº¥y trá»±c tiáº¿p tá»« engine, 'fallback' = engine khÃ´ng gá»i Ä‘Æ°á»£c
    count: list.length,
    total,                  // tá»•ng sá»‘ giá»ng engine cÃ³ (má»i ngÃ´n ngá»¯)
    voices: list,
    default: list.some(v => v.id === DEFAULT_TTS_VOICE) ? DEFAULT_TTS_VOICE : (list[0]?.id || null),
  });
});

// GET: Kiá»ƒm tra tráº¡ng thÃ¡i TTS service
router.get('/tts/status', async (req, res) => {
  let real = null;
  try { real = await listEdgeVoices(); } catch { real = null; }
  const reachable = Array.isArray(real) && real.length > 0;
  const pool = real || EDGE_VOICE_FALLBACK_VI;
  const viCount = pool.filter(v => (v.language || '') === 'vi').length;
  res.json({
    success: true,
    engine: VIENEU_BASE_URL ? 'vieneu' : 'edge-tts',
    provider: VIENEU_BASE_URL ? 'VieNeu (self-hosted)' : 'Microsoft Edge TTS',
    engine_node: true,               // WebSocket thuáº§n Node â€” khÃ´ng cáº§n Python
    voices_reachable: reachable,     // gá»i Ä‘Æ°á»£c voices/list cá»§a engine khÃ´ng?
    total_voices: reachable ? real.length : null,
    voices: viCount,                 // sá»‘ giá»ng vi-VN THáº¬T
    voice_clone: !!VIENEU_BASE_URL,  // Edge TTS cÃ´ng khai KHÃ”NG clone giá»ng
    note: VIENEU_BASE_URL
      ? 'VieNeu self-hosted: há»— trá»£ clone giá»ng.'
      : 'Microsoft Edge TTS cÃ´ng khai â€” khÃ´ng há»— trá»£ clone giá»ng (cáº§n VIENEU_BASE_URL tá»± host).',
    auk: { engine: 'auk', provider: 'AuK (Tencent-Hunyuan 1.5B)', configured: !!AUK_HF_TOKEN, languages: 'EN/ZH (tiáº¿ng Viá»‡t chÆ°a Ä‘áº£m báº£o)' },
    fallback: 'Web Speech API (browser)'
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Engine Edge TTS Thuáº§n Node.js â€” dÃ¹ng chung tá»« src/services/edgeTTS.js
// (WebSocket trá»±c tiáº¿p tá»›i Microsoft Edge TTS, khÃ´ng cáº§n Python)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Cháº¡y edge-tts Python lÃ m phÆ°Æ¡ng Ã¡n dá»± phÃ²ng
async function runEdgeTtsPython(voiceName, trimmedText, validRate, validPitch, tempFile) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
    const proc = spawn('python', [
      '-m', 'edge_tts',
      '--voice', voiceName,
      '--text', trimmedText,
      '--rate', validRate,
      '--pitch', validPitch,
      '--write-media', tempFile
    ], { timeout: 15000 });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempFile)) resolve();
      else reject(new Error(stderr || 'Python edge-tts failed'));
    });
    proc.on('error', (err) => reject(err));
  });
}

// FREE-ALL (QA 22/9/2026): TTS free cho má»i user ká»ƒ cáº£ khÃ¡ch vÃ£ng lai (user yÃªu cáº§u)
// â€” edge-tts/VieNeu Ä‘á»u miá»…n phÃ­ khÃ´ng tá»‘n key, chá»‰ giá»¯ rateLimit chá»‘ng abuse.
router.post('/tts', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { text, voice, rate, pitch, engine: engineInput } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'VÄƒn báº£n khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
  }

  const maxLength = 1000;
  const trimmedText = text.trim().substring(0, maxLength);
  const voiceInput = String(voice || '').trim();
  // FE chá»n engine: 'vieneu' (buá»™c) | 'edge-tts' (buá»™c) | '' (máº·c Ä‘á»‹nh Æ°u tiÃªn VieNeu náº¿u cÃ³)
  const enginePref = String(engineInput || '').trim().toLowerCase();
  const forceEdge = enginePref === 'edge-tts';
  const forceVieNeu = enginePref === 'vieneu';

  // Engine AuK (Tencent-Hunyuan 1.5B) â€” Instruct TTS qua HF Space (ZeroGPU).
  // ChÆ°a cáº¥u hÃ¬nh token â†’ bÃ¡o rÃµ (KHÃ”NG láº·ng láº½ Ä‘á»•i sang Edge) + nháº¯c giá»›i háº¡n VN.
  if (enginePref === 'auk') {
    const preset = AUK_VOICE_PRESETS.find(p => p.id === voiceInput);
    const desc = preset ? preset.desc : (voiceInput || AUK_VOICE_PRESETS[0].desc);
    const wantFlash = String(req.body.variant || '').trim().toLowerCase() === 'flash';
    const variant = wantFlash ? 'AuK-Flash âš¡' : 'AuK (Base)';
    // Flash khoÃ¡ NFE 4 / CFG 0 (theo UI space); Base máº·c Ä‘á»‹nh 32 / 2.
    const nfe = wantFlash ? 4 : (Number(req.body.nfe) || 32);
    const cfg = wantFlash ? 0 : (Number.isFinite(Number(req.body.cfg)) ? Number(req.body.cfg) : 2);
    if (!AUK_HF_TOKEN) {
      return res.status(503).json({
        success: false,
        engine: 'auk',
        error: 'Engine AuK (Tencent) chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh: thiáº¿u AUK_HF_TOKEN.',
        hint: 'Admin Ä‘áº·t biáº¿n mÃ´i trÆ°á»ng AUK_HF_TOKEN (token Hugging Face cÃ³ quota ZeroGPU). AuK tá»‘i Æ°u EN/ZH â€” tiáº¿ng Viá»‡t cÃ³ thá»ƒ chÆ°a á»•n Ä‘á»‹nh.',
      });
    }
    try {
      const instruction = `Say the following with ${desc}: ${trimmedText}`;
      const buf = await aukGenerate(instruction, { variant, nfe, cfg, seed: req.body.seed });
      return res.json({
        success: true,
        audio: buf.toString('base64'),
        format: 'wav',
        engine: 'auk',
        voice: voiceInput,
        voice_label: preset ? preset.label : desc,
        text_length: trimmedText.length,
        note: 'AuK (Tencent-Hunyuan 1.5B) â€” tá»‘i Æ°u tiáº¿ng Anh/Trung',
      });
    } catch (aukErr) {
      console.error('[TTS] AuK failed:', aukErr.message);
      return res.status(502).json({
        success: false,
        engine: 'auk',
        error: 'AuK lá»—i: ' + aukErr.message,
        hint: 'Kiá»ƒm tra AUK_HF_TOKEN vÃ  quota ZeroGPU cá»§a Hugging Face Space Tencent-Hunyuan/AuK.',
      });
    }
  }

  // Engine ahm7xmakki â€” TTS free (khÃ´ng key) giá»ng Viá»‡t; chá»‘t cháº·n Ä‘á»™c láº­p vá»›i Edge/VieNeu.
  if (enginePref === 'ahm') {
    const idx = AHM_TTS_VOICE_INDEX[voiceInput] || AHM_TTS_DEFAULT_INDEX;
    try {
      const buf = await generateAhmTTS(trimmedText, idx);
      return res.json({
        success: true,
        audio: buf.toString('base64'),
        format: 'mp3',
        engine: 'ahm',
        voice: voiceInput,
        voice_label: voiceInput,
        text_length: trimmedText.length,
      });
    } catch (ahmErr) {
      console.error('[TTS] ahm failed:', ahmErr.message);
      return res.status(502).json({ success: false, engine: 'ahm', error: 'ahm TTS lá»—i: ' + ahmErr.message });
    }
  }

  // Æ¯u tiÃªn sá»‘ 1 khi cáº¥u hÃ¬nh: VieNeu v3 Turbo (tá»± host, 48kHz) â€” voice lÃ  tÃªn preset cÃ³ dáº¥u
  // (nháº­n cáº£ voice Edge cÅ© qua alias, cáº£ giá»ng clone Ä‘Ã£ enroll trÃªn server VieNeu)
  if (VIENEU_BASE_URL && !forceEdge && Date.now() >= VIENEU_FAIL_UNTIL) {
    try {
      const vnVoice = VIENEU_VOICE_ALIAS[voiceInput]
        || (voiceInput && !isEdgeVoiceId(voiceInput) ? voiceInput : VIENEU_DEFAULT_VOICE);
      const wavBuffer = await generateVieNeuTTS(trimmedText, vnVoice);
      const base64Audio = wavBuffer.toString('base64');
      return res.json({
        success: true,
        audio: base64Audio,
        format: 'wav',
        engine: 'vieneu',
        voice: vnVoice,
        voice_label: vnVoice,
        text_length: trimmedText.length
      });
    } catch (vnErr) {
      VIENEU_FAIL_COUNT++; if (VIENEU_FAIL_COUNT >= 2) { VIENEU_FAIL_UNTIL = Date.now() + 5 * 60 * 1000; VIENEU_FAIL_COUNT = 0; console.warn('[TTS] Vieneu breaker ON 5 phut — di thang Edge'); }
      // NgÆ°á»i dÃ¹ng chá»§ Ä‘á»™ng chá»n VieNeu â†’ bÃ¡o lá»—i tháº­t, KHÃ”NG láº·ng láº½ Ä‘á»•i sang Edge.
      if (forceVieNeu) {
        console.error('[TTS] VieNeu (forced) failed:', vnErr.message);
        return res.status(502).json({
          success: false,
          engine: 'vieneu',
          error: 'VieNeu táº¡m thá»i khÃ´ng pháº£n há»“i: ' + vnErr.message,
          hint: 'Engine VieNeu cháº¡y trÃªn mÃ¡y tá»± host â€” kiá»ƒm tra server local (port 8124) vÃ  tunnel.'
        });
      }
      console.warn('[TTS] VieNeu failed, falling back to Edge TTS:', vnErr.message);
    }
  }

  // Edge TTS (Microsoft) â€” validate theo danh sÃ¡ch giá»ng THáº¬T cá»§a engine (khÃ´ng hardcode).
  let edgeVoices = null;
  try { edgeVoices = await listEdgeVoices(); } catch { edgeVoices = null; }
  let voiceName = voiceInput || DEFAULT_TTS_VOICE;
  if (edgeVoices) {
    const realIds = new Set(edgeVoices.map(v => v.id));
    if (!realIds.has(voiceName) && !isEdgeVoiceId(voiceName)) {
      // KhÃ´ng bá»‹a/thay ngáº§m: bÃ¡o rÃµ giá»ng khÃ´ng tá»“n táº¡i + gá»£i Ã½ giá»ng vi tháº­t.
      return res.status(400).json({
        success: false,
        error: `Giá»ng "${voiceInput}" khÃ´ng tá»“n táº¡i trÃªn engine Microsoft Edge TTS.`,
        available: edgeVoices.filter(v => v.language === 'vi').map(v => v.id),
      });
    }
  } else if (voiceInput && !isEdgeVoiceId(voiceInput)) {
    voiceName = DEFAULT_TTS_VOICE;
  }
  const voiceLang = localeFromVoice(voiceName);
  const edgeEntry = (edgeVoices || EDGE_VOICE_FALLBACK_VI).find(v => v.id === voiceName);
  const validRate = rate && /^[+-]\d+%$/.test(rate) ? rate : '+0%';
  const validPitch = pitch && /^[+-]\d+Hz$/.test(pitch) ? pitch : '+0Hz';

  try {
    let audioBuffer;

    // Gá»i trá»±c tiáº¿p Edge TTS WebSocket thuáº§n Node.js (SiÃªu nhanh 300ms, khÃ´ng cáº§n Python)
    try {
      audioBuffer = await generateEdgeTTSNode(voiceName, trimmedText, validRate, validPitch, voiceLang);
    } catch (wsErr) {
      console.warn('[TTS] Pure Node.js WebSocket failed, trying Python fallback:', wsErr.message);
      // Dá»± phÃ²ng: Thá»­ gá»i Python náº¿u WebSocket gáº·p sá»± cá»‘
      const tempFile = path.join(__dirname, '..', '..', `tts_${Date.now()}.mp3`);
      await runEdgeTtsPython(voiceName, trimmedText, validRate, validPitch, tempFile);
      if (fs.existsSync(tempFile)) {
        audioBuffer = fs.readFileSync(tempFile);
        try { fs.unlinkSync(tempFile); } catch(e) {}
      }
    }

    if (audioBuffer && audioBuffer.length > 0) {
      const base64Audio = audioBuffer.toString('base64');
      return res.json({
        success: true,
        audio: base64Audio,
        format: 'mp3',
        engine: 'edge-tts',
        provider: 'Microsoft Edge TTS',
        voice: voiceName,
        locale: voiceLang,
        voice_label: edgeEntry?.friendlyName || voiceName,
        rate: validRate,
        pitch: validPitch,
        text_length: trimmedText.length
      });
    }

    throw new Error('KhÃ´ng thá»ƒ táº¡o Ã¢m thanh TTS');
  } catch (err) {
    console.error('[TTS] Error:', err.message);
    // QA 28/9: Edge TTS + Python fallback Ä‘á»u lá»—i â†’ thá»­ provider TTS free ahm7xmakki
    // (Ä‘Ã£ verify tráº£ MP3 tiáº¿ng Viá»‡t). KhÃ´ng thay Ä‘á»•i hÃ nh vi khi Edge cháº¡y bÃ¬nh thÆ°á»ng.
    try {
      const ahmBuf = await generateAhmTTS(trimmedText, AHM_TTS_VOICE_INDEX[voiceName]);
      console.warn('[TTS] Edge tháº¥t báº¡i, dÃ¹ng ahm7xmakki fallback.');
      return res.json({
        success: true,
        audio: ahmBuf.toString('base64'),
        format: 'mp3',
        engine: 'ahm-tts',
        provider: 'ahm7xmakki TTS',
        voice: voiceName,
        locale: voiceLang,
        voice_label: edgeEntry?.friendlyName || voiceName,
        text_length: trimmedText.length
      });
    } catch (ahmErr) {
      console.error('[TTS] ahm fallback cÅ©ng lá»—i:', ahmErr.message);
    }
    res.status(500).json({
      success: false,
      error: 'Lá»—i phÃ¡t Ã¢m thanh: ' + err.message,
      note: 'Dá»‹ch vá»¥ giá»ng nÃ³i Microsoft Edge TTS táº¡m thá»i giÃ¡n Ä‘oáº¡n.'
    });
  }
});

// Clone giá»ng (VieNeu): nháº­n file máº«u 3-8s + vÄƒn báº£n â†’ forward multipart tá»›i
// {VIENEU_BASE_URL}/v1/clone â†’ tráº£ WAV base64 (cÃ¹ng Ä‘á»‹nh dáº¡ng vá»›i /services/tts).
const cloneUpload = multer({  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // 4/10: má»™t sá»‘ client (curl Windows, vÃ i trÃ¬nh duyá»‡t) gá»­i audio vá»›i
    // Content-Type application/octet-stream â†’ cháº¥p nháº­n theo Ä‘uÃ´i file ná»¯a.
    const mimeOk = file.mimetype && file.mimetype.startsWith('audio/');
    const extOk = /\.(wav|mp3|m4a|ogg|oga|webm|flac|aac)$/i.test(file.originalname || '');
    if (mimeOk || extOk) cb(null, true);
    else cb(new Error('Chá»‰ cháº¥p nháº­n file audio máº«u (wav/mp3/m4a/ogg/webm)'), false);
  }
});
// Bá»c single('audio') Ä‘á»ƒ lá»—i multer/busboy tráº£ JSON 400 rÃµ rÃ ng thay vÃ¬ rÆ¡i
// vÃ o global error handler (500 mÃ¹). 4/10: debug upload flaky.
const uploadAudioSample = (req, res, next) => {
  cloneUpload.single('audio')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: 'Upload lá»—i: ' + (err.message || err.code || 'unknown') });
    }
    next();
  });
};

router.post('/tts/clone', rateLimit({ windowMs: 60000, max: 10 }), uploadAudioSample, async (req, res) => {
  try {
    if (!VIENEU_BASE_URL) {
      return res.status(503).json({
        success: false,
        error: 'Clone giá»ng cáº§n engine VieNeu (VIENEU_BASE_URL chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh trÃªn server).'
      });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, error: 'Thiáº¿u file audio máº«u (3-8 giÃ¢y).' });
    }
    const cloneText = String(req.body?.text || '').trim().substring(0, 1000);
    if (!cloneText) {
      return res.status(400).json({ success: false, error: 'Thiáº¿u vÄƒn báº£n cáº§n Ä‘á»c báº±ng giá»ng clone.' });
    }
    const refText = String(req.body?.ref_text || '').trim().substring(0, 500);

    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' }), req.file.originalname || 'ref.wav');
    form.append('text', cloneText);
    if (refText) form.append('ref_text', refText);

    const upstream = await fetch(`${VIENEU_BASE_URL}/v1/clone`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VIENEU_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('[TTS clone] VieNeu HTTP', upstream.status, detail.substring(0, 200));
      return res.status(502).json({
        success: false,
        engine: 'vieneu',
        error: `VieNeu clone HTTP ${upstream.status}`,
        detail: detail.substring(0, 200)
      });
    }
    const wavBuffer = Buffer.from(await upstream.arrayBuffer());
    if (!wavBuffer.length) {
      return res.status(502).json({ success: false, engine: 'vieneu', error: 'VieNeu clone tráº£ audio rá»—ng' });
    }
    return res.json({
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      engine: 'vieneu',
      voice: 'clone',
      voice_label: 'Giá»ng Ä‘Ã£ clone',
      text_length: cloneText.length
    });
  } catch (err) {
    console.error('[TTS clone] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Lá»—i clone giá»ng: ' + err.message });
  }
});

// â”€â”€â”€ Giá»ng tÃ¹y chá»‰nh cá»§a user ("Giá»ng cá»§a tÃ´i", 4/10) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// VieNeu /v1/clone lÃ  stateless (tráº£ WAV xong xÃ³a máº«u) â†’ muá»‘n TÃI DÃ™NG giá»ng
// pháº£i lÆ°u file máº«u. LÆ°u máº«u vÃ o DB theo user (Render disk ephemeral nÃªn
// khÃ´ng Ä‘á»ƒ file local). CÃ³ API /:id/speak Ä‘á»ƒ Ä‘á»c vÄƒn báº£n má»›i báº±ng giá»ng Ä‘Ã£
// lÆ°u â€” dÃ¹ng trong app láº«n gá»i tá»« bÃªn ngoÃ i nhÆ° API TTS giá»ng riÃªng.
db.run(`CREATE TABLE IF NOT EXISTS giong_tuy_chinh (
  giong_id TEXT PRIMARY KEY,
  ma_nguoi_dung TEXT NOT NULL,
  ten_giong TEXT NOT NULL,
  audio_mime TEXT,
  audio_b64 TEXT,
  dung_luong INTEGER DEFAULT 0,
  ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP
)`, () => {});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024; // máº«u 3-8s wav ~ vÃ i trÄƒm KB

// LÆ°u máº«u giá»ng (Ä‘áº·t tÃªn) â€” cáº§n Ä‘Äƒng nháº­p
router.post('/tts/custom-voices', authMiddleware, rateLimit({ windowMs: 60000, max: 10 }), uploadAudioSample, async (req, res) => {
  try {
    const name = String(req.body?.ten || req.body?.name || '').trim().substring(0, 60);
    if (!name) return res.status(400).json({ success: false, error: 'Thiáº¿u tÃªn giá»ng (ten).' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, error: 'Thiáº¿u file audio máº«u.' });
    }
    if (req.file.buffer.length > MAX_SAMPLE_BYTES) {
      return res.status(400).json({ success: false, error: 'File máº«u quÃ¡ lá»›n (tá»‘i Ä‘a 2MB, khoáº£ng 3-8 giÃ¢y).' });
    }
    const id = require('crypto').randomUUID();
    await dbRun(
      'INSERT INTO giong_tuy_chinh (giong_id, ma_nguoi_dung, ten_giong, audio_mime, audio_b64, dung_luong) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.user.id, name, req.file.mimetype || 'audio/wav', req.file.buffer.toString('base64'), req.file.buffer.length]
    );
    return res.json({ success: true, id, ten: name, dung_luong: req.file.buffer.length });
  } catch (err) {
    console.error('[TTS custom-voices] Save error:', err.message);
    return res.status(500).json({ success: false, error: 'Lá»—i lÆ°u giá»ng: ' + err.message });
  }
});

// Danh sÃ¡ch giá»ng cá»§a tÃ´i (khÃ´ng kÃ¨m audio)
router.get('/tts/custom-voices', authMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT giong_id AS id, ten_giong AS ten, audio_mime, dung_luong, ngay_tao FROM giong_tuy_chinh WHERE ma_nguoi_dung = ? ORDER BY ngay_tao DESC',
      [req.user.id]
    );
    return res.json({ success: true, voices: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lá»—i táº£i danh sÃ¡ch: ' + err.message });
  }
});

// Táº£i file máº«u vá» (Ä‘á»ƒ chÃ¨n/cháº¿ biáº¿n chá»— khÃ¡c)
router.get('/tts/custom-voices/:id/sample', authMiddleware, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT ten_giong, audio_mime, audio_b64 FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?',
      [req.params.id, req.user.id]
    );
    if (!row || !row.audio_b64) return res.status(404).json({ success: false, error: 'KhÃ´ng tÃ¬m tháº¥y máº«u giá»ng.' });
    const buf = Buffer.from(row.audio_b64, 'base64');
    const ext = String(row.audio_mime || '').includes('mp3') || String(row.audio_mime || '').includes('mpeg') ? 'mp3' : 'wav';
    res.setHeader('Content-Type', row.audio_mime || 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="giong-${req.params.id}.${ext}"`);
    return res.send(buf);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lá»—i táº£i máº«u: ' + err.message });
  }
});

// XÃ³a giá»ng
router.delete('/tts/custom-voices/:id', authMiddleware, async (req, res) => {
  try {
    await dbRun('DELETE FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?', [req.params.id, req.user.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lá»—i xÃ³a: ' + err.message });
  }
});

// Äá»c vÄƒn báº£n má»›i báº±ng giá»ng Ä‘Ã£ lÆ°u â€” API tÃ¡i dÃ¹ng (trong app + gá»i ngoÃ i)
router.post('/tts/custom-voices/:id/speak', authMiddleware, rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    if (!VIENEU_BASE_URL) {
      return res.status(503).json({ success: false, error: 'Cáº§n engine VieNeu (VIENEU_BASE_URL chÆ°a cáº¥u hÃ¬nh).' });
    }
    const text = String(req.body?.text || '').trim().substring(0, 1000);
    if (!text) return res.status(400).json({ success: false, error: 'Thiáº¿u text.' });
    const row = await dbGet(
      'SELECT ten_giong, audio_mime, audio_b64 FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?',
      [req.params.id, req.user.id]
    );
    if (!row || !row.audio_b64) return res.status(404).json({ success: false, error: 'KhÃ´ng tÃ¬m tháº¥y máº«u giá»ng.' });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(row.audio_b64, 'base64')], { type: row.audio_mime || 'audio/wav' }), 'ref.wav');
    form.append('text', text);
    const upstream = await fetch(`${VIENEU_BASE_URL}/v1/clone`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VIENEU_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res.status(502).json({ success: false, engine: 'vieneu', error: `VieNeu clone HTTP ${upstream.status}`, detail: detail.substring(0, 200) });
    }
    const wavBuffer = Buffer.from(await upstream.arrayBuffer());
    if (!wavBuffer.length) return res.status(502).json({ success: false, engine: 'vieneu', error: 'VieNeu clone tráº£ audio rá»—ng' });
    return res.json({
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      engine: 'vieneu',
      voice_id: req.params.id,
      voice_label: row.ten_giong,
    });
  } catch (err) {
    console.error('[TTS custom-voices] Speak error:', err.message);
    return res.status(500).json({ success: false, error: 'Lá»—i Ä‘á»c: ' + err.message });
  }
});

const getCountryFlag = (code) => {
  if (!code || code.length !== 2) return 'ðŸŒ';
  const codePoints = code.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
};

// ============================================================
// HLS Stream Proxy â€” trÃ¡nh CORS khi trÃ¬nh duyá»‡t load stream
// Browser gá»i: /api/services/iptv/proxy?url=<encoded_stream_url>
// Backend fetch vá» rá»“i chuyá»ƒn tiáº¿p vá»›i CORS headers má»Ÿ
// ============================================================
// P2-19d: proxy yÃªu cáº§u Ä‘Äƒng nháº­p. <video>/hls.js khÃ´ng gá»­i Ä‘Æ°á»£c Authorization
// header â†’ cho phÃ©p token qua ?token= (bridge sang header cho authMiddleware).
// FE Ä‘Ã£ gá»­i token vÃ o URL proxy (App.jsx playHlsStream, YouTubeTab proxyUrl);
// playlist m3u8 rewrite giá»¯ láº¡i token cho cÃ¡c segment con (qsToken).
// 4/10 FREE-ALL YouTube: khÃ¡ch vÃ£ng lai (khÃ´ng token) váº«n xem Ä‘Æ°á»£c qua
// /youtube/proxy nhÆ°ng CHá»ˆ vá»›i host media Ä‘Ã£ biáº¿t (chá»‘ng open-proxy).
// /iptv/proxy giá»¯ nguyÃªn: báº¯t buá»™c login.
function proxyAuth(req, res, next) {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  return authMiddleware(req, res, next);
}
function youtubeProxyAuth(req, res, next) {
  if (req.headers.authorization || req.query.token) return proxyAuth(req, res, next);
  return next(); // khÃ¡ch: handler /youtube/proxy kiá»ƒm tra host allowlist
}
// Guest váº«n xem IPTV Ä‘Æ°á»£c (khÃ´ng token) nhÆ°ng limit riÃªng 30 req/phÃºt/IP
// Ä‘á»ƒ chá»‘ng láº¡m dá»¥ng bÄƒng thÃ´ng â€” SSRF check trong handler váº«n Ã¡p dá»¥ng.
const iptvGuestRate = rateLimit({ windowMs: 60000, max: 30 });
function iptvProxyGate(req, res, next) {
  if (req.headers.authorization || req.query.token) return proxyAuth(req, res, next);
  return iptvGuestRate(req, res, next);
}

router.get('/iptv/proxy', rateLimit({ windowMs: 60000, max: 120 }), iptvProxyGate, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    // P2-18: check async (literal + DNS resolve) thay vÃ¬ isPrivateHostname sync
    const check = await assertPublicUrlAsync(targetUrl);
    if (!check.ok) {
      const code = (check.reason === 'URL khÃ´ng há»£p lá»‡' || check.reason === 'Chá»‰ cho phÃ©p http/https') ? 400 : 403;
      return res.status(code).json({ error: check.reason });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  try {
    // Chá»‘ng SSRF qua redirect: kiá»ƒm tra láº¡i Ä‘á»‹a chá»‰ má»—i bÆ°á»›c (tá»‘i Ä‘a 5 hops)
    let effectiveUrl = targetUrl;
    let upstream;
    for (let hop = 0; hop <= 5; hop++) {
      upstream = await fetch(effectiveUrl, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': new URL(targetUrl).origin + '/',
          'Origin': new URL(targetUrl).origin
        },
        signal: AbortSignal.timeout(15000)
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        const nextUrl = new URL(upstream.headers.get('location'), effectiveUrl).toString();
        const hopCheck = await assertPublicUrlAsync(nextUrl);
        if (!hopCheck.ok) {
          return res.status(403).json({ error: 'Internal network access is not allowed (redirect)' });
        }
        effectiveUrl = nextUrl;
        continue;
      }
      break;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Content-Type', contentType);
    res.status(upstream.status);

    // Náº¿u lÃ  file .m3u8 playlist thÃ¬ rewrite cÃ¡c URL â†’ tuyá»‡t Ä‘á»‘i qua proxy
    if (contentType.toLowerCase().includes('mpegurl') || effectiveUrl.toLowerCase().endsWith('.m3u8')) {
      let body = await upstream.text();
      // Chuáº©n hoÃ¡ CRLF -> LF (má»™t sá»‘ server dÃ¹ng CRLF, regex rewrite sáº½ miss)
      if (body.includes('\r\n')) body = body.replace(/\r\n/g, '\n');

      const base = effectiveUrl.substring(0, effectiveUrl.lastIndexOf('/') + 1);
      const origin = new URL(effectiveUrl).origin;
      const toAbsolute = (u) => {
        if (/^https?:\/\//i.test(u)) return u;
        if (u.startsWith('/')) return origin + u;
        return base + u;
      };
      // Giá»¯ ?token= cho segment con (náº¿u client gá»i proxy kÃ¨m token qua query)
      const qsToken = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';
      const toProxy = (u) => `${req.protocol}://${req.get('host')}/api/services/iptv/proxy?url=${encodeURIComponent(toAbsolute(u))}${qsToken}`;
      // 1) Rewrite dÃ²ng URI thÆ°á»ng (segment, variant playlist)
      body = body.replace(/^(?!#)([^\r\n]+)$/gm, (line) => {
        line = line.trim();
        if (!line) return line;
        return toProxy(line);
      });
      // 2) Rewrite URI náº±m TRONG dÃ²ng #EXT-X-MAP / #EXT-X-KEY / #EXT-X-MEDIA
      //    (init segments fMP4, AES keys, audio/subtitle renditions) â€” náº¿u khÃ´ng
      //    proxy, trÃ¬nh duyá»‡t fetch trá»±c tiáº¿p cross-origin â†’ CORS cháº·n â†’ máº¥t audio.
      body = body.replace(/^(#EXT-X-(?:MAP|KEY|MEDIA)):([^\r\n]*)$/gim, (whole, tag, attrs) => {
        return tag + ':' + attrs.replace(/URI="([^"]*)"/gi, (m, u) => `URI="${toProxy(u)}"`);
      });
      return res.send(body);
    }

    // Dá»¯ liá»‡u nhá»‹ phÃ¢n (ts segments, etc.) â€” pipe tháº³ng
    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[IPTV Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Proxy upstream error: ' + err.message });
  }
});

// IPTV Channels API
router.get('/iptv/channels', async (req, res) => {
  const { country, category, limit = 1500 } = req.query;
  try {
    const availableCategories = [
      'news', 'sports', 'entertainment', 'music', 'movies',
      'documentary', 'animation', 'kids', 'general', 'education',
      'religion', 'science', 'business', 'shop'
    ];
    
    const COUNTRY_CODE_MAP = { 'GB': 'uk', 'UK': 'uk' };
    
    let url = 'https://iptv-org.github.io/iptv/index.m3u';
    
    if (country && country !== 'all' && country.trim()) {
      const mappedCode = COUNTRY_CODE_MAP[country.toUpperCase()] || country.toLowerCase();
      url = `https://iptv-org.github.io/iptv/countries/${mappedCode}.m3u`;
    } else if (category && availableCategories.includes(category.toLowerCase())) {
      url = `https://iptv-org.github.io/iptv/categories/${category.toLowerCase()}.m3u`;
    } else if (category && category.trim() && !availableCategories.includes(category.toLowerCase())) {
      return res.json({ success: false, error: `Category '${category}' kh\u00f4ng t\u1ed3n t\u1ea1i. Categories c\u00f3 s\u1eb5n: ${availableCategories.join(', ')}` });
    }
      
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000)
      });
    } catch (err) {
      console.log('[IPTV] Fetch M3U url error, trying index fallback:', err.message);
      resp = await fetch('https://iptv-org.github.io/iptv/index.m3u', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000)
      }).catch(() => null);
    }
    
    let text = '';
    if (resp && resp.ok) {
      text = await resp.text();
    }
    
    const channels = [];
    const seenUrls = new Set();
    const seenNames = new Set();

    if (text && text.length > 50) {
      const lines = text.split('\n');
      let currentChannel = null;

      for (const rawLine of lines) {
        const line = rawLine.replace('\r', '').trim();
        if (!line || line.startsWith('#EXTVLCOPT') || line.startsWith('#KODIPROP') || line.startsWith('#EXTM3U')) continue;
        
        if (line.startsWith('#EXTINF:')) {
          const lastComma = line.lastIndexOf(',');
          const name = lastComma >= 0 ? line.substring(lastComma + 1).trim() : 'KÃªnh Truyá»n HÃ¬nh';

          // Bá» qua cÃ¡c kÃªnh Ä‘Ã£ Ä‘Æ°á»£c Ä‘Ã¡nh dáº¥u lÃ  Geo-blocked, Not 24/7, Offline, Blocked trong danh sÃ¡ch M3U
          if (/geo-blocked|not 24\/7|offline|discontinued|blocked|dead/i.test(name)) {
            currentChannel = null;
            continue;
          }

          const logoMatch = line.match(/tvg-logo="([^"]+)"/);
          const logo = logoMatch ? logoMatch[1] : '';
          const groupMatch = line.match(/group-title="([^"]+)"/);
          const group = groupMatch ? groupMatch[1] : '';

          const countryMatch = line.match(/tvg-country="([^"]+)"/);
          let countryCode = '';
          if (countryMatch) {
            countryCode = countryMatch[1].split(',')[0].trim().toUpperCase();
          } else {
            const idMatch = line.match(/tvg-id="[^"]*\.([a-z]{2})"/i);
            if (idMatch) countryCode = idMatch[1].toUpperCase();
          }
          
          currentChannel = { name, logo, group, country: countryCode };
        } else if (line.startsWith('http') && currentChannel) {
          const cleanUrl = line.split(/[\s"'\r\n]/)[0].trim();
          
          if (
            cleanUrl && 
            (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) && 
            !seenUrls.has(cleanUrl)
          ) {
            seenUrls.add(cleanUrl);
            currentChannel.url = cleanUrl;
            currentChannel.name = currentChannel.name.replace(/\s+/g, ' ').trim();
            channels.push(currentChannel);
          }
          currentChannel = null;
        }
      }
    }

    // Lá»c kÃªnh nÆ°á»›c ngoÃ i khi filter quá»‘c gia â€” chá»‰ bá» kÃªnh rÃµ rÃ ng khÃ´ng pháº£i VN
    if (country && country !== 'all' && country.trim()) {
      const targetCode = country.toUpperCase();
      const FOREIGN_BLACKLIST = /uniquely thai|lao sv|lao-thai|laos thai|thai tv|hmong tv|rtm asean|mnb world|vietnamese american|us viet|phoenix viet|little saigon|tea tv/i;
      const filtered = channels.filter(ch => {
        if (ch.country === targetCode) return true;
        if (ch.country && ch.country !== targetCode) return false;
        if (ch.name && FOREIGN_BLACKLIST.test(ch.name)) return false;
        return true;
      });
      channels.length = 0;
      channels.push(...filtered);
    }

    // Bá»• sung cÃ¡c kÃªnh Truyá»n HÃ¬nh Viá»‡t Nam trá»±c tiáº¿p (VTV, VTC, Tá»‰nh ThÃ nh)
    if (!category && (!country || country.toUpperCase() === 'VN')) {
      const vnDirectChannels = [
        // VTV â€” nguá»“n FPTPlay (Ä‘ang sá»‘ng 100%)
        { name: 'VTV1 HD - Thá»i Sá»± 24/7', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv1/live247-hls-avc/index.m3u8' },
        { name: 'VTV2 HD - Khoa Há»c & GiÃ¡o Dá»¥c', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Education', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv2/live247-hls-avc/index.m3u8' },
        { name: 'VTV3 HD - Giáº£i TrÃ­ & Thá»ƒ Thao', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://live.fptplay53.net/live/media/vtv3/live247-hls-avc/index.m3u8' },
        { name: 'VTV4 HD - Äá»‘i Ngoáº¡i Quá»‘c Táº¿', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv4/live247-hls-avc/index.m3u8' },
        { name: 'VTV5 HD - Tiáº¿ng DÃ¢n Tá»™c', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv5/live247-hls-avc/index.m3u8' },
        { name: 'VTV5 TÃ¢y Nam Bá»™ HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv5tnb/live-hls-avc/index.m3u8' },
        { name: 'VTV5 TÃ¢y NguyÃªn HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://vips-livecdn.fptplay.net/live/media/vtv5tn/live-hls-avc/index.m3u8' },
        { name: 'VTV6 HD - KÃªnh Thanh Thiáº¿u NiÃªn', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Entertainment', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv6/live247-hls-avc/index.m3u8' },
        { name: 'VTV7 HD - KÃªnh GiÃ¡o Dá»¥c Quá»‘c Gia', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Education', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv7/live247-hls-avc/index.m3u8' },
        { name: 'VTV9 HD - KÃªnh Nam Bá»™', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv9/live247-hls-avc/index.m3u8' },
        { name: 'VTV10 HD - KÃªnh Äa Ná»n Táº£ng', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv10/live247-hls-avc/index.m3u8' },
        // CÃ¡c Ä‘Ã i khÃ¡c â€” nguá»“n vtvprime (Ä‘ang sá»‘ng)
        { name: 'ANTV - Truyá»n HÃ¬nh CÃ´ng An NhÃ¢n DÃ¢n', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8' },
        { name: 'QPVN - Quá»‘c PhÃ²ng Viá»‡t Nam HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/QPTV/index.m3u8' },
        { name: 'SCTV2 HD', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/SCTV2/index.m3u8' },
        { name: 'HTV Key - KÃªnh ChÃ¬a KhÃ³a VÃ ng', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/HTVKey/index.m3u8' },
        // KÃªnh Tá»‰nh ThÃ nh
        { name: 'Cáº§n ThÆ¡ TV1 (1080p)', logo: '', group: 'General', country: 'VN', url: 'https://live.canthotv.vn/live/tv/chunklist.m3u8' },
        { name: 'Cáº§n ThÆ¡ TV3 (1080p)', logo: '', group: 'General', country: 'VN', url: 'https://live.canthotv.vn/cs3/tv/chunklist.m3u8' },
        { name: 'Äá»“ng ThÃ¡p TV1 (720p)', logo: '', group: 'General', country: 'VN', url: 'https://liveh34.vtvprime.vn/hls/DONGTHAPTV/index.m3u8' },
        { name: 'ThÃ¡i NguyÃªn TV (720p)', logo: '', group: 'General', country: 'VN', url: 'https://streaming.thainguyentv.vn/hls/livestream.m3u8' },
        // KÃªnh quá»‘c táº¿ liÃªn quan VN
        { name: 'TVB Vietnam (1080p)', logo: '', group: 'Entertainment', country: 'VN', url: 'https://amg01868-amg01868c3-tvbanywhere-us-4491.playouts.now.amagi.tv/playlist/amg01868-tvbusa-tvbvietnam-tvbanywhereus/playlist.m3u8' },
      ];

      for (const ch of vnDirectChannels) {
        if (!seenUrls.has(ch.url)) {
          seenUrls.add(ch.url);
          channels.unshift(ch);
        }
      }
    }

    const { search } = req.query;
    let result = channels;
    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      result = channels.filter(ch => ch.name.toLowerCase().includes(q));
    }

    res.json({ success: true, count: result.length, categories: availableCategories, channels: result });
  } catch (err) {
    res.json({ success: false, error: 'L\u1ed7i k\u1ebft n\u1ed1i IPTV: ' + (err.message || 'Timeout ho\u1eb7c server kh\u00f4ng ph\u1ea3n h\u1ed3i') });
  }
});


// Map code -> tÃªn quá»‘c gia
const countryNames = {
  'VN': 'Vietnam', 'US': 'United States', 'GB': 'United Kingdom', 'FR': 'France',
  'DE': 'Germany', 'IT': 'Italy', 'ES': 'Spain', 'JP': 'Japan', 'KR': 'South Korea',
  'CN': 'China', 'RU': 'Russia', 'BR': 'Brazil', 'MX': 'Mexico', 'CA': 'Canada',
  'AU': 'Australia', 'IN': 'India', 'TH': 'Thailand', 'PH': 'Philippines',
  'ID': 'Indonesia', 'MY': 'Malaysia', 'SG': 'Singapore', 'HK': 'Hong Kong',
  'TW': 'Taiwan', 'NZ': 'New Zealand', 'ZA': 'South Africa', 'NG': 'Nigeria',
  'KE': 'Kenya', 'EG': 'Egypt', 'TR': 'Turkey', 'SA': 'Saudi Arabia',
  'AE': 'United Arab Emirates', 'IL': 'Israel', 'PK': 'Pakistan', 'BD': 'Bangladesh',
  'NL': 'Netherlands', 'BE': 'Belgium', 'CH': 'Switzerland', 'AT': 'Austria',
  'SE': 'Sweden', 'NO': 'Norway', 'DK': 'Denmark', 'FI': 'Finland',
  'PL': 'Poland', 'CZ': 'Czech Republic', 'HU': 'Hungary', 'RO': 'Romania',
  'GR': 'Greece', 'PT': 'Portugal', 'IE': 'Ireland', 'AR': 'Argentina',
  'CL': 'Chile', 'CO': 'Colombia', 'PE': 'Peru', 'VE': 'Venezuela',
  'CU': 'Cuba', 'PR': 'Puerto Rico', 'DO': 'Dominican Republic', 'JM': 'Jamaica',
  'TN': 'Tunisia', 'MA': 'Morocco', 'DZ': 'Algeria', 'LY': 'Libya',
  'QA': 'Qatar', 'BH': 'Bahrain', 'KW': 'Kuwait', 'OM': 'Oman',
  'JO': 'Jordan', 'LB': 'Lebanon', 'SY': 'Syria', 'IQ': 'Iraq',
  'IR': 'Iran', 'AF': 'Afghanistan', 'UZ': 'Uzbekistan', 'KZ': 'Kazakhstan',
  'TJ': 'Tajikistan', 'KG': 'Kyrgyzstan', 'TM': 'Turkmenistan', 'MN': 'Mongolia',
  'LA': 'Laos', 'KH': 'Cambodia', 'MM': 'Myanmar', 'VG': 'British Virgin Islands',
  'VI': 'U.S. Virgin Islands', 'TC': 'Turks and Caicos', 'BS': 'Bahamas',
  'BM': 'Bermuda', 'KY': 'Cayman Islands', 'AI': 'Anguilla', 'AG': 'Antigua and Barbuda',
  'KN': 'Saint Kitts and Nevis', 'LC': 'Saint Lucia', 'VC': 'Saint Vincent and the Grenadines',
  'GD': 'Grenada', 'BZ': 'Belize', 'HT': 'Haiti', 'TT': 'Trinidad and Tobago',
  'GY': 'Guyana', 'SR': 'Suriname', 'EC': 'Ecuador', 'BO': 'Bolivia',
  'PY': 'Paraguay', 'UY': 'Uruguay', 'FM': 'Micronesia', 'PW': 'Palau',
  'FJ': 'Fiji', 'SB': 'Solomon Islands', 'VU': 'Vanuatu', 'WS': 'Samoa',
  'KI': 'Kiribati', 'TO': 'Tonga', 'PG': 'Papua New Guinea', 'BT': 'Bhutan',
  'NP': 'Nepal', 'SL': 'Sierra Leone', 'LR': 'Liberia', 'GH': 'Ghana',
  'CI': 'CÃ´te d\'Ivoire', 'SN': 'Senegal', 'ML': 'Mali', 'BJ': 'Benin',
  'BF': 'Burkina Faso', 'NE': 'Niger', 'TD': 'Chad', 'CF': 'Central African Republic',
  'CM': 'Cameroon', 'GA': 'Gabon', 'CG': 'Republic of the Congo', 'CD': 'Democratic Republic of the Congo',
  'AO': 'Angola', 'ZM': 'Zambia', 'ZW': 'Zimbabwe', 'MW': 'Malawi',
  'MZ': 'Mozambique', 'BW': 'Botswana', 'NA': 'Namibia', 'LS': 'Lesotho',
  'SZ': 'Eswatini', 'MU': 'Mauritius', 'SC': 'Seychelles', 'MG': 'Madagascar',
  'GM': 'Gambia', 'GW': 'Guinea-Bissau', 'GN': 'Guinea', 'ET': 'Ethiopia',
  'SO': 'Somalia', 'DJ': 'Djibouti', 'ER': 'Eritrea', 'SD': 'Sudan',
  'SS': 'South Sudan', 'UG': 'Uganda', 'RW': 'Rwanda', 'BI': 'Burundi',
  'TZ': 'Tanzania', 'AL': 'Albania', 'BA': 'Bosnia and Herzegovina', 'HR': 'Croatia',
  'ME': 'Montenegro', 'RS': 'Serbia', 'MK': 'North Macedonia', 'SI': 'Slovenia',
  'SK': 'Slovakia', 'UA': 'Ukraine', 'BY': 'Belarus', 'MD': 'Moldova',
  'LT': 'Lithuania', 'LV': 'Latvia', 'EE': 'Estonia', 'IS': 'Iceland',
  'LU': 'Luxembourg', 'MT': 'Malta', 'CY': 'Cyprus', 'PS': 'Palestine',
  'AM': 'Armenia', 'AZ': 'Azerbaijan', 'GE': 'Georgia', 'AD': 'Andorra',
  'MC': 'Monaco', 'LI': 'Liechtenstein', 'SM': 'San Marino', 'VA': 'Vatican City'
};

// IPTV Countries list - 250+ quá»‘c gia vá»›i MÃ£ Quá»‘c Gia (English) + Cá»
router.get('/iptv/countries', async (req, res) => {
  try {
    let countryList = [];
    try {
      const resp = await fetch('https://iptv-org.github.io/api/countries.json', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        const data = await resp.json();
        countryList = data.map(c => ({
          code: c.code.toUpperCase(),
          name: c.name,
          flag: (c.flag && !c.flag.includes('?')) ? c.flag : getCountryFlag(c.code)
        }));
      }
    } catch (e) {
      console.log('[IPTV] Lá»—i fetch countries API, dÃ¹ng fallback:', e.message);
    }

    if (!countryList.length) {
      countryList = Object.entries(countryNames).map(([code, name]) => ({
        code,
        name,
        flag: getCountryFlag(code)
      }));
    }

    // Ghim VN lÃªn Ä‘áº§u, sau Ä‘Ã³ sáº¯p xáº¿p theo TÃªn Quá»‘c Gia (A-Z)
    countryList.sort((a, b) => {
      if (a.code === 'VN') return -1;
      if (b.code === 'VN') return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, count: countryList.length, countries: countryList });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ------------------- OFFICE API: DOCX / PPTX / PDF -------------------

// POST /api/office/generate-docx - Táº¡o file Word tá»« text (Markdown -> DOCX)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// YOUTUBE FREE: Xem YouTube khÃ´ng quáº£ng cÃ¡o â€” nhÆ° Premium free
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 20/9/2026: engine Ä‘Ã£ Ä‘á»•i sang youtube-dl-exec (npm, binary yt-dlp tá»± táº£i lÃºc
// npm install) â€” KHÃ”NG cáº§n Python ná»¯a. Sá»­a lá»—i "YouTube cháº¿t trÃªn Render free".
// FREE-ALL (QA 22/9/2026): YouTube cho khÃ¡ch vÃ£ng lai â€” gá»¡ auth khá»i search/stream/status
// (user yÃªu cáº§u: khÃ´ng cáº§n Ä‘Äƒng nháº­p váº«n xem Ä‘Æ°á»£c). Giá»¯ rateLimit + proxyAuth á»Ÿ /proxy.
router.get('/youtube/status', async (req, res) => {
  try {
    const st = await ytdlp.getStatus();
    res.json({
      success: true,
      ...st,
      ffmpegPath: ffmpegPath || null,
      note: !st.ready ? 'Binary yt-dlp chÆ°a táº£i (npm install láº¡i Ä‘á»ƒ postinstall táº£i binary).' : undefined,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/youtube/search', async (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'Thiáº¿u tá»« khÃ³a (q)' });
  try {
    const result = await searchVideos(q, parseInt(limit, 10) || 12);
    // searchVideos tráº£ { videos: [...] } â€” unwrap Ä‘á»ƒ FE nháº­n array (YouTubeTab.jsx:106)
    res.json({ success: true, videos: Array.isArray(result) ? result : (result.videos || []) });
  } catch (e) {
    console.error('[YouTube] Search error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/youtube/stream', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video khÃ´ng há»£p lá»‡ (chá»‰ há»— trá»£ YouTube).' });
  try {
    const info = await getVideoStream(url);
    res.json({ success: true, ...info });
  } catch (e) {
    console.error('[YouTube] Stream error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// BÃ¬nh luáº­n video â€” láº¥y qua worker (yt-dlp --write-comments, cháº­m 10-30s), cache 24h in-memory.
// YouTube cÃ³ thá»ƒ cháº·n IP Render nÃªn cháº¡y qua worker (IP nhÃ ) nhÆ° /stream.
router.get('/youtube/comments', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video khÃ´ng há»£p lá»‡ (chá»‰ há»— trá»£ YouTube).' });

  if (!globalThis.__ytCommentsCache) globalThis.__ytCommentsCache = new Map();
  const cacheKey = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');
  // Comment local cá»§a app luÃ´n Ä‘á»c fresh tá»« DB (khÃ´ng qua cache yt-dlp)
  const localRows = await dbAll(
    'SELECT id, ten_hien_thi AS author, noi_dung AS text, ngay_tao AS time FROM binh_luan_youtube WHERE video_id = ? ORDER BY ngay_tao DESC LIMIT 50',
    [cacheKey]
  ).catch(() => []);
  const localComments = (localRows || []).map((r) => ({
    id: r.id, author: r.author || 'Báº¡n', text: r.text, likes: 0,
    time: String(r.time || '').substring(0, 10), local: true,
  }));
  const hit = globalThis.__ytCommentsCache.get(cacheKey);
  if (hit && Date.now() - hit.t < 24 * 3600 * 1000) {
    return res.json({ success: true, comments: [...localComments, ...(hit.data.comments || [])], count: hit.data.count, localCount: localComments.length, cached: true });
  }

  try {
    const workerUrl = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
    const workerTok = (process.env.YTDLP_WORKER_TOKEN || '').trim();
    if (!workerUrl) return res.status(503).json({ success: false, error: 'Thiáº¿u worker Ä‘á»ƒ láº¥y bÃ¬nh luáº­n (YTDLP_WORKER_URL).' });
    const resp = await fetch(`${workerUrl}/comments?${workerTok ? `token=${encodeURIComponent(workerTok)}&` : ''}id=${encodeURIComponent(cacheKey)}`, { signal: AbortSignal.timeout(100000) });
    const data = await resp.json();
    if (!data.ok) {
      // Worker thua â†’ váº«n tráº£ comment local (khÃ´ng tráº¯ng trang)
      if (localComments.length) return res.json({ success: true, comments: localComments, count: localComments.length, localCount: localComments.length });
      return res.status(500).json({ success: false, error: data.error || 'Láº¥y bÃ¬nh luáº­n tháº¥t báº¡i.' });
    }
    globalThis.__ytCommentsCache.set(cacheKey, { t: Date.now(), data: { comments: data.comments, count: data.count } });
    res.json({ success: true, comments: [...localComments, ...(data.comments || [])], count: data.count, localCount: localComments.length });
  } catch (e) {
    console.error('[YouTube] Comments error:', e.message);
    // Worker/timeout thua â†’ váº«n tráº£ comment local (khÃ´ng tráº¯ng trang)
    if (localComments.length) return res.json({ success: true, comments: localComments, count: localComments.length, localCount: localComments.length });
    res.status(500).json({ success: false, error: 'Lá»—i láº¥y bÃ¬nh luáº­n: ' + e.message });
  }
});

// Avatar kÃªnh YouTube tháº­t â€” qua worker (yt-dlp trang channel â†’ avatar_uncropped).
// Cache 7 ngÃ y in-memory (avatar hiáº¿m khi Ä‘á»•i). FE hiá»ƒn thá»‹ chá»¯ cÃ¡i trÆ°á»›c,
// swap sang áº£nh tháº­t khi vá» (progressive enhancement nhÆ° YouTube).
if (!globalThis.__ytAvatarCache) globalThis.__ytAvatarCache = new Map();
const YT_AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
router.get('/youtube/channel-avatar', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  let channelId = String(req.query.channel_id || '').trim();
  const videoId = String(req.query.video_id || '').trim();
  // Cache video â†’ channel (24h): resolve qua worker /info cháº­m ~10-22s vÃ  bá»‹ gá»i
  // láº·p láº¡i má»—i láº§n retry/refresh (avatar grid 16 video). Nhá»› map Ä‘á»ƒ láº§n sau ~instant.
  if (!globalThis.__ytVidChannelCache) globalThis.__ytVidChannelCache = new Map();
  const YT_VIDCH_TTL_MS = 24 * 3600 * 1000;
  // Flat search Ä‘Ã´i khi tráº£ channel_id rá»—ng/"NA" â†’ resolve tá»« video page (luÃ´n cÃ³ channel_id)
  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    if (!/^[\w-]{6,}$/.test(videoId)) {
      return res.status(400).json({ success: false, error: 'channel_id khÃ´ng há»£p lá»‡.' });
    }
    const vhit = globalThis.__ytVidChannelCache.get(videoId);
    if (vhit && Date.now() - vhit.t < YT_VIDCH_TTL_MS && /^UC[\w-]{20,}$/.test(vhit.id || '')) {
      channelId = vhit.id;
    } else {
      try {
        const workerUrl0 = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
        const workerTok0 = (process.env.YTDLP_WORKER_TOKEN || '').trim();
        if (!workerUrl0) return res.status(503).json({ success: false, error: 'Thiáº¿u worker.' });
        const ir = await fetch(`${workerUrl0}/info?${workerTok0 ? `token=${encodeURIComponent(workerTok0)}&` : ''}id=${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(45000) });
        const ij = await ir.json().catch(() => null);
        if (ij && ij.ok && /^UC[\w-]{20,}$/.test(ij.channel_id || '')) {
          channelId = ij.channel_id;
          globalThis.__ytVidChannelCache.set(videoId, { t: Date.now(), id: channelId });
          if (globalThis.__ytVidChannelCache.size > 1000) {
            const firstKey = globalThis.__ytVidChannelCache.keys().next().value;
            globalThis.__ytVidChannelCache.delete(firstKey);
          }
        } else {
          return res.status(404).json({ success: false, error: 'KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c kÃªnh cá»§a video.' });
        }
      } catch (e) {
        return res.status(502).json({ success: false, error: 'Lá»—i resolve kÃªnh: ' + e.message });
      }
    }
  }
  const hit = globalThis.__ytAvatarCache.get(channelId);
  if (hit && Date.now() - hit.t < YT_AVATAR_TTL_MS) {
    return res.json({ success: true, ...hit.data, cached: true });
  }
  try {
    const workerUrl = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
    const workerTok = (process.env.YTDLP_WORKER_TOKEN || '').trim();
    if (!workerUrl) return res.status(503).json({ success: false, error: 'Thiáº¿u worker (YTDLP_WORKER_URL).' });
    const resp = await fetch(`${workerUrl}/channel-avatar?${workerTok ? `token=${encodeURIComponent(workerTok)}&` : ''}id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(40000) });
    const data = await resp.json();
    if (!data.ok || !data.avatar_url) return res.status(500).json({ success: false, error: data.error || 'Láº¥y avatar tháº¥t báº¡i.' });
    const out = { channel_id: channelId, avatar_url: data.avatar_url, channel: data.channel || '' };
    globalThis.__ytAvatarCache.set(channelId, { t: Date.now(), data: out });
    if (globalThis.__ytAvatarCache.size > 500) {
      const first = globalThis.__ytAvatarCache.keys().next().value;
      globalThis.__ytAvatarCache.delete(first);
    }
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('[YouTube] Channel-avatar error:', e.message);
    res.status(500).json({ success: false, error: 'Lá»—i láº¥y avatar: ' + e.message });
  }
});

// â”€â”€â”€ BÃ¬nh luáº­n LOCAL (cá»§a app, khÃ´ng cáº§n Google OAuth) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// YouTube Data API Ä‘Ã²i OAuth scope youtube.force-ssl + user re-consent nÃªn
// comment app Ä‘á»ƒ á»Ÿ lá»›p riÃªng: ai cÅ©ng xem/gá»­i Ä‘Æ°á»£c bÃ¬nh luáº­n ngay trong app,
// khÃ´ng phá»¥ thuá»™c tÃ i khoáº£n Google. Comment yt-dlp (GET /comments) + comment
// local hiá»ƒn thá»‹ chung trong tab (local ghim lÃªn Ä‘áº§u, cÃ³ nhÃ£n "trong app").
db.run(`CREATE TABLE IF NOT EXISTS binh_luan_youtube (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  ma_nguoi_dung TEXT NOT NULL,
  ten_hien_thi TEXT,
  noi_dung TEXT NOT NULL,
  ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP
)`, () => {});
db.run('CREATE INDEX IF NOT EXISTS idx_binhluan_video ON binh_luan_youtube (video_id, ngay_tao DESC)', () => {});

// Gá»­i bÃ¬nh luáº­n LÃŠN YOUTUBE THáº¬T qua YouTube Data API (cáº§n Google OAuth scope
// youtube.force-ssl). FE gá»­i cÃ¹ng lÃºc vá»›i comment local; khÃ´ng cÃ³ token liÃªn káº¿t
// thÃ¬ chá»‰ lÆ°u local. Access token háº¿t háº¡n â†’ dÃ¹ng refresh token Ä‘á»ƒ láº¥y má»›i.
router.post('/youtube/comments/youtube', authMiddleware, async (req, res) => {
  try {
    const { url, text } = req.body || {};
    if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video khÃ´ng há»£p lá»‡.' });
    const content = String(text || '').trim().slice(0, 2000);
    if (content.length < 1) return res.status(400).json({ success: false, error: 'BÃ¬nh luáº­n trá»‘ng.' });
    const vid = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');

    const { decryptKey } = require('../utils/cryptoKeys');
    const row = await dbGet(
      'SELECT access_token, refresh_token, scope FROM google_oauth_tokens WHERE ma_nguoi_dung = ?',
      [req.user.id]
    ).catch(() => null);
    const hasScope = row && String(row.scope || '').includes('youtube.force-ssl');
    if (!row || !hasScope) {
      return res.status(409).json({ success: false, error: 'NO_YOUTUBE_SCOPE', message: 'ChÆ°a liÃªn káº¿t quyá»n YouTube (Ä‘Äƒng nháº­p Google láº¡i, tick Ã´ YouTube).' });
    }
    let access = decryptKey(row.access_token);
    const doPost = (tok) => fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { videoId: vid, topLevelComment: { snippet: { textOriginal: content } } } }),
      signal: AbortSignal.timeout(30000),
    });
    let r = await doPost(access);
    if (r.status === 401 && row.refresh_token) {
      // Access háº¿t háº¡n â†’ refresh rá»“i thá»­ láº¡i 1 láº§n
      const rt = decryptKey(row.refresh_token);
      const tk = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.VITE_GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: rt,
          grant_type: 'refresh_token',
        }),
      }).then((x) => x.json()).catch(() => ({}));
      if (!tk.access_token) return res.status(401).json({ success: false, error: 'Token Google háº¿t háº¡n, vui lÃ²ng Ä‘Äƒng nháº­p Google láº¡i.' });
      const { encryptKey } = require('../utils/cryptoKeys');
      access = tk.access_token;
      await dbRun('UPDATE google_oauth_tokens SET access_token = ?, ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_nguoi_dung = ?', [encryptKey(access), req.user.id]).catch(() => {});
      r = await doPost(access);
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ success: false, error: `YouTube tá»« chá»‘i (HTTP ${r.status}). ${detail.substring(0, 180)}` });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[YouTube] Comment-to-YouTube error:', e.message);
    res.status(500).json({ success: false, error: 'Lá»—i gá»­i bÃ¬nh luáº­n lÃªn YouTube: ' + e.message });
  }
});
router.post('/youtube/comments/local', authMiddleware, async (req, res) => {
  try {
    const { url, text } = req.body || {};
    if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video khÃ´ng há»£p lá»‡.' });
    const content = String(text || '').trim().slice(0, 2000);
    if (content.length < 1) return res.status(400).json({ success: false, error: 'BÃ¬nh luáº­n trá»‘ng.' });
    const vid = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const me = req.user || {};
    const uid = me.ma_nguoi_dung || me.id || 'guest';
    // JWT chá»‰ chá»©a {id, role} â€” JWT payload khÃ´ng cÃ³ ten_day_du/email â†’ tra DB theo ma_nguoi_dung
    let tenHienThi = me.ten_day_du || me.email || '';
    if (!tenHienThi && uid !== 'guest') {
      try {
        const u = await dbGet('SELECT ten_day_du, email FROM nguoi_dung WHERE ma_nguoi_dung = ?', [uid]);
        if (u) tenHienThi = u.ten_day_du || u.email || '';
      } catch { /* giá»¯ fallback */ }
    }
    tenHienThi = tenHienThi || 'Báº¡n';
    await dbRun(
      'INSERT INTO binh_luan_youtube (id, video_id, ma_nguoi_dung, ten_hien_thi, noi_dung) VALUES (?, ?, ?, ?, ?)',
      [id, vid, uid, tenHienThi, content]
    );
    res.json({ success: true, comment: { id, author: tenHienThi, text: content, likes: 0, time: new Date().toISOString().substring(0, 10), local: true } });
  } catch (e) {
    console.error('[YouTube] Local comment error:', e.message);
    res.status(500).json({ success: false, error: 'Lá»—i gá»­i bÃ¬nh luáº­n: ' + e.message });
  }
});

// â”€â”€â”€ CLASSROOM PROXY (OpenMAIC) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// open.maic.chat Cáº¤M iframe (X-Frame-Options: SAMEORIGIN + CSP frame-ancestors
// 'self' â€” Ä‘Ã£ verify báº±ng curl) â†’ iframe trá»±c tiáº¿p KHÃ”NG BAO GIá»œ load Ä‘Æ°á»£c.
// Proxy qua backend: strip frame headers + rewrite URL vá» /api/classroom/*.
// YÃªu cáº§u Ä‘Äƒng nháº­p (token qua Authorization header hoáº·c ?token= â€” iframe khÃ´ng
// gá»­i Ä‘Æ°á»£c header). RateLimit cao vÃ¬ app Next.js táº£i nhiá»u chunk/API.
const MAIC_UPSTREAM = 'https://open.maic.chat';

async function classroomAuth(req) {
  try {
    const jwt = require('jsonwebtoken');
    const { getJWTSecret } = require('../middleware/auth.middleware');
    let token = '';
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);
    if (!token && req.query.token) token = String(req.query.token);
    if (!token) return null;
    return jwt.verify(token, getJWTSecret());
  } catch { return null; }
}

router.use('/classroom', rateLimit({ windowMs: 60000, max: 300 }), async (req, res) => {
  const user = await classroomAuth(req);
  if (!user) return res.status(401).send('Unauthorized â€” vui lÃ²ng Ä‘Äƒng nháº­p Rexi AI Ä‘á»ƒ dÃ¹ng Lá»›p Há»c AI.');

  // subpath sau /api/classroom (Express 5 Ä‘Ã£ strip mount point khá»i req.url)
  let sub = req.url || '/';
  if (!sub.startsWith('/')) sub = '/' + sub;
  const targetUrl = MAIC_UPSTREAM + sub;

  const base = `${req.protocol}://${req.get('host')}/api/services/classroom`;

  try {
    // Forward headers (bá» host/connection/content-length â€” fetch tá»± tÃ­nh)
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'content-length'].includes(lk)) continue;
      fwdHeaders[k] = v;
    }
    fwdHeaders['host'] = 'open.maic.chat';
    fwdHeaders['origin'] = MAIC_UPSTREAM;
    fwdHeaders['referer'] = MAIC_UPSTREAM + '/';

    // Body: JSON/urlencoded Ä‘Ã£ parse sáºµn â†’ serialize láº¡i; cÃ²n láº¡i (multipart/binary) stream raw
    let body;
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const method = (req.method || 'GET').toUpperCase();
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length) {
      if (ct.includes('json')) body = JSON.stringify(req.body);
      else if (ct.includes('urlencoded')) body = new URLSearchParams(req.body).toString();
    }
    if (body === undefined && !['GET', 'HEAD'].includes(method)) body = req;

    const upstream = await fetch(targetUrl, {
      method,
      headers: fwdHeaders,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(120000),
    });

    // Redirect: rewrite Location vá» proxy (khÃ´ng auto-follow Ä‘á»ƒ browser Ä‘i Ä‘Ãºng Ä‘Æ°á»ng proxy)
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const abs = new URL(loc, MAIC_UPSTREAM).toString();
        const proxied = abs.startsWith(MAIC_UPSTREAM) ? base + abs.slice(MAIC_UPSTREAM.length) : abs;
        res.status(upstream.status).set('location', proxied).end();
        return;
      }
    }

    // Copy headers â€” TRá»ª frame-blocking (cho phÃ©p iframe) + hop-by-hop
    const dropHeaders = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-length', 'transfer-encoding', 'connection', 'content-encoding']);
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (dropHeaders.has(lk) || lk === 'set-cookie') return;
      try { res.setHeader(k, v); } catch (e) { /* header khÃ´ng há»£p lá»‡ â€” bá» qua */ }
    });
    // Cookies: forward, strip Domain (thÃ nh host-only = domain mÃ¬nh) + scope Path vá» /api/services/classroom
    const getSetCookie = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    for (const sc of getSetCookie) {
      let fixed = String(sc).replace(/;\s*domain=[^;]*/i, '').replace(/;\s*[Pp]ath=\/(?=;|$)/, '; Path=/api/services/classroom');
      try { res.append('set-cookie', fixed); } catch (e) { /* bá» qua */ }
    }
    // Náº¿u upstream váº«n cháº·n frame báº±ng CSP khÃ¡c (report-only Ä‘Ã£ strip) â€” Ã©p thÃªm header má»Ÿ.
    // QUAN TRá»ŒNG: helmet cá»§a chÃ­nh backend mÃ¬nh gáº¯n X-Frame-Options: SAMEORIGIN lÃªn
    // Má»ŒI response â†’ pháº£i gá»¡ á»Ÿ Ä‘Ã¢y, náº¿u khÃ´ng iframe váº«n bá»‹ cháº·n.
    res.removeHeader('x-frame-options');
    res.setHeader('content-security-policy', "frame-ancestors 'self' https://rexiai.bot.cd https://www.rexiai.bot.cd https://rexiai.de5.net https://*.vercel.app http://localhost:*");

    const rct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (rct.includes('text/html')) {
      let html = await upstream.text();
      // Tuyá»‡t Ä‘á»‘i vá» upstream â†’ vá» proxy
      html = html.split(MAIC_UPSTREAM).join(base);
      // Root-absolute trong attributes (Next.js dÃ¹ng /_next/, /api/, /favicon...)
      html = html.replace(/(src|href|action|srcset|content|data-src)="\/([^\/"])/g, `$1="${base}/$2`);
      html = html.replace(/(src|href|action|srcset|content|data-src)='\/([^\/'])/g, `$1='${base}/$2`);
      html = html.replace(/url\(\s*\/(?!\/)/g, `url(${base}/`);
      // JS string literals gá»i API cÃ¹ng origin: fetch("/api/..."), "/_next/..." â†’ vá» proxy
      html = html.replace(/"\/api\//g, `"${base}/api/`);
      html = html.replace(/'\/api\//g, `'${base}/api/`);
      html = html.replace(/`\/api\//g, `\`${base}/api/`);
      html = html.replace(/"\/_next\//g, `"${base}/_next/`);
      html = html.replace(/'\/_next\//g, `'${base}/_next/`);
      // Boot-script (inject CUá»I Ä‘á»ƒ regex rewrite á»Ÿ trÃªn khÃ´ng cháº¡m vÃ o nÃ³):
      // Next.js render link/fetch lÃºc runtime báº±ng path root-absolute ("/home", fetch("/api/..."))
      // â†’ trÃ¬nh duyá»‡t resolve vá» domain mÃ¬nh, THOÃT proxy. Patch fetch/XHR/click/history/EventSource
      // Ä‘á»ƒ má»i request cÃ¹ng-origin Ä‘i qua /api/services/classroom.
      const BOOT = `<script>(function(){var P='/api/services/classroom';function fix(u){if(typeof u!=='string')return u;if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){if(u.indexOf('/api/')===0||u.indexOf('/_next/')===0||u.indexOf('/favicon')===0||u.indexOf('/manifest')===0||u.indexOf('/robots')===0)return P+u;}return u;}try{var _f=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=fix(i);else if(i&&i.url){try{i=new Request(fix(i.url),i);}catch(e){}}return _f.call(this,i,n);};var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')u=fix(u);return _o.call(this,m,u);};document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href');if(h&&h.charAt(0)==='/'&&h.charAt(1)!=='/'&&h.indexOf('/api/services/classroom')!==0){e.preventDefault();e.stopPropagation();window.location.assign(P+h);}},true);['pushState','replaceState'].forEach(function(k){var _h=history[k];history[k]=function(s,t,u){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf('/api/services/classroom')!==0)u=P+u;return _h.call(this,s,t,u);};});if(window.EventSource){var _E=window.EventSource;window.EventSource=function(u,c){if(typeof u==='string')u=fix(u);return new _E(u,c);};window.EventSource.prototype=_E.prototype;}}catch(e){}})();<\/script>`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + BOOT);
      else html = BOOT + html;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    // CÃ²n láº¡i (JS/CSS/API JSON/streaming/SSE/áº£nh...) pipe trá»±c tiáº¿p
    res.status(upstream.status);
    if (upstream.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error('[Classroom] Proxy error:', targetUrl, e.message);
    res.status(502).json({ success: false, error: 'Lá»—i proxy Lá»›p Há»c AI: ' + e.message });
  }
});

// Proxy stream video (chá»‘ng CORS + SSRF) â€” copy pattern tá»« iptv/proxy
router.get('/youtube/proxy', rateLimit({ windowMs: 60000, max: 120 }), youtubeProxyAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    // P2-18: check async (literal + DNS resolve) thay vÃ¬ isPrivateHostname sync
    const check = await assertPublicUrlAsync(targetUrl);
    if (!check.ok) {
      const code = (check.reason === 'URL khÃ´ng há»£p lá»‡' || check.reason === 'Chá»‰ cho phÃ©p http/https') ? 400 : 403;
      return res.status(code).json({ error: check.reason });
    }
    // 4/10 FREE-ALL: khÃ¡ch (khÃ´ng qua authMiddleware) chá»‰ Ä‘Æ°á»£c proxy host media Ä‘Ã£ biáº¿t
    if (!req.user) {
      let host = '';
      try { host = new URL(targetUrl).hostname; } catch (e) { /* fallthrough 400 dÆ°á»›i */ }
      if (!ytdlp.isYouTubeProxyHost(host)) {
        return res.status(403).json({ error: 'KhÃ¡ch vÃ£ng lai chá»‰ phÃ¡t Ä‘Æ°á»£c luá»“ng YouTube (Ä‘Äƒng nháº­p Ä‘á»ƒ má»Ÿ rá»™ng).' });
      }
    }
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  try {
    let effectiveUrl = targetUrl;
    // Giá»¯ Range Ä‘á»ƒ player seek Ä‘Æ°á»£c (trÆ°á»›c Ä‘Ã¢y bá» qua â†’ táº£i NGUYÃŠN video vÃ o RAM,
    // video dÃ i trÃªn Render free dá»… OOM/502). Timeout dÃ i vÃ¬ cáº§n stream cáº£ video.
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
    };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;
    let upstream;
    for (let hop = 0; hop <= 5; hop++) {
      upstream = await fetch(effectiveUrl, {
        redirect: 'manual',
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(600000)
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        const nextUrl = new URL(upstream.headers.get('location'), effectiveUrl).toString();
        const hopCheck = await assertPublicUrlAsync(nextUrl);
        if (!hopCheck.ok) {
          return res.status(403).json({ error: 'Internal network access is not allowed (redirect)' });
        }
        effectiveUrl = nextUrl;
        continue;
      }
      break;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/octet-stream');
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.status(upstream.status);

    // 4/10: playlist m3u (YouTube LIVE chá»‰ cÃ³ HLS, khÃ´ng cÃ³ mp4 progressive) â†’
    // rewrite URL segment â†’ tuyá»‡t Ä‘á»‘i qua proxy nÃ y. googlevideo khÃ´ng cÃ³ CORS,
    // trÃ¬nh duyá»‡t fetch segment trá»±c tiáº¿p bá»‹ cháº·n â€” copy pattern iptv/proxy.
    const _ctYt = (upstream.headers.get('content-type') || '').toLowerCase();
    if (_ctYt.includes('mpegurl') || effectiveUrl.toLowerCase().includes('/hls_playlist/') || effectiveUrl.toLowerCase().endsWith('.m3u8')) {
      let body = await upstream.text();
      if (body.includes('\r\n')) body = body.replace(/\r\n/g, '\n');

      const baseYt = effectiveUrl.substring(0, effectiveUrl.lastIndexOf('/') + 1);
      let originYt = '';
      try { originYt = new URL(effectiveUrl).origin; } catch (e) { /* segment relative giá»¯ nguyÃªn base */ }
      const toAbsoluteYt = (u) => {
        if (/^https?:\/\//i.test(u)) return u;
        if (u.startsWith('/') && originYt) return originYt + u;
        return baseYt + u;
      };
      // Giá»¯ ?token= cho segment con (guest auth qua allowlist host googlevideo/worker)
      const qsTokenYt = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';
      // Segment googlevideo bá»‹ IP-lock theo IP yÃªu cáº§u â€” PHáº¢I fetch qua worker (IP nhÃ );
      // BE proxy (IP Render) fetch trá»±c tiáº¿p sáº½ 403. Fallback BE proxy náº¿u thiáº¿u worker env.
      const workerUrlYt = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
      const workerTokYt = (process.env.YTDLP_WORKER_TOKEN || '').trim();
      const toProxyYt = (u) => {
        if (workerUrlYt) {
          return `${workerUrlYt}/stream?${workerTokYt ? `token=${encodeURIComponent(workerTokYt)}&` : ''}url=${encodeURIComponent(toAbsoluteYt(u))}`;
        }
        return `${req.protocol}://${req.get('host')}/api/services/youtube/proxy?url=${encodeURIComponent(toAbsoluteYt(u))}${qsTokenYt}`;
      };
      // 1) Rewrite dÃ²ng URI thÆ°á»ng (segment, variant playlist)
      body = body.replace(/^(?!#)([^\r\n]+)$/gm, (line) => {
        line = line.trim();
        if (!line) return line;
        return toProxyYt(line);
      });
      // 2) Rewrite URI TRONG #EXT-X-MAP / #EXT-X-KEY / #EXT-X-MEDIA (init segment, key, rendition)
      body = body.replace(/^(#EXT-X-(?:MAP|KEY|MEDIA)):([^\r\n]*)$/gim, (whole, tag, attrs) => {
        return tag + ':' + attrs.replace(/URI="([^"]*)"/gi, (m, u) => `URI="${toProxyYt(u)}"`);
      });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(body);
    }

    if (!upstream.body) return res.end();
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', (e) => {
      console.error('[YouTube Proxy] stream error:', e.message);
      try { res.destroy(); } catch (_) {}
    });
    res.on('close', () => { try { nodeStream.destroy(); } catch (_) {} });
    return nodeStream.pipe(res);
  } catch (err) {
    console.error('[YouTube Proxy] Error:', err.message);
    return res.status(502).json({ error: 'Proxy upstream error: ' + err.message });
  }
});

// TÃ“M Táº®T VIDEO AI: táº£i audio â†’ Groq Whisper (STT) â†’ Groq LLM â†’ Markdown
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TÃ³m táº¯t má»™t video YouTube chá»‰ báº±ng 1 cÃ¢u há»i. DÃ¢y chuyá»n:
//   yt-dlp (audio mp3) â†’ Groq whisper-large-v3 (transcript) â†’ llama-3.3-70b (tÃ³m táº¯t VN)
// TÃ“M Táº®T VIDEO AI: táº£i audio â†’ STT (Groq Whisper â†’ fallback Gemini) â†’ LLM (Groq â†’ fallback Gemini)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TÃ³m táº¯t má»™t video YouTube chá»‰ báº±ng 1 cÃ¢u há»i. DÃ¢y chuyá»n:
//   yt-dlp (audio mp3 â‰¤10 phÃºt) â†’ Groq whisper-large-v3 / Gemini (transcript) â†’ LLM (tÃ³m táº¯t VN)
// Chá»‰ cho phÃ©p URL YouTube há»£p lá»‡ â€” cháº·n file:// (Ä‘á»c file cá»¥c bá»™!), SSRF, host ná»™i bá»™
function isValidYouTubeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  // Video ID thuáº§n (11 kÃ½ tá»±) â€” dÃ¹ng phá»• biáº¿n trong app
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return true;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  if (isPrivateHostname(u.hostname)) return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    return /^\/[A-Za-z0-9_-]{11}/.test(u.pathname);
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return /^\/(watch|shorts|live|embed)\b/.test(u.pathname);
  }
  return false;
}

function buildSummaryPrompt(text) {
  return `Báº¡n lÃ  chuyÃªn gia tÃ³m táº¯t video chuyÃªn nghiá»‡p. DÆ°á»›i Ä‘Ã¢y lÃ  transcript (lá»i thoáº¡i) cá»§a má»™t video YouTube. HÃ£y tÃ³m táº¯t báº±ng TIáº¾NG VIá»†T theo Ä‘Ãºng Ä‘á»‹nh dáº¡ng Markdown sau (chá»‰ tráº£ ná»™i dung, khÃ´ng thÃªm lá»i dáº«n):

# ðŸ“ TÃ³m táº¯t video

## ðŸŽ¯ Ã chÃ­nh
- <3-5 gáº¡ch Ä‘áº§u dÃ²ng nÃªu ná»™i dung cá»‘t lÃµi>

## ðŸ“Œ Äiá»ƒm ná»•i báº­t
- <cÃ¡c thÃ´ng tin/quan Ä‘iá»ƒm quan trá»ng>

## ðŸ’¡ Káº¿t luáº­n / BÃ i há»c
- <káº¿t luáº­n rÃºt ra tá»« video>

Transcript:
"""
${text.slice(0, 20000)}
"""`;
}

// STT qua Groq Whisper (cÃ³ timeout 90s â€” trÃ¡nh treo vÃ´ háº¡n khi Groq báº­n)
async function transcribeWithGroq(groq, audioPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: await Groq.toFile(
        fs.createReadStream(audioPath),
        path.basename(audioPath),
        { type: 'audio/mpeg' }
      ),
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
    }, { signal: controller.signal });
    return {
      text: String(transcription?.text || '').trim(),
      segments: Array.isArray(transcription?.segments)
        ? transcription.segments.map(s => ({
            start: Number(s.start || 0),
            end: Number(s.end || 0),
            text: String(s.text || '').trim()
          }))
        : []
    };
  } finally {
    clearTimeout(timer);
  }
}

// Chuyá»ƒn segments -> ná»™i dung file SRT (phá»¥ Ä‘á» timestamp chuáº©n)
function segmentsToSrt(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), secs = s % 60;
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return segments.map((seg, i) => {
    const text = (seg.text || '').trim();
    if (!text) return null;
    return `${i + 1}\n${fmt(seg.start)} --> ${fmt(seg.end)}\n${text}`;
  }).filter(Boolean).join('\n\n');
}

// STT qua Gemini (fallback khi Groq lá»—i/háº¿t quota)
async function transcribeWithGemini(genAI, audioPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const b64 = fs.readFileSync(audioPath).toString('base64');
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mpeg', data: b64 } },
          { text: 'HÃ£y chuyá»ƒn toÃ n bá»™ lá»i thoáº¡i trong audio nÃ y thÃ nh vÄƒn báº£n. Chá»‰ tráº£ vá» vÄƒn báº£n lá»i thoáº¡i, khÃ´ng thÃªm gÃ¬ khÃ¡c.' }
        ]
      }]
    }, { signal: controller.signal });
    return String(result.response.text() || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

// TÃ³m táº¯t báº±ng Groq (thá»­ nhiá»u model â€” model cÃ³ thá»ƒ bá»‹ Groq gá»¡ báº¥t cá»© lÃºc nÃ o)
const GROQ_SUMMARY_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
async function summarizeWithGroq(groq, text) {
  if (!groq) return '';
  for (const m of GROQ_SUMMARY_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await groq.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: buildSummaryPrompt(text) }],
        temperature: 0.4,
        max_tokens: 1800,
      }, { signal: controller.signal });
      const out = String(res?.choices?.[0]?.message?.content || '').trim();
      if (out) return out;
    } catch (e) {
      console.error('[YouTube] Groq LLM summarize error (' + m + '):', e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

// TÃ³m táº¯t báº±ng xkiro (náº¥c cuá»‘i â€” key trong DB, Ä‘Ã£ dÃ¹ng á»•n cho quickSummarize)
async function summarizeWithXkiro(text) {
  try {
    const row = await new Promise((res) => db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'xkiro' LIMIT 1", [], (err, r) => res(r)));
    if (!row || !row.gia_tri_khoa) return '';
    let key = row.gia_tri_khoa;
    try { key = decryptKey(key).trim(); } catch { key = String(key).trim(); }
    if (!key) return '';
    const r = await fetch('https://api.xkiro.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'mistralai/ministral-8b',
        messages: [{ role: 'user', content: buildSummaryPrompt(text) }],
        temperature: 0.4,
        max_tokens: 1800
      }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    return String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  } catch (e) {
    console.error('[YouTube] xkiro summarize error:', e.message);
    return '';
  }
}

// TÃ³m táº¯t báº±ng Gemini (fallback)
async function summarizeWithGemini(genAI, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(buildSummaryPrompt(text), { signal: controller.signal });
    return String(result.response.text() || '').trim();
  } catch (e) {
    console.error('[YouTube] Gemini LLM summarize error:', e.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// FREE-ALL: tÃ³m táº¯t AI má»Ÿ cho guest (rateLimit Ä‘Ã£ cháº·n abuse)
router.post('/youtube/summarize', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ success: false, error: 'URL/ID video khÃ´ng há»£p lá»‡ (chá»‰ há»— trá»£ YouTube).' });
  }

  let audioPath = null;
  try {
    // TÃªn file duy nháº¥t â€” trÃ¡nh Ä‘á»¥ng nhau giá»¯a 2 request Ä‘á»“ng thá»i
    const outPath = path.join(tempDir, `ytsum_${Date.now()}_${Math.random().toString(36).slice(2)}`);

    const groq = await getGroqClient();
    if (!groq) {
      return res.status(503).json({
        success: false,
        error: 'CHUA_CO_KEY',
        message: 'Cáº§n GROQ_API_KEY trong báº£ng khoa_api Ä‘á»ƒ dÃ¹ng TÃ³m táº¯t AI.'
      });
    }

    // â”€â”€ BÆ°á»›c 0: Captions-first (manual subs qua worker /subs) â€” chuáº©n 100%,
    // auto-captions kÃ©m Whisper trÃªn nháº¡c. CÃ³ manual subs â†’ skip download+STT.
    let videoTitle = '';
    let transcript = '';
    let sttSource = '';
    let srt = '';
    try {
      const vid0 = ytdlp.extractVideoId(url);
      if (vid0) {
        const cap = await ytdlp.fetchCaptionsSrt(vid0);
        if (cap && cap.srt) {
          srt = cap.srt;
          transcript = ytdlp.transcriptFromSrt(srt);
          videoTitle = cap.title || '';
          sttSource = 'captions:' + (cap.lang || 'en');
        }
      }
    } catch (e) {
      console.log('[YouTube] captions-first fail, fallback STT:', e.message);
    }

    if (!transcript) {
      const dl = await downloadAudio(url, outPath);
      audioPath = dl && dl.file;

      if (!audioPath || !fs.existsSync(audioPath)) {
        return res.status(500).json({ success: false, error: 'KhÃ´ng táº£i Ä‘Æ°á»£c audio cá»§a video. Thá»­ video khÃ¡c.' });
      }

      // â”€â”€ BÆ°á»›c 1: Nháº­n diá»‡n giá»ng nÃ³i (Groq â†’ fallback Gemini) â”€â”€
      try {
        const groqRes = await transcribeWithGroq(groq, audioPath);
        transcript = groqRes.text;
        srt = segmentsToSrt(groqRes.segments);
        sttSource = 'groq';
      } catch (e) {
        console.log('[YouTube] Groq STT fail, fallback Gemini:', e.message);
      }
      if (!transcript) {
        const gemini = await getGeminiClient(); // láº¥y lazily â€” chá»‰ khi cáº§n fallback
        if (gemini) {
          try {
            transcript = await transcribeWithGemini(gemini, audioPath);
            sttSource = 'gemini';
          } catch (e2) {
            console.error('[YouTube] Gemini STT fail:', e2.message);
          }
        }
      }
      if (!transcript) {
        return res.status(502).json({ success: false, error: 'KhÃ´ng nháº­n diá»‡n Ä‘Æ°á»£c giá»ng nÃ³i (cáº£ Groq láº«n Gemini Ä‘á»u lá»—i). Thá»­ video khÃ¡c.' });
      }
      if (!videoTitle) videoTitle = dl?.title || '';
    }

    // Dá»n artifact cho Cáº¢ 2 nguá»“n (captions/STT): collapse spaces + dÃ²ng láº·p
    transcript = ytdlp.cleanTranscriptText(transcript);
    srt = ytdlp.cleanSrtArtifacts(srt);

    // â”€â”€ BÆ°á»›c 2: TÃ³m táº¯t báº±ng LLM (Groq â†’ fallback Gemini) â”€â”€
    // P1-11: summarizeWithGroq lÃ  async â†’ pháº£i await, bá»c try/catch, validate string
    let summary = '';
    try {
      summary = await summarizeWithGroq(groq, transcript);
    } catch (e) {
      console.error('[YouTube] Groq summarize throw:', e.message);
      summary = '';
    }
    if (typeof summary !== 'string') summary = '';
    if (!summary) {
      try {
        const gemini = await getGeminiClient();
        if (gemini) summary = await summarizeWithGemini(gemini, transcript);
      } catch (e) {
        console.error('[YouTube] Gemini summarize throw:', e.message);
      }
      if (typeof summary !== 'string') summary = '';
    }
    if (!summary) {
      try {
        summary = await summarizeWithXkiro(transcript);
      } catch (e) {
        console.error('[YouTube] xkiro summarize throw:', e.message);
      }
      if (typeof summary !== 'string') summary = '';
    }

    res.json({ success: true, title: videoTitle, transcript, summary, srt, stt_source: sttSource });
  } catch (err) {
    console.error('[YouTube] Summarize error:', err.message);
    // Lá»—i cÃ³ nguyÃªn nhÃ¢n rÃµ (bot-check, thiáº¿u key, audio lá»—i) â†’ tráº£ tháº³ng message
    // thay vÃ¬ 500 chung chung Ä‘á»ƒ user biáº¿t Ä‘Æ°á»ng xá»­ lÃ½.
    const known = /^(YouTube Ä‘ang cháº·n|KhÃ´ng táº£i Ä‘Æ°á»£c audio|KhÃ´ng tÃ¬m tháº¥y file mp3|Thiáº¿u URL\/ID|Thiáº¿u Ä‘Æ°á»ng dáº«n|worker audio|ffmpeg)/.test(err.message || '');
    if (known) return res.status(502).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: 'Lá»—i tÃ³m táº¯t video. Vui lÃ²ng thá»­ láº¡i.' });
  } finally {
    // Dá»n Ä‘Ãºng file cá»§a request nÃ y (khÃ´ng Ä‘á»¥ng file cá»§a request khÃ¡c)
    if (audioPath && fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }
    }
  }
});

// â”€â”€â”€ TIKTOK FEED (xem dá»c + lá»c chá»§ Ä‘á», AI nhÃ¬n hÃ¬nh tá»± lÆ°á»›t) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tiktokService = require('../services/tiktokService');
const chatExecutor = require('../services/chatExecutor');

// Feed: "DÃ nh cho báº¡n" (foryou=1, nÃªn kÃ¨m session Ä‘Äƒng nháº­p) / @user / #hashtag.
// CÃ o lÃ¢u (tá»›i ~90s) nÃªn gá»­i nhá»‹p giá»¯ káº¿t ná»‘i má»—i 10s (proxy cáº¯t khi im láº·ng quÃ¡ lÃ¢u).
router.get('/tiktok/feed', rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const giuKetNoi = setInterval(() => { try { res.write(' '); } catch (e) {} }, 10000);
  try {
    const data = await tiktokService.fetchFeed({
      user: req.query.user,
      tag: req.query.tag,
      foryou: req.query.foryou,
      session: req.query.session,
      limit: req.query.limit,
    });
    clearInterval(giuKetNoi);
    res.end(JSON.stringify({ success: true, ...data }));
  } catch (e) {
    clearInterval(giuKetNoi);
    console.error('[TikTok] feed error:', (e.message || e).toString().slice(0, 200));
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(JSON.stringify({ success: false, error: (e.message || 'TikTok feed lá»—i').toString().slice(0, 300) }));
    } else {
      try { res.end(JSON.stringify({ success: false, error: (e.message || 'TikTok feed lá»—i').toString().slice(0, 300) })); } catch (e2) {}
    }
  }
});

// Proxy stream playAddr (CDN TikTok cháº·n hotlink thiáº¿u Referer; FE cÅ©ng cáº§n cÃ¹ng origin cho canvas)
router.get('/tiktok/stream', rateLimit({ windowMs: 60000, max: 400 }), async (req, res) => {
  const target = String(req.query.u || '');
  if (!/^https:\/\//.test(target) || !/tiktok(?:cdn|v16|v19|\.com)/i.test(target)) {
    return res.status(400).json({ success: false, error: 'URL khÃ´ng há»£p lá»‡' });
  }
  try {
    const upstream = await fetch(target, {
      headers: tiktokService.streamHeaders(req.headers.range ? { Range: req.headers.range } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: `CDN TikTok tráº£ ${upstream.status} â€” báº¥m táº£i láº¡i feed (playAddr háº¿t háº¡n)` });
    }
    res.status(upstream.status);
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, error: (e.message || 'stream lá»—i').toString().slice(0, 200) });
  }
});

// ÄÆ°á»ng phÃ¡t chÃ­nh: giáº£i link qua tikwm rá»“i pipe vá» FE (CDN TikTok cháº·n IP mÃ¡y nÃ y â†’ 403).
// Náº¿u cÃ³ session Ä‘Äƒng nháº­p + playAddr gá»‘c (u): thá»­ táº£i trá»±c tiáº¿p báº±ng cookie nick tháº­t
// trÆ°á»›c (CDN ná»›i tay hÆ¡n), rá»›t má»›i qua tikwm.
// FE gá»i: /tiktok/media?id=<videoId>&user=<tÃ¡c giáº£>&u=<playAddr, cÃ³ thÃ¬ tá»‘t>&session=<token>
router.get('/tiktok/media', rateLimit({ windowMs: 60000, max: 400 }), async (req, res) => {
  const id = String(req.query.id || '').trim();
  const author = String(req.query.user || req.query.author || '').trim();
  if (!/^\d{10,25}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Thiáº¿u id video' });
  }
  const playAddr = String(req.query.u || '');
  const ses = await tiktokService.getSession(req.query.session);
  const pipeVe = async (upstream) => {
    res.status(upstream.status);
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=7200');
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  };
  try {
    // 1. Nick tháº­t â†’ CDN trá»±c tiáº¿p
    if (ses && /^https:\/\//.test(playAddr)) {
      try {
        const truc = await tiktokService.fetchDirect(playAddr, ses.cookieString, req.headers.range);
        return await pipeVe(truc);
      } catch (e) {
        console.warn('[TikTok] media trá»±c tiáº¿p lá»—i, qua tikwm:', (e.message || e).toString().slice(0, 100));
      }
    }
    // 2. BÃªn trung gian tikwm
    const entry = await tiktokService.resolvePlayUrl(id, author);
    const upstream = await fetch(entry.url, {
      headers: tiktokService.streamHeaders(req.headers.range ? { Range: req.headers.range } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: `Nguá»“n phÃ¡t tráº£ ${upstream.status} â€” thá»­ video khÃ¡c` });
    }
    return await pipeVe(upstream);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, error: (e.message || 'media lá»—i').toString().slice(0, 200) });
  }
});

// Táº¡o phiÃªn Ä‘Äƒng nháº­p TikTok tá»« cookie user copy (document.cookie trÃªn tiktok.com).
// FE giá»¯ token trong localStorage, gá»­i kÃ¨m feed/media Ä‘á»ƒ lÆ°á»›t nick tháº­t.
router.post('/tiktok/session', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const data = await tiktokService.createSession((req.body || {}).cookies);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(400).json({ success: false, error: (e.message || 'session lá»—i').toString().slice(0, 200) });
  }
});

// ÄÄƒng nháº­p báº±ng QR: start â†’ {loginId} (má»Ÿ browser ná»n, chá»¥p QR); FE hiá»‡n QR,
// poll status má»—i 3s â†’ done kÃ¨m {token} phiÃªn nick tháº­t.
router.post('/tiktok/qr/start', rateLimit({ windowMs: 60000, max: 120 }), async (req, res) => {
  try {
    const data = await tiktokService.startLogin();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(502).json({ success: false, error: (e.message || 'khÃ´ng má»Ÿ Ä‘Æ°á»£c QR').toString().slice(0, 200) });
  }
});
router.get('/tiktok/qr/status', rateLimit({ windowMs: 60000, max: 120 }), async (req, res) => {
  const st = tiktokService.loginStatus(req.query.loginId);
  if (req.query.anh !== '1') delete st.anhTrangThai;
  res.json({ success: true, ...st });
});

// AI nhÃ¬n frame â†’ video cÃ³ khá»›p chá»§ Ä‘á» user muá»‘n khÃ´ng? (vision route cá»§a modelRouter)
router.post('/tiktok/classify', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  const { image, topics, caption } = req.body || {};
  if (!image || !/^data:image\/(png|jpe?g|webp);base64,/.test(String(image))) {
    return res.status(400).json({ success: false, error: 'Thiáº¿u frame (data:image/*;base64)' });
  }
  const topicList = (Array.isArray(topics) ? topics : String(topics || '').split(/[,;\n]/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  if (!topicList.length) {
    return res.json({ success: true, match: true, reason: 'ChÆ°a Ä‘áº·t chá»§ Ä‘á»' });
  }
  const candidates = [
    { provider: 'gemini', model: 'models/gemini-3-flash-preview' },
    { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
    { provider: 'nvidia', model: 'google/gemma-4-31b-it' },
  ];
  const systemPrompt = 'Báº¡n lÃ  bá»™ lá»c ná»™i dung video ngáº¯n. Chá»‰ tráº£ Ä‘Ãºng 1 dÃ²ng JSON, KHÃ”NG thÃªm chá»¯ nÃ o khÃ¡c: {"match": true|false, "reason": "tá»‘i Ä‘a 12 tá»«"}';
  const userMsg = `![frame](${image})\nNgÆ°á»i xem CHá»ˆ muá»‘n xem cÃ¡c chá»§ Ä‘á»: ${topicList.join(', ')}.\nCaption video: ${String(caption || '(khÃ´ng cÃ³)').slice(0, 300)}.\nNhÃ¬n khung hÃ¬nh nÃ y vÃ  quyáº¿t Ä‘á»‹nh video cÃ³ thuá»™c chá»§ Ä‘á» ngÆ°á»i xem muá»‘n khÃ´ng (ná»™i dung, Ä‘á»‘i tÆ°á»£ng, bá»‘i cáº£nh). Tráº£ JSON.`;
  try {
    const result = await chatExecutor.callWithFallback(candidates, {
      systemPrompt,
      history: [{ vai_tro: 'user', noi_dung: userMsg }],
      thinkingLevel: 'fast',
    });
    if (!result.ok) {
      return res.status(502).json({ success: false, error: (result.errors || []).join(' | ').slice(0, 300) });
    }
    const m = /"match"\s*:\s*(true|false)/i.exec(result.content);
    const r = /"reason"\s*:\s*"([^"]*)"/i.exec(result.content);
    return res.json({
      success: true,
      match: m ? m[1].toLowerCase() === 'true' : true, // AI parse lá»—i â†’ fail-open (giá»¯ video)
      reason: r ? r[1] : String(result.content).slice(0, 60),
      provider: result.provider,
    });
  } catch (e) {
    return res.status(502).json({ success: false, error: (e.message || 'classify lá»—i').toString().slice(0, 200) });
  }
});

router.post('/office/generate-docx', authMiddleware, async (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Thiáº¿u ná»™i dung vÄƒn báº£n' });
  if (content.length > 50000) return res.status(400).json({ error: 'Ná»™i dung quÃ¡ dÃ i (tá»‘i Ä‘a 50,000 kÃ½ tá»±)' });

  try {

    // PhÃ¢n tÃ­ch content thÃ nh cÃ¡c Ä‘oáº¡n
    const lines = content.split('\n').filter(l => l.trim());
    const children = [];

    // TiÃªu Ä‘á» chÃ­nh
    if (title) {
      children.push(
        new Paragraph({
          text: title,
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6 } }
        })
      );
    }

    // Xá»­ lÃ½ tá»«ng dÃ²ng
    for (const line of lines) {
      const trimmed = line.trim();
      
      // PhÃ¡t hiá»‡n table (dÃ²ng cÃ³ |)
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.split('|').filter(c => c.trim());
        if (cells.length > 1) {
          children.push(
            new Table({
              rows: [
                new TableRow({
                  children: cells.map(c => new TableCell({
                    children: [new Paragraph({ text: c.trim(), alignment: AlignmentType.CENTER })],
                    width: { size: 100 / cells.length, type: WidthType.PERCENTAGE },
                    borders: { top: { style: BorderStyle.SINGLE }, bottom: { style: BorderStyle.SINGLE }, left: { style: BorderStyle.SINGLE }, right: { style: BorderStyle.SINGLE } }
                  }))
                })
              ]
            })
          );
          continue;
        }
      }

      // PhÃ¡t hiá»‡n bullet (- hoáº·c *)
      if (trimmed.match(/^[-*]\s/)) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed.replace(/^[-*]\s*/, ''), size: 22 })],
            bullet: { level: 0 },
            spacing: { after: 100 }
          })
        );
        continue;
      }

      // PhÃ¡t hiá»‡n numbered (1., 2.,...)
      if (trimmed.match(/^\d+\.\s/)) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed.replace(/^\d+\.\s*/, ''), size: 22 })],
            numbering: { reference: 'default-numbering', level: 0 },
            spacing: { after: 100 }
          })
        );
        continue;
      }

      // PhÃ¡t hiá»‡n heading (# ## ###)
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const levelMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6 };
        children.push(
          new Paragraph({
            text: headingMatch[2],
            heading: levelMap[level] || HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          })
        );
        continue;
      }

      // VÄƒn báº£n thÆ°á»ng
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed, size: 22 })],
          spacing: { after: 120 },
          alignment: AlignmentType.JUSTIFIED
        })
      );
    }

    const doc = new Document({
      title: title || 'TÃ i liá»‡u Rexi AI',
      description: 'ÄÆ°á»£c táº¡o bá»Ÿi Rexi AI Office Generator',
      styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
      sections: [{ children, properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } } }]
    });

    const buffer = await Packer.toBuffer(doc);
    const base64 = buffer.toString('base64');

    res.json({
      success: true,
      data: base64,
      format: 'docx',
      filename: `${(title || 'Tai_lieu_RexiAI').replace(/[^a-zA-Z0-9_]/g, '_')}.docx`,
      size: buffer.length
    });
  } catch (err) {
    console.error('[Office] DOCX Error:', err.message);
    res.status(500).json({ success: false, error: 'Lá»—i táº¡o DOCX: ' + err.message });
  }
});

// POST /api/office/generate-pptx - Táº¡o file PowerPoint (pptxgenjs)
router.post('/office/generate-pptx', authMiddleware, async (req, res) => {
  const { title, slides } = req.body;
  if (!slides || !Array.isArray(slides) || slides.length === 0 || slides.length > 50) {
    return res.status(400).json({ error: 'Thiáº¿u danh sÃ¡ch slide (slides: [{title, content}])' });
  }

  try {
    const pres = new PptxGenJS();

    // Slide 1: TiÃªu Ä‘á»
    const slide1 = pres.addSlide();
    slide1.addText(title || 'BÃ i thuyáº¿t trÃ¬nh Rexi AI', { x: 0.5, y: 1, w: 9, h: 2, fontSize: 36, color: 'FFFFFF', bold: true, align: 'center' });
    slide1.addText('ÄÆ°á»£c táº¡o bá»Ÿi Rexi AI Office Generator', { x: 0.5, y: 3.2, w: 9, h: 0.8, fontSize: 16, color: 'AAAAAA', align: 'center' });
    slide1.background = { color: '1E1E2E' };

    // CÃ¡c slide ná»™i dung
    for (const slide of slides) {
      const s = pres.addSlide();
      s.background = { color: '1E1E2E' };
      
      // TiÃªu Ä‘á» slide
      s.addText(slide.title || '', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, color: '89B4FA', bold: true });
      
      // Ná»™i dung
      const contentLines = (slide.content || '').split('\n').filter(l => l.trim());
      let yPos = 1.4;
      for (const line of contentLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          s.addText('â€¢ ' + trimmed.substring(2), { x: 0.7, y: yPos, w: 8.5, h: 0.4, fontSize: 16, color: 'CDD6F4' });
        } else {
          s.addText(trimmed, { x: 0.5, y: yPos, w: 8.8, h: 0.5, fontSize: 16, color: 'CDD6F4' });
        }
        yPos += 0.45;
      }
    }

    const buffer = await pres.write({ outputType: 'nodebuffer' });
    const base64 = buffer.toString('base64');

    res.json({
      success: true,
      data: base64,
      format: 'pptx',
      filename: `${(title || 'Bai_thuyet_trinh_RexiAI').replace(/[^a-zA-Z0-9_]/g, '_')}.pptx`,
      slides_count: slides.length + 1,
      size: buffer.length
    });
  } catch (err) {
    console.error('[Office] PPTX Error:', err.message);
    res.status(500).json({ success: false, error: 'Lá»—i táº¡o PPTX: ' + err.message });
  }
});

// POST /api/office/process-pdf - Xá»­ lÃ½ PDF (merge, split, info)
router.post('/office/process-pdf', authMiddleware, async (req, res) => {
  const { action, base64_pdf } = req.body;
  if (!base64_pdf) return res.status(400).json({ error: 'Thiáº¿u file PDF (base64_pdf)' });

  try {
    const pdfBytes = Buffer.from(base64_pdf, 'base64');
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    if (action === 'info') {
      res.json({
        success: true,
        action: 'info',
        pages: doc.getPageCount(),
        title: doc.getTitle() || 'Untitled',
        author: doc.getAuthor() || 'Unknown',
        subject: doc.getSubject() || '',
        keywords: doc.getKeywords() || '',
        creator: doc.getCreator() || 'Rexi AI PDF Processor'
      });
    } else if (action === 'extract' || action === 'extract-text') {
      // TrÃ­ch xuáº¥t toÃ n bá»™ ná»™i dung chá»¯ trong PDF (cháº¡y CPU, khÃ´ng cáº§n GPU)
      const pdf = new PDFParse({ data: pdfBytes });
      const parsed = await pdf.getText({});
      await pdf.destroy();
      let fullText = (parsed.text || '').trim();
      let ocrUsed = false;
      // Fallback OCR: PDF áº£nh/scan (pdf-parse tráº£ rá»—ng) -> gá»i LightOnOCR local (port 8099)
      if (fullText.length < 20) {
        try {
          // DÃ¹ng FormData + Blob built-in cá»§a Node (fetch xá»­ lÃ½ native, tá»± set boundary)
          const form = new FormData();
          form.append('file', new Blob([Buffer.from(pdfBytes)], { type: 'application/pdf' }), 'scan.pdf');
          const ocrRes = await fetch('http://127.0.0.1:8099/ocr', {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(120000) // trÃ¡nh treo vÄ©nh viá»…n khi OCR server cháº­m/cháº¿t
          });
          if (ocrRes.ok) {
            const ocrJson = await ocrRes.json();
            if (ocrJson.text && ocrJson.text.trim().length > fullText.length) {
              fullText = ocrJson.text.trim();
              ocrUsed = true;
            }
          }
        } catch (ocrErr) {
          console.warn('[Office] OCR fallback unavailable:', ocrErr.message);
        }
      }
      const maxChars = parseInt(req.body.max_chars, 10) || 50000;
      const truncated = fullText.length > maxChars;
      res.json({
        success: true,
        action: 'extract',
        pages: doc.getPageCount(),
        chars: fullText.length,
        truncated,
        ocr_used: ocrUsed,
        text: truncated ? fullText.substring(0, maxChars) : fullText
      });
    } else {
      res.json({
        success: false,
        action: action || 'unknown',
        error: `HÃ nh Ä‘á»™ng '${action || 'unknown'}' chÆ°a Ä‘Æ°á»£c há»— trá»£. Há»— trá»£: info, extract`
      });
    }
  } catch (err) {
    console.error('[Office] PDF Error:', err.message);
    res.status(500).json({ success: false, error: 'Lá»—i xá»­ lÃ½ PDF: ' + err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LIVE CAPTION: Nháº­n diá»‡n giá»ng nÃ³i tá»« video báº±ng Groq Whisper + Dá»‹ch Tiáº¿ng Viá»‡t
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LIVE CAPTION: Nháº­n diá»‡n giá»ng nÃ³i tá»« video báº±ng Groq Whisper + Dá»‹ch Tiáº¿ng Viá»‡t
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tempDir = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// I5: dá»n file temp cÅ© >1h â€” server restart/crash giá»¯a render/upload lÃ m file káº¹t láº¡i,
// RAM 512MB trÃªn Render khÃ´ng Ä‘á»§ chá»©a rÃ¡c tÃ­ch tá»¥ (ytdl audio + render mp4 + upload)
function cleanupOldTemp() {
  const dirs = [tempDir, path.join(tempDir, 'video')];
  const now = Date.now();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        const isRecent = now - st.mtimeMs < 60 * 60 * 1000;
        if (!isRecent) fs.rmSync(p, { recursive: true, force: true });
      } catch (e) { /* file biáº¿n máº¥t giá»¯a chá»«ng â€” bá» qua */ }
    }
  }
}
cleanupOldTemp();
setInterval(cleanupOldTemp, 60 * 60 * 1000).unref();

// Guest váº«n dÃ¹ng Phá»¥ Äá» AI Ä‘Æ°á»£c (khÃ´ng token) nhÆ°ng limit 30 req/phÃºt/IP
// (1 ngÆ°á»i xem ~12 chunk/phÃºt) â€” chá»‘ng láº¡m dá»¥ng quota Groq Whisper.
// LÆ°u Ã½: client guest váº«n gá»­i header "Bearer " rá»—ng â†’ coi nhÆ° khÃ´ng cÃ³ token.
const transcribeGuestRate = rateLimit({ windowMs: 60000, max: 30 });
function transcribeGate(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth !== 'Bearer' && auth !== 'Bearer ') return proxyAuth(req, res, next);
  if (req.query.token) return proxyAuth(req, res, next);
  return transcribeGuestRate(req, res, next);
}

router.post('/transcribe', transcribeGate, upload.single('audio'), async (req, res) => {
  const audioFile = req.file;
  const srcLang = req.body.lang || 'auto';

  if (!audioFile) {
    return res.status(400).json({ success: false, error: 'KhÃ´ng nháº­n Ä‘Æ°á»£c file audio.' });
  }
  const tmpPath = audioFile.path;

  // P2-audit: nhiá»u client (curl, upload file láº¡) gá»­i audio vá»›i Content-Type
  // application/octet-stream â†’ Groq tá»« chá»‘i vÃ  request rÆ¡i xuá»‘ng 500 HTML.
  // Sniff láº¡i mimetype theo Ä‘uÃ´i file khi client khÃ´ng khai bÃ¡o Ä‘Ãºng.
  const EXT_MIME = {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.oga': 'audio/ogg',
    '.flac': 'audio/flac', '.amr': 'audio/amr', '.aac': 'audio/aac',
  };
  let sendMime = audioFile.mimetype || '';
  if (!sendMime || sendMime === 'application/octet-stream') {
    const ext = path.extname(audioFile.originalname || '').toLowerCase();
    sendMime = EXT_MIME[ext] || sendMime || 'application/octet-stream';
  }

  try {
    const groq = await getGroqClient();
    if (!groq) {
      return res.status(503).json({
        success: false,
        error: 'CHUA_CO_KEY',
        message: 'Cáº§n thÃªm GROQ_API_KEY vÃ o file .env hoáº·c báº£ng khoa_api Ä‘á»ƒ dÃ¹ng tÃ­nh nÄƒng Phá»¥ Äá» AI. Láº¥y key miá»…n phÃ­ táº¡i: https://console.groq.com'
      });
    }

    // Gá»i Groq Whisper API Ä‘á»ƒ nháº­n diá»‡n giá»ng nÃ³i (+ timeout 60s â€” P2-20(5))
    // Sá»­ dá»¥ng FormData Ä‘á»ƒ Ä‘áº£m báº£o Groq nháº­n Ä‘Ãºng file vá»›i metadata
    // Groq SDK 1.x expects an object payload, not a `form-data` instance.
    // Convert the Multer file stream with Groq.toFile() so the SDK can build
    // a compatible multipart request (this also supports browser WebM chunks).
    const transcription = await withTimeout(groq.audio.transcriptions.create({
      file: await Groq.toFile(
        fs.createReadStream(tmpPath),
        path.basename(tmpPath),
        { type: sendMime }
      ),
      model: 'whisper-large-v3',
      response_format: 'json',
      ...(srcLang !== 'auto' ? { language: srcLang } : {})
    }), 60000, 'Nháº­n diá»‡n giá»ng nÃ³i');

    const originalText = typeof transcription === 'string'
      ? transcription.trim()
      : String(transcription?.text || '').trim();
    if (!originalText) {
      return res.json({ success: true, text: '', original: '' });
    }

    // Dá»‹ch sang tiáº¿ng Viá»‡t: Google (local) â†’ LLM Groq/Gemini (cloud â€” Google bá»‹ cháº·n tá»« datacenter)
    let vietnameseText = originalText;
    if (srcLang !== 'vi') {
      try {
        vietnameseText = await translateToVietnamese(originalText, srcLang);
      } catch (transErr) {
        console.log('[Transcribe] Translate error:', transErr.message);
      }
    }

    res.json({ success: true, text: vietnameseText, original: originalText });

  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    const isTimeout = /quÃ¡ thá»i gian/i.test(err.message || '');
    res.status(isTimeout ? 504 : 500).json({ success: false, error: 'Lá»—i nháº­n diá»‡n giá»ng nÃ³i: ' + err.message });
  } finally {
    // P2-20(5): xÃ³a file temp TRONG finally â€” má»i Ä‘Æ°á»ng return/throw Ä‘á»u dá»n
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
});

// ========== BROWSER STREAM ROUTES ==========
const browserStream = require('../services/browserStream');
const browserTask = require('../services/browserTask');

// Cháº¡y tÃ¡c vá»¥ dÃ i (nhiá»u bÆ°á»›c) â€” agent tá»± observe â†’ quyáº¿t Ä‘á»‹nh â†’ hÃ nh Ä‘á»™ng, liÃªn tá»¥c
router.post('/browser/task', authMiddleware, async (req, res) => {
  try {
    const { goal, maxSteps, intervalMs, model } = req.body || {};
    const result = await browserTask.start(goal, { maxSteps, intervalMs, model });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/task/stop', authMiddleware, async (req, res) => {
  try {
    res.json(browserTask.stop((req.body || {}).reason || 'NgÆ°á»i dÃ¹ng dá»«ng'));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/browser/task', authMiddleware, async (req, res) => {
  try {
    res.json(browserTask.status());
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Äá»c mÃ n hÃ¬nh báº±ng model vision (canvas/game/Ä‘á»“ hoáº¡ khÃ´ng cÃ³ DOM text)
router.post('/browser/vision', authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    const result = await browserStream.vision(prompt);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/launch', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    // P2-18: cháº·n URL ná»™i bá»™ ká»ƒ cáº£ khi launch kÃ¨m URL (browserStream.navigate khÃ´ng tá»± check)
    if (url && url !== 'about:blank') {
      const check = await assertPublicUrlAsync(url);
      if (!check.ok) return res.status(403).json({ success: false, error: check.reason });
    }
    const result = await browserStream.launch({ url: url || 'about:blank' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/navigate', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    // P2-18: browserStream.navigate() khÃ´ng check SSRF â†’ check á»Ÿ route (Ä‘Ã£ cÃ³ auth)
    const check = await assertPublicUrlAsync(url);
    if (!check.ok) return res.status(403).json({ success: false, error: check.reason });
    const result = await browserStream.navigate(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/click', authMiddleware, async (req, res) => {
  try {
    const { x, y } = req.body;
    const result = await browserStream.click(x, y);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/type', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    const result = await browserStream.type(text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/key', authMiddleware, async (req, res) => {
  try {
    const { key } = req.body;
    const result = await browserStream.key(key);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/scroll', authMiddleware, async (req, res) => {
  try {
    const { deltaX, deltaY } = req.body;
    const result = await browserStream.scroll(deltaX, deltaY);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET: Ä‘á»c text + viewportText + scrollY cá»§a trang hiá»‡n táº¡i (tÆ°Æ¡ng Ä‘Æ°Æ¡ng tool browser_read)
router.get('/browser/read', authMiddleware, async (req, res) => {
  try {
    const maxChars = Number(req.query.maxChars) || 6000;
    const result = await browserStream.readText(maxChars);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/browser/close', authMiddleware, async (req, res) => {
  try {
    await browserStream.close();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/browser/status', authMiddleware, (req, res) => {
  res.json(browserStream.getStatus());
});

// GET: stream frame JPEG THÃ” (binary) â€” multipart/x-mixed-replace (kiá»ƒu MJPEG).
// Nhanh hÆ¡n SSE base64 ráº¥t nhiá»u: khÃ´ng base64 (+33%), khÃ´ng JSON stringify ~40KB/frame.
// FE dÃ¹ng endpoint nÃ y Ä‘á»ƒ váº½; SSE chá»‰ Ä‘á»ƒ nháº­n event (step/task).
router.get('/browser/stream-frames', async (req, res) => {
  const token = req.query.token || '';
  let user = null;
  try {
    const jwt = require('jsonwebtoken');
    const { getJWTSecret } = require('../middleware/auth.middleware');
    user = jwt.verify(token, getJWTSecret());
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid token' });
  }
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`--frame\r\nContent-Type: image/jpeg\r\n\r\n`);

  // ÄÄƒng kÃ½ vÃ o kÃªnh binary TRÆ¯á»šC khi launch â†’ launch() biáº¿t cÃ³ ngÆ°á»i xem â†’ báº­t screencast.
  browserStream._frameSubs.add(res);
  browserStream._resetAutoClose();

  try {
    if (!browserStream.page || browserStream.page.isClosed()) {
      await browserStream.launch();
    }
  } catch (e) {
    console.error('[Frames] Auto-launch error:', e.message);
  }
  await browserStream.startScreencast();

  const ka = setInterval(() => { try { if (!res.writableEnded && !res.destroyed) res.write('\r\n'); } catch (e) {} }, 15000);
  const cleanup = () => {
    clearInterval(ka);
    browserStream._frameSubs.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// GET: SSE stream frames â€” thay WebSocket (Render proxy chÃ¨n WS compression RSV1/
// fragmentation â†’ connection cháº¿t 1006 ngáº§m, self-test xÃ¡c nháº­n). HTTP thÆ°á»ng qua
// Render + Cloudflare OK. Auth ?token= (EventSource khÃ´ng gá»­i Ä‘Æ°á»£c header).
router.get('/browser/stream-sse', async (req, res) => {
  const token = req.query.token || '';
  let user = null;
  try {
    const jwt = require('jsonwebtoken');
    const { getJWTSecret } = require('../middleware/auth.middleware');
    user = jwt.verify(token, getJWTSecret());
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid token' });
  }
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', stream: 'screencast', opts: browserStream.streamOpts })}\n\n`);
  console.log('[SSE] Browser stream client connected (screencast), user:', user.id || user.email);

  // Tá»± launch browser khi client káº¿t ná»‘i (náº¿u chÆ°a cÃ³)
  if (!browserStream.page && !browserStream.browser) {
    browserStream.launch().catch(e => console.error('[SSE] Auto-launch error:', e.message));
  }

  // Push model: server Ä‘áº©y frame qua kÃªnh nÃ y (CDP screencast), client KHÃ”NG cÃ²n poll.
  browserStream.addSubscriber(res).catch(e => console.error('[SSE] addSubscriber:', e.message));

  // Keepalive Ä‘á»ƒ proxy (Render/Cloudflare) khÃ´ng cáº¯t káº¿t ná»‘i khi trang tÄ©nh khÃ´ng cÃ³ frame.
  const ka = setInterval(() => {
    try { if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); } catch (e) {}
  }, 15000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    clearInterval(ka);
    browserStream.removeSubscriber(res);
    console.log('[SSE] Browser stream client disconnected');
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
});

// GET: self-test WS tá»« TRONG instance qua localhost â€” tÃ¡ch thá»§ pháº¡m (server vs proxy ngoÃ i)
router.get('/browser/ws-selftest', authMiddleware, async (req, res) => {
  try {
    const WebSocket = require('ws');
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const port = process.env.PORT || 5000;
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/services/browser/stream?token=${encodeURIComponent(token)}`);
      const events = [];
      const to = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ events, note: 'timeout 15s' }); }, 15000);
      ws.on('open', () => events.push('open'));
      ws.on('message', (d) => { const t = JSON.parse(d).type; events.push(`msg:${t}`); });
      ws.on('close', (c) => { events.push(`close:${c}`); clearTimeout(to); resolve({ events }); });
      ws.on('error', (e) => { events.push(`error:${e.message.substring(0, 50)}`); });
    });
    res.json({ success: true, ...result, status: browserStream.getStatus() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST: AI Action (Stagehand) â€” Ä‘iá»u khiá»ƒn browser báº±ng ngÃ´n ngá»¯ tá»± nhiÃªn
router.post('/browser/act', authMiddleware, async (req, res) => {
  try {
    const { instruction } = req.body;
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ success: false, error: 'Thiáº¿u chá»‰ dáº«n (instruction)' });
    }
    const result = await browserStream.act(instruction);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Cuá»™n liÃªn tá»¥c (mÆ°á»£t) â€” dÃ¹ng cho TikTok/shorts: nhá»‹p cuá»™n á»•n Ä‘á»‹nh trong N ms
router.post('/browser/scroll-continuous', authMiddleware, async (req, res) => {
  try {
    const { deltaX, deltaY, durationMs, intervalMs, wait, mode } = req.body || {};
    const result = await browserStream.scrollContinuous({ deltaX, deltaY, durationMs, intervalMs, wait, mode });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Dá»«ng cuá»™n liÃªn tá»¥c Ä‘ang cháº¡y ná»n
router.post('/browser/scroll-stop', authMiddleware, async (req, res) => {
  try {
    res.json(await browserStream.stopScrollContinuous());
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST: chá»‰nh thÃ´ng sá»‘ stream (cháº¥t lÆ°á»£ng/fps/kÃ­ch thÆ°á»›c) â€” "mÆ°á»£t hÆ¡n" hoáº·c "nháº¹ hÆ¡n"
router.post('/browser/stream-opts', authMiddleware, async (req, res) => {
  try {
    const { quality, fps, maxWidth, maxHeight, everyNthFrame, scale, viewportWidth, viewportHeight } = req.body || {};
    const opts = await browserStream.setStreamOpts({ quality, fps, maxWidth, maxHeight, everyNthFrame, scale, viewportWidth, viewportHeight });
    browserStream._resetAutoClose();
    res.json({ success: true, opts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Di chuá»™t liÃªn tá»¥c (hover/kÃ©o) â€” thao tÃ¡c mÆ°á»£t cho game/canvas
router.post('/browser/move', authMiddleware, async (req, res) => {
  try {
    const { x, y, steps } = req.body || {};
    const result = await browserStream.mouseMove(Number(x), Number(y), Number(steps) || 1);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Nháº¥n/tháº£ chuá»™t rá»i (giá»¯ chuá»™t Ä‘á»ƒ kÃ©o/thao tÃ¡c game)
router.post('/browser/mouse', authMiddleware, async (req, res) => {
  try {
    const { action, x, y, button } = req.body || {};
    const result = await browserStream.mouseButton(action, Number(x), Number(y), button);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HYPERFRAMES VIDEO RENDERER â€” HTML â†’ MP4 via HyperFrames CLI
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { execSync, spawn } = require('child_process');
const { safeExecSync } = require('../utils/safeExec');
const ffmpegPath = require('ffmpeg-static');

// Temp dir for video renders
const videoTempDir = path.join(__dirname, '..', '..', 'temp', 'video');
if (!fs.existsSync(videoTempDir)) fs.mkdirSync(videoTempDir, { recursive: true });

// GET: Check HyperFrames availability
router.get('/video/status', authMiddleware, async (req, res) => {
  try {
    // Check ffmpeg
    const ffmpegOk = ffmpegPath && fs.existsSync(ffmpegPath);
    // Check hyperframes CLI
    let hfVersion = null;
    try {
      hfVersion = safeExecSync('npx hyperframes info --json', { timeout: 15000, encoding: 'utf8' });
    } catch {}
    // Check Chrome/Puppeteer
    let chromeOk = false;
    try {
      const puppeteerCache = path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer');
      chromeOk = fs.existsSync(puppeteerCache);
    } catch {}

    // QA 17/9: engine render chÃ­nh giá» lÃ  Playwright + ffmpeg (videoRenderer).
    // Kiá»ƒm tra tháº­t báº±ng cÃ¡ch launch browser thá»­, khÃ´ng Ä‘oÃ¡n theo thÆ° má»¥c cache.
    let playwrightOk = false;
    let playwrightBrowser = null;
    let playwrightError = null;
    if (videoRenderer.isAvailable()) {
      try {
        const probe = await videoRenderer.probeBrowser();
        playwrightOk = true;
        playwrightBrowser = probe.label;
      } catch (e) { playwrightError = String(e.message || e).slice(0, 200); }
    }
    res.json({
      success: true,
      engine: playwrightOk ? 'playwright' : 'hyperframes',
      ffmpeg: ffmpegOk,
      ffmpegPath: ffmpegPath || null,
      hyperframes: !!hfVersion,
      chrome: chromeOk,
      playwright: playwrightOk,
      playwrightBrowser,
      playwrightError,
      // QA 28/9: táº¡o video AI miá»…n phÃ­ qua HuggingFace Spaces (endpoint /generate-video),
      // Ä‘á»™c láº­p vá»›i renderer composition (Playwright+ffmpeg) á»Ÿ trÃªn.
      aiVideo: true,
      aiVideoProviders: [
        'minimax-h3 (HF Inference API, 33B, textâ†’video + imageâ†’video, cáº§n HF_TOKEN)',
        'huggingface-spaces: zeroscope-v2 (textâ†’video)',
        'huggingface-spaces: wan2.2-14b-i2v (áº£nhâ†’video)',
        'storyboard: ghÃ©p N cáº£nh ~3s thÃ nh video dÃ i (param scenes 1-6)'
      ],
      ready: ffmpegOk && playwrightOk
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST: Render HTML composition â†’ MP4
// P2-20(6): rate-limit 3 render/giá»/user (sau auth Ä‘á»ƒ key theo user) + giá»›i háº¡n
// duration â‰¤ 30s + width â‰¤ 1920 (chá»‘ng Ä‘á»‘t CPU/RAM báº±ng job khá»•ng lá»“).
router.post('/video/render', authMiddleware, rateLimit({ windowMs: 3600000, max: 20, message: 'Báº¡n Ä‘Ã£ render 20 video trong giá» nÃ y. Vui lÃ²ng chá» thÃªm rá»“i thá»­ láº¡i.' }), async (req, res) => {
  const { html, width, height, fps, duration } = req.body;
  if (!html || !html.trim()) {
    return res.status(400).json({ error: 'Thiáº¿u ná»™i dung HTML composition' });
  }
  if (html.length > 500000) {
    return res.status(400).json({ error: 'HTML quÃ¡ dÃ i (tá»‘i Ä‘a 500KB)' });
  }
  const compWidth = Math.min(Math.max(parseInt(width, 10) || 1920, 320), 1920);
  const compHeight = Math.min(Math.max(parseInt(height, 10) || 1080, 240), 1080);
  const compDuration = Math.min(Math.max(parseFloat(duration) || 5, 1), 30);

  const renderId = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const projectDir = path.join(videoTempDir, renderId);
  const outputFile = path.join(projectDir, 'output.mp4');
  const fpsArgMain = Math.min(Math.max(parseInt(fps, 10) || 30, 1), 60);

  // â”€â”€â”€ OFFLOAD render náº·ng sang VIDEO WORKER local (tunnel) náº¿u cÃ³ â€” nhÆ° TTS â”€â”€â”€
  const workerUrl = (process.env.VIDEO_WORKER_URL || '').trim().replace(/\/$/, '');
  if (workerUrl) {
    try {
      const wRes = await fetch(workerUrl + '/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-worker-token': (process.env.VIDEO_WORKER_TOKEN || '') },
        body: JSON.stringify({ html, width: compWidth, height: compHeight, fps: fpsArgMain, duration: compDuration }),
        signal: AbortSignal.timeout(300000),
      });
      const data = await wRes.json();
      if (data && data.success && data.video) {
        console.log('[Video Render] worker OK â€”', Math.round((data.size || 0) / 1024), 'KB');
        return res.json({ success: true, video: data.video, format: 'mp4', size: data.size, width: compWidth, height: compHeight, duration: compDuration, fps: fpsArgMain, frames: data.frames, engine: 'worker', renderId });
      }
      console.warn('[Video Render] worker lá»—i â†’ fallback local:', data && data.error);
    } catch (eW) {
      console.warn('[Video Render] worker exception â†’ fallback local:', eW.message);
    }
  }

  // â”€â”€â”€ ÄÆ¯á»œNG CHÃNH (QA 17/9): renderer Playwright + ffmpeg cá»§a mÃ¬nh â”€â”€â”€
  // `hyperframes render` cáº§n browser riÃªng vÃ  cháº¿t á»Ÿ phase capture (Network.enable timeout).
  if (videoRenderer.isAvailable()) {
    try {
      const out = await videoRenderer.renderComposition({
        html, width: compWidth, height: compHeight, fps: fpsArgMain, duration: compDuration,
      });
      console.log(`[Video Render] playwright OK â€” ${out.frames} frames / ${(out.ms / 1000).toFixed(1)}s (${out.browser})`);
      return res.json({
        success: true,
        video: out.buffer.toString('base64'),
        format: 'mp4',
        size: out.buffer.length,
        width: compWidth,
        height: compHeight,
        duration: compDuration,
        fps: fpsArgMain,
        frames: out.frames,
        renderMs: out.ms,
        engine: 'playwright',
        renderId,
      });
    } catch (eRender) {
      console.error('[Video Render] playwright engine lá»—i â†’ thá»­ hyperframes:', eRender.message);
    }
  }

  try {
    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    // Write index.html composition (HyperFrames compatible)
    // (compWidth/compHeight/compDuration Ä‘Ã£ clamp á»Ÿ Ä‘áº§u route â€” P2-20(6))
    const compId = 'main';
    // QA 17/9: hyperframes lint bÃ¡o missing_gsap_script vÃ¬ <script src> cá»§a template
    // náº±m trong <body>; Ä‘á»“ng thá»i timeline_id_mismatch vÃ¬ template tá»± Ä‘Äƒng kÃ½
    // window.__timelines['<id-template>'] trong khi composition id lÃ  'main'.
    // â†’ hoist script CDN (https) lÃªn <head> vÃ  gÃ¡n láº¡i timeline cho 'main'.
    let bodyHtml = html;
    const hoisted = [];
    bodyHtml = html.replace(/<script\s+src="(https:\/\/[^"\s>]+)"\s*>\s*<\/script>/gi, (m, src) => {
      hoisted.push(src);
      return '';
    });
    const headScripts = hoisted.map(src => `  <script src="${src}"></script>`).join('\n');
    const compositionHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
${headScripts}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${compWidth}px; height: ${compHeight}px; overflow: hidden; background: #000; }
  </style>
</head>
<body>
  <div data-composition-id="${compId}" data-width="${compWidth}" data-height="${compHeight}" data-start="0" data-duration="${compDuration}">
    ${bodyHtml}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    (function () {
      var own = Object.keys(window.__timelines).filter(function (k) { return k !== '${compId}'; });
      window.__timelines['${compId}'] = own.length ? window.__timelines[own[0]] : { compositions: [] };
    })();
  </script>
</body>
</html>`;
    fs.writeFileSync(path.join(projectDir, 'index.html'), compositionHtml, 'utf8');

    // Build render command
    // fps tá»« client pháº£i lÃ  sá»‘ nguyÃªn 1-60 (spawn shell:true ná»‘i chuá»—i â†’ cháº·n command injection)
    const fpsArg = Math.min(Math.max(parseInt(fps, 10) || 30, 1), 60);

    // Set FFmpeg/FFprobe path in env for hyperframes
    const env = { ...process.env };
    // FIX PROD: bá» Ä‘Æ°á»ng dáº«n Windows cá»©ng â€” dÃ¹ng ffmpeg-static (npm) + path.delimiter (; trÃªn Windows, : trÃªn Linux/Render)
    const ffmpegDir = ffmpegPath ? path.dirname(ffmpegPath) : '';
    env.FFMPEG_PATH = ffmpegPath || '';
    env.PATH = ffmpegDir ? `${ffmpegDir}${path.delimiter}${env.PATH || ''}` : env.PATH;

    // Run hyperframes render (dimensions set in HTML, not CLI flags)
    const args = [
      'hyperframes', 'render',
      projectDir,
      '-o', outputFile,
      '--fps', String(fpsArg),
    ];

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('npx', args, {
        cwd: projectDir,
        env,
        timeout: 120000, // 2 minutes max
        shell: true
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          resolve({ success: true, outputFile });
        } else {
          reject(new Error(`Render failed (code ${code}): ${stderr || stdout}`));
        }
      });
      proc.on('error', (err) => {
        reject(new Error(`Render error: ${err.message}`));
      });
    });

    // Read output file and return as base64
    if (fs.existsSync(outputFile)) {
      const videoBuffer = fs.readFileSync(outputFile);
      const base64Video = videoBuffer.toString('base64');
      const fileSize = videoBuffer.length;

      // Cleanup project dir
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch(e) {}

      res.json({
        success: true,
        video: base64Video,
        format: 'mp4',
        size: fileSize,
        width: compWidth,
        height: compHeight,
        duration: compDuration,
        fps: fpsArg,
        renderId
      });
    } else {
      throw new Error('Output file not found after render');
    }
  } catch (err) {
    // Cleanup on error
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch(e) {}
    console.error('[Video Render] Error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Lá»—i render video: ' + err.message,
      note: 'Cáº§n cÃ i FFmpeg vÃ  Chrome/Puppeteer. Cháº¡y: npx hyperframes doctor'
    });
  }
});

// POST: Preview HTML composition (return HTML for iframe preview)
router.post('/video/preview', authMiddleware, (req, res) => {
  const { html, width, height } = req.body;
  if (!html) return res.status(400).json({ error: 'Thiáº¿u HTML' });

  const previewHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${width || 1920}px; height: ${height || 1080}px; overflow: hidden; background: #000; transform-origin: top left; }
  </style>
</head>
<body>
${html}
</body>
</html>`;

  res.json({ success: true, html: previewHtml, width: width || 1920, height: height || 1080 });
});

// POST: Save composition to workspace for later editing
router.post('/video/save', authMiddleware, (req, res) => {
  const { html, name } = req.body;
  if (!html) return res.status(400).json({ error: 'Thiáº¿u HTML' });

  const safeName = (name || `composition_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const saveDir = path.join(__dirname, '..', '..', 'temp', 'video', 'compositions');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  const filePath = path.join(saveDir, `${safeName}.html`);
  fs.writeFileSync(filePath, html, 'utf8');

  res.json({ success: true, path: filePath, name: safeName });
});


// â”€â”€â”€ VIDEO AI MIá»„N PHÃ (HuggingFace Spaces â€” Gradio API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// QA 28/9: kiá»ƒm chá»©ng tháº­t báº±ng HTTP + magic bytes â€” 2 Space cÃ´ng khai tráº£ MP4
// (magic `ftyp`), KHÃ”NG cáº§n key, KHÃ”NG tá»‘n tiá»n:
//   Â· hysts/zeroscope-v2               â†’ textâ†’video (model zeroscope-v2, ~24 frame)
//   Â· observantdistressed/wan2-2-i2v-v3 â†’ áº£nhâ†’video (Wan 2.2 14B I2V, cháº¥t lÆ°á»£ng cao)
// Space free nhÆ°ng xáº¿p hÃ ng (queue) nÃªn cÃ³ thá»ƒ cháº­m; lá»—i/timeout thÃ¬ tráº£
// {success:false} Ä‘á»ƒ nÆ¡i gá»i tá»± xá»­ lÃ½. KHÃ”NG Ä‘á»¥ng renderer Playwright/ffmpeg.
const HF_VIDEO_T2V = { host: 'https://hysts-zeroscope-v2.hf.space', fn: '/run' };
const HF_VIDEO_I2V = { host: 'https://observantdistressed-wan2-2-i2v-v3.hf.space', fn: '/generate_video' };

// â”€â”€â”€ MiniMax H3 (Hugging Face Inference API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Model: MiniMaxAI/MiniMax-H3 (33B, Image-Text-to-Video)
// YÃªu cáº§u: HF_TOKEN (env) cÃ³ quyá»n inference. Free tier: ~30 req/hr.
// Endpoint: https://api-inference.huggingface.co/models/MiniMaxAI/MiniMax-H3
// Input: { inputs: "prompt", parameters: { num_frames: 24, fps: 8, ... } }
// Returns: video bytes (MP4)
async function generateVideoMiniMaxH3(prompt, imageUrl) {
  const token = (process.env.HF_TOKEN || '').trim();
  if (!token) return { success: false, error: 'ChÆ°a cáº¥u hÃ¬nh HF_TOKEN cho MiniMax-H3' };

  try {
    const payload = {
      inputs: String(prompt || '').slice(0, 800),
      parameters: {
        num_frames: 24,
        fps: 8,
        guidance_scale: 7.5,
        num_inference_steps: 25,
      }
    };
    // Náº¿u cÃ³ image_url â†’ image-to-video (MiniMax-H3 há»— trá»£ I2V)
    if (imageUrl && imageUrl.trim()) {
      payload.image = imageUrl.trim();
    }

    const r = await fetch('https://api-inference.huggingface.co/models/MiniMaxAI/MiniMax-H3', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000) // 3 phÃºt
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 503) {
        // Model loading - retry once
        await new Promise(res => setTimeout(res, 10000));
        return generateVideoMiniMaxH3(prompt, imageUrl);
      }
      return { success: false, error: `MiniMax-H3 HTTP ${r.status}: ${String(t).slice(0, 200)}` };
    }

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.startsWith('video/')) {
      const t = await r.text().catch(() => '');
      return { success: false, error: `MiniMax-H3 khÃ´ng tráº£ video: ${contentType} - ${String(t).slice(0, 200)}` };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { success: false, error: 'MiniMax-H3 tráº£ video rá»—ng' };

    // Verify MP4 magic bytes
    const isMp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
    if (!isMp4) {
      // Try to detect if it's webm
      const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      if (!isWebm) return { success: false, error: 'Dá»¯ liá»‡u MiniMax-H3 khÃ´ng pháº£i video há»£p lá»‡' };
    }

    return { success: true, video: `data:${contentType};base64,${buf.toString('base64')}`, mimeType: contentType, provider: 'minimax-h3', bytes: buf.length };
  } catch (e) {
    console.log('[generate-video] MiniMax-H3 error:', e.message);
    return { success: false, error: e.message };
  }
}
// Cloudflare trÆ°á»›c má»™t sá»‘ Space cháº·n UA láº¡ â†’ dÃ¹ng UA trÃ¬nh duyá»‡t cho cháº¯c.
const HF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Gá»i Gradio 5: POST /gradio_api/call/<fn> â†’ event_id, rá»“i GET SSE .../<event_id>
// Ä‘á»ƒ láº¥y URL file. Gradio tráº£ SSE dáº¡ng `event: ...\ndata: ...`.
async function gradioCall(host, fn, data, timeoutMs) {
  // HF_TOKEN (env, Render Ä‘Ã£ set) nÃ¢ng quota ZeroGPU lÃªn má»©c tÃ i khoáº£n â€” khÃ´ng cÃ³ token
  // thÃ¬ ZeroGPU chá»‰ cho ~60s/IP rá»“i bÃ¡o "quota exceeded" cho má»i request.
  const hfTok = (process.env.HF_TOKEN || '').trim();
  const auth = hfTok ? { Authorization: `Bearer ${hfTok}` } : {};
  const hdrs = { 'Content-Type': 'application/json', 'User-Agent': HF_UA, Origin: host, Referer: host + '/', ...auth };
  const post = await fetch(`${host}/gradio_api/call${fn}`, {
    method: 'POST', headers: hdrs, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000)
  });
  if (!post.ok) throw new Error(`Gradio POST HTTP ${post.status}`);
  const j = await post.json().catch(() => null);
  const eventId = j && j.event_id;
  if (!eventId) throw new Error('Gradio khÃ´ng tráº£ event_id');
  const stream = await fetch(`${host}/gradio_api/call${fn}/${eventId}`, {
    headers: { 'User-Agent': HF_UA, Accept: 'text/event-stream', Origin: host, Referer: host + '/', ...auth },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!stream.ok) throw new Error(`Gradio SSE HTTP ${stream.status}`);
  const text = await stream.text();
  let videoUrl = null;
  let errMsg = '';
  let curEvent = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === 'null') continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { continue; } // heartbeat / máº£nh khÃ¡c
    if (curEvent === 'error') { errMsg = String(parsed && (parsed.error || parsed.message) || raw).slice(0, 200); continue; }
    const m = JSON.stringify(parsed).match(/https?:\/\/[^"\\]+\.mp4/);
    if (m) videoUrl = m[0]; // báº£n ghi `complete` cuá»‘i cÃ¹ng lÃ  káº¿t quáº£
  }
  if (!videoUrl) throw new Error(errMsg ? `Space lá»—i: ${errMsg}` : 'Gradio khÃ´ng tráº£ URL video (.mp4)');
  return videoUrl;
}

// Táº£i MP4 tá»« URL Space â†’ Buffer + xÃ¡c thá»±c magic bytes.
async function fetchVideoBuffer(url) {
  const dl = await fetch(url, { headers: { 'User-Agent': HF_UA }, signal: AbortSignal.timeout(120000) });
  if (!dl.ok) throw new Error(`Táº£i MP4 HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (!buf.length) throw new Error('Video tráº£ vá» rá»—ng');
  // magic bytes: MP4 cÃ³ 'ftyp' á»Ÿ offset 4; WebM báº¯t Ä‘áº§u báº±ng EBML 1A 45 DF A3.
  const isMp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (!isMp4 && !isWebm) throw new Error('Dá»¯ liá»‡u táº£i vá» khÃ´ng pháº£i video');
  return { buf, mime: isMp4 ? 'video/mp4' : 'video/webm' };
}

// prompt â†’ buffer video (HuggingFace Spaces, miá»…n phÃ­ nhÆ°ng cÃ³ thá»ƒ xáº¿p hÃ ng/cháº­p chá»n).
// CÃ³ image_url â†’ thá»­ Wan 2.2 I2V trÆ°á»›c; lá»—i thÃ¬ tá»± rÆ¡i vá» zeroscope T2V Ä‘á»ƒ váº«n cÃ³ video.
// Storyboard mode gá»i hÃ m nÃ y cho Tá»ªNG cáº£nh (khÃ´ng kÃ¨m image_url â€” trÃ¡nh trá»™n resolution
// giá»¯a wan-i2v vÃ  zeroscope lÃ m concat ffmpeg vá»¡).
async function generateVideoBufferHF(prompt, imageUrl) {
  const p = String(prompt || '').slice(0, 800);
  let lastErr = '';
  if (imageUrl) {
    try {
      const img = { path: imageUrl, url: imageUrl, orig_name: 'input.png', meta: { _type: 'gradio.FileData' } };
      const data = [img, null, p || 'make this image come alive, cinematic motion, smooth animation',
        6, '', 3.5, 1, 1, 42, true, 6, 'UniPCMultistep', 3.0, 16, true, [], true, true];
      const url = await gradioCall(HF_VIDEO_I2V.host, HF_VIDEO_I2V.fn, data, 300000);
      const { buf, mime } = await fetchVideoBuffer(url);
      return { buf, mime, provider: 'hf-wan2.2-i2v' };
    } catch (e) {
      console.log('[generate-video] Wan I2V lá»—i â†’ rÆ¡i vá» zeroscope T2V:', e.message);
      lastErr = e.message;
    }
  }
  try {
    const data = [p || 'a cinematic scene', 0, 24, 20];
    const url = await gradioCall(HF_VIDEO_T2V.host, HF_VIDEO_T2V.fn, data, 300000);
    const { buf, mime } = await fetchVideoBuffer(url);
    return { buf, mime, provider: 'hf-zeroscope' };
  } catch (e) {
    throw new Error(e.message + (lastErr ? ' | i2v: ' + lastErr : ''));
  }
}

// Tráº£ vá» cÃ¹ng dáº¡ng vá»›i generateImage*: {success, video:"data:<mime>;base64,...", mimeType, provider}.
async function generateVideoHF(prompt, imageUrl) {
  try {
    const { buf, mime, provider } = await generateVideoBufferHF(prompt, imageUrl);
    return { success: true, video: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider, bytes: buf.length };
  } catch (e) {
    console.log('[generate-video] HF Space error:', e.message);
    return { success: false, error: e.message };
  }
}

// â”€â”€â”€ STORYBOARD MODE (29/9): video DÃ€I tá»« model free chá»‰ sinh Ä‘Æ°á»£c ~3s/cáº£nh â”€â”€â”€
// â†’ chia truyá»‡n thÃ nh N prompt cáº£nh, sinh tá»«ng clip rá»“i ghÃ©p báº±ng ffmpeg.
// Chia cáº£nh báº±ng Groq free (key env GROQ_API_KEY hoáº·c DB khoa_api 'groq'),
// lá»—i/thiáº¿u key thÃ¬ rÆ¡i vá» tÃ¡ch cÃ¢u thá»§ cÃ´ng â€” luÃ´n tráº£ Ä‘á»§ N prompt.
async function storyboardScenes(prompt, n) {
  const story = String(prompt || '').slice(0, 1200);
  const fallback = () => {
    const sents = story.split(/(?<=[.!?â€¦])\s+/).map(s => s.trim()).filter(Boolean);
    if (!sents.length) return Array.from({ length: n }, () => story);
    const out = [];
    for (let i = 0; i < n; i++) out.push(sents[i % sents.length]);
    return out;
  };
  try {
    let key = (process.env.GROQ_API_KEY || '').trim();
    if (!key || key === 'YOUR_GROQ_API_KEY_HERE') {
      key = await new Promise((resolve) => {
        db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'groq'", [], (e, r) => {
          if (e || !r || !r.gia_tri_khoa) return resolve('');
          try { resolve((decryptKey(r.gia_tri_khoa) || '').trim()); } catch (err) { resolve(''); }
        });
      });
    }
    if (!key) return fallback();
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_STORY_MODEL || 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: `You split a story into exactly ${n} consecutive video scene prompts. Reply ONLY a JSON array of ${n} strings. Each string: one vivid English visual scene description (max 40 words), same characters and setting across all scenes, chronological story flow. No numbering, no extra text.` },
          { role: 'user', content: story }
        ],
        temperature: 0.7, max_tokens: 700
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) return fallback();
    const j = await r.json().catch(() => null);
    const txt = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const mArr = txt.match(/\[[\s\S]*\]/);
    if (!mArr) return fallback();
    let arr;
    try { arr = JSON.parse(mArr[0]); } catch (e) { return fallback(); }
    const scenes = (Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 300));
    if (scenes.length < 2) return fallback();
    while (scenes.length < n) scenes.push(scenes[scenes.length - 1]);
    return scenes.slice(0, n);
  } catch (e) {
    console.log('[storyboard] Groq split lá»—i â†’ tÃ¡ch cÃ¢u thá»§ cÃ´ng:', e.message);
    return fallback();
  }
}

// GhÃ©p N buffer MP4 (cÃ¹ng model â†’ cÃ¹ng codec/resolution) thÃ nh 1 file.
// Re-encode libx264 + -r 24 cho Ä‘á»“ng bá»™ timestamp â€” Ä‘Ã£ test báº±ng tay 29/9.
function stitchClips(buffers) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(videoTempDir, 'story_'));
    let outFile = null;
    try {
      const lines = buffers.map((b, i) => {
        const f = path.join(dir, `s${i}.mp4`);
        fs.writeFileSync(f, b);
        return `file '${f.replace(/'/g, "'\\''")}'`;
      });
      const listFile = path.join(dir, 'list.txt');
      fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
      outFile = path.join(dir, 'out.mp4');
      const proc = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', outFile]);
      let err = '';
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code !== 0) return reject(new Error('ffmpeg concat exit ' + code + ': ' + err.slice(-300)));
        try {
          resolve(fs.readFileSync(outFile));
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
}

// POST: táº¡o video AI miá»…n phÃ­ tá»« prompt (vÃ  tuá»³ chá»n áº£nh nguá»“n).
// Thá»© tá»± Æ°u tiÃªn: MiniMax-H3 (HF Inference API, cáº§n HF_TOKEN) â†’ HF Spaces (zeroscope/wan2.2).
// Body: { prompt, image_url?, scenes? (1-6), prompts? ([cáº£nh 1, cáº£nh 2...]) }.
// scenes > 1 (hoáº·c gá»­i máº£ng prompts) â†’ storyboard mode: Groq chia truyá»‡n thÃ nh
// cÃ¡c cáº£nh â†’ sinh tá»«ng clip ~3s â†’ ghÃ©p ffmpeg thÃ nh 1 video dÃ i.
router.post('/generate-video', authMiddleware, rateLimit({ windowMs: 3600000, max: 10, message: 'Báº¡n Ä‘Ã£ táº¡o 10 video trong giá» nÃ y. Vui lÃ²ng chá» thÃªm rá»“i thá»­ láº¡i.' }), async (req, res) => {
  const { prompt, image_url } = req.body || {};
  const reqScenes = Math.min(Math.max(parseInt((req.body || {}).scenes, 10) || 1, 1), 6);
  const promptsArr = Array.isArray((req.body || {}).prompts)
    ? (req.body || {}).prompts.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim().slice(0, 800)).slice(0, 6)
    : null;
  if ((!prompt || !prompt.trim()) && !image_url && !(promptsArr && promptsArr.length)) {
    return res.json({ success: false, error: 'Vui lÃ²ng nháº­p mÃ´ táº£ video (hoáº·c áº£nh nguá»“n).' });
  }
  const n = promptsArr && promptsArr.length > 1 ? Math.min(promptsArr.length, 6) : reqScenes;

  // Helper: thá»­ MiniMax-H3 trÆ°á»›c, lá»—i thÃ¬ rÆ¡i vá» HF Spaces
  async function tryGenerateVideo(p, img) {
    const mm = await generateVideoMiniMaxH3(p, img);
    if (mm.success) return mm;
    console.log('[generate-video] MiniMax-H3 fail â†’ fallback HF Spaces:', mm.error);
    return generateVideoHF(p, img);
  }

  // Helper cho storyboard mode (buffer thÃ´ Ä‘á»ƒ stitch)
  async function tryGenerateVideoBuffer(p) {
    const mm = await generateVideoMiniMaxH3(p);
    if (mm.success) {
      // Convert base64 back to buffer for stitching
      const base64 = mm.video.split(',')[1];
      return { buf: Buffer.from(base64, 'base64'), mime: mm.mimeType, provider: mm.provider };
    }
    console.log('[generate-video] MiniMax-H3 buffer fail â†’ fallback HF Spaces:', mm.error);
    return generateVideoBufferHF(p);
  }

  if (n <= 1 && !(promptsArr && promptsArr.length > 1)) {
    const out = await tryGenerateVideo(prompt, image_url);
    return res.json(out);
  }
  // â”€â”€â”€ Storyboard: video dÃ i ~3s x N cáº£nh â”€â”€â”€
  const sceneList = promptsArr && promptsArr.length > 1 ? promptsArr : await storyboardScenes(prompt, n);
  const results = [];
  const errs = [];
  for (let i = 0; i < sceneList.length; i++) {
    try {
      const r = await tryGenerateVideoBuffer(sceneList[i]);
      results.push(r);
    } catch (e) { errs.push(`cáº£nh ${i + 1}: ${String(e.message).slice(0, 120)}`); }
  }
  if (!results.length) {
    return res.json({ success: false, error: 'Táº¥t cáº£ cáº£nh Ä‘á»u lá»—i â€” ' + errs.join(' | ').slice(0, 300) });
  }
  let buf;
  let provider = results[0].provider;
  if (results.length === 1) {
    buf = results[0].buf;
  } else {
    try {
      buf = await stitchClips(results.map(r => r.buf));
      provider += '-story';
    } catch (e) {
      console.log('[generate-video] ghÃ©p cáº£nh lá»—i â†’ tráº£ cáº£nh Ä‘áº§u:', e.message);
      buf = results[0].buf;
      errs.push('ghÃ©p lá»—i: ' + String(e.message).slice(0, 120));
    }
  }
  res.json({
    success: true,
    video: `data:video/mp4;base64,${buf.toString('base64')}`,
    mimeType: 'video/mp4',
    provider,
    bytes: buf.length,
    scenes: results.length,
    scenesRequested: sceneList.length,
    durationSec: results.length * 3,
    partial: results.length < sceneList.length,
    ...(errs.length ? { warn: errs.join(' | ').slice(0, 200) } : {})
  });
});


// â”€â”€â”€ Táº O áº¢NH AI (Gemini Image) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€ Provider áº£nh Dá»° PHÃ’NG miá»…n phÃ­ (khÃ´ng cáº§n API key) â”€â”€â”€
// QA 17/9: quota Gemini cáº¡n lÃ  tÃ­nh nÄƒng táº¡o áº£nh cháº¿t háº³n. Pollinations (Flux)
// tráº£ áº£nh trá»±c tiáº¿p qua URL, khÃ´ng cáº§n key â†’ dÃ¹ng lÃ m Ä‘Æ°á»ng lui cho /generate-image.
// QA 28/9: thÃªm HuggingFace free inference (SD3-medium, hf-inference provider) â€”
// free tier, cáº§n env HF_TOKEN (token cÃ³ quyá»n `inference`). Æ¯u tiÃªn trÆ°á»›c pollinations.
// â”€â”€â”€ xKiro image generation (SenseNova U1.5 Lite) â€” async job API â”€â”€â”€
// QA 28/9: xKiro POST /v1/images/generations â†’ 202 job â†’ GET /v1/images/generations/{id}
// tá»›i status=succeeded â†’ data[0].url (cdn.xkiro.com). Key Ä‘á»c tá»« DB (khoa_api, 'xkiro').
async function generateImageXkiro(prompt) {
  try {
    const row = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'xkiro' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1", [], (e, r) => resolve(r));
    });
    if (!row) return { success: false, error: 'KhÃ´ng cÃ³ key xkiro trong DB' };
    let key = '';
    try { key = decryptKey(row.gia_tri_khoa).trim(); } catch (e) { key = ''; }
    if (!key) return { success: false, error: 'Giáº£i mÃ£ key xkiro tháº¥t báº¡i' };
    const MODEL = 'sensenova/sensenova-u1.5-lite';
    const create = await fetch('https://api.xkiro.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: String(prompt).slice(0, 800), n: 1, size: '1024x1024' }),
      signal: AbortSignal.timeout(60000)
    });
    const job = await create.json().catch(() => null);
    if (!job || (!create.ok && create.status !== 202)) {
      return { success: false, error: `xKiro HTTP ${create.status}: ${String(JSON.stringify(job)).slice(0, 140)}` };
    }
    const id = job.id;
    if (!id) return { success: false, error: 'xKiro khÃ´ng tráº£ job id' };
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const st = await fetch(`https://api.xkiro.com/v1/images/generations/${id}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
      });
      const sd = await st.json().catch(() => null);
      if (!sd) continue;
      if (sd.status === 'succeeded' || sd.status === 'completed') {
        const url = (sd.data && sd.data[0] && sd.data[0].url) || sd.url;
        if (!url) return { success: false, error: 'xKiro khÃ´ng tráº£ url áº£nh' };
        const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!img.ok) return { success: false, error: `Táº£i áº£nh xKiro HTTP ${img.status}` };
        const mime = (img.headers.get('content-type') || 'image/png').split(';')[0];
        const buf = Buffer.from(await img.arrayBuffer());
        if (!buf.length) return { success: false, error: 'áº¢nh xKiro rá»—ng' };
        return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'xkiro' };
      }
      if (sd.status === 'failed' || sd.status === 'error') {
        return { success: false, error: 'xKiro job tháº¥t báº¡i: ' + String(JSON.stringify(sd)).slice(0, 140) };
      }
    }
    return { success: false, error: 'xKiro timeout chá» áº£nh' };
  } catch (e) {
    console.log('[generate-image] xKiro error:', e.message);
    return { success: false, error: e.message };
  }
}

async function generateImageHF(prompt, size = 1024) {
  const token = (process.env.HF_TOKEN || '').trim();
  if (!token) return { success: false, error: 'ChÆ°a cáº¥u hÃ¬nh HF_TOKEN' };
  try {
    const r = await fetch('https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: String(prompt).slice(0, 800) }),
      signal: AbortSignal.timeout(180000)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { success: false, error: `HF HTTP ${r.status}: ${String(t).slice(0, 140)}` };
    }
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return { success: false, error: 'HF khÃ´ng tráº£ áº£nh' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { success: false, error: 'HF tráº£ áº£nh rá»—ng' };
    return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'huggingface' };
  } catch (e) {
    console.log('[generate-image] HF error:', e.message);
    return { success: false, error: e.message };
  }
}

// â”€â”€â”€ NVIDIA FLUX.1-dev (build.nvidia.com) â”€â”€â”€
// QA 28/9: POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev â†’
// HTTP 200, JSON { artifacts: [{ base64 }] } (áº£nh JPEG, Ä‘Ã´i khi PNG). Key Ä‘á»c tá»«
// DB (khoa_api, 'nvidia', Ä‘Ã£ mÃ£ hÃ³a) â†’ fallback env NVIDIA_API_KEY. ÄÃ£ verify:
// 3 key khÃ¡c nhau Ä‘á»u tráº£ áº£nh ~44-46KB; flux.1-schnell validate Ä‘Æ°á»£c nhÆ°ng
// generation TREO vÃ´ háº¡n (>300s) nÃªn chá»‰ dÃ¹ng flux.1-dev.
async function generateImageNvidia(prompt, size = 1024) {
  try {
    let key = '';
    const row = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'nvidia' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1", [], (e, r) => resolve(r));
    });
    if (row) { try { key = decryptKey(row.gia_tri_khoa).trim(); } catch (e) { key = ''; } }
    if (!key) key = (process.env.NVIDIA_API_KEY || '').trim();
    if (!key) return { success: false, error: 'KhÃ´ng cÃ³ key NVIDIA (DB/env)' };
    const dim = Math.max(256, Math.min(1024, Number(size) || 1024));
    const r = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: String(prompt).slice(0, 800), mode: 'base', cfg_scale: 3.5, width: dim, height: dim, seed: 0, steps: 10 }),
      signal: AbortSignal.timeout(180000)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { success: false, error: `NVIDIA HTTP ${r.status}: ${String(t).slice(0, 140)}` };
    }
    const data = await r.json().catch(() => null);
    const b64 = data && data.artifacts && data.artifacts[0] && data.artifacts[0].base64;
    if (!b64) return { success: false, error: 'NVIDIA khÃ´ng tráº£ artifacts[0].base64' };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { success: false, error: 'NVIDIA tráº£ áº£nh rá»—ng' };
    // Nháº­n diá»‡n mime theo magic bytes (NVIDIA thÆ°á»ng tráº£ JPEG).
    const mime = (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'image/jpeg';
    return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'nvidia' };
  } catch (e) {
    console.log('[generate-image] NVIDIA error:', e.message);
    return { success: false, error: e.message };
  }
}

async function generateImageFallback(prompt, size = 1024) {
  const xk = await generateImageXkiro(prompt);
  if (xk.success) return xk;
  const nv = await generateImageNvidia(prompt, size);
  if (nv.success) return nv;
  const hf = await generateImageHF(prompt, size);
  if (hf.success) return hf;
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).slice(0, 800))}?width=${size}&height=${size}&nologo=true&model=flux`;
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return { success: false, error: `Provider dá»± phÃ²ng HTTP ${r.status}` };
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return { success: false, error: 'Provider dá»± phÃ²ng khÃ´ng tráº£ áº£nh' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { success: false, error: 'Provider dá»± phÃ²ng tráº£ áº£nh rá»—ng' };
    return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'pollinations' };
  } catch (e) {
    console.log('[generate-image] fallback error:', e.message);
    return { success: false, error: e.message };
  }
}

router.post('/generate-image', authMiddleware, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.json({ success: false, error: 'Vui lÃ²ng nháº­p mÃ´ táº£ áº£nh cáº§n táº¡o.' });
  }
  const cleanPrompt = prompt.trim().slice(0, 1000);
  try {
    const keyRow = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'gemini'", [], (err, row) => resolve(row));
    });
    // P1-12: key lÆ°u mÃ£ hÃ³a â€” pháº£i decryptKey; key rá»—ng thÃ¬ bÃ¡o chÆ°a cÃ i (khÃ´ng gá»i API vá»›i ciphertext)
    let gemKey = '';
    try {
      gemKey = keyRow && keyRow.gia_tri_khoa ? decryptKey(keyRow.gia_tri_khoa).trim() : '';
    } catch (e) {
      console.log('[generate-image] decryptKey error:', e.message);
      gemKey = '';
    }
    if (!gemKey) {
      // QA 18/9: khÃ´ng cÃ³ key Gemini â†’ thá»­ OpenRouter (image free) rá»“i tá»›i provider miá»…n phÃ­
      const or1 = await generateImageOpenRouter(cleanPrompt);
      if (or1.success) return res.json(or1);
      const fb = await generateImageFallback(cleanPrompt);
      return res.json(fb);
    }
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(gemKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: cleanPrompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] }
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await resp.json();
    if (!resp.ok) {
      const msg = data.error?.message || ('HTTP ' + resp.status);
      // QA 17/9: 429 = háº¿t quota key free â†’ tá»± chuyá»ƒn provider áº£nh miá»…n phÃ­ thay vÃ¬
      // tráº£ lá»—i cá»©ng (trÆ°á»›c Ä‘Ã¢y tÃ­nh nÄƒng táº¡o áº£nh cháº¿t háº³n khi quota Gemini cáº¡n).
      if (resp.status === 429 || resp.status === 503) {
        // QA 18/9: háº¿t quota Gemini â†’ thá»­ OpenRouter (image free) trÆ°á»›c khi rÆ¡i provider miá»…n phÃ­
        const or2 = await generateImageOpenRouter(cleanPrompt);
        if (or2.success) return res.json(or2);
        const fb = await generateImageFallback(cleanPrompt);
        if (fb.success) return res.json(fb);
        return res.json({ success: false, error: 'âš ï¸ Gemini háº¿t quota, OpenRouter vÃ  provider dá»± phÃ²ng cÅ©ng lá»—i (OR: ' + String(or2.error || '').slice(0, 80) + ' | FB: ' + String(fb.error || '').slice(0, 80) + ')' });
      }
      const friendly = resp.status === 400
        ? 'âš ï¸ Gemini tá»« chá»‘i ná»™i dung nÃ y (bá»™ lá»c an toÃ n). Vui lÃ²ng mÃ´ táº£ khÃ¡c.'
        : (resp.status === 429 ? 'âš ï¸ Gemini Ä‘ang Táº M Háº¾T QUOTA (rate limit). Vui lÃ²ng thá»­ láº¡i sau vÃ i phÃºt.' : 'Lá»—i Gemini: ' + msg);
      return res.json({ success: false, error: friendly });
    }
    const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (part && part.inlineData && part.inlineData.data) {
      const mime = part.inlineData.mimeType || 'image/png';
      return res.json({ success: true, image: `data:${mime};base64,${part.inlineData.data}`, mimeType: mime, provider: 'gemini' });
    }
    // Gemini tráº£ rá»—ng (bá»™ lá»c/khoÃ¡ model) â†’ thá»­ OpenRouter rá»“i tá»›i Ä‘Æ°á»ng dá»± phÃ²ng
    const orEmpty = await generateImageOpenRouter(cleanPrompt);
    if (orEmpty.success) return res.json(orEmpty);
    const fbEmpty = await generateImageFallback(cleanPrompt);
    return res.json(fbEmpty);
  } catch (e) {
    console.log('[generate-image] ERROR:', e.message);
    const orErr = await generateImageOpenRouter(cleanPrompt);
    if (orErr.success) return res.json(orErr);
    const fb = await generateImageFallback(cleanPrompt);
    if (fb.success) return res.json(fb);
    return res.json({ success: false, error: 'Lá»—i káº¿t ná»‘i Gemini: ' + e.message });
  }
});


// ========== RAG â€” Äá»ŒC & HIá»‚U FILE (PDF/Word/TXT) ==========
// Upload file â†’ trÃ­ch xuáº¥t text â†’ vector hÃ³a â†’ AI tráº£ lá»i dá»±a trÃªn ná»™i dung file
const ragUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.post('/documents/upload', authMiddleware, ragUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Vui lÃ²ng chá»n file Ä‘á»ƒ upload.' });
    const ext = (req.file.originalname.match(/\.(txt|md|csv|json|js|py|jsx|ts|tsx|html|css|sql|sh|xml|yml|yaml|ini|log|xlsx|pdf|docx)$/i) || [])[1];
    if (!ext) return res.status(400).json({ error: 'Chá»‰ há»— trá»£: TXT, MD, CSV, JSON, XLSX, PDF, DOCX, code files... Vui lÃ²ng chá»n file khÃ¡c.' });
    const result = await ragService.saveDocument(req.user.id, req.file.originalname, req.file.buffer);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (e) {
    console.log('[RAG] upload error:', e.message);
    res.status(500).json({ error: 'Lá»—i xá»­ lÃ½ file: ' + e.message });
  }
});

router.get('/documents', authMiddleware, async (req, res) => {
  try {
    const docs = await ragService.listDocuments(req.user.id);
    res.json({ success: true, documents: docs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/documents/:id', authMiddleware, async (req, res) => {
  try {
    const ok = await ragService.deleteDocument(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'KhÃ´ng tÃ¬m tháº¥y tÃ i liá»‡u.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== CHáº Y CODE TRONG CHAT (sandbox, ADMIN ONLY â€” P0-01) ==========
router.post('/exec-code', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { language, code } = req.body;
    if (!code || !String(code).trim()) return res.status(400).json({ error: 'Code trá»‘ng.' });
    const { runCode } = require('../services/codeRunner');
    const result = await runCode(language, code);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Lá»—i cháº¡y code: ' + e.message });
  }
});

// ========== EXPORT Há»˜I THOáº I (TXT / DOCX) ==========
router.get('/conversations/:id/export', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // P1-09: cháº·n IDOR â€” chá»‰ chá»§ sá»Ÿ há»¯u (hoáº·c admin) má»›i Ä‘Æ°á»£c export
    const ownerErr = await assertConvOwner(id, req);
    if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });
    const fmt = (req.query.format || 'txt').toLowerCase();
    const conv = await new Promise((resolve) => db.get('SELECT tieu_de FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?', [id], (e, r) => resolve(r)));
    const msgs = await new Promise((resolve) => db.all("SELECT vai_tro, noi_dung, ngay_gui FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC", [id], (e, r) => resolve(r || [])));
    if (!msgs.length) return res.status(404).json({ error: 'KhÃ´ng cÃ³ tin nháº¯n trong há»™i thoáº¡i.' });
    const title = (conv && conv.tieu_de) || 'Há»™i thoáº¡i';
    const lines = msgs.map(m => `[${(m.vai_tro === 'user' ? 'Báº¡n' : 'Rexi')} - ${(m.ngay_gui || '').substring(0, 19)}]\n${m.noi_dung}\n`);
    const text = `Há»˜I THOáº I: ${title}\n${'='.repeat(40)}\n\n` + lines.join('\n');
    if (fmt === 'docx') {
      const { Document, Packer, Paragraph } = require('docx');
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: `Há»˜I THOáº I: ${title}`, heading: 'Heading1' }),
            ...msgs.map(m => new Paragraph({
              children: [
                { text: (m.vai_tro === 'user' ? 'ðŸ‘¤ Báº¡n' : 'ðŸ¤– Rexi') + ' (' + (m.ngay_gui || '').substring(0, 19) + '):\n', bold: true },
                { text: String(m.noi_dung || '') }
              ]
            }))
          ]
        }]
      });
      const buf = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="hoi_thoai_${id.substring(0, 8)}.docx"`);
      return res.send(Buffer.from(buf));
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hoi_thoai_${id.substring(0, 8)}.txt"`);
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: 'Lá»—i export: ' + e.message });
  }
});

// ========== GIáº¢I MÃƒ QR / BARCODE TRONG áº¢NH (0 dependency) ==========
router.post('/qr', async (req, res) => {
  try {
    const { name, base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 required' });
    let buf;
    try { buf = Buffer.from(String(base64), 'base64'); } catch { return res.status(400).json({ error: 'bad base64' }); }
    if (!buf.length || buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'áº£nh trá»‘ng hoáº·c > 12MB' });
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
    if (!isPng && !/\.png$/i.test(String(name || ''))) return res.json({ ok: true, values: [], note: 'chá»‰ há»— trá»£ PNG' });
    const out = require('../utils/qr').decodeQR(buf);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'qr: ' + e.message });
  }
});

// ========== CHIA Sáºº Há»˜I THOáº I (link) ==========
router.post('/conversations/:id/share', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // P1-09: cháº·n IDOR â€” chá»‰ chá»§ sá»Ÿ há»¯u (hoáº·c admin) má»›i Ä‘Æ°á»£c táº¡o link chia sáº»
    const ownerErr = await assertConvOwner(id, req);
    if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });
    const crypto = require('crypto');
    const token = crypto.randomBytes(6).toString('hex');
    // P2-20(8): báº£ng chia_se_hoi_thoai Ä‘Ã£ táº¡o á»Ÿ init-db.js â€” khÃ´ng CREATE á»Ÿ Ä‘Ã¢y ná»¯a
    await new Promise((resolve) => db.run('INSERT INTO chia_se_hoi_thoai (ma_chia_se, ma_hoi_thoai) VALUES (?, ?)', [token, id], resolve));
    res.json({ success: true, share_token: token, share_url: `/api/services/share/${token}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public â€” xem há»™i thoáº¡i chia sáº» (khÃ´ng cáº§n Ä‘Äƒng nháº­p)
router.get('/share/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const row = await new Promise((resolve) => db.get('SELECT ma_hoi_thoai FROM chia_se_hoi_thoai WHERE ma_chia_se = ?', [token], (e, r) => resolve(r)));
    if (!row) return res.status(404).json({ error: 'Link chia sáº» khÃ´ng tá»“n táº¡i hoáº·c Ä‘Ã£ háº¿t háº¡n.' });
    const msgs = await new Promise((resolve) => db.all("SELECT vai_tro, noi_dung, ngay_gui FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC", [row.ma_hoi_thoai], (e, r) => resolve(r || [])));
    res.json({ success: true, messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== THá»NG KÃŠ CÃ NHÃ‚N ==========
router.get('/stats/me', authMiddleware, async (req, res) => {
  try {
    const uid = req.user ? req.user.id : 'guest';
    const convCount = await new Promise((resolve) => db.get("SELECT COUNT(*) c FROM cuoc_hoi_thoai WHERE ma_nguoi_dung = ?", [uid], (e, r) => resolve(r ? r.c : 0)));
    const msgCount = await new Promise((resolve) => db.get("SELECT COUNT(*) c FROM tin_nhan tn JOIN cuoc_hoi_thoai ch ON ch.ma_hoi_thoai = tn.ma_hoi_thoai WHERE ch.ma_nguoi_dung = ?", [uid], (e, r) => resolve(r ? r.c : 0)));
    const userMsgs = await new Promise((resolve) => db.get("SELECT COUNT(*) c FROM tin_nhan tn JOIN cuoc_hoi_thoai ch ON ch.ma_hoi_thoai = tn.ma_hoi_thoai WHERE ch.ma_nguoi_dung = ? AND tn.vai_tro = 'user'", [uid], (e, r) => resolve(r ? r.c : 0)));
    const aiMsgs = await new Promise((resolve) => db.get("SELECT COUNT(*) c FROM tin_nhan tn JOIN cuoc_hoi_thoai ch ON ch.ma_hoi_thoai = tn.ma_hoi_thoai WHERE ch.ma_nguoi_dung = ? AND tn.vai_tro = 'assistant'", [uid], (e, r) => resolve(r ? r.c : 0)));
    const perDay = await new Promise((resolve) => db.all("SELECT date(tn.ngay_gui) ngay, COUNT(*) c FROM tin_nhan tn JOIN cuoc_hoi_thoai ch ON ch.ma_hoi_thoai = tn.ma_hoi_thoai WHERE ch.ma_nguoi_dung = ? AND tn.vai_tro = 'user' GROUP BY date(tn.ngay_gui) ORDER BY ngay DESC LIMIT 7", [uid], (e, r) => resolve(r || [])));
    res.json({ success: true, stats: { tong_hoi_thoai: convCount, tong_tin_nhan: msgCount, tin_cua_ban: userMsgs, tin_cua_ai: aiMsgs, '7_ngay_gan_nhat': perDay } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== NHáº®C VIá»†C THÃ”NG MINH ==========
// P2-20(8): báº£ng lich_nhac/thong_bao Ä‘Ã£ táº¡o á»Ÿ init-db.js â€” bá» IIFE CREATE ráº£i rÃ¡c.

router.post('/reminders', authMiddleware, async (req, res) => {
  try {
    const { noi_dung, thoi_gian } = req.body;
    if (!noi_dung || !thoi_gian) return res.status(400).json({ error: 'Thiáº¿u ná»™i dung hoáº·c thá»i gian nháº¯c.' });
    const crypto = require('crypto');
    const ma = crypto.randomUUID();
    await new Promise((resolve) => db.run('INSERT INTO lich_nhac (ma_nhac, ma_nguoi_dung, noi_dung, thoi_gian) VALUES (?, ?, ?, ?)', [ma, req.user.id, noi_dung, thoi_gian], resolve));
    res.json({ success: true, ma_nhac: ma, noi_dung, thoi_gian });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/reminders', authMiddleware, async (req, res) => {
  try {
    const rows = await new Promise((resolve) => db.all('SELECT ma_nhac, noi_dung, thoi_gian, da_nhac FROM lich_nhac WHERE ma_nguoi_dung = ? ORDER BY thoi_gian ASC', [req.user.id], (e, r) => resolve(r || [])));
    res.json({ success: true, reminders: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/reminders/:id', authMiddleware, async (req, res) => {
  try {
    await new Promise((resolve) => db.run('DELETE FROM lich_nhac WHERE ma_nhac = ? AND ma_nguoi_dung = ?', [req.params.id, req.user.id], resolve));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const rows = await new Promise((resolve) => db.all('SELECT ma_tb, noi_dung, ngay_tao FROM thong_bao WHERE ma_nguoi_dung = ? AND da_doc = 0 ORDER BY ngay_tao DESC LIMIT 20', [req.user.id], (e, r) => resolve(r || [])));
    res.json({ success: true, notifications: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== NHáº¬T KÃ HOáº T Äá»˜NG (báº£o máº­t) ==========
// P2-20(8): báº£ng nhat_ky Ä‘Ã£ táº¡o á»Ÿ init-db.js â€” bá» IIFE CREATE ráº£i rÃ¡c.

router.get('/admin/logs', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const rows = await new Promise((resolve) => db.all('SELECT ma_nguoi_dung, hanh_dong, chi_tiet, ngay_tao FROM nhat_ky ORDER BY ngay_tao DESC LIMIT 100', [], (e, r) => resolve(r || [])));
    res.json({ success: true, logs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== OPENSHORTS â€” cáº¯t video dÃ i thÃ nh Shorts (hosted api.openshorts.app, quota free 20 phÃºt/thÃ¡ng) ==========
const OPENSHORTS_BASE = 'https://api.openshorts.app';

async function openShortsFetch(pathname, init = {}) {
  const key = process.env.OPENSHORTS_API_KEY;
  if (!key) { const err = new Error('Server chÆ°a cáº¥u hÃ¬nh OPENSHORTS_API_KEY'); err.status = 503; throw err; }
  const r = await fetch(OPENSHORTS_BASE + pathname, {
    ...init,
    headers: { 'Authorization': 'Bearer ' + key, ...(init.headers || {}) }
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const msg = (data && (typeof data.detail === 'string' ? data.detail : (data.error || data.detail && JSON.stringify(data.detail)))) || ('OpenShorts HTTP ' + r.status);
    const err = new Error(msg); err.status = r.status; err.data = data; throw err;
  }
  return data;
}

// Gá»­i job cáº¯t video (chá»‰ nháº­n URL YouTube â€” hosted plan khÃ´ng cho upload qua proxy)
router.post('/openshorts/process', authMiddleware, rateLimit({ windowMs: 3600000, max: 5, message: 'Báº¡n Ä‘Ã£ gá»­i 5 job OpenShorts trong giá» nÃ y. Quota miá»…n phÃ­ cÃ³ háº¡n, Ä‘á»£i chÃºt nhÃ©.' }), async (req, res) => {
  try {
    const { url, target_clips, captions, auto_hook, force_low_quality, layouts, clip_min_seconds, clip_max_seconds, max_minutes } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: 'Thiáº¿u URL video há»£p lá»‡ (https://...)' });
    const body = { url: String(url), acknowledged: 'true' };
    if (target_clips) body.target_clips = String(target_clips);
    if (captions != null) body.captions = String(captions);
    if (auto_hook != null) body.auto_hook = String(auto_hook);
    if (force_low_quality != null) body.force_low_quality = String(force_low_quality);
    if (layouts) body.layouts = String(layouts);
    if (clip_min_seconds) body.clip_min_seconds = String(clip_min_seconds);
    if (clip_max_seconds) body.clip_max_seconds = String(clip_max_seconds);
    if (max_minutes) body.max_minutes = String(max_minutes);
    const data = await openShortsFetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    res.json({ success: true, job: data });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Tráº¡ng thÃ¡i job + danh sÃ¡ch clip Ä‘Ã£ cáº¯t
router.get('/openshorts/status/:jobId', authMiddleware, rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  try {
    const data = await openShortsFetch('/api/status/' + encodeURIComponent(req.params.jobId));
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Quota / thÃ´ng tin gÃ³i hiá»‡n táº¡i (sá»‘ phÃºt cÃ²n láº¡i...)
router.get('/openshorts/quota', authMiddleware, async (req, res) => {
  try {
    const me = await openShortsFetch('/api/me');
    res.json({ success: true, me });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â• VIDEO EDIT (FFmpeg) â€” dá»±ng/sá»­a video (tab + agent) â•â•â•â•â•â•â•â•â•â•â•
const { videoEdit, TEMP_DIR: VIDEO_TEMP_DIR } = require('../services/videoEdit');

function tokenFromQuery(req, res, next) {
  if (!req.headers.authorization && req.query.token) req.headers.authorization = 'Bearer ' + req.query.token;
  next();
}

// POST /services/video/edit  { operation, input|inputs, ...params }
router.post('/video/edit', authMiddleware, async (req, res) => {
  try {
    const r = await videoEdit(req.body || {});
    if (!r.success) return res.status(400).json(r);
    const base = (process.env.FRONTEND_URL || 'https://rexiai.bot.cd').replace(/\/$/, '');
    res.json({ ...r, url: `${base}/api/services/video/file/${r.fileName}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /services/video/file/:name â€” táº£i file Ä‘Ã£ edit (Bearer header hoáº·c ?token=)
router.get('/video/file/:name', tokenFromQuery, authMiddleware, (req, res) => {
  const name = path.basename(req.params.name);
  const fp = path.join(VIDEO_TEMP_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'KhÃ´ng tháº¥y file' });
  res.sendFile(fp);
});

// â•â•â•â•â•â•â•â•â•â•â• OPENCUT BRIDGE (extension polling) â•â•â•â•â•â•â•â•â•â•â•
const opencutBridge = require('../services/opencutBridge');

// Extension poll láº¥y lá»‡nh (vÃ  bÃ¡o cÃ²n sá»‘ng + cÃ³ tab OpenCut)
router.post('/opencut-bridge/poll', tokenFromQuery, authMiddleware, (req, res) => {
  res.json({ commands: opencutBridge.poll(req.body && req.body.hasTab) });
});
// Extension tráº£ káº¿t quáº£
router.post('/opencut-bridge/result', tokenFromQuery, authMiddleware, (req, res) => {
  res.json(opencutBridge.submitResult(req.body || {}));
});
// Tráº¡ng thÃ¡i cáº§u ná»‘i
router.get('/opencut-bridge/status', tokenFromQuery, authMiddleware, (req, res) => {
  res.json(opencutBridge.status());
});
// Chá»¥p mÃ n hÃ¬nh OpenCut (qua extension) â€” tráº£ dataURL PNG
router.post('/opencut-bridge/shot', tokenFromQuery, authMiddleware, async (req, res) => {
  const r = await opencutBridge.enqueue('screenshot', {}, 20000);
  res.json(r);
});
// Agent AN TOÃ€N cho OpenCut â€” CHá»ˆ má»Ÿ tool opencut_act, cho Má»ŒI user Ä‘Ã£ Ä‘Äƒng nháº­p (khÃ´ng cáº§n admin)
router.post('/opencut-bridge/ask', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Thiáº¿u message' });
    const { runInternalAgent } = require('../services/internalAgent');
    const result = await runInternalAgent(
      `Báº¡n há»— trá»£ ngÆ°á»i dÃ¹ng Ä‘iá»u khiá»ƒn tab OpenCut cá»§a CHÃNH Há»Œ qua tool opencut_act (extension cá»§a há» Ä‘Ã£ káº¿t ná»‘i vá»›i server). Thá»±c hiá»‡n yÃªu cáº§u sau: ${String(message).trim()}`,
      { allowedTools: ['opencut_act'] }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload file nguá»“n cho dá»±ng video (lÆ°u temp, tráº£ path server dÃ¹ng cho /video/edit)
const videoUpload = multer({ dest: path.join(__dirname, '..', '..', 'temp'), limits: { fileSize: 200 * 1024 * 1024 } });
router.post('/video/upload', authMiddleware, videoUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ChÆ°a cÃ³ file' });
    const ext = (path.extname(req.file.originalname) || '.mp4').toLowerCase();
    const dest = path.join(VIDEO_TEMP_DIR, 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext);
    try { fs.renameSync(req.file.path, dest); } catch (e) { fs.copyFileSync(req.file.path, dest); try { fs.unlinkSync(req.file.path); } catch (e2) {} }
    res.json({ success: true, path: dest, name: path.basename(dest), sizeBytes: req.file.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

