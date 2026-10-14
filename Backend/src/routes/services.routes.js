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

// QA 18/9: tạo ảnh qua OpenRouter (models image-output:free) — chen giữa Gemini và
// provider miễn phí trong chain của /generate-image. Trả { success, image, provider }.
async function generateImageOpenRouter(prompt) {
  try {
    const keyRows = await new Promise((resolve) => {
      db.all("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'openrouter' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> ''", [], (e, rows) => resolve(rows || []));
    });
    if (!keyRows.length) return { success: false, error: 'Không có key OpenRouter trong DB' };
    let orKey = '';
    try { orKey = decryptKey(keyRows[0].gia_tri_khoa).trim(); } catch (e) { orKey = ''; }
    if (!orKey) return { success: false, error: 'Giải mã key OpenRouter thất bại' };
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
        lastErr = `${model} không trả ảnh${typeof msg.content === 'string' ? ' (trả text)' : ''}`;
      } catch (e) { lastErr = e.message; }
    }
    return { success: false, error: lastErr || 'OpenRouter không trả ảnh' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Multer: Lưu file audio tạm thời vào thư mục temp
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'temp')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.webm';
      cb(null, `caption_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // P2-20(5): 50MB → 25MB max (multer này chỉ dùng cho /transcribe)
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/webm', 'audio/mp3', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/x-wav', 'audio/x-m4a'];
    // P2-audit: nhiều client (curl, upload từ app lạ) gửi file audio với Content-Type
    // application/octet-stream → bị chặn ở đây trước khi handler kịp sniff theo đuôi file.
    // Chấp nhận octet-stream khi ĐUÔI file là audio — handler sẽ map mimetype theo đuôi.
    const AUDIO_EXT = ['.wav', '.mp3', '.webm', '.m4a', '.mp4', '.ogg', '.opus', '.oga', '.flac', '.amr', '.aac'];
    if (allowedTypes.includes(file.mimetype)
      || file.mimetype.startsWith('audio/')
      || (file.mimetype === 'application/octet-stream' && AUDIO_EXT.includes(path.extname(file.originalname || '').toLowerCase()))) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file audio (mp3, wav, webm, m4a, ogg, mp4)'), false);
    }
  }
});

// Khởi tạo Groq client
// NOTE FOR AI AGENTS & DEVELOPERS: API Key của Groq được lưu trữ trực tiếp trong Cơ sở dữ liệu SQLite
// ở bảng `khoa_api` (cột `ten_nha_cung_cap` = 'groq', đã mã hóa). Hàm getGroqClient() sẽ ưu tiên lấy từ DB
// nếu file .env không có `GROQ_API_KEY`. Vì vậy key đã sẵn có trong DB mà không cần khai báo trong .env!
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

// P2-20(5): bọc promise thêm timeout (Groq SDK không phải lúc nào cũng nhận AbortSignal)
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'Yêu cầu') + ` quá thời gian (${Math.round(ms / 1000)}s). Vui lòng thử lại với file ngắn hơn.`)), ms)),
  ]);
}

// Khởi tạo Gemini client (key từ DB — bảng khoa_api, ten_nha_cung_cap = 'gemini')
// Dùng làm FALLBACK khi Groq hết quota/lỗi — đảm bảo Tóm tắt AI luôn hoạt động.
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

// Dịch bất kỳ ngôn ngữ → tiếng Việt.
// Google Translate free bị CHẶN từ IP datacenter (Render trả HTML consent) → fallback
// LLM dùng key sẵn trong khoa_api (Groq → Gemini). Nếu văn bản đã là tiếng Việt thì trả y nguyên.
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
  } catch (e) { /* Google chặn/không JSON → rơi xuống LLM */ }
  const prompt = `Dịch đoạn văn bản sau sang tiếng Việt tự nhiên, giữ nguyên ý nghĩa. Nếu văn bản ĐÃ LÀ tiếng Việt thì trả lại y nguyên. CHỈ trả về bản dịch, không giải thích, không thêm bất kỳ chữ nào khác:\n\n${t}`;
  try {
    const groq = await getGroqClient();
    if (groq) {
      const model = process.env.GROQ_TRANSLATE_MODEL || process.env.GROSS_SUMMARY_MODEL || 'openai/gpt-oss-20b';
      const r = await withTimeout(groq.chat.completions.create({
        model, temperature: 0.2, max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }), 60000, 'Dịch');
      const out = String((r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '').trim();
      if (out) return out;
    }
  } catch (e) { console.log('[Translate] Groq error:', e.message); }
  try {
    const genAI = await getGeminiClient();
    if (genAI) {
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_TRANSLATE_MODEL || 'gemini-2.5-flash' });
      const r = await withTimeout(model.generateContent(prompt), 60000, 'Dịch');
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

// ─── P1-09: kiểm tra chủ sở hữu cuộc hội thoại (admin bypass) ───
// Trả null nếu được phép; trả { status, error } nếu bị chặn (404/403/500).
function assertConvOwner(maHoiThoai, req) {
  return new Promise((resolve) => {
    if (req.user && (req.user.role === 'admin' || req.user.phan_quyen === 'admin')) return resolve(null);
    const expectedOwner = req.user ? req.user.id : GUEST_USER_ID;
    db.get("SELECT ma_nguoi_dung FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ? AND ngay_xoa IS NULL", [maHoiThoai], (err, row) => {
      if (err) return resolve({ status: 500, error: err.message });
      if (!row) return resolve({ status: 404, error: 'Không tìm thấy cuộc hội thoại.' });
      if (row.ma_nguoi_dung !== expectedOwner) return resolve({ status: 403, error: 'Không có quyền truy cập cuộc hội thoại này.' });
      resolve(null);
    });
  });
}

// Skills API — Lấy skills đang kích hoạt (public dành cho chat)
router.get('/skills', authMiddleware, (req, res) => {
  db.all("SELECT * FROM ky_nang WHERE trang_thai = 'kich_hoat'", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Skills API — Lấy TẤT CẢ skills (kể cả bị tắt) — dành cho Admin quản lý
router.get('/skills/all', authMiddleware, (req, res) => {
  db.all("SELECT * FROM ky_nang ORDER BY trang_thai DESC, ten_ky_nang ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Skills API — Toggle bật/tắt một skill (Admin only)
router.put('/skills/:id/toggle', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  const { trang_thai } = req.body;
  if (!trang_thai || !['kich_hoat', 'vo_hieu'].includes(trang_thai)) {
    return res.status(400).json({ success: false, error: 'trang_thai phải là "kich_hoat" hoặc "vo_hieu"' });
  }
  db.run('UPDATE ky_nang SET trang_thai = ? WHERE ma_ky_nang = ?', [trang_thai, id], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy kỹ năng' });
    // P1-13: ghi nhật ký ai toggle skill nào
    logActivity(req.user && req.user.id, 'toggle_skill', `${id} -> ${trang_thai}`);
    res.json({ success: true, message: `Đã ${trang_thai === 'kich_hoat' ? 'bật' : 'tắt'} kỹ năng`, trang_thai });
  });
});

// Live Desktop API - Cho mọi user đã đăng nhập (TỐI ƯU HIỆU NĂNG)
// Live Desktop API - Cho mọi user đã đăng nhập (TỐI ƯU HIỆU NĂNG)
const DESKTOP_ONLY_LOCAL = (res) => {
  if (process.platform !== 'win32') {
    res.status(501).json({ success: false, error: 'Remote Desktop chỉ khả dụng khi backend chạy trên Windows local — trên server web tính năng này tắt.' });
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
    res.status(500).json({ error: 'Lỗi chụp màn hình: ' + error.message });
  }
});

router.post('/desktop/click', [authMiddleware, adminMiddleware], (req, res) => {
  if (DESKTOP_ONLY_LOCAL(res)) return;
  const { x_percent, y_percent } = req.body;
  
  // VALIDATE LINH HOẠT: chấp nhận cả số và string number, chặn string chữ
  const x = Number(x_percent);
  const y = Number(y_percent);
  
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x_percent và y_percent phải là số (ví dụ: 0.5)' });
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return res.status(400).json({ error: 'Giá trị percent phải từ 0.0 đến 1.0' });
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
      return res.status(500).json({ error: 'Không thể điều khiển chuột: ' + err.message });
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
      error: 'Không thể lấy dữ liệu thời tiết: ' + err.message,
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
      return res.json({ success: true, symbol: symbol.toUpperCase(), currentPrice: prices[0]?.toFixed(2) || 'N/A', change: '0', changePercent: '0', prices, recommendation: 'FLAT ➡️', source: 'Yahoo Finance' });
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
      recommendation: currentPrice > prevPrice ? 'UP 📈' : (currentPrice < prevPrice ? 'DOWN 📉' : 'FLAT ➡️'),
      source: 'Yahoo Finance'
    });
  } catch (err) {
    res.json({
      success: false,
      error: 'Không thể lấy dữ liệu chứng khoán: ' + err.message,
      symbol: symbol.toUpperCase(),
      source: 'error'
    });
  }
});

// Vietnamese TTS API - Edge TTS WebSocket thuần Node (không cần Python)
// FIX 24/9/2026 (user báo tên giọng "ảo"): danh sách giọng KHÔNG hardcode nữa — lấy
// ĐỘNG từ voices/list thật của Microsoft (xem edgeTTS.listEdgeVoices). Verify 24/9:
// engine trả ĐÚNG 2 giọng vi-VN (id thật): vi-VN-HoaiMyNeural (Female) và
// vi-VN-NamMinhNeural (Male), FriendlyName "Microsoft HoaiMy/NamMinh Online (Natural)".
// Không bịa vùng miền/giới tính; label lấy từ dữ liệu engine.
const EDGE_VOICE_FALLBACK_VI = [
  { id: 'vi-VN-HoaiMyNeural', name: 'HoaiMy', gender: 'Nữ', locale: 'vi-VN', language: 'vi',
    friendlyName: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)' },
  { id: 'vi-VN-NamMinhNeural', name: 'NamMinh', gender: 'Nam', locale: 'vi-VN', language: 'vi',
    friendlyName: 'Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)' },
];
const DEFAULT_TTS_VOICE = 'vi-VN-HoaiMyNeural';
const isEdgeVoiceId = (v) => /^[a-z]{2,3}-[A-Z]{2}-[\w]+Neural$/.test(String(v || ''));

// Chuẩn hóa 1 voice engine → shape FE dùng (id/label/gender/locale). Label lấy từ
// dữ liệu THẬT của engine (name + giới tính + locale), không thêm thông tin bịa.
function toVoiceEntry(v) {
  const label = v.friendlyName
    ? `${v.name || v.id} (${v.gender || '?'}) · ${v.locale}`
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

// Lấy danh sách giọng Edge (thật nếu gọi được, fallback static nếu mạng lỗi).
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

// ── VieNeu-TTS v3 Turbo (20/9/2026) ─────────────────────────────────────────
// Engine OpenAI-compatible tự host (máy local có model): VIENEU_BASE_URL trỏ tới
// `python -m apps.openai_speech` (port 8000). 25 preset giọng Việt 48kHz + cloning.
// Không cấu hình env → app tự dùng edge-tts như cũ. Render free không chạy nổi model.
const VIENEU_BASE_URL = (process.env.VIENEU_BASE_URL || '').trim().replace(/\/$/, '');
const VIENEU_API_KEY = (process.env.VIENEU_API_KEY || 'not-needed').trim();
const VIENEU_TIMEOUT_MS = Number(process.env.VIENEU_TIMEOUT_MS || 120000);

// Preset voices của VieNeu v3 Turbo (GET /v1/voices) — dùng khi server không gọi được /v1/voices
const VIENEU_PRESET_VOICES = [
  'Adam bựa', 'Trúc Ly', 'Anh Khôi', 'Mai Anh', 'Minh Quân Pro', 'Thùy Dung', 'Thiền Tâm Đức',
  'Ngọc Huyền', 'Quang Sơn', 'Ngọc Trân',
  'Minh Đức', 'Phạm Tuyên', 'Xuân Vĩnh', 'Thanh Bình', 'Ngọc Linh', 'Đoan Trang', 'Quỳnh Anh', 'Mạnh Dũng',
  'Thái Sơn', 'Thục Đoan', 'Minh Triết', 'Mỹ Duyên', 'Đức Trí', 'Kim Thanh', 'Adam'
];
const VIENEU_DEFAULT_VOICE = 'Minh Quân Pro';

async function fetchVieNeuVoices() {
  try {
    const res = await fetch(`${VIENEU_BASE_URL}/v1/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.data) && data.data.length) return data.data.map(v => String(v.id || v.name));
  } catch {}
  return null;
}

// Gọi VieNeu OpenAI-compatible POST /v1/audio/speech → Buffer WAV
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
  if (!buf.length) throw new Error('VieNeu trả về audio rỗng');
  return buf;
}

// Map voice Edge cũ (user đã lưu trong localStorage) → giọng VieNeu gần tương đương
const VIENEU_VOICE_ALIAS = {
  'vi-VN-HoaiMyNeural': 'Trúc Ly',
  'vi-VN-NamMinhNeural': 'Minh Quân Pro',
};

// ── ahm7xmakki TTS (provider TTS free, không cần key — CHỈ dùng làm chốt chặn
//    cuối khi Edge TTS/VieNeu đều lỗi) ──────────────────────────────────────
// QA 28/9: POST https://ahm7xmakki.com/api/tts {text, voiceIndex} → audio/mpeg (MP3).
// /api/voices trả 583 giọng; giọng Việt: index 314 HoaiMy (Nữ), 315 NamMinh (Nam).
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
  if (!buf.length) throw new Error('ahm trả về audio rỗng');
  return buf;
}

// ── AuK (Tencent-Hunyuan) — 1.5B foundation model speech generation/editing ──
// Research 1/10/2026 (repo Tencent-Hunyuan/AuK, MIT weights — nhưng encoder
// Qwen2.5-Omni-3B theo Qwen Research License = non-commercial; paper train
// bilingual EN+ZH, tiếng Việt KHÔNG được đảm bảo). Gọi qua Hugging Face Space
// gradio_api (ZeroGPU); anonymous bị space từ chối (event error null — verified
// 1/10) nên BẮT BUỘC cấu hình AUK_HF_TOKEN. Instruct TTS: mô tả giọng, không
// cần audio tham chiếu.
const AUK_SPACE_BASE = (process.env.AUK_SPACE_BASE || 'https://tencent-auk.hf.space').trim().replace(/\/$/, '');
const AUK_HF_TOKEN = (process.env.AUK_HF_TOKEN || '').trim();
const AUK_TIMEOUT_MS = Number(process.env.AUK_TIMEOUT_MS || 180000);

