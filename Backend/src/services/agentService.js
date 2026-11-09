const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { stripAnsi } = require('../utils/stripAnsi');
const { generateEdgeTTSNode, listEdgeVoices, localeFromVoice } = require('./edgeTTS');
const { assertPublicUrlAsync } = require('../utils/urlSafety');
const { safeExec } = require('../utils/safeExec');
const { videoEdit } = require('./videoEdit');

// ========== TOOL REGISTRY ==========
// Thêm tool mới chỉ cần thêm 1 object vào đây, AI tự hiểu và dùng!
const TOOL_REGISTRY = [
  {
    name: 'browser_navigate',
    description: 'Mở trình duyệt đến URL bất kỳ. Dùng để xem web, YouTube, TikTok, TV online, opencut edit video...',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL cần mở' } }, required: ['url'] }
  },
  {
    name: 'browser_click',
    description: 'Click chuột tại vị trí (x,y) trên trang web',
    parameters: { type: 'object', properties: { x: { type: 'number', description: 'Tọa độ X' }, y: { type: 'number', description: 'Tọa độ Y' } }, required: ['x', 'y'] }
  },
  {
    name: 'browser_type',
    description: 'Gõ text vào ô input trên web',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Nội dung cần gõ' } }, required: ['text'] }
  },
  {
    name: 'browser_act',
    description: 'Dùng AI thực hiện hành động trên web: bấm nút, chọn đáp án, điền form, cuộn, mở link. AI đã được cấp sẵn nội dung + danh sách nút/ô đang hiển thị nên chọn đúng. TRẢ VỀ LUÔN nội dung trang sau hành động (đọc field "text"/"viewportText" để biết kết quả).',
    parameters: { type: 'object', properties: { instruction: { type: 'string', description: 'Mô tả hành động, vd: "bấm nút Next", "chọn đáp án B", "cuộn xuống"' } }, required: ['instruction'] }
  },
  {
    name: 'browser_scroll',
    description: 'Cuộn trang theo pixel (deltaY âm = lên, dương = xuống). Dùng để tới phần dưới/trên trang rồi đọc bằng browser_read.',
    parameters: { type: 'object', properties: { deltaY: { type: 'number', description: 'Số pixel cuộn dọc (vd 800). Âm = lên, dương = xuống' } }, required: ['deltaY'] }
  },
  {
    name: 'browser_screenshot',
    description: 'Chụp màn hình browser để kiểm tra kết quả',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_read',
    description: 'Đọc nội dung TEXT của trang đang mở. Trả kèm "viewportText" = phần ĐANG NHÌN THẤY (theo vị trí cuộn) + scrollY. Dùng sau browser_navigate để tóm tắt, hoặc sau khi cuộn/bấm để biết trang đã đổi thế nào.',
    parameters: { type: 'object', properties: { maxChars: { type: 'number', description: 'Số ký tự tối đa (mặc định 6000)' } } }
  },
  {
    name: 'process_word',
    description: 'Đọc/xử lý file Word (.docx). Dùng để phân tích, chỉnh sửa văn bản',
    parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'Đường dẫn file Word' }, instruction: { type: 'string', description: 'Cần làm gì với file?' } }, required: ['filePath', 'instruction'] }
  },
  {
    name: 'create_word',
    description: 'Tạo file Word mới với nội dung chỉ định',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'Nội dung file' }, outputPath: { type: 'string', description: 'Đường dẫn lưu file' } }, required: ['content', 'outputPath'] }
  },
  {
    name: 'execute_command',
    description: 'Chạy lệnh terminal/CMD. Dùng để chạy script, build code, cài đặt...',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Câu lệnh cần chạy' } }, required: ['command'] }
  },
  {
    name: 'run_code',
    description: 'Chạy code Python / JavaScript / Bash và trả về kết quả stdout. Dùng khi người dùng yêu cầu tính toán, xử lý dữ liệu, tạo script.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'javascript', 'bash'], description: 'Ngôn ngữ code' },
        code: { type: 'string', description: 'Code cần chạy' }
      },
      required: ['language', 'code']
    }
  },
  {
    name: 'search_web',
    description: 'Tìm kiếm thông tin trên internet',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Từ khóa tìm kiếm' } }, required: ['query'] }
  },
  {
    name: 'web_analyze',
    description: 'Phân tích website từ URL: đọc nội dung, chụp screenshot, đánh giá SEO, design, tốc độ. Dùng khi user muốn đánh giá 1 website.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL website cần phân tích' } }, required: ['url'] }
  },
  {
    name: 'text_to_speech',
    description: 'Tạo giọng nói tiếng Việt từ văn bản, trả về file audio. Hỗ trợ 10 giọng nói (Nam/Nữ, Bắc/Nam), điều chỉnh tốc độ và cao độ.',
    parameters: { type: 'object', properties: { 
      text: { type: 'string', description: 'Nội dung cần đọc' }, 
      voice: { type: 'string', description: 'Giọng đọc: vi-VN-HoaiMyNeural (Nữ/Bắc), vi-VN-NamMinhNeural (Nam/Nam), vi-VN-DuyAnhNeural (Nam/Bắc), vi-VN-ThuyMinhNeural (Nữ/Nam)...', default: 'vi-VN-HoaiMyNeural' },
      rate: { type: 'string', description: 'Tốc độ: +20% hoặc -10%', default: '+0%' },
      pitch: { type: 'string', description: 'Cao độ giọng: +10% hoặc -5%', default: '+0%' }
    }, required: ['text'] }
  },
  {
    name: 'video_edit',
    description: 'Dựng/sửa video bằng FFmpeg (không cần GUI): cắt (trim), ghép nhiều clip (concat), chèn chữ (add_text), chèn nhạc (add_audio), đổi tỉ lệ (resize), đổi tốc độ (speed), tách âm thanh (extract_audio), tạo ảnh bìa (thumbnail). Input là file/URL. Trả về file video đã xử lý + link tải.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['trim', 'concat', 'add_audio', 'add_text', 'resize', 'speed', 'extract_audio', 'thumbnail', 'make_video'], description: 'Phép xử lý' },
        slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } } }, description: 'make_video: danh sách slide {title, subtitle}' },
        secondsPerSlide: { type: 'number', description: 'make_video: giây mỗi slide (mặc định 3)' },
        music: { type: 'string', description: 'make_video: URL nhạc nền (tùy chọn)' },
        musicMix: { type: 'number', description: 'make_video: âm lượng nhạc 0..1' },
        input: { type: 'string', description: 'File/URL video nguồn (đa số op)' },
        inputs: { type: 'array', items: { type: 'string' }, description: 'Danh sách input (cho concat, >=2)' },
        start: { type: 'string', description: 'Mốc bắt đầu (giây hoặc mm:ss)' },
        duration: { type: 'string', description: 'Độ dài' },
        end: { type: 'string', description: 'Mốc kết thúc (thay cho duration)' },
        audio: { type: 'string', description: 'File/URL nhạc (add_audio)' },
        mix: { type: 'number', description: 'Âm lượng nhạc 0..1 (add_audio)' },
        text: { type: 'string', description: 'Chữ cần chèn (add_text)' },
        position: { type: 'string', enum: ['top', 'center', 'bottom'], description: 'Vị trí chữ' },
        color: { type: 'string', description: 'Màu chữ (vd white, yellow, #ff0000)' },
        fontSize: { type: 'number', description: 'Cỡ chữ' },
        width: { type: 'number', description: 'Rộng đích (resize)' },
        height: { type: 'number', description: 'Cao đích (resize)' },
        speed: { type: 'number', description: 'Hệ số tốc độ (speed, vd 1.5)' },
        at: { type: 'string', description: 'Mốc lấy ảnh bìa (thumbnail)' },
        loop: { type: 'boolean', description: 'trim: lặp nguồn cho đủ độ dài (video ngắn muốn kéo dài)' }
      },
      required: ['operation']
    }
  },
  {
    name: 'opencut_act',
    description: 'Điều khiển tab OpenCut đang mở trên trình duyệt NGƯỜI DÙNG (qua extension Rexi OpenCut Bridge) để thao tác hộ: bấm nút, gõ chữ, chạy JS, đọc trang. action: eval ({code}) chạy JS trong trang và trả kết quả; click ({selector} hoặc {text}); type ({selector, text}); text (đọc nội dung trang); list (liệt kê các nút bấm được); wait ({ms}).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['eval', 'click', 'type', 'text', 'list', 'wait'], description: 'Hành động' },
        selector: { type: 'string', description: 'CSS selector' },
        text: { type: 'string', description: 'Text để tìm/click, hoặc nội dung cần gõ' },
        code: { type: 'string', description: 'JS chạy khi action=eval' },
        ms: { type: 'number', description: 'Thời gian chờ (ms) khi action=wait' }
      },
      required: ['action']
    }
  }
];