// "Giọng" của AuK = mô tả giọng tự nhiên (Instruct TTS). desc giữ tiếng Anh vì
// model tối ưu EN/ZH — mô tả tiếng Việt có thể bị hiểu sai.
const AUK_VOICE_PRESETS = [
  { id: 'nu-am-diu', label: 'Nữ ấm dịu (warm female)', desc: 'a warm, gentle female voice, calm and clear' },
  { id: 'nam-tram', label: 'Nam trầm chững (deep male)', desc: 'a deep, confident male voice, professional and steady' },
  { id: 'nu-tre-vui', label: 'Nữ trẻ vui (cheerful female)', desc: 'a cheerful young female voice, energetic and bright' },
  { id: 'nam-ke-chuyen', label: 'Nam kể chuyện (storyteller)', desc: 'a calm elderly male storyteller voice, warm and expressive' },
  { id: 'nu-thi-tham', label: 'Nữ thì thầm (whisper)', desc: 'a soft whispering female voice, intimate and quiet' },
];

// Gọi HF Space gradio_api: enqueue → poll SSE → tải file audio → Buffer.
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
  if (!event_id) throw new Error('không nhận được event_id');
  // 2. poll SSE (ZeroGPU queue có thể chờ lâu → timeout rộng)
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
      throw new Error(`space báo lỗi${dv && dv !== '{"error": null}' ? ': ' + dv.substring(0, 160) : ' (kiểm tra token/quota ZeroGPU)'}`);
    }
    if (ev === 'complete') completeData = dv;
  }
  if (!completeData) throw new Error('không có event complete');
  const out = JSON.parse(completeData);
  // 3. tìm FileData audio trong mảng output (shape có thể đổi theo space → dò phòng thủ)
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
  if (!file) throw new Error('không tìm thấy file audio trong kết quả');
  const url = file.url
    ? (file.url.startsWith('http') ? file.url : AUK_SPACE_BASE + file.url)
    : `${AUK_SPACE_BASE}/gradio_api/file=${file.path}`;
  // 4. tải audio
  const audioRes = await fetch(url, { headers: auth, signal: AbortSignal.timeout(60000) });
  if (!audioRes.ok) throw new Error(`tải audio HTTP ${audioRes.status}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  if (!buf.length) throw new Error('audio rỗng');
  return buf;
}

// GET: Lấy danh sách giọng nói TTS tiếng Việt
// VieNeu active (env VIENEU_BASE_URL) → trả 25 preset giọng v3 Turbo; ngược lại 2 giọng Edge.
router.get('/tts/voices', async (req, res) => {
  const { lang, engine: engineQuery } = req.query;
  // FE có thể yêu cầu rõ engine: ?engine=edge-tts buộc trả danh sách Edge dù đã cấu hình VieNeu.
  const wantEdge = String(engineQuery || '').trim().toLowerCase() === 'edge-tts';
  const wantAuk = String(engineQuery || '').trim().toLowerCase() === 'auk';
  const wantAhm = String(engineQuery || '').trim().toLowerCase() === 'ahm';
  // Engine ahm7xmakki — TTS free (không key), giọng Việt (583 giọng, vi: index 314/315).
  if (wantAhm) {
    return res.json({
      success: true,
      engine: 'ahm',
      provider: 'ahm7xmakki (free TTS)',
      voice_clone: false,
      voices: [
        { id: 'vi-VN-HoaiMyNeural', label: 'HoaiMy (Nữ) · ahm', engine: 'ahm', gender: 'Nữ' },
        { id: 'vi-VN-NamMinhNeural', label: 'NamMinh (Nam) · ahm', engine: 'ahm', gender: 'Nam' },
      ],
      count: 2,
      default: 'vi-VN-HoaiMyNeural',
    });
  }
  // Engine AuK (Tencent-Hunyuan 1.5B): "giọng" = mô tả giọng (Instruct TTS).
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
      note: 'AuK (Tencent) tối ưu cho tiếng Anh/Trung — tiếng Việt có thể chưa ổn định.',
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
    source,                 // 'live' = lấy trực tiếp từ engine, 'fallback' = engine không gọi được
    count: list.length,
    total,                  // tổng số giọng engine có (mọi ngôn ngữ)
    voices: list,
    default: list.some(v => v.id === DEFAULT_TTS_VOICE) ? DEFAULT_TTS_VOICE : (list[0]?.id || null),
  });
});

// GET: Kiểm tra trạng thái TTS service
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
    engine_node: true,               // WebSocket thuần Node — không cần Python
    voices_reachable: reachable,     // gọi được voices/list của engine không?
    total_voices: reachable ? real.length : null,
    voices: viCount,                 // số giọng vi-VN THẬT
    voice_clone: !!VIENEU_BASE_URL,  // Edge TTS công khai KHÔNG clone giọng
    note: VIENEU_BASE_URL
      ? 'VieNeu self-hosted: hỗ trợ clone giọng.'
      : 'Microsoft Edge TTS công khai — không hỗ trợ clone giọng (cần VIENEU_BASE_URL tự host).',
    auk: { engine: 'auk', provider: 'AuK (Tencent-Hunyuan 1.5B)', configured: !!AUK_HF_TOKEN, languages: 'EN/ZH (tiếng Việt chưa đảm bảo)' },
    fallback: 'Web Speech API (browser)'
  });
});

// ═══════════════════════════════════════════════════════════════════
// Engine Edge TTS Thuần Node.js — dùng chung từ src/services/edgeTTS.js
// (WebSocket trực tiếp tới Microsoft Edge TTS, không cần Python)
// ═══════════════════════════════════════════════════════════════════

// Chạy edge-tts Python làm phương án dự phòng
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

// FREE-ALL (QA 22/9/2026): TTS free cho mọi user kể cả khách vãng lai (user yêu cầu)
// — edge-tts/VieNeu đều miễn phí không tốn key, chỉ giữ rateLimit chống abuse.
router.post('/tts', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { text, voice, rate, pitch, engine: engineInput } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Văn bản không được để trống' });
  }

  const maxLength = 1000;
  const trimmedText = text.trim().substring(0, maxLength);
  const voiceInput = String(voice || '').trim();
  // FE chọn engine: 'vieneu' (buộc) | 'edge-tts' (buộc) | '' (mặc định ưu tiên VieNeu nếu có)
  const enginePref = String(engineInput || '').trim().toLowerCase();
  const forceEdge = enginePref === 'edge-tts';
  const forceVieNeu = enginePref === 'vieneu';

  // Engine AuK (Tencent-Hunyuan 1.5B) — Instruct TTS qua HF Space (ZeroGPU).
  // Chưa cấu hình token → báo rõ (KHÔNG lặng lẽ đổi sang Edge) + nhắc giới hạn VN.
  if (enginePref === 'auk') {
    const preset = AUK_VOICE_PRESETS.find(p => p.id === voiceInput);
    const desc = preset ? preset.desc : (voiceInput || AUK_VOICE_PRESETS[0].desc);
    const wantFlash = String(req.body.variant || '').trim().toLowerCase() === 'flash';
    const variant = wantFlash ? 'AuK-Flash ⚡' : 'AuK (Base)';
    // Flash khoá NFE 4 / CFG 0 (theo UI space); Base mặc định 32 / 2.
    const nfe = wantFlash ? 4 : (Number(req.body.nfe) || 32);
    const cfg = wantFlash ? 0 : (Number.isFinite(Number(req.body.cfg)) ? Number(req.body.cfg) : 2);
    if (!AUK_HF_TOKEN) {
      return res.status(503).json({
        success: false,
        engine: 'auk',
        error: 'Engine AuK (Tencent) chưa được cấu hình: thiếu AUK_HF_TOKEN.',
        hint: 'Admin đặt biến môi trường AUK_HF_TOKEN (token Hugging Face có quota ZeroGPU). AuK tối ưu EN/ZH — tiếng Việt có thể chưa ổn định.',
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
        note: 'AuK (Tencent-Hunyuan 1.5B) — tối ưu tiếng Anh/Trung',
      });
    } catch (aukErr) {
      console.error('[TTS] AuK failed:', aukErr.message);
      return res.status(502).json({
        success: false,
        engine: 'auk',
        error: 'AuK lỗi: ' + aukErr.message,
        hint: 'Kiểm tra AUK_HF_TOKEN và quota ZeroGPU của Hugging Face Space Tencent-Hunyuan/AuK.',
      });
    }
  }

  // Engine ahm7xmakki — TTS free (không key) giọng Việt; chốt chặn độc lập với Edge/VieNeu.
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
      return res.status(502).json({ success: false, engine: 'ahm', error: 'ahm TTS lỗi: ' + ahmErr.message });
    }
  }

  // Ưu tiên số 1 khi cấu hình: VieNeu v3 Turbo (tự host, 48kHz) — voice là tên preset có dấu
  // (nhận cả voice Edge cũ qua alias, cả giọng clone đã enroll trên server VieNeu)
  if (VIENEU_BASE_URL && !forceEdge) {
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
      // Người dùng chủ động chọn VieNeu → báo lỗi thật, KHÔNG lặng lẽ đổi sang Edge.
      if (forceVieNeu) {
        console.error('[TTS] VieNeu (forced) failed:', vnErr.message);
        return res.status(502).json({
          success: false,
          engine: 'vieneu',
          error: 'VieNeu tạm thời không phản hồi: ' + vnErr.message,
          hint: 'Engine VieNeu chạy trên máy tự host — kiểm tra server local (port 8124) và tunnel.'
        });
      }
      console.warn('[TTS] VieNeu failed, falling back to Edge TTS:', vnErr.message);
    }
  }

  // Edge TTS (Microsoft) — validate theo danh sách giọng THẬT của engine (không hardcode).
  let edgeVoices = null;
  try { edgeVoices = await listEdgeVoices(); } catch { edgeVoices = null; }
  let voiceName = voiceInput || DEFAULT_TTS_VOICE;
  if (edgeVoices) {
    const realIds = new Set(edgeVoices.map(v => v.id));
    if (!realIds.has(voiceName) && !isEdgeVoiceId(voiceName)) {
      // Không bịa/thay ngầm: báo rõ giọng không tồn tại + gợi ý giọng vi thật.
      return res.status(400).json({
        success: false,
        error: `Giọng "${voiceInput}" không tồn tại trên engine Microsoft Edge TTS.`,
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

    // Gọi trực tiếp Edge TTS WebSocket thuần Node.js (Siêu nhanh 300ms, không cần Python)
    try {
      audioBuffer = await generateEdgeTTSNode(voiceName, trimmedText, validRate, validPitch, voiceLang);
    } catch (wsErr) {
      console.warn('[TTS] Pure Node.js WebSocket failed, trying Python fallback:', wsErr.message);
      // Dự phòng: Thử gọi Python nếu WebSocket gặp sự cố
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

    throw new Error('Không thể tạo âm thanh TTS');
  } catch (err) {
    console.error('[TTS] Error:', err.message);
    // QA 28/9: Edge TTS + Python fallback đều lỗi → thử provider TTS free ahm7xmakki
    // (đã verify trả MP3 tiếng Việt). Không thay đổi hành vi khi Edge chạy bình thường.
    try {
      const ahmBuf = await generateAhmTTS(trimmedText, AHM_TTS_VOICE_INDEX[voiceName]);
      console.warn('[TTS] Edge thất bại, dùng ahm7xmakki fallback.');
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
      console.error('[TTS] ahm fallback cũng lỗi:', ahmErr.message);
    }
    res.status(500).json({
      success: false,
      error: 'Lỗi phát âm thanh: ' + err.message,
      note: 'Dịch vụ giọng nói Microsoft Edge TTS tạm thời gián đoạn.'
    });
  }
});

// Clone giọng (VieNeu): nhận file mẫu 3-8s + văn bản → forward multipart tới
// {VIENEU_BASE_URL}/v1/clone → trả WAV base64 (cùng định dạng với /services/tts).
const cloneUpload = multer({  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // 4/10: một số client (curl Windows, vài trình duyệt) gửi audio với
    // Content-Type application/octet-stream → chấp nhận theo đuôi file nữa.
    const mimeOk = file.mimetype && file.mimetype.startsWith('audio/');
    const extOk = /\.(wav|mp3|m4a|ogg|oga|webm|flac|aac)$/i.test(file.originalname || '');
    if (mimeOk || extOk) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file audio mẫu (wav/mp3/m4a/ogg/webm)'), false);
  }
});
// Bọc single('audio') để lỗi multer/busboy trả JSON 400 rõ ràng thay vì rơi
// vào global error handler (500 mù). 4/10: debug upload flaky.
const uploadAudioSample = (req, res, next) => {
  cloneUpload.single('audio')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: 'Upload lỗi: ' + (err.message || err.code || 'unknown') });
    }
    next();
  });
};

router.post('/tts/clone', rateLimit({ windowMs: 60000, max: 10 }), uploadAudioSample, async (req, res) => {
  try {
    if (!VIENEU_BASE_URL) {
      return res.status(503).json({
        success: false,
        error: 'Clone giọng cần engine VieNeu (VIENEU_BASE_URL chưa được cấu hình trên server).'
      });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, error: 'Thiếu file audio mẫu (3-8 giây).' });
    }
    const cloneText = String(req.body?.text || '').trim().substring(0, 1000);
    if (!cloneText) {
      return res.status(400).json({ success: false, error: 'Thiếu văn bản cần đọc bằng giọng clone.' });
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
      return res.status(502).json({ success: false, engine: 'vieneu', error: 'VieNeu clone trả audio rỗng' });
    }
    return res.json({
      success: true,
      audio: wavBuffer.toString('base64'),
      format: 'wav',
      engine: 'vieneu',
      voice: 'clone',
      voice_label: 'Giọng đã clone',
      text_length: cloneText.length
    });
  } catch (err) {
    console.error('[TTS clone] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Lỗi clone giọng: ' + err.message });
  }
});

// ─── Giọng tùy chỉnh của user ("Giọng của tôi", 4/10) ─────────────────────
// VieNeu /v1/clone là stateless (trả WAV xong xóa mẫu) → muốn TÁI DÙNG giọng
// phải lưu file mẫu. Lưu mẫu vào DB theo user (Render disk ephemeral nên
// không để file local). Có API /:id/speak để đọc văn bản mới bằng giọng đã
// lưu — dùng trong app lẫn gọi từ bên ngoài như API TTS giọng riêng.
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
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024; // mẫu 3-8s wav ~ vài trăm KB

// Lưu mẫu giọng (đặt tên) — cần đăng nhập
router.post('/tts/custom-voices', authMiddleware, rateLimit({ windowMs: 60000, max: 10 }), uploadAudioSample, async (req, res) => {
  try {
    const name = String(req.body?.ten || req.body?.name || '').trim().substring(0, 60);
    if (!name) return res.status(400).json({ success: false, error: 'Thiếu tên giọng (ten).' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, error: 'Thiếu file audio mẫu.' });
    }
    if (req.file.buffer.length > MAX_SAMPLE_BYTES) {
      return res.status(400).json({ success: false, error: 'File mẫu quá lớn (tối đa 2MB, khoảng 3-8 giây).' });
    }
    const id = require('crypto').randomUUID();
    await dbRun(
      'INSERT INTO giong_tuy_chinh (giong_id, ma_nguoi_dung, ten_giong, audio_mime, audio_b64, dung_luong) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.user.id, name, req.file.mimetype || 'audio/wav', req.file.buffer.toString('base64'), req.file.buffer.length]
    );
    return res.json({ success: true, id, ten: name, dung_luong: req.file.buffer.length });
  } catch (err) {
    console.error('[TTS custom-voices] Save error:', err.message);
    return res.status(500).json({ success: false, error: 'Lỗi lưu giọng: ' + err.message });
  }
});

// Danh sách giọng của tôi (không kèm audio)
router.get('/tts/custom-voices', authMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT giong_id AS id, ten_giong AS ten, audio_mime, dung_luong, ngay_tao FROM giong_tuy_chinh WHERE ma_nguoi_dung = ? ORDER BY ngay_tao DESC',
      [req.user.id]
    );
    return res.json({ success: true, voices: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lỗi tải danh sách: ' + err.message });
  }
});

// Tải file mẫu về (để chèn/chế biến chỗ khác)
router.get('/tts/custom-voices/:id/sample', authMiddleware, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT ten_giong, audio_mime, audio_b64 FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?',
      [req.params.id, req.user.id]
    );
    if (!row || !row.audio_b64) return res.status(404).json({ success: false, error: 'Không tìm thấy mẫu giọng.' });
    const buf = Buffer.from(row.audio_b64, 'base64');
    const ext = String(row.audio_mime || '').includes('mp3') || String(row.audio_mime || '').includes('mpeg') ? 'mp3' : 'wav';
    res.setHeader('Content-Type', row.audio_mime || 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="giong-${req.params.id}.${ext}"`);
    return res.send(buf);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lỗi tải mẫu: ' + err.message });
  }
});

// Xóa giọng
router.delete('/tts/custom-voices/:id', authMiddleware, async (req, res) => {
  try {
    await dbRun('DELETE FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?', [req.params.id, req.user.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lỗi xóa: ' + err.message });
  }
});

// Đọc văn bản mới bằng giọng đã lưu — API tái dùng (trong app + gọi ngoài)
router.post('/tts/custom-voices/:id/speak', authMiddleware, rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    if (!VIENEU_BASE_URL) {
      return res.status(503).json({ success: false, error: 'Cần engine VieNeu (VIENEU_BASE_URL chưa cấu hình).' });
    }
    const text = String(req.body?.text || '').trim().substring(0, 1000);
    if (!text) return res.status(400).json({ success: false, error: 'Thiếu text.' });
    const row = await dbGet(
      'SELECT ten_giong, audio_mime, audio_b64 FROM giong_tuy_chinh WHERE giong_id = ? AND ma_nguoi_dung = ?',
      [req.params.id, req.user.id]
    );
    if (!row || !row.audio_b64) return res.status(404).json({ success: false, error: 'Không tìm thấy mẫu giọng.' });
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
    if (!wavBuffer.length) return res.status(502).json({ success: false, engine: 'vieneu', error: 'VieNeu clone trả audio rỗng' });
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
    return res.status(500).json({ success: false, error: 'Lỗi đọc: ' + err.message });
  }
});

const getCountryFlag = (code) => {
  if (!code || code.length !== 2) return '🌐';
  const codePoints = code.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
};