// ========== EXECUTE TOOL ==========
const browserStream = require('./browserStream');
const { Document, Packer, Paragraph } = require('docx');

async function executeTool(toolName, args) {
  console.log('[Agent] Tool: ' + toolName, JSON.stringify(args));
  switch (toolName) {
    case 'browser_navigate': {
      // FIX SECURITY: chặn URL nội bộ (SSRF) trước khi mở browser (P2-18: bản async có resolve DNS)
      const checkNav = await assertPublicUrlAsync(args.url);
      if (!checkNav.ok) return { error: checkNav.reason };
      if (!browserStream.browser) await browserStream.launch();
      return await browserStream.navigate(args.url);
    }
    case 'browser_click':
      return await browserStream.click(args.x, args.y);
    case 'browser_type':
      return await browserStream.type(args.text);
    case 'browser_act':
      if (!browserStream.browser) await browserStream.launch();
      return await browserStream.act(args.instruction);
    case 'browser_scroll':
      if (!browserStream.browser) await browserStream.launch();
      return await browserStream.scroll(0, args.deltaY || 800);
    case 'browser_screenshot':
      if (!browserStream.page) return { error: 'Browser chưa mở' };
      const buf = await browserStream.page.screenshot({ type: 'jpeg', quality: 70 });
      return { screenshot: 'data:image/jpeg;base64,' + buf.toString('base64') };
    case 'browser_read':
      return await browserStream.readText(args.maxChars || 6000);
    case 'process_word': {
      const content = fs.readFileSync(args.filePath, 'utf-8');
      const result = await callAI('Xử lý: ' + args.instruction + '\n\nNội dung:\n' + content);
      if (args.savePath && result && !result.startsWith('Lỗi AI:')) {
        fs.writeFileSync(args.savePath, result, 'utf-8');
        return { result, savedTo: args.savePath };
      }
      return { result };
    }
    case 'create_word': {
      const d = new Document({ sections: [{ children: args.content.split('\n').map(l => new Paragraph({ text: l })) }] });
      const buffer = await Packer.toBuffer(d);
      const outputDir = path.dirname(args.outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(args.outputPath, buffer);
      return { success: true, path: args.outputPath, size: buffer.length };
    }
    case 'execute_command': {
      // FIX PROD: dùng safeExec — timeout + cắt output + chặn lệnh hủy diệt
      const r = await safeExec(args.command, { timeout: 30000, strict: true });
      return { success: r.success, stdout: stripAnsi(r.stdout).trim(), stderr: stripAnsi(r.stderr).trim(), timedOut: r.timedOut };
    }
    case 'run_code': {
      const { runCode } = require('./codeRunner');
      return await runCode(args.language, args.code);
    }
    case 'search_web': {
      return await searchWebTool(args.query);
    }
    case 'web_analyze': {
      const url = args.url;
      if (!url) return { error: 'Thiếu URL' };
      // FIX SECURITY: chặn URL nội bộ (SSRF) trước khi phân tích website (P2-18: bản async có resolve DNS)
      const checkUrl = await assertPublicUrlAsync(url);
      if (!checkUrl.ok) return { error: checkUrl.reason };
      if (!browserStream.browser) await browserStream.launch();
      const page = browserStream.page || (await browserStream.browser.newPage());
      const startTime = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const loadTime = Date.now() - startTime;
        const title = await page.title();
        const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '(không có)');
        const metaKeywords = await page.$eval('meta[name="keywords"]', el => el.content).catch(() => '(không có)');
        const h1Count = await page.$$eval('h1', els => els.length);
        const h2Count = await page.$$eval('h2', els => els.length);
        const imgNoAlt = await page.$$eval('img:not([alt]), img[alt=""]', els => els.length);
        const totalImages = await page.$$eval('img', els => els.length);
        const links = await page.$$eval('a[href]', els => els.length);
        const bodyText = await page.$eval('body', el => el.innerText.substring(0, 3000));
        const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
        const screenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
        const htmlSize = await page.content().then(c => c.length);
        return {
          title, metaDesc, metaKeywords, h1Count, h2Count,
          imgNoAlt, totalImages, links, loadTime, htmlSize,
          bodyText, screenshot,
          score: {
            seo: h1Count > 0 && metaDesc !== '(không có)' ? 'Tốt' : 'Cần cải thiện',
            speed: loadTime < 2000 ? 'Nhanh' : loadTime < 5000 ? 'Trung bình' : 'Chậm',
            accessibility: imgNoAlt === 0 ? 'Tốt' : 'Có ' + imgNoAlt + ' ảnh thiếu alt'
          }
        };
      } catch (err) {
        return { error: 'Lỗi phân tích: ' + err.message };
      }
    }
    case 'text_to_speech': {
      // FIX PROD: dùng Edge TTS Thuần Node.js (WebSocket tới Microsoft) — KHÔNG cần Python,
      // chạy được cả trên Render (trước đây dùng python3 trên Linux → lỗi trên server).
      // Voice validate theo danh sach THAT cua engine (khong hardcode) - dong bo services.routes.
      const isEdgeVoiceId = (v) => /^[a-z]{2,3}-[A-Z]{2}-[\w]+Neural$/.test(String(v || ''));
      let voices = null;
      try { voices = await listEdgeVoices(); } catch { voices = null; }
      const reqVoice = String(args.voice || '');
      const voiceName = (!voices || voices.some(v => v.id === reqVoice) || isEdgeVoiceId(reqVoice))
        ? (reqVoice || 'vi-VN-HoaiMyNeural') : 'vi-VN-HoaiMyNeural';
      const validRate = args.rate && /^[+-]\d+%$/.test(args.rate) ? args.rate : '+0%';
      const validPitch = args.pitch && /^[+-]\d+Hz$/.test(args.pitch) ? args.pitch : '+0Hz';
      const cleanedText = (args.text || '').replace(/"/g, '\\"').substring(0, 1000);
      if (!cleanedText.trim()) return { error: 'Văn bản trống' };
      try {
        const outFile = path.join(__dirname, '..', '..', 'temp', 'tts_' + Date.now() + '.mp3');
        const audioBuffer = await generateEdgeTTSNode(voiceName, cleanedText, validRate, validPitch, localeFromVoice(voiceName));
        if (!audioBuffer || audioBuffer.length === 0) return { error: 'TTS không tạo được âm thanh' };
        fs.writeFileSync(outFile, audioBuffer);
        return { success: true, audioFile: outFile, voice: voiceName };
      } catch (err) {
        return { error: 'TTS lỗi: ' + (err.message || err) };
      }
    }
    case 'video_edit': {
      const r = await videoEdit(args);
      if (r && r.success && r.fileName) {
        const base = (process.env.FRONTEND_URL || 'https://rexiai.bot.cd').replace(/\/$/, '');
        r.url = `${base}/api/services/video/file/${r.fileName}`;
      }
      return r;
    }
    case 'opencut_act': {
      const { enqueue } = require('./opencutBridge');
      return await enqueue(args.action, args);
    }
    default:
      return { error: "Tool '" + toolName + "' chưa được implement" };
  }
}
// ========== SEARCH WEB TOOL ==========
// Tìm kiếm web không cần API key:
//  1. DuckDuckGo Instant Answer API (api.duckduckgo.com — JSON, free, no key)
//  2. Fallback: scrape kết quả html.duckduckgo.com (đỡ rủi ro IA trả rỗng)
//  3. Fallback 2 (QA 17/9): Bing HTML — DDG chặn IP datacenter Render (403/anomaly)
//  4. Fallback 3 (QA 17/9): Google News RSS — JSON-free, gần như không chặn IP
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Giải mã HTML entities trong kết quả scrape (Bing/DDG trả &#224; &nbsp;...) + cắt gọn
function decodeHtmlEnt(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { const c = parseInt(n, 10); return (c > 0 && c < 0x10FFFF) ? String.fromCharCode(c) : _; })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const c = parseInt(h, 16); return (c > 0 && c < 0x10FFFF) ? String.fromCharCode(c) : _; })
    .replace(/&nbsp;|&#0?160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;|&#0?34;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '...').replace(/&emdash;|&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function cleanSearchResults(arr) {
  return (arr || []).map(r => ({
    type: r.type,
    title: decodeHtmlEnt(r.title).slice(0, 200),
    snippet: decodeHtmlEnt(r.snippet).slice(0, 400),
    url: String(r.url || '').replace(/&amp;/g, '&').trim(),
    source: r.source
  }));
}