// ============================================================
// HLS Stream Proxy — tránh CORS khi trình duyệt load stream
// Browser gọi: /api/services/iptv/proxy?url=<encoded_stream_url>
// Backend fetch về rồi chuyển tiếp với CORS headers mở
// ============================================================
// P2-19d: proxy yêu cầu đăng nhập. <video>/hls.js không gửi được Authorization
// header → cho phép token qua ?token= (bridge sang header cho authMiddleware).
// FE đã gửi token vào URL proxy (App.jsx playHlsStream, YouTubeTab proxyUrl);
// playlist m3u8 rewrite giữ lại token cho các segment con (qsToken).
// 4/10 FREE-ALL YouTube: khách vãng lai (không token) vẫn xem được qua
// /youtube/proxy nhưng CHỈ với host media đã biết (chống open-proxy).
// /iptv/proxy giữ nguyên: bắt buộc login.
function proxyAuth(req, res, next) {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  return authMiddleware(req, res, next);
}
function youtubeProxyAuth(req, res, next) {
  if (req.headers.authorization || req.query.token) return proxyAuth(req, res, next);
  return next(); // khách: handler /youtube/proxy kiểm tra host allowlist
}
// Guest vẫn xem IPTV được (không token) nhưng limit riêng 30 req/phút/IP
// để chống lạm dụng băng thông — SSRF check trong handler vẫn áp dụng.
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
    // P2-18: check async (literal + DNS resolve) thay vì isPrivateHostname sync
    const check = await assertPublicUrlAsync(targetUrl);
    if (!check.ok) {
      const code = (check.reason === 'URL không hợp lệ' || check.reason === 'Chỉ cho phép http/https') ? 400 : 403;
      return res.status(code).json({ error: check.reason });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  try {
    // Chống SSRF qua redirect: kiểm tra lại địa chỉ mỗi bước (tối đa 5 hops)
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

    // Nếu là file .m3u8 playlist thì rewrite các URL → tuyệt đối qua proxy
    if (contentType.toLowerCase().includes('mpegurl') || effectiveUrl.toLowerCase().endsWith('.m3u8')) {
      let body = await upstream.text();
      // Chuẩn hoá CRLF -> LF (một số server dùng CRLF, regex rewrite sẽ miss)
      if (body.includes('\r\n')) body = body.replace(/\r\n/g, '\n');

      const base = effectiveUrl.substring(0, effectiveUrl.lastIndexOf('/') + 1);
      const origin = new URL(effectiveUrl).origin;
      const toAbsolute = (u) => {
        if (/^https?:\/\//i.test(u)) return u;
        if (u.startsWith('/')) return origin + u;
        return base + u;
      };
      // Giữ ?token= cho segment con (nếu client gọi proxy kèm token qua query)
      const qsToken = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';
      const toProxy = (u) => `${req.protocol}://${req.get('host')}/api/services/iptv/proxy?url=${encodeURIComponent(toAbsolute(u))}${qsToken}`;
      // 1) Rewrite dòng URI thường (segment, variant playlist)
      body = body.replace(/^(?!#)([^\r\n]+)$/gm, (line) => {
        line = line.trim();
        if (!line) return line;
        return toProxy(line);
      });
      // 2) Rewrite URI nằm TRONG dòng #EXT-X-MAP / #EXT-X-KEY / #EXT-X-MEDIA
      //    (init segments fMP4, AES keys, audio/subtitle renditions) — nếu không
      //    proxy, trình duyệt fetch trực tiếp cross-origin → CORS chặn → mất audio.
      body = body.replace(/^(#EXT-X-(?:MAP|KEY|MEDIA)):([^\r\n]*)$/gim, (whole, tag, attrs) => {
        return tag + ':' + attrs.replace(/URI="([^"]*)"/gi, (m, u) => `URI="${toProxy(u)}"`);
      });
      return res.send(body);
    }

    // Dữ liệu nhị phân (ts segments, etc.) — pipe thẳng
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
          const name = lastComma >= 0 ? line.substring(lastComma + 1).trim() : 'Kênh Truyền Hình';

          // Bỏ qua các kênh đã được đánh dấu là Geo-blocked, Not 24/7, Offline, Blocked trong danh sách M3U
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

    // Lọc kênh nước ngoài khi filter quốc gia — chỉ bỏ kênh rõ ràng không phải VN
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

    // Bổ sung các kênh Truyền Hình Việt Nam trực tiếp (VTV, VTC, Tỉnh Thành)
    if (!category && (!country || country.toUpperCase() === 'VN')) {
      const vnDirectChannels = [
        // VTV — nguồn FPTPlay (đang sống 100%)
        { name: 'VTV1 HD - Thời Sự 24/7', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv1/live247-hls-avc/index.m3u8' },
        { name: 'VTV2 HD - Khoa Học & Giáo Dục', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Education', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv2/live247-hls-avc/index.m3u8' },
        { name: 'VTV3 HD - Giải Trí & Thể Thao', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://live.fptplay53.net/live/media/vtv3/live247-hls-avc/index.m3u8' },
        { name: 'VTV4 HD - Đối Ngoại Quốc Tế', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv4/live247-hls-avc/index.m3u8' },
        { name: 'VTV5 HD - Tiếng Dân Tộc', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv5/live247-hls-avc/index.m3u8' },
        { name: 'VTV5 Tây Nam Bộ HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv5tnb/live-hls-avc/index.m3u8' },
        { name: 'VTV5 Tây Nguyên HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://vips-livecdn.fptplay.net/live/media/vtv5tn/live-hls-avc/index.m3u8' },
        { name: 'VTV6 HD - Kênh Thanh Thiếu Niên', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Entertainment', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv6/live247-hls-avc/index.m3u8' },
        { name: 'VTV7 HD - Kênh Giáo Dục Quốc Gia', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'Education', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv7/live247-hls-avc/index.m3u8' },
        { name: 'VTV9 HD - Kênh Nam Bộ', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv9/live247-hls-avc/index.m3u8' },
        { name: 'VTV10 HD - Kênh Đa Nền Tảng', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'General', country: 'VN', url: 'https://live-a.fptplay53.net/live/media/vtv10/live247-hls-avc/index.m3u8' },
        // Các đài khác — nguồn vtvprime (đang sống)
        { name: 'ANTV - Truyền Hình Công An Nhân Dân', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/ANNINHTV/index.m3u8' },
        { name: 'QPVN - Quốc Phòng Việt Nam HD', logo: 'https://i.imgur.com/mgp6RAU.png', group: 'News', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/QPTV/index.m3u8' },
        { name: 'SCTV2 HD', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/SCTV2/index.m3u8' },
        { name: 'HTV Key - Kênh Chìa Khóa Vàng', logo: 'https://i.imgur.com/efrauLr.png', group: 'Entertainment', country: 'VN', url: 'https://liveh12.vtvprime.vn/hls/HTVKey/index.m3u8' },
        // Kênh Tỉnh Thành
        { name: 'Cần Thơ TV1 (1080p)', logo: '', group: 'General', country: 'VN', url: 'https://live.canthotv.vn/live/tv/chunklist.m3u8' },
        { name: 'Cần Thơ TV3 (1080p)', logo: '', group: 'General', country: 'VN', url: 'https://live.canthotv.vn/cs3/tv/chunklist.m3u8' },
        { name: 'Đồng Tháp TV1 (720p)', logo: '', group: 'General', country: 'VN', url: 'https://liveh34.vtvprime.vn/hls/DONGTHAPTV/index.m3u8' },
        { name: 'Thái Nguyên TV (720p)', logo: '', group: 'General', country: 'VN', url: 'https://streaming.thainguyentv.vn/hls/livestream.m3u8' },
        // Kênh quốc tế liên quan VN
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


// Map code -> tên quốc gia
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
  'CI': 'Côte d\'Ivoire', 'SN': 'Senegal', 'ML': 'Mali', 'BJ': 'Benin',
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

// IPTV Countries list - 250+ quốc gia với Mã Quốc Gia (English) + Cờ
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
      console.log('[IPTV] Lỗi fetch countries API, dùng fallback:', e.message);
    }

    if (!countryList.length) {
      countryList = Object.entries(countryNames).map(([code, name]) => ({
        code,
        name,
        flag: getCountryFlag(code)
      }));
    }

    // Ghim VN lên đầu, sau đó sắp xếp theo Tên Quốc Gia (A-Z)
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

// POST /api/office/generate-docx - Tạo file Word từ text (Markdown -> DOCX)
// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE FREE: Xem YouTube không quảng cáo — như Premium free
// ─────────────────────────────────────────────────────────────────────────────
// 20/9/2026: engine đã đổi sang youtube-dl-exec (npm, binary yt-dlp tự tải lúc
// npm install) — KHÔNG cần Python nữa. Sửa lỗi "YouTube chết trên Render free".
// FREE-ALL (QA 22/9/2026): YouTube cho khách vãng lai — gỡ auth khỏi search/stream/status
// (user yêu cầu: không cần đăng nhập vẫn xem được). Giữ rateLimit + proxyAuth ở /proxy.
router.get('/youtube/status', async (req, res) => {
  try {
    const st = await ytdlp.getStatus();
    res.json({
      success: true,
      ...st,
      ffmpegPath: ffmpegPath || null,
      note: !st.ready ? 'Binary yt-dlp chưa tải (npm install lại để postinstall tải binary).' : undefined,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/youtube/search', async (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'Thiếu từ khóa (q)' });
  try {
    const result = await searchVideos(q, parseInt(limit, 10) || 12);
    // searchVideos trả { videos: [...] } — unwrap để FE nhận array (YouTubeTab.jsx:106)
    res.json({ success: true, videos: Array.isArray(result) ? result : (result.videos || []) });
  } catch (e) {
    console.error('[YouTube] Search error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/youtube/stream', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video không hợp lệ (chỉ hỗ trợ YouTube).' });
  try {
    const info = await getVideoStream(url);
    res.json({ success: true, ...info });
  } catch (e) {
    console.error('[YouTube] Stream error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Bình luận video — lấy qua worker (yt-dlp --write-comments, chậm 10-30s), cache 24h in-memory.
// YouTube có thể chặn IP Render nên chạy qua worker (IP nhà) như /stream.
router.get('/youtube/comments', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video không hợp lệ (chỉ hỗ trợ YouTube).' });

  if (!globalThis.__ytCommentsCache) globalThis.__ytCommentsCache = new Map();
  const cacheKey = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');
  // Comment local của app luôn đọc fresh từ DB (không qua cache yt-dlp)
  const localRows = await dbAll(
    'SELECT id, ten_hien_thi AS author, noi_dung AS text, ngay_tao AS time FROM binh_luan_youtube WHERE video_id = ? ORDER BY ngay_tao DESC LIMIT 50',
    [cacheKey]
  ).catch(() => []);
  const localComments = (localRows || []).map((r) => ({
    id: r.id, author: r.author || 'Bạn', text: r.text, likes: 0,
    time: String(r.time || '').substring(0, 10), local: true,
  }));
  const hit = globalThis.__ytCommentsCache.get(cacheKey);
  if (hit && Date.now() - hit.t < 24 * 3600 * 1000) {
    return res.json({ success: true, comments: [...localComments, ...(hit.data.comments || [])], count: hit.data.count, localCount: localComments.length, cached: true });
  }

  try {
    const workerUrl = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
    const workerTok = (process.env.YTDLP_WORKER_TOKEN || '').trim();
    if (!workerUrl) return res.status(503).json({ success: false, error: 'Thiếu worker để lấy bình luận (YTDLP_WORKER_URL).' });
    const resp = await fetch(`${workerUrl}/comments?${workerTok ? `token=${encodeURIComponent(workerTok)}&` : ''}id=${encodeURIComponent(cacheKey)}`, { signal: AbortSignal.timeout(100000) });
    const data = await resp.json();
    if (!data.ok) {
      // Worker thua → vẫn trả comment local (không trắng trang)
      if (localComments.length) return res.json({ success: true, comments: localComments, count: localComments.length, localCount: localComments.length });
      return res.status(500).json({ success: false, error: data.error || 'Lấy bình luận thất bại.' });
    }
    globalThis.__ytCommentsCache.set(cacheKey, { t: Date.now(), data: { comments: data.comments, count: data.count } });
    res.json({ success: true, comments: [...localComments, ...(data.comments || [])], count: data.count, localCount: localComments.length });
  } catch (e) {
    console.error('[YouTube] Comments error:', e.message);
    // Worker/timeout thua → vẫn trả comment local (không trắng trang)
    if (localComments.length) return res.json({ success: true, comments: localComments, count: localComments.length, localCount: localComments.length });
    res.status(500).json({ success: false, error: 'Lỗi lấy bình luận: ' + e.message });
  }
});

// Avatar kênh YouTube thật — qua worker (yt-dlp trang channel → avatar_uncropped).
// Cache 7 ngày in-memory (avatar hiếm khi đổi). FE hiển thị chữ cái trước,
// swap sang ảnh thật khi về (progressive enhancement như YouTube).
if (!globalThis.__ytAvatarCache) globalThis.__ytAvatarCache = new Map();
const YT_AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
router.get('/youtube/channel-avatar', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  let channelId = String(req.query.channel_id || '').trim();
  const videoId = String(req.query.video_id || '').trim();
  // Cache video → channel (24h): resolve qua worker /info chậm ~10-22s và bị gọi
  // lặp lại mỗi lần retry/refresh (avatar grid 16 video). Nhớ map để lần sau ~instant.
  if (!globalThis.__ytVidChannelCache) globalThis.__ytVidChannelCache = new Map();
  const YT_VIDCH_TTL_MS = 24 * 3600 * 1000;
  // Flat search đôi khi trả channel_id rỗng/"NA" → resolve từ video page (luôn có channel_id)
  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    if (!/^[\w-]{6,}$/.test(videoId)) {
      return res.status(400).json({ success: false, error: 'channel_id không hợp lệ.' });
    }
    const vhit = globalThis.__ytVidChannelCache.get(videoId);
    if (vhit && Date.now() - vhit.t < YT_VIDCH_TTL_MS && /^UC[\w-]{20,}$/.test(vhit.id || '')) {
      channelId = vhit.id;
    } else {
      try {
        const workerUrl0 = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
        const workerTok0 = (process.env.YTDLP_WORKER_TOKEN || '').trim();
        if (!workerUrl0) return res.status(503).json({ success: false, error: 'Thiếu worker.' });
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
          return res.status(404).json({ success: false, error: 'Không xác định được kênh của video.' });
        }
      } catch (e) {
        return res.status(502).json({ success: false, error: 'Lỗi resolve kênh: ' + e.message });
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
    if (!workerUrl) return res.status(503).json({ success: false, error: 'Thiếu worker (YTDLP_WORKER_URL).' });
    const resp = await fetch(`${workerUrl}/channel-avatar?${workerTok ? `token=${encodeURIComponent(workerTok)}&` : ''}id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(40000) });
    const data = await resp.json();
    if (!data.ok || !data.avatar_url) return res.status(500).json({ success: false, error: data.error || 'Lấy avatar thất bại.' });
    const out = { channel_id: channelId, avatar_url: data.avatar_url, channel: data.channel || '' };
    globalThis.__ytAvatarCache.set(channelId, { t: Date.now(), data: out });
    if (globalThis.__ytAvatarCache.size > 500) {
      const first = globalThis.__ytAvatarCache.keys().next().value;
      globalThis.__ytAvatarCache.delete(first);
    }
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('[YouTube] Channel-avatar error:', e.message);
    res.status(500).json({ success: false, error: 'Lỗi lấy avatar: ' + e.message });
  }
});

// ─── Bình luận LOCAL (của app, không cần Google OAuth) ─────────────────────
// YouTube Data API đòi OAuth scope youtube.force-ssl + user re-consent nên
// comment app để ở lớp riêng: ai cũng xem/gửi được bình luận ngay trong app,
// không phụ thuộc tài khoản Google. Comment yt-dlp (GET /comments) + comment
// local hiển thị chung trong tab (local ghim lên đầu, có nhãn "trong app").
db.run(`CREATE TABLE IF NOT EXISTS binh_luan_youtube (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  ma_nguoi_dung TEXT NOT NULL,
  ten_hien_thi TEXT,
  noi_dung TEXT NOT NULL,
  ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP
)`, () => {});
db.run('CREATE INDEX IF NOT EXISTS idx_binhluan_video ON binh_luan_youtube (video_id, ngay_tao DESC)', () => {});

// Gửi bình luận LÊN YOUTUBE THẬT qua YouTube Data API (cần Google OAuth scope
// youtube.force-ssl). FE gửi cùng lúc với comment local; không có token liên kết
// thì chỉ lưu local. Access token hết hạn → dùng refresh token để lấy mới.
router.post('/youtube/comments/youtube', authMiddleware, async (req, res) => {
  try {
    const { url, text } = req.body || {};
    if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video không hợp lệ.' });
    const content = String(text || '').trim().slice(0, 2000);
    if (content.length < 1) return res.status(400).json({ success: false, error: 'Bình luận trống.' });
    const vid = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');

    const { decryptKey } = require('../utils/cryptoKeys');
    const row = await dbGet(
      'SELECT access_token, refresh_token, scope FROM google_oauth_tokens WHERE ma_nguoi_dung = ?',
      [req.user.id]
    ).catch(() => null);
    const hasScope = row && String(row.scope || '').includes('youtube.force-ssl');
    if (!row || !hasScope) {
      return res.status(409).json({ success: false, error: 'NO_YOUTUBE_SCOPE', message: 'Chưa liên kết quyền YouTube (đăng nhập Google lại, tick ô YouTube).' });
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
      // Access hết hạn → refresh rồi thử lại 1 lần
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
      if (!tk.access_token) return res.status(401).json({ success: false, error: 'Token Google hết hạn, vui lòng đăng nhập Google lại.' });
      const { encryptKey } = require('../utils/cryptoKeys');
      access = tk.access_token;
      await dbRun('UPDATE google_oauth_tokens SET access_token = ?, ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_nguoi_dung = ?', [encryptKey(access), req.user.id]).catch(() => {});
      r = await doPost(access);
    }
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ success: false, error: `YouTube từ chối (HTTP ${r.status}). ${detail.substring(0, 180)}` });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[YouTube] Comment-to-YouTube error:', e.message);
    res.status(500).json({ success: false, error: 'Lỗi gửi bình luận lên YouTube: ' + e.message });
  }
});
router.post('/youtube/comments/local', authMiddleware, async (req, res) => {
  try {
    const { url, text } = req.body || {};
    if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ success: false, error: 'URL/ID video không hợp lệ.' });
    const content = String(text || '').trim().slice(0, 2000);
    if (content.length < 1) return res.status(400).json({ success: false, error: 'Bình luận trống.' });
    const vid = url.replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, '').replace(/&.*$/, '').replace(/^https?:\/\/youtu\.be\//, '');
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const me = req.user || {};
    const uid = me.ma_nguoi_dung || me.id || 'guest';
    // JWT chỉ chứa {id, role} — JWT payload không có ten_day_du/email → tra DB theo ma_nguoi_dung
    let tenHienThi = me.ten_day_du || me.email || '';
    if (!tenHienThi && uid !== 'guest') {
      try {
        const u = await dbGet('SELECT ten_day_du, email FROM nguoi_dung WHERE ma_nguoi_dung = ?', [uid]);
        if (u) tenHienThi = u.ten_day_du || u.email || '';
      } catch { /* giữ fallback */ }
    }
    tenHienThi = tenHienThi || 'Bạn';
    await dbRun(
      'INSERT INTO binh_luan_youtube (id, video_id, ma_nguoi_dung, ten_hien_thi, noi_dung) VALUES (?, ?, ?, ?, ?)',
      [id, vid, uid, tenHienThi, content]
    );
    res.json({ success: true, comment: { id, author: tenHienThi, text: content, likes: 0, time: new Date().toISOString().substring(0, 10), local: true } });
  } catch (e) {
    console.error('[YouTube] Local comment error:', e.message);
    res.status(500).json({ success: false, error: 'Lỗi gửi bình luận: ' + e.message });
  }
});

// ─── CLASSROOM PROXY (OpenMAIC) ────────────────────────────────────────────
// open.maic.chat CẤM iframe (X-Frame-Options: SAMEORIGIN + CSP frame-ancestors
// 'self' — đã verify bằng curl) → iframe trực tiếp KHÔNG BAO GIỜ load được.
// Proxy qua backend: strip frame headers + rewrite URL về /api/classroom/*.
// Yêu cầu đăng nhập (token qua Authorization header hoặc ?token= — iframe không
// gửi được header). RateLimit cao vì app Next.js tải nhiều chunk/API.
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
  if (!user) return res.status(401).send('Unauthorized — vui lòng đăng nhập Rexi AI để dùng Lớp Học AI.');

  // subpath sau /api/classroom (Express 5 đã strip mount point khỏi req.url)
  let sub = req.url || '/';
  if (!sub.startsWith('/')) sub = '/' + sub;
  const targetUrl = MAIC_UPSTREAM + sub;

  const base = `${req.protocol}://${req.get('host')}/api/services/classroom`;

  try {
    // Forward headers (bỏ host/connection/content-length — fetch tự tính)
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'content-length'].includes(lk)) continue;
      fwdHeaders[k] = v;
    }
    fwdHeaders['host'] = 'open.maic.chat';
    fwdHeaders['origin'] = MAIC_UPSTREAM;
    fwdHeaders['referer'] = MAIC_UPSTREAM + '/';

    // Body: JSON/urlencoded đã parse sẵn → serialize lại; còn lại (multipart/binary) stream raw
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

    // Redirect: rewrite Location về proxy (không auto-follow để browser đi đúng đường proxy)
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const abs = new URL(loc, MAIC_UPSTREAM).toString();
        const proxied = abs.startsWith(MAIC_UPSTREAM) ? base + abs.slice(MAIC_UPSTREAM.length) : abs;
        res.status(upstream.status).set('location', proxied).end();
        return;
      }
    }

    // Copy headers — TRỪ frame-blocking (cho phép iframe) + hop-by-hop
    const dropHeaders = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-length', 'transfer-encoding', 'connection', 'content-encoding']);
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (dropHeaders.has(lk) || lk === 'set-cookie') return;
      try { res.setHeader(k, v); } catch (e) { /* header không hợp lệ — bỏ qua */ }
    });
    // Cookies: forward, strip Domain (thành host-only = domain mình) + scope Path về /api/services/classroom
    const getSetCookie = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    for (const sc of getSetCookie) {
      let fixed = String(sc).replace(/;\s*domain=[^;]*/i, '').replace(/;\s*[Pp]ath=\/(?=;|$)/, '; Path=/api/services/classroom');
      try { res.append('set-cookie', fixed); } catch (e) { /* bỏ qua */ }
    }
    // Nếu upstream vẫn chặn frame bằng CSP khác (report-only đã strip) — ép thêm header mở.
    // QUAN TRỌNG: helmet của chính backend mình gắn X-Frame-Options: SAMEORIGIN lên
    // MỌI response → phải gỡ ở đây, nếu không iframe vẫn bị chặn.
    res.removeHeader('x-frame-options');
    res.setHeader('content-security-policy', "frame-ancestors 'self' https://rexiai.bot.cd https://www.rexiai.bot.cd https://rexiai.de5.net https://*.vercel.app http://localhost:*");

    const rct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (rct.includes('text/html')) {
      let html = await upstream.text();
      // Tuyệt đối về upstream → về proxy
      html = html.split(MAIC_UPSTREAM).join(base);
      // Root-absolute trong attributes (Next.js dùng /_next/, /api/, /favicon...)
      html = html.replace(/(src|href|action|srcset|content|data-src)="\/([^\/"])/g, `$1="${base}/$2`);
      html = html.replace(/(src|href|action|srcset|content|data-src)='\/([^\/'])/g, `$1='${base}/$2`);
      html = html.replace(/url\(\s*\/(?!\/)/g, `url(${base}/`);
      // JS string literals gọi API cùng origin: fetch("/api/..."), "/_next/..." → về proxy
      html = html.replace(/"\/api\//g, `"${base}/api/`);
      html = html.replace(/'\/api\//g, `'${base}/api/`);
      html = html.replace(/`\/api\//g, `\`${base}/api/`);
      html = html.replace(/"\/_next\//g, `"${base}/_next/`);
      html = html.replace(/'\/_next\//g, `'${base}/_next/`);
      // Boot-script (inject CUỐI để regex rewrite ở trên không chạm vào nó):
      // Next.js render link/fetch lúc runtime bằng path root-absolute ("/home", fetch("/api/..."))
      // → trình duyệt resolve về domain mình, THOÁT proxy. Patch fetch/XHR/click/history/EventSource
      // để mọi request cùng-origin đi qua /api/services/classroom.
      const BOOT = `<script>(function(){var P='/api/services/classroom';function fix(u){if(typeof u!=='string')return u;if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){if(u.indexOf('/api/')===0||u.indexOf('/_next/')===0||u.indexOf('/favicon')===0||u.indexOf('/manifest')===0||u.indexOf('/robots')===0)return P+u;}return u;}try{var _f=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=fix(i);else if(i&&i.url){try{i=new Request(fix(i.url),i);}catch(e){}}return _f.call(this,i,n);};var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')u=fix(u);return _o.call(this,m,u);};document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href');if(h&&h.charAt(0)==='/'&&h.charAt(1)!=='/'&&h.indexOf('/api/services/classroom')!==0){e.preventDefault();e.stopPropagation();window.location.assign(P+h);}},true);['pushState','replaceState'].forEach(function(k){var _h=history[k];history[k]=function(s,t,u){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf('/api/services/classroom')!==0)u=P+u;return _h.call(this,s,t,u);};});if(window.EventSource){var _E=window.EventSource;window.EventSource=function(u,c){if(typeof u==='string')u=fix(u);return new _E(u,c);};window.EventSource.prototype=_E.prototype;}}catch(e){}})();<\/script>`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + BOOT);
      else html = BOOT + html;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    // Còn lại (JS/CSS/API JSON/streaming/SSE/ảnh...) pipe trực tiếp
    res.status(upstream.status);
    if (upstream.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error('[Classroom] Proxy error:', targetUrl, e.message);
    res.status(502).json({ success: false, error: 'Lỗi proxy Lớp Học AI: ' + e.message });
  }
});

// Proxy stream video (chống CORS + SSRF) — copy pattern từ iptv/proxy
router.get('/youtube/proxy', rateLimit({ windowMs: 60000, max: 120 }), youtubeProxyAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    // P2-18: check async (literal + DNS resolve) thay vì isPrivateHostname sync
    const check = await assertPublicUrlAsync(targetUrl);
    if (!check.ok) {
      const code = (check.reason === 'URL không hợp lệ' || check.reason === 'Chỉ cho phép http/https') ? 400 : 403;
      return res.status(code).json({ error: check.reason });
    }
    // 4/10 FREE-ALL: khách (không qua authMiddleware) chỉ được proxy host media đã biết
    if (!req.user) {
      let host = '';
      try { host = new URL(targetUrl).hostname; } catch (e) { /* fallthrough 400 dưới */ }
      if (!ytdlp.isYouTubeProxyHost(host)) {
        return res.status(403).json({ error: 'Khách vãng lai chỉ phát được luồng YouTube (đăng nhập để mở rộng).' });
      }
    }
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  try {
    let effectiveUrl = targetUrl;
    // Giữ Range để player seek được (trước đây bỏ qua → tải NGUYÊN video vào RAM,
    // video dài trên Render free dễ OOM/502). Timeout dài vì cần stream cả video.
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

    // 4/10: playlist m3u (YouTube LIVE chỉ có HLS, không có mp4 progressive) →
    // rewrite URL segment → tuyệt đối qua proxy này. googlevideo không có CORS,
    // trình duyệt fetch segment trực tiếp bị chặn — copy pattern iptv/proxy.
    const _ctYt = (upstream.headers.get('content-type') || '').toLowerCase();
    if (_ctYt.includes('mpegurl') || effectiveUrl.toLowerCase().includes('/hls_playlist/') || effectiveUrl.toLowerCase().endsWith('.m3u8')) {
      let body = await upstream.text();
      if (body.includes('\r\n')) body = body.replace(/\r\n/g, '\n');

      const baseYt = effectiveUrl.substring(0, effectiveUrl.lastIndexOf('/') + 1);
      let originYt = '';
      try { originYt = new URL(effectiveUrl).origin; } catch (e) { /* segment relative giữ nguyên base */ }
      const toAbsoluteYt = (u) => {
        if (/^https?:\/\//i.test(u)) return u;
        if (u.startsWith('/') && originYt) return originYt + u;
        return baseYt + u;
      };
      // Giữ ?token= cho segment con (guest auth qua allowlist host googlevideo/worker)
      const qsTokenYt = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';
      // Segment googlevideo bị IP-lock theo IP yêu cầu — PHẢI fetch qua worker (IP nhà);
      // BE proxy (IP Render) fetch trực tiếp sẽ 403. Fallback BE proxy nếu thiếu worker env.
      const workerUrlYt = (process.env.YTDLP_WORKER_URL || '').trim().replace(/\/+$/, '');
      const workerTokYt = (process.env.YTDLP_WORKER_TOKEN || '').trim();
      const toProxyYt = (u) => {
        if (workerUrlYt) {
          return `${workerUrlYt}/stream?${workerTokYt ? `token=${encodeURIComponent(workerTokYt)}&` : ''}url=${encodeURIComponent(toAbsoluteYt(u))}`;
        }
        return `${req.protocol}://${req.get('host')}/api/services/youtube/proxy?url=${encodeURIComponent(toAbsoluteYt(u))}${qsTokenYt}`;
      };
      // 1) Rewrite dòng URI thường (segment, variant playlist)
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

// TÓM TẮT VIDEO AI: tải audio → Groq Whisper (STT) → Groq LLM → Markdown
// ─────────────────────────────────────────────────────────────────────────────
// Tóm tắt một video YouTube chỉ bằng 1 câu hỏi. Dây chuyền:
//   yt-dlp (audio mp3) → Groq whisper-large-v3 (transcript) → llama-3.3-70b (tóm tắt VN)
// TÓM TẮT VIDEO AI: tải audio → STT (Groq Whisper → fallback Gemini) → LLM (Groq → fallback Gemini)
// ─────────────────────────────────────────────────────────────────────────────
// Tóm tắt một video YouTube chỉ bằng 1 câu hỏi. Dây chuyền:
//   yt-dlp (audio mp3 ≤10 phút) → Groq whisper-large-v3 / Gemini (transcript) → LLM (tóm tắt VN)
// Chỉ cho phép URL YouTube hợp lệ — chặn file:// (đọc file cục bộ!), SSRF, host nội bộ
function isValidYouTubeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  // Video ID thuần (11 ký tự) — dùng phổ biến trong app
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
  return `Bạn là chuyên gia tóm tắt video chuyên nghiệp. Dưới đây là transcript (lời thoại) của một video YouTube. Hãy tóm tắt bằng TIẾNG VIỆT theo đúng định dạng Markdown sau (chỉ trả nội dung, không thêm lời dẫn):

# 📝 Tóm tắt video

## 🎯 Ý chính
- <3-5 gạch đầu dòng nêu nội dung cốt lõi>

## 📌 Điểm nổi bật
- <các thông tin/quan điểm quan trọng>

## 💡 Kết luận / Bài học
- <kết luận rút ra từ video>

Transcript:
"""
${text.slice(0, 20000)}
"""`;
}

// STT qua Groq Whisper (có timeout 90s — tránh treo vô hạn khi Groq bận)
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

// Chuyển segments -> nội dung file SRT (phụ đề timestamp chuẩn)
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

// STT qua Gemini (fallback khi Groq lỗi/hết quota)
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
          { text: 'Hãy chuyển toàn bộ lời thoại trong audio này thành văn bản. Chỉ trả về văn bản lời thoại, không thêm gì khác.' }
        ]
      }]
    }, { signal: controller.signal });
    return String(result.response.text() || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

// Tóm tắt bằng Groq (thử nhiều model — model có thể bị Groq gỡ bất cứ lúc nào)
const GROQ_SUMMARY_MODELS = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'];
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

// Tóm tắt bằng xkiro (nấc cuối — key trong DB, đã dùng ổn cho quickSummarize)
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

// Tóm tắt bằng Gemini (fallback)
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

// FREE-ALL: tóm tắt AI mở cho guest (rateLimit đã chặn abuse)
router.post('/youtube/summarize', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ success: false, error: 'URL/ID video không hợp lệ (chỉ hỗ trợ YouTube).' });
  }

  let audioPath = null;
  try {
    // Tên file duy nhất — tránh đụng nhau giữa 2 request đồng thời
    const outPath = path.join(tempDir, `ytsum_${Date.now()}_${Math.random().toString(36).slice(2)}`);

    const groq = await getGroqClient();
    if (!groq) {
      return res.status(503).json({
        success: false,
        error: 'CHUA_CO_KEY',
        message: 'Cần GROQ_API_KEY trong bảng khoa_api để dùng Tóm tắt AI.'
      });
    }

    // ── Bước 0: Captions-first (manual subs qua worker /subs) — chuẩn 100%,
    // auto-captions kém Whisper trên nhạc. Có manual subs → skip download+STT.
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
        return res.status(500).json({ success: false, error: 'Không tải được audio của video. Thử video khác.' });
      }

      // ── Bước 1: Nhận diện giọng nói (Groq → fallback Gemini) ──
      try {
        const groqRes = await transcribeWithGroq(groq, audioPath);
        transcript = groqRes.text;
        srt = segmentsToSrt(groqRes.segments);
        sttSource = 'groq';
      } catch (e) {
        console.log('[YouTube] Groq STT fail, fallback Gemini:', e.message);
      }
      if (!transcript) {
        const gemini = await getGeminiClient(); // lấy lazily — chỉ khi cần fallback
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
        return res.status(502).json({ success: false, error: 'Không nhận diện được giọng nói (cả Groq lẫn Gemini đều lỗi). Thử video khác.' });
      }
      if (!videoTitle) videoTitle = dl?.title || '';
    }

    // Dọn artifact cho CẢ 2 nguồn (captions/STT): collapse spaces + dòng lặp
    transcript = ytdlp.cleanTranscriptText(transcript);
    srt = ytdlp.cleanSrtArtifacts(srt);

    // ── Bước 2: Tóm tắt bằng LLM (Groq → fallback Gemini) ──
    // P1-11: summarizeWithGroq là async → phải await, bọc try/catch, validate string
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
    // Lỗi có nguyên nhân rõ (bot-check, thiếu key, audio lỗi) → trả thẳng message
    // thay vì 500 chung chung để user biết đường xử lý.
    const known = /^(YouTube đang chặn|Không tải được audio|Không tìm thấy file mp3|Thiếu URL\/ID|Thiếu đường dẫn|worker audio|ffmpeg)/.test(err.message || '');
    if (known) return res.status(502).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: 'Lỗi tóm tắt video. Vui lòng thử lại.' });
  } finally {
    // Dọn đúng file của request này (không đụng file của request khác)
    if (audioPath && fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }
    }
  }
});

// ─── TIKTOK FEED (xem dọc + lọc chủ đề, AI nhìn hình tự lướt) ───────────────
const tiktokService = require('../services/tiktokService');
const chatExecutor = require('../services/chatExecutor');

// Feed: "Dành cho bạn" (foryou=1, nên kèm session đăng nhập) / @user / #hashtag.
// Cào lâu (tới ~90s) nên gửi nhịp giữ kết nối mỗi 10s (proxy cắt khi im lặng quá lâu).
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
      res.end(JSON.stringify({ success: false, error: (e.message || 'TikTok feed lỗi').toString().slice(0, 300) }));
    } else {
      try { res.end(JSON.stringify({ success: false, error: (e.message || 'TikTok feed lỗi').toString().slice(0, 300) })); } catch (e2) {}
    }
  }
});