async function googleNewsRss(query, limit = 8) {
  const rssRes = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=vi&gl=VN&ceid=VN:vi',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!rssRes.ok) return [];
  const xml = await rssRes.text();
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let im;
  while ((im = itemRe.exec(xml)) !== null && out.length < limit) {
    const item = im[1];
    const title = (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const source = (item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    if (title) out.push({ type: 'news', title: decodeHtmlEnt(title), url: link.trim().replace(/&amp;/g, '&'), snippet: decodeHtmlEnt((source.trim() + ' — ' + pubDate.trim()).replace(/^ — /, '')), source: 'google-news-rss' });
  }
  return out;
}

// ─── LAYER 1: DDG Instant Answer (JSON sạch, nhanh) ───
async function layerDDGIA(q) {
  try {
    const iaUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1&skip_disambig=1';
    const iaRes = await fetch(iaUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!iaRes.ok) return [];
    const ia = await iaRes.json();
    const results = [];
    if (ia.AbstractText) results.push({ type: 'abstract', title: ia.Heading || q, snippet: ia.AbstractText, url: ia.AbstractURL || '' });
    if (ia.Answer && ia.AnswerType !== '') results.push({ type: 'answer', title: 'Câu trả lời', snippet: String(ia.Answer), url: '' });
    if (Array.isArray(ia.RelatedTopics)) {
      for (const t of ia.RelatedTopics) {
        if (!t || typeof t !== 'object') continue;
        if (t.Topics && Array.isArray(t.Topics)) {
          for (const sub of t.Topics) {
            if (sub && sub.Text) results.push({ type: 'related', title: sub.FirstURL || '', snippet: sub.Text, url: sub.FirstURL || '' });
          }
        } else if (t.Text) {
          results.push({ type: 'related', title: t.FirstURL || '', snippet: t.Text, url: t.FirstURL || '' });
        }
      }
    }
    return cleanSearchResults(results).slice(0, 8);
  } catch (e) {
    console.warn('[Agent][search] DDG IA fail:', e.message);
    return [];
  }
}

// ─── LAYER 2: DDG HTML scrape ───
async function layerDDGHTML(q) {
  try {
    const htmlRes = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!htmlRes.ok) return [];
    const html = await htmlRes.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < 8) {
      out.push({
        type: 'result',
        title: m[2].replace(/<[^>]+>/g, '').trim(),
        snippet: m[3].replace(/<[^>]+>/g, '').trim(),
        url: m[1]
      });
    }
    return cleanSearchResults(out);
  } catch (e) {
    console.warn('[Agent][search] DDG HTML fail:', e.message);
    return [];
  }
}