// Proxy stream playAddr (CDN TikTok chặn hotlink thiếu Referer; FE cũng cần cùng origin cho canvas)
router.get('/tiktok/stream', rateLimit({ windowMs: 60000, max: 400 }), async (req, res) => {
  const target = String(req.query.u || '');
  if (!/^https:\/\//.test(target) || !/tiktok(?:cdn|v16|v19|\.com)/i.test(target)) {
    return res.status(400).json({ success: false, error: 'URL không hợp lệ' });
  }
  try {
    const upstream = await fetch(target, {
      headers: tiktokService.streamHeaders(req.headers.range ? { Range: req.headers.range } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: `CDN TikTok trả ${upstream.status} — bấm tải lại feed (playAddr hết hạn)` });
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
    if (!res.headersSent) res.status(502).json({ success: false, error: (e.message || 'stream lỗi').toString().slice(0, 200) });
  }
});

// Đường phát chính: giải link qua tikwm rồi pipe về FE (CDN TikTok chặn IP máy này → 403).
// Nếu có session đăng nhập + playAddr gốc (u): thử tải trực tiếp bằng cookie nick thật
// trước (CDN nới tay hơn), rớt mới qua tikwm.
// FE gọi: /tiktok/media?id=<videoId>&user=<tác giả>&u=<playAddr, có thì tốt>&session=<token>
router.get('/tiktok/media', rateLimit({ windowMs: 60000, max: 400 }), async (req, res) => {
  const id = String(req.query.id || '').trim();
  const author = String(req.query.user || req.query.author || '').trim();
  if (!/^\d{10,25}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Thiếu id video' });
  }
  const playAddr = String(req.query.u || '');
  const ses = tiktokService.getSession(req.query.session);
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
    // 1. Nick thật → CDN trực tiếp
    if (ses && /^https:\/\//.test(playAddr)) {
      try {
        const truc = await tiktokService.fetchDirect(playAddr, ses.cookieString, req.headers.range);
        return await pipeVe(truc);
      } catch (e) {
        console.warn('[TikTok] media trực tiếp lỗi, qua tikwm:', (e.message || e).toString().slice(0, 100));
      }
    }
    // 2. Bên trung gian tikwm
    const entry = await tiktokService.resolvePlayUrl(id, author);
    const upstream = await fetch(entry.url, {
      headers: tiktokService.streamHeaders(req.headers.range ? { Range: req.headers.range } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: `Nguồn phát trả ${upstream.status} — thử video khác` });
    }
    return await pipeVe(upstream);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, error: (e.message || 'media lỗi').toString().slice(0, 200) });
  }
});

// Tạo phiên đăng nhập TikTok từ cookie user copy (document.cookie trên tiktok.com).
// FE giữ token trong localStorage, gửi kèm feed/media để lướt nick thật.
router.post('/tiktok/session', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const data = tiktokService.createSession((req.body || {}).cookies);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(400).json({ success: false, error: (e.message || 'session lỗi').toString().slice(0, 200) });
  }
});

// AI nhìn frame → video có khớp chủ đề user muốn không? (vision route của modelRouter)
router.post('/tiktok/classify', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  const { image, topics, caption } = req.body || {};
  if (!image || !/^data:image\/(png|jpe?g|webp);base64,/.test(String(image))) {
    return res.status(400).json({ success: false, error: 'Thiếu frame (data:image/*;base64)' });
  }
  const topicList = (Array.isArray(topics) ? topics : String(topics || '').split(/[,;\n]/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  if (!topicList.length) {
    return res.json({ success: true, match: true, reason: 'Chưa đặt chủ đề' });
  }
  const candidates = [
    { provider: 'gemini', model: 'models/gemini-3-flash-preview' },
    { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
    { provider: 'nvidia', model: 'google/gemma-4-31b-it' },
  ];
  const systemPrompt = 'Bạn là bộ lọc nội dung video ngắn. Chỉ trả đúng 1 dòng JSON, KHÔNG thêm chữ nào khác: {"match": true|false, "reason": "tối đa 12 từ"}';
  const userMsg = `![frame](${image})\nNgười xem CHỈ muốn xem các chủ đề: ${topicList.join(', ')}.\nCaption video: ${String(caption || '(không có)').slice(0, 300)}.\nNhìn khung hình này và quyết định video có thuộc chủ đề người xem muốn không (nội dung, đối tượng, bối cảnh). Trả JSON.`;
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
      match: m ? m[1].toLowerCase() === 'true' : true, // AI parse lỗi → fail-open (giữ video)
      reason: r ? r[1] : String(result.content).slice(0, 60),
      provider: result.provider,
    });
  } catch (e) {
    return res.status(502).json({ success: false, error: (e.message || 'classify lỗi').toString().slice(0, 200) });
  }
});

router.post('/office/generate-docx', authMiddleware, async (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Thiếu nội dung văn bản' });
  if (content.length > 50000) return res.status(400).json({ error: 'Nội dung quá dài (tối đa 50,000 ký tự)' });

  try {

    // Phân tích content thành các đoạn
    const lines = content.split('\n').filter(l => l.trim());
    const children = [];

    // Tiêu đề chính
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

    // Xử lý từng dòng
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Phát hiện table (dòng có |)
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

      // Phát hiện bullet (- hoặc *)
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

      // Phát hiện numbered (1., 2.,...)
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

      // Phát hiện heading (# ## ###)
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

      // Văn bản thường
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed, size: 22 })],
          spacing: { after: 120 },
          alignment: AlignmentType.JUSTIFIED
        })
      );
    }

    const doc = new Document({
      title: title || 'Tài liệu Rexi AI',
      description: 'Được tạo bởi Rexi AI Office Generator',
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
    res.status(500).json({ success: false, error: 'Lỗi tạo DOCX: ' + err.message });
  }
});

// POST /api/office/generate-pptx - Tạo file PowerPoint (pptxgenjs)
router.post('/office/generate-pptx', authMiddleware, async (req, res) => {
  const { title, slides } = req.body;
  if (!slides || !Array.isArray(slides) || slides.length === 0 || slides.length > 50) {
    return res.status(400).json({ error: 'Thiếu danh sách slide (slides: [{title, content}])' });
  }

  try {
    const pres = new PptxGenJS();

    // Slide 1: Tiêu đề
    const slide1 = pres.addSlide();
    slide1.addText(title || 'Bài thuyết trình Rexi AI', { x: 0.5, y: 1, w: 9, h: 2, fontSize: 36, color: 'FFFFFF', bold: true, align: 'center' });
    slide1.addText('Được tạo bởi Rexi AI Office Generator', { x: 0.5, y: 3.2, w: 9, h: 0.8, fontSize: 16, color: 'AAAAAA', align: 'center' });
    slide1.background = { color: '1E1E2E' };

    // Các slide nội dung
    for (const slide of slides) {
      const s = pres.addSlide();
      s.background = { color: '1E1E2E' };
      
      // Tiêu đề slide
      s.addText(slide.title || '', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, color: '89B4FA', bold: true });
      
      // Nội dung
      const contentLines = (slide.content || '').split('\n').filter(l => l.trim());
      let yPos = 1.4;
      for (const line of contentLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          s.addText('• ' + trimmed.substring(2), { x: 0.7, y: yPos, w: 8.5, h: 0.4, fontSize: 16, color: 'CDD6F4' });
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
    res.status(500).json({ success: false, error: 'Lỗi tạo PPTX: ' + err.message });
  }
});

// POST /api/office/process-pdf - Xử lý PDF (merge, split, info)
router.post('/office/process-pdf', authMiddleware, async (req, res) => {
  const { action, base64_pdf } = req.body;
  if (!base64_pdf) return res.status(400).json({ error: 'Thiếu file PDF (base64_pdf)' });

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
      // Trích xuất toàn bộ nội dung chữ trong PDF (chạy CPU, không cần GPU)
      const pdf = new PDFParse({ data: pdfBytes });
      const parsed = await pdf.getText({});
      await pdf.destroy();
      let fullText = (parsed.text || '').trim();
      let ocrUsed = false;
      // Fallback OCR: PDF ảnh/scan (pdf-parse trả rỗng) -> gọi LightOnOCR local (port 8099)
      if (fullText.length < 20) {
        try {
          // Dùng FormData + Blob built-in của Node (fetch xử lý native, tự set boundary)
          const form = new FormData();
          form.append('file', new Blob([Buffer.from(pdfBytes)], { type: 'application/pdf' }), 'scan.pdf');
          const ocrRes = await fetch('http://127.0.0.1:8099/ocr', {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(120000) // tránh treo vĩnh viễn khi OCR server chậm/chết
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
        error: `Hành động '${action || 'unknown'}' chưa được hỗ trợ. Hỗ trợ: info, extract`
      });
    }
  } catch (err) {
    console.error('[Office] PDF Error:', err.message);
    res.status(500).json({ success: false, error: 'Lỗi xử lý PDF: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CAPTION: Nhận diện giọng nói từ video bằng Groq Whisper + Dịch Tiếng Việt
// ─────────────────────────────────────────────────────────────────────────────
// LIVE CAPTION: Nhận diện giọng nói từ video bằng Groq Whisper + Dịch Tiếng Việt
// ─────────────────────────────────────────────────────────────────────────────
const tempDir = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// I5: dọn file temp cũ >1h — server restart/crash giữa render/upload làm file kẹt lại,
// RAM 512MB trên Render không đủ chứa rác tích tụ (ytdl audio + render mp4 + upload)
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
      } catch (e) { /* file biến mất giữa chừng — bỏ qua */ }
    }
  }
}
cleanupOldTemp();
setInterval(cleanupOldTemp, 60 * 60 * 1000).unref();

// Guest vẫn dùng Phụ Đề AI được (không token) nhưng limit 30 req/phút/IP
// (1 người xem ~12 chunk/phút) — chống lạm dụng quota Groq Whisper.
// Lưu ý: client guest vẫn gửi header "Bearer " rỗng → coi như không có token.
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
    return res.status(400).json({ success: false, error: 'Không nhận được file audio.' });
  }
  const tmpPath = audioFile.path;

  // P2-audit: nhiều client (curl, upload file lạ) gửi audio với Content-Type
  // application/octet-stream → Groq từ chối và request rơi xuống 500 HTML.
  // Sniff lại mimetype theo đuôi file khi client không khai báo đúng.
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
        message: 'Cần thêm GROQ_API_KEY vào file .env hoặc bảng khoa_api để dùng tính năng Phụ Đề AI. Lấy key miễn phí tại: https://console.groq.com'
      });
    }

    // Gọi Groq Whisper API để nhận diện giọng nói (+ timeout 60s — P2-20(5))
    // Sử dụng FormData để đảm bảo Groq nhận đúng file với metadata
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
    }), 60000, 'Nhận diện giọng nói');

    const originalText = typeof transcription === 'string'
      ? transcription.trim()
      : String(transcription?.text || '').trim();
    if (!originalText) {
      return res.json({ success: true, text: '', original: '' });
    }

    // Dịch sang tiếng Việt: Google (local) → LLM Groq/Gemini (cloud — Google bị chặn từ datacenter)
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
    const isTimeout = /quá thời gian/i.test(err.message || '');
    res.status(isTimeout ? 504 : 500).json({ success: false, error: 'Lỗi nhận diện giọng nói: ' + err.message });
  } finally {
    // P2-20(5): xóa file temp TRONG finally — mọi đường return/throw đều dọn
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
});

// ========== BROWSER STREAM ROUTES ==========
const browserStream = require('../services/browserStream');

router.post('/browser/launch', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    // P2-18: chặn URL nội bộ kể cả khi launch kèm URL (browserStream.navigate không tự check)
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
    // P2-18: browserStream.navigate() không check SSRF → check ở route (đã có auth)
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

// GET: SSE stream frames — thay WebSocket (Render proxy chèn WS compression RSV1/
// fragmentation → connection chết 1006 ngầm, self-test xác nhận). HTTP thường qua
// Render + Cloudflare OK. Auth ?token= (EventSource không gửi được header).
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
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  console.log('[SSE] Browser stream client connected, user:', user.id || user.email);

  let closed = false;
  req.on('close', () => { closed = true; });

  // Tự launch browser khi client kết nối (nếu chưa có)
  if (!browserStream.page && !browserStream.browser) {
    browserStream.launch().catch(e => console.error('[SSE] Auto-launch error:', e.message));
  }

  const interval = setInterval(async () => {
    if (closed || res.writableEnded) { clearInterval(interval); return; }
    try {
      const shot = await browserStream.debugFrame();
      if (closed) return;
      if (shot.success) {
        res.write(`data: ${JSON.stringify({ type: 'frame', data: `data:image/jpeg;base64,${shot.b64}` })}\n\n`);
      }
    } catch (e) {
      // bỏ frame lỗi, không chết stream
    }
  }, 600);
});

// GET: self-test WS từ TRONG instance qua localhost — tách thủ phạm (server vs proxy ngoài)
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

// POST: AI Action (Stagehand) — điều khiển browser bằng ngôn ngữ tự nhiên
router.post('/browser/act', authMiddleware, async (req, res) => {
  try {
    const { instruction } = req.body;
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ success: false, error: 'Thiếu chỉ dẫn (instruction)' });
    }
    const result = await browserStream.act(instruction);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPERFRAMES VIDEO RENDERER — HTML → MP4 via HyperFrames CLI
// ─────────────────────────────────────────────────────────────────────────────
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

    // QA 17/9: engine render chính giờ là Playwright + ffmpeg (videoRenderer).
    // Kiểm tra thật bằng cách launch browser thử, không đoán theo thư mục cache.
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
      // QA 28/9: tạo video AI miễn phí qua HuggingFace Spaces (endpoint /generate-video),
      // độc lập với renderer composition (Playwright+ffmpeg) ở trên.
      aiVideo: true,
      aiVideoProviders: ['huggingface-spaces: zeroscope-v2 (text→video)', 'huggingface-spaces: wan2.2-14b-i2v (ảnh→video)', 'storyboard: ghép N cảnh ~3s thành video dài (param scenes 1-6)'],
      ready: ffmpegOk && playwrightOk
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST: Render HTML composition → MP4
// P2-20(6): rate-limit 3 render/giờ/user (sau auth để key theo user) + giới hạn
// duration ≤ 30s + width ≤ 1920 (chống đốt CPU/RAM bằng job khổng lồ).
router.post('/video/render', authMiddleware, rateLimit({ windowMs: 3600000, max: 20, message: 'Bạn đã render 20 video trong giờ này. Vui lòng chờ thêm rồi thử lại.' }), async (req, res) => {
  const { html, width, height, fps, duration } = req.body;
  if (!html || !html.trim()) {
    return res.status(400).json({ error: 'Thiếu nội dung HTML composition' });
  }
  if (html.length > 500000) {
    return res.status(400).json({ error: 'HTML quá dài (tối đa 500KB)' });
  }
  const compWidth = Math.min(Math.max(parseInt(width, 10) || 1920, 320), 1920);
  const compHeight = Math.min(Math.max(parseInt(height, 10) || 1080, 240), 1080);
  const compDuration = Math.min(Math.max(parseFloat(duration) || 5, 1), 30);

  const renderId = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const projectDir = path.join(videoTempDir, renderId);
  const outputFile = path.join(projectDir, 'output.mp4');
  const fpsArgMain = Math.min(Math.max(parseInt(fps, 10) || 30, 1), 60);

  // ─── OFFLOAD render nặng sang VIDEO WORKER local (tunnel) nếu có — như TTS ───
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
        console.log('[Video Render] worker OK —', Math.round((data.size || 0) / 1024), 'KB');
        return res.json({ success: true, video: data.video, format: 'mp4', size: data.size, width: compWidth, height: compHeight, duration: compDuration, fps: fpsArgMain, frames: data.frames, engine: 'worker', renderId });
      }
      console.warn('[Video Render] worker lỗi → fallback local:', data && data.error);
    } catch (eW) {
      console.warn('[Video Render] worker exception → fallback local:', eW.message);
    }
  }

  // ─── ĐƯỜNG CHÍNH (QA 17/9): renderer Playwright + ffmpeg của mình ───
  // `hyperframes render` cần browser riêng và chết ở phase capture (Network.enable timeout).
  if (videoRenderer.isAvailable()) {
    try {
      const out = await videoRenderer.renderComposition({
        html, width: compWidth, height: compHeight, fps: fpsArgMain, duration: compDuration,
      });
      console.log(`[Video Render] playwright OK — ${out.frames} frames / ${(out.ms / 1000).toFixed(1)}s (${out.browser})`);
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
      console.error('[Video Render] playwright engine lỗi → thử hyperframes:', eRender.message);
    }
  }

  try {
    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    // Write index.html composition (HyperFrames compatible)
    // (compWidth/compHeight/compDuration đã clamp ở đầu route — P2-20(6))
    const compId = 'main';
    // QA 17/9: hyperframes lint báo missing_gsap_script vì <script src> của template
    // nằm trong <body>; đồng thời timeline_id_mismatch vì template tự đăng ký
    // window.__timelines['<id-template>'] trong khi composition id là 'main'.
    // → hoist script CDN (https) lên <head> và gán lại timeline cho 'main'.
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
    // fps từ client phải là số nguyên 1-60 (spawn shell:true nối chuỗi → chặn command injection)
    const fpsArg = Math.min(Math.max(parseInt(fps, 10) || 30, 1), 60);

    // Set FFmpeg/FFprobe path in env for hyperframes
    const env = { ...process.env };
    // FIX PROD: bỏ đường dẫn Windows cứng — dùng ffmpeg-static (npm) + path.delimiter (; trên Windows, : trên Linux/Render)
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
      error: 'Lỗi render video: ' + err.message,
      note: 'Cần cài FFmpeg và Chrome/Puppeteer. Chạy: npx hyperframes doctor'
    });
  }
});