// ─── LAYER 3: Bing HTML ───
async function layerBing(q) {
  try {
    const bingRes = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=vi',
      { headers: { 'User-Agent': UA, 'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(8000) });
    if (!bingRes.ok) return [];
    const bingHtml = await bingRes.text();
    const outB = [];
    const reB = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
    let mb;
    while ((mb = reB.exec(bingHtml)) !== null && outB.length < 8) {
      const snip = (mb[3].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
      outB.push({
        type: 'result',
        title: mb[2].replace(/<[^>]+>/g, '').trim(),
        snippet: snip.replace(/<[^>]+>/g, '').trim(),
        url: mb[1]
      });
    }
    return cleanSearchResults(outB);
  } catch (e) {
    console.warn('[Agent][search] Bing fail:', e.message);
    return [];
  }
}

// ─── MINI-RANKER RAG-style: recall từ khóa + độ tươi + dedupe ───
function normSearchKey(s) {
  return decodeHtmlEnt(s).toLowerCase().normalize('NFC').replace(/[^a-z0-9\u00c0-\u1ef9]+/gi, ' ').trim().replace(/\s+/g, ' ');
}
function searchQueryTokens(q) {
  const stop = new Set(['là', 'gì', 'của', 'cho', 'với', 'và', 'các', 'những', 'một', 'cái', 'này', 'kia', 'đó', 'bao', 'nhiêu', 'như', 'thế', 'nào', 'the', 'a', 'an', 'of', 'for', 'with', 'and', 'what', 'who', 'where', 'when', 'how', 'is', 'are', 'do', 'does']);
  return [...new Set(normSearchKey(q).split(' ').filter(w => w.length > 1 && !stop.has(w)))];
}
function parseResultAgeHours(t) {
  const s = String(t || '').toLowerCase().normalize('NFC');
  let m = s.match(/(\d+)\s*(phút|phut|minute|min\b)/); if (m) return (+m[1]) / 60;
  m = s.match(/(\d+)\s*(giờ|gio|hour|hr\b)/); if (m) return +m[1];
  m = s.match(/(\d+)\s*(ngày|ngay|day\b)/); if (m) return (+m[1]) * 24;
  m = s.match(/(\d+)\s*(tuần|tuan|week\b)/); if (m) return (+m[1]) * 168;
  m = s.match(/(\d+)\s*(tháng|thang|month\b)/); if (m) return (+m[1]) * 720;
  m = s.match(/(\d+)\s*(năm|nam|year\b)/); if (m) return (+m[1]) * 8760;
  m = s.match(/\w{3}, \d{1,2} \w{3} \d{4} [\d:]+ gmt/);
  if (m) { const d = Date.parse(m[0]); if (!isNaN(d)) { const h = (Date.now() - d) / 3600000; return h >= 0 ? h : null; } }
  return null;
}
function rankSearchResults(q, arr) {
  const toks = searchQueryTokens(q);
  const isNews = /tin tức|thời sự|thời tiết|dự báo|bão|chứng khoán|tỷ giá|bitcoin|crypto|mới nhất|hôm nay|vừa ra mắt|tin nóng|news|today|latest|weather|forecast|stock|price|breaking|giá/i.test(q);
  const seenUrl = new Set(), seenTitle = new Set();
  const out = [];
  for (const r of (arr || [])) {
    const url = String(r.url || '').trim();
    const title = String(r.title || '').trim();
    if (!title) continue;
    const tkey = normSearchKey(title).slice(0, 90);
    if (url && seenUrl.has(url)) continue;
    if (tkey && seenTitle.has(tkey)) continue;
    if (url) seenUrl.add(url);
    if (tkey) seenTitle.add(tkey);
    const tToks = new Set(normSearchKey(title).split(' ').filter(Boolean));
    const sToks = new Set(normSearchKey(r.snippet).split(' ').filter(Boolean));
    let hit = 0;
    for (const w of toks) {
      if (tToks.has(w)) { hit += 3; continue; }
      if (w.length >= 4) {
        let fuzzy = false;
        for (const t of tToks) { if ((t.includes(w) || w.includes(t)) && t.length >= 4) { fuzzy = true; break; } }
        if (fuzzy) { hit += 1.5; continue; }
      }
      if (sToks.has(w)) hit += 1;
    }
    const recall = toks.length ? hit / (toks.length * 3) : 0;
    const ageH = parseResultAgeHours(r.snippet) ?? parseResultAgeHours(title);
    const fresh = (ageH === null || ageH === undefined) ? 0.3 : ageH <= 24 ? 1 : ageH <= 72 ? 0.7 : ageH <= 168 ? 0.4 : ageH <= 720 ? 0.15 : 0;
    const boost = (r.type === 'abstract' || r.type === 'answer') ? 1.2 : 0;
    out.push({ type: r.type, title, snippet: String(r.snippet || ''), url, source: r.source, _score: recall * 5 + fresh * 2 + boost, _ageH: ageH });
  }
  out.sort((a, b) => b._score - a._score);
  // Câu hỏi tin tức: loại tin cũ (>7 ngày) khi còn đủ tin tươi
  if (isNews) {
    const freshOnes = out.filter(r => r._ageH === null || r._ageH === undefined || r._ageH <= 168);
    if (freshOnes.length >= 3) return freshOnes;
  }
  return out;
}

async function searchWebTool(query) {
  if (!query || !String(query).trim()) return { results: [] };
  const q = String(query).trim();
  // Chạy SONG SONG 4 tầng (thay vì nối tiếp) — tổng ≤ ~8s thay vì ~21s
  const settled = await Promise.allSettled([layerDDGIA(q), layerDDGHTML(q), layerBing(q), googleNewsRss(q, 8)]);
  const names = ['duckduckgo-ia', 'duckduckgo-html', 'bing-html', 'google-news-rss'];
  const tagged = [];
  settled.forEach((st, i) => {
    if (st.status === 'fulfilled' && Array.isArray(st.value)) {
      st.value.forEach(r => tagged.push({ ...r, source: r.source || names[i] }));
    }
  });
  const ranked = rankSearchResults(q, tagged);
  const used = [...new Set(ranked.map(r => r.source))].join('+') || 'none';
  return {
    results: ranked.slice(0, 8).map(r => ({
      type: r.type, title: String(r.title).slice(0, 200),
      snippet: String(r.snippet).slice(0, 400), url: r.url, source: r.source
    })),
    source: 'merged:' + used
  };
}

// ========== CALL AI ==========
async function callAI(prompt, m) {
  const { spawn } = require('child_process');
  const OPENCODE_BIN = process.env.OPENCODE_BIN_PATH || path.join(process.env.USERPROFILE || '', '.opencode', 'bin', 'opencode.exe');
  // Model mặc định: nvidia gemma-4-31b-it — key có sẵn trong auth.json opencode, chạy được, context 200k
  const model = m || 'nvidia/google/gemma-4-31b-it';

  // Thử OpenCode binary trước (miễn phí) — --pure bỏ plugins nặng (project 71k file → build chậm)
  if (fs.existsSync(OPENCODE_BIN)) {
    return new Promise((resolve) => {
      const proc = spawn(OPENCODE_BIN, ['run', prompt, '--auto', '--model', model, '--pure', '--title', 'agent-task'], {
        timeout: 300000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANG: 'en_US.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CLICOLOR: '0', CLICOLOR_FORCE: '0' }
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += stripAnsi(d.toString()); });
      proc.stderr.on('data', d => { stderr += stripAnsi(d.toString()); });
      proc.on('close', () => resolve(stdout.trim() || stderr.trim() || 'Lỗi AI: Không có phản hồi.'));
      proc.on('error', () => resolve('Lỗi AI: Không tìm thấy OpenCode binary.'));
    });
  }

  // FALLBACK: OmniRoute Free AI Gateway (đã cài trong skills/omniroute) — không cần API key
  // endpoint: http://localhost:20128/v1/chat/completions (có thể override bằng OMNIROUTE_BASE_URL)
  const omniBase = (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const omniRes = await fetch(omniBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: (process.env.OMNIROUTE_MODEL || 'pollinations/gpt-5') + '',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048
      })
    });
    clearTimeout(timer);
    if (omniRes.ok) {
      const data = await omniRes.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text.trim();
    }
  } catch (e) {
    console.warn('[Agent][callAI] OmniRoute fallback fail:', e.message);
  }

  // FALLBACK (cloud): provider OpenAI-compatible có key trong khoa_api — cùng chain internalAgent.
  // Trên Render (Linux) không có opencode.exe/OmniRoute → bắt buộc đi qua đây.
  try {
    const db = require('../config/db');
    const { decryptKey } = require('../utils/cryptoKeys');
    const { PROVIDER_ENDPOINTS } = require('../model-scanner.scheduler');
    const getCKey = async (prov) => {
      const rows = await new Promise((res) => db.all(
        "SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = ? AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1",
        [prov], (e, r) => res(e ? [] : (r || []))));
      if (!rows.length) return process.env[`${prov.toUpperCase()}_API_KEY`] || null;
      try { return decryptKey(rows[0].gia_tri_khoa).trim(); } catch { return rows[0].gia_tri_khoa; }
    };
    // Chain agent KHONG chot cung: env AGENT_PROVIDER/MODEL -> DB app_settings(agent_chain)
    // -> mac dinh (deepseek truoc, roi xkiro/kiosapi). Doi qua API PUT /api/agent/chain, khong can deploy.
    const chain = await getAgentChain();
    for (const c of chain) {
      try {
        const key = await getCKey(c.provider);
        const ep = PROVIDER_ENDPOINTS[c.provider];
        if (!key || !ep || !ep.endpoint) continue;
        const url = ep.endpoint.replace(/\/models\/?$/, '') + '/chat/completions';
        const cres = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2048 }),
          signal: AbortSignal.timeout(90000),
        });
        const ctext = await cres.text();
        if (!cres.ok) { console.warn('[Agent][callAI] cloud ' + c.provider + ' HTTP ' + cres.status); continue; }
        let j = null; try { j = JSON.parse(ctext); } catch { /* noop */ }
        const out = (j && j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) || '';
        if (String(out).trim()) return String(out).trim();
      } catch (e2) { console.warn('[Agent][callAI] cloud ' + c.provider + ' fail:', e2.message); }
    }
  } catch (eCloud) {
    console.warn('[Agent][callAI] cloud chain fail:', eCloud.message);
  }

  return 'Lỗi AI: Không có nguồn AI khả dụng (OpenCode chưa cài / OmniRoute chưa chạy / cloud LLM đều fail).';
}