// POST: Preview HTML composition (return HTML for iframe preview)
router.post('/video/preview', authMiddleware, (req, res) => {
  const { html, width, height } = req.body;
  if (!html) return res.status(400).json({ error: 'Thiếu HTML' });

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
  if (!html) return res.status(400).json({ error: 'Thiếu HTML' });

  const safeName = (name || `composition_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const saveDir = path.join(__dirname, '..', '..', 'temp', 'video', 'compositions');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  const filePath = path.join(saveDir, `${safeName}.html`);
  fs.writeFileSync(filePath, html, 'utf8');

  res.json({ success: true, path: filePath, name: safeName });
});


// ─── VIDEO AI MIỄN PHÍ (HuggingFace Spaces — Gradio API) ───────────
// QA 28/9: kiểm chứng thật bằng HTTP + magic bytes — 2 Space công khai trả MP4
// (magic `ftyp`), KHÔNG cần key, KHÔNG tốn tiền:
//   · hysts/zeroscope-v2               → text→video (model zeroscope-v2, ~24 frame)
//   · observantdistressed/wan2-2-i2v-v3 → ảnh→video (Wan 2.2 14B I2V, chất lượng cao)
// Space free nhưng xếp hàng (queue) nên có thể chậm; lỗi/timeout thì trả
// {success:false} để nơi gọi tự xử lý. KHÔNG đụng renderer Playwright/ffmpeg.
const HF_VIDEO_T2V = { host: 'https://hysts-zeroscope-v2.hf.space', fn: '/run' };
const HF_VIDEO_I2V = { host: 'https://observantdistressed-wan2-2-i2v-v3.hf.space', fn: '/generate_video' };
// Cloudflare trước một số Space chặn UA lạ → dùng UA trình duyệt cho chắc.
const HF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Gọi Gradio 5: POST /gradio_api/call/<fn> → event_id, rồi GET SSE .../<event_id>
// để lấy URL file. Gradio trả SSE dạng `event: ...\ndata: ...`.
async function gradioCall(host, fn, data, timeoutMs) {
  // HF_TOKEN (env, Render đã set) nâng quota ZeroGPU lên mức tài khoản — không có token
  // thì ZeroGPU chỉ cho ~60s/IP rồi báo "quota exceeded" cho mọi request.
  const hfTok = (process.env.HF_TOKEN || '').trim();
  const auth = hfTok ? { Authorization: `Bearer ${hfTok}` } : {};
  const hdrs = { 'Content-Type': 'application/json', 'User-Agent': HF_UA, Origin: host, Referer: host + '/', ...auth };
  const post = await fetch(`${host}/gradio_api/call${fn}`, {
    method: 'POST', headers: hdrs, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000)
  });
  if (!post.ok) throw new Error(`Gradio POST HTTP ${post.status}`);
  const j = await post.json().catch(() => null);
  const eventId = j && j.event_id;
  if (!eventId) throw new Error('Gradio không trả event_id');
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
    try { parsed = JSON.parse(raw); } catch (e) { continue; } // heartbeat / mảnh khác
    if (curEvent === 'error') { errMsg = String(parsed && (parsed.error || parsed.message) || raw).slice(0, 200); continue; }
    const m = JSON.stringify(parsed).match(/https?:\/\/[^"\\]+\.mp4/);
    if (m) videoUrl = m[0]; // bản ghi `complete` cuối cùng là kết quả
  }
  if (!videoUrl) throw new Error(errMsg ? `Space lỗi: ${errMsg}` : 'Gradio không trả URL video (.mp4)');
  return videoUrl;
}

// Tải MP4 từ URL Space → Buffer + xác thực magic bytes.
async function fetchVideoBuffer(url) {
  const dl = await fetch(url, { headers: { 'User-Agent': HF_UA }, signal: AbortSignal.timeout(120000) });
  if (!dl.ok) throw new Error(`Tải MP4 HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (!buf.length) throw new Error('Video trả về rỗng');
  // magic bytes: MP4 có 'ftyp' ở offset 4; WebM bắt đầu bằng EBML 1A 45 DF A3.
  const isMp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (!isMp4 && !isWebm) throw new Error('Dữ liệu tải về không phải video');
  return { buf, mime: isMp4 ? 'video/mp4' : 'video/webm' };
}

// prompt → buffer video (HuggingFace Spaces, miễn phí nhưng có thể xếp hàng/chập chờn).
// Có image_url → thử Wan 2.2 I2V trước; lỗi thì tự rơi về zeroscope T2V để vẫn có video.
// Storyboard mode gọi hàm này cho TỪNG cảnh (không kèm image_url — tránh trộn resolution
// giữa wan-i2v và zeroscope làm concat ffmpeg vỡ).
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
      console.log('[generate-video] Wan I2V lỗi → rơi về zeroscope T2V:', e.message);
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

// Trả về cùng dạng với generateImage*: {success, video:"data:<mime>;base64,...", mimeType, provider}.
async function generateVideoHF(prompt, imageUrl) {
  try {
    const { buf, mime, provider } = await generateVideoBufferHF(prompt, imageUrl);
    return { success: true, video: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider, bytes: buf.length };
  } catch (e) {
    console.log('[generate-video] HF Space error:', e.message);
    return { success: false, error: e.message };
  }
}

// ─── STORYBOARD MODE (29/9): video DÀI từ model free chỉ sinh được ~3s/cảnh ───
// → chia truyện thành N prompt cảnh, sinh từng clip rồi ghép bằng ffmpeg.
// Chia cảnh bằng Groq free (key env GROQ_API_KEY hoặc DB khoa_api 'groq'),
// lỗi/thiếu key thì rơi về tách câu thủ công — luôn trả đủ N prompt.
async function storyboardScenes(prompt, n) {
  const story = String(prompt || '').slice(0, 1200);
  const fallback = () => {
    const sents = story.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
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
        model: process.env.GROQ_STORY_MODEL || 'llama-3.1-8b-instant',
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
    console.log('[storyboard] Groq split lỗi → tách câu thủ công:', e.message);
    return fallback();
  }
}

// Ghép N buffer MP4 (cùng model → cùng codec/resolution) thành 1 file.
// Re-encode libx264 + -r 24 cho đồng bộ timestamp — đã test bằng tay 29/9.
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

// POST: tạo video AI miễn phí từ prompt (và tuỳ chọn ảnh nguồn) qua HuggingFace Spaces.
// Body: { prompt, image_url?, scenes? (1-6), prompts? ([cảnh 1, cảnh 2...]) }.
// scenes > 1 (hoặc gửi mảng prompts) → storyboard mode: Groq chia truyện thành
// các cảnh → sinh từng clip ~3s → ghép ffmpeg thành 1 video dài.
router.post('/generate-video', authMiddleware, rateLimit({ windowMs: 3600000, max: 10, message: 'Bạn đã tạo 10 video trong giờ này. Vui lòng chờ thêm rồi thử lại.' }), async (req, res) => {
  const { prompt, image_url } = req.body || {};
  const reqScenes = Math.min(Math.max(parseInt((req.body || {}).scenes, 10) || 1, 1), 6);
  const promptsArr = Array.isArray((req.body || {}).prompts)
    ? (req.body || {}).prompts.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim().slice(0, 800)).slice(0, 6)
    : null;
  if ((!prompt || !prompt.trim()) && !image_url && !(promptsArr && promptsArr.length)) {
    return res.json({ success: false, error: 'Vui lòng nhập mô tả video (hoặc ảnh nguồn).' });
  }
  const n = promptsArr && promptsArr.length > 1 ? Math.min(promptsArr.length, 6) : reqScenes;
  if (n <= 1 && !(promptsArr && promptsArr.length > 1)) {
    const out = await generateVideoHF(prompt, image_url);
    return res.json(out);
  }
  // ─── Storyboard: video dài ~3s x N cảnh ───
  const sceneList = promptsArr && promptsArr.length > 1 ? promptsArr : await storyboardScenes(prompt, n);
  const results = [];
  const errs = [];
  for (let i = 0; i < sceneList.length; i++) {
    try {
      const r = await generateVideoBufferHF(sceneList[i]);
      results.push(r);
    } catch (e) { errs.push(`cảnh ${i + 1}: ${String(e.message).slice(0, 120)}`); }
  }
  if (!results.length) {
    return res.json({ success: false, error: 'Tất cả cảnh đều lỗi — ' + errs.join(' | ').slice(0, 300) });
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
      console.log('[generate-video] ghép cảnh lỗi → trả cảnh đầu:', e.message);
      buf = results[0].buf;
      errs.push('ghép lỗi: ' + String(e.message).slice(0, 120));
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


// ─── TẠO ẢNH AI (Gemini Image) ─────────────────────────────────
// ─── Provider ảnh DỰ PHÒNG miễn phí (không cần API key) ───
// QA 17/9: quota Gemini cạn là tính năng tạo ảnh chết hẳn. Pollinations (Flux)
// trả ảnh trực tiếp qua URL, không cần key → dùng làm đường lui cho /generate-image.
// QA 28/9: thêm HuggingFace free inference (SD3-medium, hf-inference provider) —
// free tier, cần env HF_TOKEN (token có quyền `inference`). Ưu tiên trước pollinations.
// ─── xKiro image generation (SenseNova U1.5 Lite) — async job API ───
// QA 28/9: xKiro POST /v1/images/generations → 202 job → GET /v1/images/generations/{id}
// tới status=succeeded → data[0].url (cdn.xkiro.com). Key đọc từ DB (khoa_api, 'xkiro').
async function generateImageXkiro(prompt) {
  try {
    const row = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'xkiro' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1", [], (e, r) => resolve(r));
    });
    if (!row) return { success: false, error: 'Không có key xkiro trong DB' };
    let key = '';
    try { key = decryptKey(row.gia_tri_khoa).trim(); } catch (e) { key = ''; }
    if (!key) return { success: false, error: 'Giải mã key xkiro thất bại' };
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
    if (!id) return { success: false, error: 'xKiro không trả job id' };
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const st = await fetch(`https://api.xkiro.com/v1/images/generations/${id}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
      });
      const sd = await st.json().catch(() => null);
      if (!sd) continue;
      if (sd.status === 'succeeded' || sd.status === 'completed') {
        const url = (sd.data && sd.data[0] && sd.data[0].url) || sd.url;
        if (!url) return { success: false, error: 'xKiro không trả url ảnh' };
        const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!img.ok) return { success: false, error: `Tải ảnh xKiro HTTP ${img.status}` };
        const mime = (img.headers.get('content-type') || 'image/png').split(';')[0];
        const buf = Buffer.from(await img.arrayBuffer());
        if (!buf.length) return { success: false, error: 'Ảnh xKiro rỗng' };
        return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'xkiro' };
      }
      if (sd.status === 'failed' || sd.status === 'error') {
        return { success: false, error: 'xKiro job thất bại: ' + String(JSON.stringify(sd)).slice(0, 140) };
      }
    }
    return { success: false, error: 'xKiro timeout chờ ảnh' };
  } catch (e) {
    console.log('[generate-image] xKiro error:', e.message);
    return { success: false, error: e.message };
  }
}

async function generateImageHF(prompt, size = 1024) {
  const token = (process.env.HF_TOKEN || '').trim();
  if (!token) return { success: false, error: 'Chưa cấu hình HF_TOKEN' };
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
    if (!mime.startsWith('image/')) return { success: false, error: 'HF không trả ảnh' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { success: false, error: 'HF trả ảnh rỗng' };
    return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'huggingface' };
  } catch (e) {
    console.log('[generate-image] HF error:', e.message);
    return { success: false, error: e.message };
  }
}

// ─── NVIDIA FLUX.1-dev (build.nvidia.com) ───
// QA 28/9: POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev →
// HTTP 200, JSON { artifacts: [{ base64 }] } (ảnh JPEG, đôi khi PNG). Key đọc từ
// DB (khoa_api, 'nvidia', đã mã hóa) → fallback env NVIDIA_API_KEY. Đã verify:
// 3 key khác nhau đều trả ảnh ~44-46KB; flux.1-schnell validate được nhưng
// generation TREO vô hạn (>300s) nên chỉ dùng flux.1-dev.
async function generateImageNvidia(prompt, size = 1024) {
  try {
    let key = '';
    const row = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'nvidia' AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1", [], (e, r) => resolve(r));
    });
    if (row) { try { key = decryptKey(row.gia_tri_khoa).trim(); } catch (e) { key = ''; } }
    if (!key) key = (process.env.NVIDIA_API_KEY || '').trim();
    if (!key) return { success: false, error: 'Không có key NVIDIA (DB/env)' };
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
    if (!b64) return { success: false, error: 'NVIDIA không trả artifacts[0].base64' };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { success: false, error: 'NVIDIA trả ảnh rỗng' };
    // Nhận diện mime theo magic bytes (NVIDIA thường trả JPEG).
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
    if (!r.ok) return { success: false, error: `Provider dự phòng HTTP ${r.status}` };
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return { success: false, error: 'Provider dự phòng không trả ảnh' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { success: false, error: 'Provider dự phòng trả ảnh rỗng' };
    return { success: true, image: `data:${mime};base64,${buf.toString('base64')}`, mimeType: mime, provider: 'pollinations' };
  } catch (e) {
    console.log('[generate-image] fallback error:', e.message);
    return { success: false, error: e.message };
  }
}

router.post('/generate-image', authMiddleware, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.json({ success: false, error: 'Vui lòng nhập mô tả ảnh cần tạo.' });
  }
  const cleanPrompt = prompt.trim().slice(0, 1000);
  try {
    const keyRow = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'gemini'", [], (err, row) => resolve(row));
    });
    // P1-12: key lưu mã hóa — phải decryptKey; key rỗng thì báo chưa cài (không gọi API với ciphertext)
    let gemKey = '';
    try {
      gemKey = keyRow && keyRow.gia_tri_khoa ? decryptKey(keyRow.gia_tri_khoa).trim() : '';
    } catch (e) {
      console.log('[generate-image] decryptKey error:', e.message);
      gemKey = '';
    }
    if (!gemKey) {
      // QA 18/9: không có key Gemini → thử OpenRouter (image free) rồi tới provider miễn phí
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
      // QA 17/9: 429 = hết quota key free → tự chuyển provider ảnh miễn phí thay vì
      // trả lỗi cứng (trước đây tính năng tạo ảnh chết hẳn khi quota Gemini cạn).
      if (resp.status === 429 || resp.status === 503) {
        // QA 18/9: hết quota Gemini → thử OpenRouter (image free) trước khi rơi provider miễn phí
        const or2 = await generateImageOpenRouter(cleanPrompt);
        if (or2.success) return res.json(or2);
        const fb = await generateImageFallback(cleanPrompt);
        if (fb.success) return res.json(fb);
        return res.json({ success: false, error: '⚠️ Gemini hết quota, OpenRouter và provider dự phòng cũng lỗi (OR: ' + String(or2.error || '').slice(0, 80) + ' | FB: ' + String(fb.error || '').slice(0, 80) + ')' });
      }
      const friendly = resp.status === 400
        ? '⚠️ Gemini từ chối nội dung này (bộ lọc an toàn). Vui lòng mô tả khác.'
        : (resp.status === 429 ? '⚠️ Gemini đang TẠM HẾT QUOTA (rate limit). Vui lòng thử lại sau vài phút.' : 'Lỗi Gemini: ' + msg);
      return res.json({ success: false, error: friendly });
    }
    const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (part && part.inlineData && part.inlineData.data) {
      const mime = part.inlineData.mimeType || 'image/png';
      return res.json({ success: true, image: `data:${mime};base64,${part.inlineData.data}`, mimeType: mime, provider: 'gemini' });
    }
    // Gemini trả rỗng (bộ lọc/khoá model) → thử OpenRouter rồi tới đường dự phòng
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
    return res.json({ success: false, error: 'Lỗi kết nối Gemini: ' + e.message });
  }
});


// ========== RAG — ĐỌC & HIỂU FILE (PDF/Word/TXT) ==========
// Upload file → trích xuất text → vector hóa → AI trả lời dựa trên nội dung file
const ragUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.post('/documents/upload', authMiddleware, ragUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file để upload.' });
    const ext = (req.file.originalname.match(/\.(txt|md|csv|json|js|py|jsx|ts|tsx|html|css|sql|sh|xml|yml|yaml|ini|log|xlsx|pdf|docx)$/i) || [])[1];
    if (!ext) return res.status(400).json({ error: 'Chỉ hỗ trợ: TXT, MD, CSV, JSON, XLSX, PDF, DOCX, code files... Vui lòng chọn file khác.' });
    const result = await ragService.saveDocument(req.user.id, req.file.originalname, req.file.buffer);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (e) {
    console.log('[RAG] upload error:', e.message);
    res.status(500).json({ error: 'Lỗi xử lý file: ' + e.message });
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
    if (!ok) return res.status(404).json({ error: 'Không tìm thấy tài liệu.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== CHẠY CODE TRONG CHAT (sandbox, ADMIN ONLY — P0-01) ==========
router.post('/exec-code', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { language, code } = req.body;
    if (!code || !String(code).trim()) return res.status(400).json({ error: 'Code trống.' });
    const { runCode } = require('../services/codeRunner');
    const result = await runCode(language, code);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi chạy code: ' + e.message });
  }
});

// ========== EXPORT HỘI THOẠI (TXT / DOCX) ==========
router.get('/conversations/:id/export', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // P1-09: chặn IDOR — chỉ chủ sở hữu (hoặc admin) mới được export
    const ownerErr = await assertConvOwner(id, req);
    if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });
    const fmt = (req.query.format || 'txt').toLowerCase();
    const conv = await new Promise((resolve) => db.get('SELECT tieu_de FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?', [id], (e, r) => resolve(r)));
    const msgs = await new Promise((resolve) => db.all("SELECT vai_tro, noi_dung, ngay_gui FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC", [id], (e, r) => resolve(r || [])));
    if (!msgs.length) return res.status(404).json({ error: 'Không có tin nhắn trong hội thoại.' });
    const title = (conv && conv.tieu_de) || 'Hội thoại';
    const lines = msgs.map(m => `[${(m.vai_tro === 'user' ? 'Bạn' : 'Rexi')} - ${(m.ngay_gui || '').substring(0, 19)}]\n${m.noi_dung}\n`);
    const text = `HỘI THOẠI: ${title}\n${'='.repeat(40)}\n\n` + lines.join('\n');
    if (fmt === 'docx') {
      const { Document, Packer, Paragraph } = require('docx');
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: `HỘI THOẠI: ${title}`, heading: 'Heading1' }),
            ...msgs.map(m => new Paragraph({
              children: [
                { text: (m.vai_tro === 'user' ? '👤 Bạn' : '🤖 Rexi') + ' (' + (m.ngay_gui || '').substring(0, 19) + '):\n', bold: true },
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
    res.status(500).json({ error: 'Lỗi export: ' + e.message });
  }
});

// ========== GIẢI MÃ QR / BARCODE TRONG ẢNH (0 dependency) ==========
router.post('/qr', async (req, res) => {
  try {
    const { name, base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 required' });
    let buf;
    try { buf = Buffer.from(String(base64), 'base64'); } catch { return res.status(400).json({ error: 'bad base64' }); }
    if (!buf.length || buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'ảnh trống hoặc > 12MB' });
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
    if (!isPng && !/\.png$/i.test(String(name || ''))) return res.json({ ok: true, values: [], note: 'chỉ hỗ trợ PNG' });
    const out = require('../utils/qr').decodeQR(buf);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'qr: ' + e.message });
  }
});

// ========== CHIA SẺ HỘI THOẠI (link) ==========
router.post('/conversations/:id/share', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // P1-09: chặn IDOR — chỉ chủ sở hữu (hoặc admin) mới được tạo link chia sẻ
    const ownerErr = await assertConvOwner(id, req);
    if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });
    const crypto = require('crypto');
    const token = crypto.randomBytes(6).toString('hex');
    // P2-20(8): bảng chia_se_hoi_thoai đã tạo ở init-db.js — không CREATE ở đây nữa
    await new Promise((resolve) => db.run('INSERT INTO chia_se_hoi_thoai (ma_chia_se, ma_hoi_thoai) VALUES (?, ?)', [token, id], resolve));
    res.json({ success: true, share_token: token, share_url: `/api/services/share/${token}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public — xem hội thoại chia sẻ (không cần đăng nhập)
router.get('/share/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const row = await new Promise((resolve) => db.get('SELECT ma_hoi_thoai FROM chia_se_hoi_thoai WHERE ma_chia_se = ?', [token], (e, r) => resolve(r)));
    if (!row) return res.status(404).json({ error: 'Link chia sẻ không tồn tại hoặc đã hết hạn.' });
    const msgs = await new Promise((resolve) => db.all("SELECT vai_tro, noi_dung, ngay_gui FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC", [row.ma_hoi_thoai], (e, r) => resolve(r || [])));
    res.json({ success: true, messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== THỐNG KÊ CÁ NHÂN ==========
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

// ========== NHẮC VIỆC THÔNG MINH ==========
// P2-20(8): bảng lich_nhac/thong_bao đã tạo ở init-db.js — bỏ IIFE CREATE rải rác.

router.post('/reminders', authMiddleware, async (req, res) => {
  try {
    const { noi_dung, thoi_gian } = req.body;
    if (!noi_dung || !thoi_gian) return res.status(400).json({ error: 'Thiếu nội dung hoặc thời gian nhắc.' });
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

// ========== NHẬT KÝ HOẠT ĐỘNG (bảo mật) ==========
// P2-20(8): bảng nhat_ky đã tạo ở init-db.js — bỏ IIFE CREATE rải rác.

router.get('/admin/logs', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const rows = await new Promise((resolve) => db.all('SELECT ma_nguoi_dung, hanh_dong, chi_tiet, ngay_tao FROM nhat_ky ORDER BY ngay_tao DESC LIMIT 100', [], (e, r) => resolve(r || [])));
    res.json({ success: true, logs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== OPENSHORTS — cắt video dài thành Shorts (hosted api.openshorts.app, quota free 20 phút/tháng) ==========
const OPENSHORTS_BASE = 'https://api.openshorts.app';

async function openShortsFetch(pathname, init = {}) {
  const key = process.env.OPENSHORTS_API_KEY;
  if (!key) { const err = new Error('Server chưa cấu hình OPENSHORTS_API_KEY'); err.status = 503; throw err; }
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

// Gửi job cắt video (chỉ nhận URL YouTube — hosted plan không cho upload qua proxy)
router.post('/openshorts/process', authMiddleware, rateLimit({ windowMs: 3600000, max: 5, message: 'Bạn đã gửi 5 job OpenShorts trong giờ này. Quota miễn phí có hạn, đợi chút nhé.' }), async (req, res) => {
  try {
    const { url, target_clips, captions, auto_hook, force_low_quality, layouts, clip_min_seconds, clip_max_seconds, max_minutes } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: 'Thiếu URL video hợp lệ (https://...)' });
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

// Trạng thái job + danh sách clip đã cắt
router.get('/openshorts/status/:jobId', authMiddleware, rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  try {
    const data = await openShortsFetch('/api/status/' + encodeURIComponent(req.params.jobId));
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Quota / thông tin gói hiện tại (số phút còn lại...)
router.get('/openshorts/quota', authMiddleware, async (req, res) => {
  try {
    const me = await openShortsFetch('/api/me');
    res.json({ success: true, me });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═══════════ VIDEO EDIT (FFmpeg) — dựng/sửa video (tab + agent) ═══════════
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

// GET /services/video/file/:name — tải file đã edit (Bearer header hoặc ?token=)
router.get('/video/file/:name', tokenFromQuery, authMiddleware, (req, res) => {
  const name = path.basename(req.params.name);
  const fp = path.join(VIDEO_TEMP_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không thấy file' });
  res.sendFile(fp);
});

// ═══════════ OPENCUT BRIDGE (extension polling) ═══════════
const opencutBridge = require('../services/opencutBridge');

// Extension poll lấy lệnh (và báo còn sống + có tab OpenCut)
router.post('/opencut-bridge/poll', tokenFromQuery, authMiddleware, (req, res) => {
  res.json({ commands: opencutBridge.poll(req.body && req.body.hasTab) });
});
// Extension trả kết quả
router.post('/opencut-bridge/result', tokenFromQuery, authMiddleware, (req, res) => {
  res.json(opencutBridge.submitResult(req.body || {}));
});
// Trạng thái cầu nối
router.get('/opencut-bridge/status', tokenFromQuery, authMiddleware, (req, res) => {
  res.json(opencutBridge.status());
});
// Chụp màn hình OpenCut (qua extension) — trả dataURL PNG
router.post('/opencut-bridge/shot', tokenFromQuery, authMiddleware, async (req, res) => {
  const r = await opencutBridge.enqueue('screenshot', {}, 20000);
  res.json(r);
});
// Agent AN TOÀN cho OpenCut — CHỈ mở tool opencut_act, cho MỌI user đã đăng nhập (không cần admin)
router.post('/opencut-bridge/ask', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Thiếu message' });
    const { runInternalAgent } = require('../services/internalAgent');
    const result = await runInternalAgent(
      `Bạn hỗ trợ người dùng điều khiển tab OpenCut của CHÍNH HỌ qua tool opencut_act (extension của họ đã kết nối với server). Thực hiện yêu cầu sau: ${String(message).trim()}`,
      { allowedTools: ['opencut_act'] }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload file nguồn cho dựng video (lưu temp, trả path server dùng cho /video/edit)
const videoUpload = multer({ dest: path.join(__dirname, '..', '..', 'temp'), limits: { fileSize: 200 * 1024 * 1024 } });
router.post('/video/upload', authMiddleware, videoUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Chưa có file' });
    const ext = (path.extname(req.file.originalname) || '.mp4').toLowerCase();
    const dest = path.join(VIDEO_TEMP_DIR, 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext);
    try { fs.renameSync(req.file.path, dest); } catch (e) { fs.copyFileSync(req.file.path, dest); try { fs.unlinkSync(req.file.path); } catch (e2) {} }
    res.json({ success: true, path: dest, name: path.basename(dest), sizeBytes: req.file.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