// Chain agent dong: env -> DB setting -> mac dinh. Export de API GET/PUT.
async function getAgentChain() {
  const chain = [];
  const seen = new Set();
  const push = (provider, model) => {
    provider = String(provider || '').toLowerCase();
    model = String(model || '');
    const k = provider + '|' + model;
    if (provider && model && !seen.has(k)) { seen.add(k); chain.push({ provider, model }); }
  };
  if (process.env.AGENT_PROVIDER && process.env.AGENT_MODEL) {
    push(process.env.AGENT_PROVIDER, process.env.AGENT_MODEL);
  }
  try {
    const db = require('../config/db');
    const row = await new Promise((res) => db.get("SELECT gia_tri FROM app_settings WHERE khoa = 'agent_chain'", [], (e, r) => res(e ? null : r)));
    if (row && row.gia_tri) {
      const arr = JSON.parse(row.gia_tri);
      if (Array.isArray(arr)) for (const c of arr) {
        if (c && c.provider && c.model) push(c.provider, c.model);
      }
    }
  } catch (e) { console.warn('[Agent] doc agent_chain fail:', e.message); }
  push('groq', 'openai/gpt-oss-120b');        // model agent mạnh (ReAct JSON ổn) — ưu tiên đầu chuỗi
  push('unorouter', 'deepseek-v4-flash:free');
  push('xkiro', 'mistralai/mistral-small-2603');
  push('kiosapi', 'sensenova-6.8-flash');
  return chain;
}

module.exports = { executeTool, TOOL_REGISTRY, callAI, searchWebTool, getAgentChain };

