// Lazy-load: CHỈ require khi thực sự cần, tiết kiệm ~300-500MB RAM
let chromium = null;
const WebSocket = require('ws');
const { exec } = require('child_process');
const util = require('util');
const { decryptKey } = require('../utils/cryptoKeys');
const browserTask = require('./browserTask');
const execPromise = util.promisify(exec);

function getChromium() {
  if (!chromium) {
    console.log('[BrowserStream] Lazy-loading Playwright chromium...');
    chromium = require('playwright').chromium;
  }
  return chromium;
}

class BrowserStreamService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.wss = null;
    this.clients = new Set();
    this.frameInterval = null;
    this.stagehand = null;
    this._autoCloseTimer = null;
    this._frameSkipCounter = 0;
    this.subscribers = new Set();          // SSE response streams (push frames)
    this._screencastOn = false;
    this._screencastHandler = null;
    this._fallbackInterval = null;
    this.streamOpts = { quality: 45, maxWidth: 960, maxHeight: 540, fps: 15 };
    this._lastFrameTs = 0;
    this._droppedFrames = 0;
    this._lastFrameB64 = null;      // frame gần nhất (cho vision)
    this._visionModel = null;       // model vision đã xác nhận hoạt động
    this._lastFrameAt = 0;          // mốc thời gian frame cuối (để keepalive)
    this._keepAliveTimer = null;
    this._encodeCount = 0;          // số frame browser đã encode (đo tải CPU)
  }

  setWSS(wss) {
    this.wss = wss;
    console.log('[BrowserStream] setWSS called, path:', wss.options?.path || 'default');
    this.wss.on('connection', (ws, req) => {
      // DEBUG 4/10: ping ngay khi connection — nếu client nhận được thì handler chạy
      try { ws.send(JSON.stringify({ type: 'hello', msg: 'connection handler running' })); } catch (e) {}
      // P0-03: WS đã qua verifyClient ở server.js — decode lại token để gắn user,
      // phòng trường hợp WSS được dựng ở nơi khác mà quên verifyClient.
      let user = null;
      try {
        const jwt = require('jsonwebtoken');
        const { getJWTSecret } = require('../middleware/auth.middleware');
        const reqUrl = req?.url || '';
        let token = '';
        const q = reqUrl.indexOf('?');
        if (q >= 0) {
          try { token = new URL(reqUrl, 'http://localhost').searchParams.get('token') || ''; } catch (e) {}
        }
        if (!token) {
          const proto = req?.headers?.['sec-websocket-protocol'] || '';
          const parts = String(proto).split(',').map((s) => s.trim()).filter(Boolean);
          if (parts.length) token = parts[parts.length - 1];
        }
        if (token) user = jwt.verify(token, getJWTSecret());
      } catch (e) { user = null; this._authError = e ? e.message : 'unknown'; }
      if (!user) {
        console.log('[WS] Rejected unauthenticated client');
        // DEBUG 4/10: gửi lỗi thật về client trước khi close (handshake chưa hoàn tất
        // server-side thì close(4401) ngầm → client chỉ thấy 1006 không biết vì sao)
        try { ws.send(JSON.stringify({ type: 'auth_failed', msg: this._authError || 'invalid token' })); } catch (e2) {}
        try { ws.close(4401, 'Unauthorized'); } catch (e) {}
        return;
      }
      ws.user = user;
      console.log('[WS] Client connected! User:', user.id || user.email || '?', 'URL:', req?.url?.split('?')[0], 'Total:', this.clients.size + 1);
      this.clients.add(ws);
      this._totalConnections = (this._totalConnections || 0) + 1;
      this._resetAutoClose();

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log('[WS] Client disconnected. Total:', this.clients.size);
        // Auto-close browser nếu không còn client sau 60s
        if (this.clients.size === 0) {
          this._scheduleAutoClose();
        }
      });
      
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data);
          await this.handleMessage(msg, ws);
        } catch (e) {
          console.error('WS message error:', e);
        }
      });

      // Send initial frame immediately when client connects
      if (!this.page && !this.browser) {
        // FIX 4/10: connect mà chưa có browser → tự launch + gửi frame đầu
        // (trước đây chỉ navigate/click mới launch → client connect thấy màn hình đen vĩnh viễn)
        this.launch().then(() => {
          if (!this.page) return null;
          return this.page.screenshot({ type: 'jpeg', quality: 40 });
        }).then((screenshot) => {
          if (!screenshot) return;
          const frameData = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
          const message = JSON.stringify({ type: 'frame', data: frameData });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
            console.log('[WS] Sent initial frame to new client (auto-launched)');
          }
        }).catch(e => console.error('[WS] Auto-launch/frame error:', e.message));
      } else if (this.page) {
        this.page.screenshot({ type: 'jpeg', quality: 40 }).then(screenshot => {
          const frameData = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
          const message = JSON.stringify({ type: 'frame', data: frameData });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
            console.log('[WS] Sent initial frame to new client');
          }
        }).catch(e => console.error('[WS] Initial frame error:', e.message));
      }
    });

    // Frame mượt: CDP Page.startScreencast (event-driven, ~fps cấu hình) thay vì setInterval chụp 2fps.
    // Chỉ chạy khi có người xem (subscribers/clients) — không tốn CPU khi rảnh.
    this.startScreencast().catch((e) => console.error('[BrowserStream] screencast init:', e.message));
  }

  // Bật screencast event-driven. Frames đẩy qua _sendFrame() tới cả SSE subscribers lẫn WS clients.
  async startScreencast() {
    if (this._screencastOn || !this.cdpSession) return;
    try {
      if (!this._screencastHandler) {
        this._screencastHandler = async (params) => {
          // Phải ACK mỗi frame, nếu không Chromium ngừng gửi frame tiếp.
          try { await this.cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch (e) {}
          this._encodeCount++;
          const now = Date.now();
          const minGap = 1000 / (this.streamOpts.fps || 15);
          if (now - this._lastFrameTs < minGap) { this._droppedFrames++; return; } // throttle tới fps mục tiêu
          this._lastFrameTs = now;
          this._lastFrameAt = now;
          this._sendFrame(params.data);
        };
        this.cdpSession.on('Page.screencastFrame', this._screencastHandler);
      }
      // everyNthFrame: Chromium BỎ QUA frame trước khi encode → giảm tải CPU encode JPEG
      // (trên Render free 0.5 vCPU, encode ở nhịp compositor 60/s là nút thắt chính).
      const targetFps = Math.max(1, this.streamOpts.fps || 15);
      const everyNthFrame = Math.max(1, Math.min(4, Math.round(60 / targetFps)));
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.streamOpts.quality,
        maxWidth: this.streamOpts.maxWidth,
        maxHeight: this.streamOpts.maxHeight,
        everyNthFrame,
      });
      this._screencastOn = true;
      if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
      this._startKeepAlive();
      console.log('[BrowserStream] Screencast ON', JSON.stringify({ ...this.streamOpts, everyNthFrame }));
    } catch (e) {
      console.error('[BrowserStream] startScreencast failed, dùng fallback:', e.message);
      this._startFallbackFrames();
    }
  }

  // Keepalive: trang tĩnh không sinh frame mới → compositor ngừng đẩy → client tưởng chết.
  // Cứ mỗi 1.5s nếu không có frame nào mới → chụp 1 tấm bằng CDP để đẩy cho client.
  _startKeepAlive() {
    if (this._keepAliveTimer) return;
    this._keepAliveTimer = setInterval(async () => {
      if (!this._screencastOn) return;
      if (this.subscribers.size === 0 && this.clients.size === 0) return;
      const idle = Date.now() - (this._lastFrameAt || 0);
      if (idle < 1500) return;
      try {
        const r = await this.cdpSession.send('Page.captureScreenshot', { format: 'jpeg', quality: this.streamOpts.quality });
        this._lastFrameAt = Date.now();
        this._lastFrameTs = this._lastFrameAt;
        this._sendFrame(r.data);
      } catch (e) { /* ignore */ }
    }, 1200);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
  }

  async stopScreencast() {
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
    this._stopKeepAlive();
    if (!this._screencastOn || !this.cdpSession) { this._screencastOn = false; return; }
    try { await this.cdpSession.send('Page.stopScreencast'); } catch (e) {}
    this._screencastOn = false;
  }

  // Fallback nếu startScreencast không hỗ trợ: poll ~10fps (vẫn mượt hơn 2fps cũ).
  _startFallbackFrames() {
    if (this._fallbackInterval) return;
    this._fallbackInterval = setInterval(async () => {
      if (!this.page || (this.subscribers.size === 0 && this.clients.size === 0)) return;
      try {
        let b64 = null;
        if (this.cdpSession) {
          try { const r = await this.cdpSession.send('Page.captureScreenshot', { format: 'jpeg', quality: this.streamOpts.quality }); b64 = r.data; } catch (e) {}
        }
        if (!b64) { const buf = await this.page.screenshot({ type: 'jpeg', quality: this.streamOpts.quality }); b64 = buf.toString('base64'); }
        this._sendFrame(b64);
      } catch (e) { /* bỏ frame lỗi */ }
    }, Math.max(1000 / (this.streamOpts.fps || 10), 66));
    console.log('[BrowserStream] fallback frame interval ON (~' + this.streamOpts.fps + 'fps)');
  }

  // Đổi thông số stream (quality/fps/kích thước) — restart screencast nếu đang chạy.
  async setStreamOpts(opts = {}) {
    if (typeof opts.quality === 'number') this.streamOpts.quality = Math.max(20, Math.min(90, opts.quality | 0));
    if (typeof opts.fps === 'number') this.streamOpts.fps = Math.max(1, Math.min(60, opts.fps | 0));
    if (typeof opts.maxWidth === 'number') this.streamOpts.maxWidth = opts.maxWidth | 0;
    if (typeof opts.maxHeight === 'number') this.streamOpts.maxHeight = opts.maxHeight | 0;
    if (this._screencastOn) {
      try { await this.cdpSession.send('Page.stopScreencast'); } catch (e) {}
      this._screencastOn = false;
      this._lastFrameTs = 0;
      await this.startScreencast();
    }
    return this.streamOpts;
  }

  // Đăng ký 1 SSE response làm người nhận frame (push thay vì client poll).
  async addSubscriber(res) {
    this.subscribers.add(res);
    this._resetAutoClose();
    await this.startScreencast();
    // Gửi ngay 1 frame hiện tại để client không thấy màn hình trống khi trang tĩnh.
    try {
      const shot = await this.debugFrame();
      if (shot.success && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'frame', data: `data:image/jpeg;base64,${shot.b64}`, ts: Date.now() })}\n\n`);
      }
    } catch (e) { /* ignore */ }
  }

  removeSubscriber(res) {
    this.subscribers.delete(res);
    if (this.subscribers.size === 0 && this.clients.size === 0) this._scheduleAutoClose();
  }

  // Phát 1 frame tới mọi kênh; bỏ frame cho client chậm (backpressure) để không dồn RAM.
  _sendFrame(b64, mime = 'image/jpeg') {
    this._lastFrameB64 = b64;
    const message = JSON.stringify({ type: 'frame', data: `data:${mime};base64,${b64}`, ts: Date.now() });
    this.clients.forEach((c) => { try { if (c.readyState === WebSocket.OPEN) c.send(message); } catch (e) {} });
    this.subscribers.forEach((res) => {
      try {
        if (res.writableEnded || res.destroyed) { this.subscribers.delete(res); return; }
        if (res.writableLength > 3 * 1024 * 1024) { this._droppedFrames++; return; } // client tắc nghẽn → bỏ frame
        res.write(`data: ${message}\n\n`);
      } catch (e) { this.subscribers.delete(res); }
    });
  }

  // Gửi event phi-frame (step, task status...) tới client — cùng kênh SSE.
  _sendEvent(obj) {
    const message = JSON.stringify({ ...obj, ts: Date.now() });
    this.clients.forEach((c) => { try { if (c.readyState === WebSocket.OPEN) c.send(message); } catch (e) {} });
    this.subscribers.forEach((res) => {
      try {
        if (res.writableEnded || res.destroyed) { this.subscribers.delete(res); return; }
        res.write(`data: ${message}\n\n`);
      } catch (e) { this.subscribers.delete(res); }
    });
  }

  // Lấy frame hiện tại (b64) — ưu tiên frame vừa stream, không thì chụp 1 tấm.
  async getFrameB64(opts = {}) {
    // fresh=true: chụp mới để không đọc trúng frame cũ (quan trọng cho vision).
    if (opts.fresh) {
      try {
        const shot = await this.debugFrame();
        if (shot && shot.success) return shot.b64;
      } catch (e) { /* ignore */ }
    }
    if (this._lastFrameB64) return this._lastFrameB64;
    const shot = await this.debugFrame().catch(() => null);
    return shot && shot.success ? shot.b64 : null;
  }

  // ĐỌC MÀN HÌNH bằng model vision — cho canvas/game/đồ hoạ không có DOM text.
  // Ưu tiên NVIDIA (nvidiaChat: pool model VL + xoay key) → fallback Groq multimodal.
  async vision(prompt, opts = {}) {
    const b64 = await this.getFrameB64({ fresh: opts.fresh !== false });
    if (!b64) return { success: false, error: 'Chưa có frame nào để đọc.' };
    const question = String(prompt || 'Mô tả chính xác nội dung đang hiển thị trên màn hình, kèm toạ độ các nút/điểm đáng chú ý.');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
      ],
    }];

    // 1) NVIDIA — model VL trong pool, tự xoay key khi lỗi
    try {
      const nvidiaChat = require('./nvidiaChat');
      const r = await nvidiaChat.handle({ model: opts.model || undefined, messages });
      if (r && r.ok && r.content) {
        this._visionModel = r.model;
        return { success: true, model: r.model, provider: 'nvidia', text: r.content };
      }
      if (r && r.tried && r.tried.length) console.log('[BrowserStream] vision nvidia fail:', r.tried.slice(0, 3).join(' | '));
    } catch (e) {
      console.log('[BrowserStream] vision nvidia exception:', e.message);
    }

    // 2) Fallback: Groq multimodal
    const apiKey = await this._getGroqKey();
    if (!apiKey) return { success: false, error: 'Không có provider vision khả dụng (NVIDIA/Groq).' };
    const candidates = this._visionModel
      ? [this._visionModel]
      : ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-3.2-11b-vision-preview'];
    let lastErr = '';
    for (const model of candidates) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: opts.maxTokens || 700 }),
        });
        if (!res.ok) { lastErr = model + ': HTTP ' + res.status; continue; }
        const data = await res.json();
        const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        if (!text) { lastErr = model + ': rỗng'; continue; }
        this._visionModel = model;
        return { success: true, model, provider: 'groq', text };
      } catch (e) { lastErr = model + ': ' + e.message; }
    }
    return { success: false, error: 'Không đọc được màn hình: ' + lastErr };
  }

  _scheduleAutoClose() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    this._autoCloseTimer = setTimeout(async () => {
      if (this.clients.size === 0 && this.browser) {
        console.log('[BrowserStream] Auto-closing browser — no clients for 60s');
        await this.close();
      }
    }, 60000); // 60s
  }

  _resetAutoClose() {
    if (this._autoCloseTimer) {
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }
  }

  async handleMessage(msg, ws) {
    // P0-03: chỉ client đã xác thực mới được điều khiển browser qua WS
    // (REST /browser/* đã có authMiddleware — WS phải tương đương).
    if (!ws || !ws.user) return;
    if (!this.page) return;
    
    switch (msg.type) {
      case 'click':
        await this.page.mouse.click(msg.x, msg.y);
        break;
      case 'type':
        await this.page.keyboard.type(msg.text);
        break;
      case 'key':
        await this.page.keyboard.press(msg.key);
        break;
      case 'scroll':
        await this.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
        break;
      case 'navigate':
        await this.page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
    }
  }

  async launch(options = {}) {
    console.log('[BrowserStream] launch() called, browser exists:', !!this.browser, 'url:', options.url);
    // Chống launch song song (SSE + action cùng lúc) → dùng chung 1 promise.
    if (this._launchPromise) return this._launchPromise;
    if (this.browser && this.page) return { success: true };
    this._launchPromise = this._launch(options).finally(() => { this._launchPromise = null; });
    return this._launchPromise;
  }

  // Chờ page sẵn sàng (browser có thể đã mở nhưng page chưa tạo xong) — tránh this.page undefined.
  async _ensurePage(timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.page && !this.page.isClosed()) return this.page;
      if (!this.browser) { await this.launch(); continue; }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Trình duyệt chưa sẵn sàng (launch quá lâu)');
  }

  async _launch(options = {}) {

    try {
      console.log('[BrowserStream] Launching chromium (bundled, headless — KHÔNG mở cửa sổ Chrome thật)...');
      const pw = getChromium();
      const ARGS = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--window-size=1280,720',
        '--js-flags=--max-old-space-size=256',
        '--disable-blink-features=AutomationControlled',
        '--lang=vi-VN',
        // --- Tối ưu CPU cho Render free (0.5 vCPU, software raster) ---
        // KHÔNG bật --disable-frame-rate-limit / --disable-gpu-vsync: chúng ép
        // compositor chạy tốc độ tối đa → mỗi frame đều tốn CPU raster + encode.
        // Nhịp frame giới hạn bằng everyNthFrame của Page.startScreencast.
        '--disable-features=CalculateNativeWinOcclusion,BackForwardCache',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--autoplay-policy=no-user-gesture-required',
      ];
      // Ưu tiên full Chromium (channel 'chromium' → new headless, có compositor thật)
      // để Page.startScreencast sinh frame mượt; fallback về headless shell nếu thiếu bản full.
      try {
        this.browser = await pw.launch({ channel: 'chromium', headless: true, args: ARGS });
        console.log('[BrowserStream] Launch OK — full chromium (new headless)');
      } catch (e1) {
        console.log('[BrowserStream] channel chromium fail -> headless shell:', e1.message);
        try {
          this.browser = await pw.launch({ headless: true, args: ARGS });
          console.log('[BrowserStream] Launch OK — headless shell');
        } catch (e2) {
          console.log('[BrowserStream] Default launch failed, retrying minimal:', e2.message);
          this.browser = await pw.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,720'],
          });
        }
      }

      const context = await this.browser.newContext({
        // Khớp canvas FE (1280×720) để toạ độ click bám đúng + giảm 10% diện tích raster.
        viewport: { width: 1280, height: 720 },
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        deviceScaleFactor: 1,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });

      this.page = await context.newPage();
      console.log('[BrowserStream] Page created, this.page:', !!this.page);

      // CDP session for frame capture
      this.cdpSession = await this.page.context().newCDPSession(this.page);
      console.log('[BrowserStream] CDP session created');

      await this.cdpSession.send('Page.enable');
      // Bỏ Animation.enable — không cần, tiết kiệm memory
      // Nếu đã có người xem (SSE/WS mở trước khi launch) → bật screencast ngay.
      if (this.subscribers.size > 0 || this.clients.size > 0) {
        this.startScreencast().catch(() => {});
      }
    } catch (e) {
      console.error('[BrowserStream] Launch failed:', e.message);
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      throw new Error('Không thể khởi động Chrome: ' + e.message);
    }

    // KHÔNG init Stagehand ở đây nữa — lazy init khi cần act()

    // Navigate to initial page
    if (options.url) {
      try {
        await this.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        console.log('[BrowserStream] Initial navigation failed:', e.message);
      }
    }

    return { success: true };
  }

  // NOTE FOR AI AGENTS: Key API Groq được ưu tiên lấy trực tiếp từ CSDL SQLite (bảng khoa_api, ten_nha_cung_cap = 'groq').
  // File .env chỉ là phương án dự phòng (fallback), không bắt buộc phải có GROQ_API_KEY trong .env.
  async _getGroqKey() {
    try {
      const db = require('../config/db');
      const key = await new Promise((resolve) => {
        db.get("SELECT gia_tri_khoa FROM khoa_api WHERE ten_nha_cung_cap = 'groq'", [], (e, r) => resolve(r?.gia_tri_khoa ? decryptKey(r.gia_tri_khoa) : ''));
      });
      return key || process.env.GROQ_API_KEY || '';
    } catch (e) {
      return process.env.GROQ_API_KEY || '';
    }
  }

  // Dùng Groq LLM dịch lệnh tiếng Việt → hành động JSON → thực thi bằng Playwright
  // (điều khiển đúng page đang stream; không cần Stagehand vì v3 không wire được page ngoài)
  async _executeWithGroq(instruction) {
    const apiKey = await this._getGroqKey();
    if (!apiKey) {
      return { success: false, error: 'AI Action cần API key Groq. Vào Admin Panel → Keys để thêm, hoặc đặt GROQ_API_KEY trong .env.' };
    }

    const actionSchema = {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'click | clickAt | type | press | scroll | goto | wait | done' },
              selector: { type: 'string', description: 'CSS selector hoặc text=... (chỉ cho click/type)' },
              text: { type: 'string', description: 'nội dung cần gõ (chỉ cho type)' },
              key: { type: 'string', description: 'phím như Enter/Backspace (chỉ cho press)' },
              direction: { type: 'string', description: 'up/down/left/right (chỉ cho scroll)' },
              url: { type: 'string', description: 'URL cần mở (chỉ cho goto)' },
              x: { type: 'number', description: 'toạ độ X (chỉ cho clickAt)' },
              y: { type: 'number', description: 'toạ độ Y (chỉ cho clickAt)' },
              description: { type: 'string' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    };

    const terms = (String(instruction).toLowerCase().match(/[a-zà-ỹ0-9]+/gi) || []).filter(w => w.length >= 2);
    const elements = await this._interactiveMap(80, terms).catch(() => []);
    const elList = elements.map((e, i) => `${i + 1}. <${e.tag}${e.role ? ' role=' + e.role : ''}> "${e.text}"${e.id ? ' id=' + e.id : ''}${e.name ? ' name=' + e.name : ''}${e.href ? ' href=' + e.href : ''} @(${e.x},${e.y})`).join('\n');
    const vp = await this._viewportText(2500).catch(() => '');

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            {
              role: 'system',
              content: 'Bạn là trợ lý điều khiển trình duyệt (Playwright). Dịch chỉ dẫn thành danh sách hành động JSON thực hiện trên TRANG HIỆN TẠI.\n' +
                'URL: ' + (this.page?.url() || 'chưa mở') + '\n' +
                'PHẦN TỬ TƯƠNG TÁC ĐANG HIỂN THỊ (chọn đúng từ đây):\n' + (elList || '(không thấy phần tử nào)') + '\n' +
                'NỘI DUNG ĐANG NHÌN THẤY:\n' + (vp ? vp.slice(0, 1200) : '(trống)') + '\n\n' +
                'QUY TẮC CHỌN:\n' +
                '- click: ưu tiên selector lấy ĐÚNG TỪ DANH SÁCH: link thì dùng a[href="<href>"] (chính xác nhất), hoặc "#id", hoặc "[name=...]". Nếu nhiều phần tử cùng chữ "Next" thì PHẢI dùng a[href=...] để chọn đúng cái cần.\n' +
                '- Phần tử là canvas/không có nhãn (vd phím đàn, nút vẽ bằng hình) → dùng {"type":"clickAt","x":..,"y":..} theo toạ độ trong danh sách.\n' +
                '- type: cần selector ô nhập (từ danh sách). press: phím (vd Enter). scroll: direction up/down. goto: url.\n' +
                '- Chỉ trả về 1 hành động nếu đủ. Không cần thao tác → actions rỗng.'
            },
            { role: 'user', content: instruction }
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'browser_actions', schema: actionSchema } }
        })
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      let actions = [];
      try { actions = JSON.parse(content).actions || []; } catch (e) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { actions = JSON.parse(m[0]).actions || []; } catch (e2) {} }
      }

      if (!actions || actions.length === 0) {
        return { success: true, result: { message: 'Không có hành động phù hợp cho chỉ dẫn này.' } };
      }

      let lastError = '';
      for (const a of actions) {
        try {
          switch (a.type) {
            case 'click':
              if (a.selector) {
                const loc = this.page.locator(a.selector).first();
                try {
                  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                  await loc.click({ timeout: 8000 });
                } catch (e1) {
                  // fallback 1: click trực tiếp bằng DOM
                  try { await loc.evaluate((el) => el.click()); }
                  catch (e2) {
                    // fallback 2: nếu là link → điều hướng thẳng tới href
                    const href = await loc.getAttribute('href').catch(() => null);
                    if (href) await this.page.goto(new URL(href, this.page.url()).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    else throw e1;
                  }
                }
              }
              await this.page.waitForTimeout(250);
              break;
            case 'clickAt':
              if (typeof a.x === 'number' && typeof a.y === 'number') await this.page.mouse.click(a.x, a.y);
              await this.page.waitForTimeout(250);
              break;
            case 'type':
              if (a.selector) await this.page.locator(a.selector).first().fill(a.text || '', { timeout: 10000 });
              else await this.page.keyboard.type(a.text || '');
              await this.page.waitForTimeout(200);
              break;
            case 'press':
              await this.page.keyboard.press(a.key || 'Enter');
              await this.page.waitForTimeout(350);
              break;
            case 'scroll':
              await this.page.mouse.wheel(0, a.direction === 'up' ? -600 : 600);
              break;
            case 'goto':
              if (a.url) await this.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              break;
            case 'wait':
              await this.page.waitForTimeout(600);
              break;
            case 'done':
              return { success: true, result: { message: '✅ Đã hoàn tất: ' + (a.description || instruction) } };
          }
        } catch (e) {
          lastError = a.type + (a.selector ? ' ' + a.selector : '') + ': ' + e.message;
          console.log('[BrowserAction] action loi:', lastError);
        }
      }
      // Sau hành động có thể đã điều hướng trang → chờ load xong rồi mới đọc tiêu đề/nội dung
      await this.page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      await this.page.waitForTimeout(300).catch(() => {});
      // Một số trang có trang trung gian tiêu đề "Loading ..." → chờ tới trang thật rồi mới đọc
      let title = '';
      for (let i = 0; i < 8; i++) {
        try { title = await this.page.title(); } catch { title = ''; }
        if (title && !/^loading/i.test(title)) break;
        await this.page.waitForTimeout(400).catch(() => {});
      }
      const after = await this._viewportText(2500).catch(() => '');
      const actionsUsed = actions.map(a => a.type + (a.selector ? (' ' + a.selector) : '') + (a.x != null ? (' (' + a.x + ',' + a.y + ')') : '')).join(' | ');
      return { success: true, result: { message: `✅ Đã thực hiện ${actions.length} hành động: ${instruction}`, url: this.page.url(), title, text: after, viewportText: after, actionsUsed, error: lastError || undefined, mapUsed: elList.slice(0, 1400) } };
    } catch (e) {
      return { success: false, error: 'Lỗi AI Action: ' + e.message };
    }
  }

  async navigate(url) {
    if (!this.page) {
      await this.launch({ url });
    } else {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    // Trả luôn TIÊU ĐỀ + TEXT trang để agent (model text) đọc được nội dung ngay,
    // không phải đoán qua screenshot (model không nhìn ảnh).
    let title = '';
    let text = '';
    try {
      title = await this.page.title();
      text = await this.page.evaluate(() =>
        String((document.body && document.body.innerText) || '')
          .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 6000));
    } catch (e) { /* ignore */ }
    return { success: true, url: this.page.url(), title, text };
  }

  // Text ĐANG NHÌN THẤY trong khung nhìn hiện tại (theo vị trí cuộn) — để agent đọc đúng phần đang xem.
  async _viewportText(maxChars = 3000) {
    if (!this.page) return '';
    try {
      return await this.page.evaluate((m) => {
        const vh = window.innerHeight, vw = window.innerWidth;
        const root = document.querySelector('main') || document.querySelector('article') || document.body || document.documentElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const parts = [];
        let n, total = 0;
        while ((n = walker.nextNode())) {
          const t = n.nodeValue && n.nodeValue.trim();
          if (!t) continue;
          const el = n.parentElement;
          if (!el) continue;
          if (el.closest('nav, aside, header, footer, [role="navigation"], [role="banner"], [role="menu"]')) continue;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
          parts.push(t);
          total += t.length + 1;
          if (total > m) break;
        }
        return parts.join('\n').slice(0, m);
      }, maxChars);
    } catch { return ''; }
  }

  // Danh sách phần tử TƯƠNG TÁC đang hiển thị (nhãn + toạ độ) — cấp cho LLM của act() để chọn đúng selector.
  async _interactiveMap(max = 80, terms = []) {
    if (!this.page) return [];
    try {
      return await this.page.evaluate((max, terms) => {
        const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[onclick]';
        const vh = window.innerHeight, vw = window.innerWidth;
        const out = [];
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
          let label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.value ||
            el.innerText || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ');
          if (label.length > 60) label = label.slice(0, 60);
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            text: label,
            id: el.id || '',
            name: el.getAttribute('name') || '',
            href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            onScreen,
          });
          if (out.length >= max * 4) break;
        }
        // Ưu tiên: (1) phần tử có nhãn khớp từ khoá trong chỉ dẫn, (2) phần tử đang hiển thị
        const hit = (e) => { const t = (e.text || '').toLowerCase(); return terms.some(w => t.includes(w)) ? 1 : 0; };
        out.sort((a, b) => (hit(b) - hit(a)) || ((b.onScreen ? 1 : 0) - (a.onScreen ? 1 : 0)));
        return out.slice(0, max);
      }, max, terms);
    } catch { return []; }
  }

  // Đọc lại nội dung trang hiện tại dưới dạng text (cho agent).
  // Kèm viewportText = phần đang nhìn thấy + vị trí cuộn — để agent đọc đúng sau khi cuộn/bấm.
  async readText(maxChars = 6000) {
    if (!this.page) return { success: false, error: 'Chưa mở trang nào.' };
    try {
      const title = await this.page.title();
      const text = await this.page.evaluate((m) =>
        String((document.body && document.body.innerText) || '')
          .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, m), maxChars);
      let scrollY = 0, scrollHeight = 0;
      try {
        const pos = await this.page.evaluate(() => ({ y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, vh: window.innerHeight }));
        scrollY = pos.y; scrollHeight = pos.h;
      } catch { /* ignore */ }
      const viewportText = await this._viewportText(3000);
      return { success: true, url: this.page.url(), title, text, viewportText, scrollY, scrollHeight };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async act(instruction) {
    await this._ensurePage();

    const trimmed = String(instruction || '').trim();
    const goto = async (url) => {
      try {
        // P2-18: act() đi qua WS (không qua route /browser/navigate) → check SSRF tại đây
        const { assertPublicUrlAsync } = require('../utils/urlSafety');
        const check = await assertPublicUrlAsync(url);
        if (!check.ok) return { success: false, error: check.reason };
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { success: true, result: { message: `Đã mở: ${url}` } };
      } catch (e) {
        return { success: false, error: 'Không mở được trang: ' + e.message };
      }
    };

    // 1) Lệnh điều hướng (open/go to/visit/mở/truy cập...) → goto trực tiếp, không cần LLM
    const navMatch = trimmed.match(/^(?:open|go to|visit|navigate to|mở|truy cập|tới)\s+(.+)$/i);
    if (navMatch) {
      let target = navMatch[1].trim();
      if (/^https?:\/\//i.test(target)) return goto(target);
      if (/^[^\s.]+\.[a-z]{2,}(?:\/.*)?$/i.test(target)) return goto('https://' + target);
      // Không phải URL → coi như tìm kiếm
      return goto('https://www.google.com/search?q=' + encodeURIComponent(target));
    }

    // 2) Lệnh tìm kiếm (search/tìm kiếm/google...) → Google Search
    const searchMatch = trimmed.match(/^(?:search|tìm kiếm|tìm|google)\s+(.+)$/i);
    if (searchMatch) {
      return goto('https://www.google.com/search?q=' + encodeURIComponent(searchMatch[1].trim()));
    }

    // 2b) Cuộn tới đầu/cuối trang bằng heuristic (không cần LLM) — trả về nội dung tại vị trí đó
    if (/(cuối trang|dưới cùng|xuống hết|bottom|kéo xuống cuối)/i.test(trimmed)) {
      try {
        await this.page.evaluate(() => { const el = document.scrollingElement || document.documentElement; el.scrollTop = el.scrollHeight; window.scrollTo(0, el.scrollHeight); });
        await this.page.waitForTimeout(450);
        const t = await this.readText(4000);
        return { success: true, result: { message: `Đã cuộn xuống cuối trang (scrollY=${t.scrollY}/${t.scrollHeight}).`, url: t.url, title: t.title, text: t.viewportText, viewportText: t.viewportText, scrollY: t.scrollY } };
      } catch (e) { /* ignore, xử lý chung bên dưới */ }
    }
    if (/(đầu trang|trên cùng|lên đầu|top|kéo lên đầu)/i.test(trimmed)) {
      try {
        await this.page.evaluate(() => { const el = document.scrollingElement || document.documentElement; el.scrollTop = 0; window.scrollTo(0, 0); });
        await this.page.waitForTimeout(350);
        const t = await this.readText(4000);
        return { success: true, result: { message: `Đã cuộn lên đầu trang (scrollY=${t.scrollY}).`, url: t.url, title: t.title, text: t.viewportText, viewportText: t.viewportText, scrollY: t.scrollY } };
      } catch (e) { /* ignore */ }
    }

    // 3) Lệnh điều khiển phức tạp → Groq LLM dịch thành hành động rồi thực thi bằng Playwright
    const r = await this._executeWithGroq(instruction).catch((e) => ({ success: false, error: String(e && e.message || e) }));
    // Không dịch được hành động (Groq thiếu key/lỗi) → trả NỘI DUNG TRANG hiện tại để agent vẫn có dữ liệu dùng.
    if (!r || r.success === false || /Không có hành động|không phù hợp/i.test(JSON.stringify(r.result || ''))) {
      try {
        const t = await this.readText(5000);
        if (t && t.text) return { success: true, result: { message: 'Không dịch được hành động cụ thể; trả về NỘI DUNG TRANG hiện tại.', url: t.url, title: t.title, text: t.text } };
      } catch (e) { /* ignore */ }
    }
    return r;
  }

  async click(x, y) {
    await this._ensurePage();
    await this.page.mouse.click(x, y);
    return { success: true };
  }

  async mouseMove(x, y, steps = 1) {
    await this._ensurePage();
    await this.page.mouse.move(Number(x) || 0, Number(y) || 0, { steps: Math.max(1, steps | 0) });
    return { success: true };
  }

  async mouseButton(action, x, y, button = 'left') {
    await this._ensurePage();
    if (typeof x === 'number' && typeof y === 'number' && !Number.isNaN(x) && !Number.isNaN(y)) {
      await this.page.mouse.move(x, y);
    }
    if (action === 'down') await this.page.mouse.down({ button });
    else if (action === 'up') await this.page.mouse.up({ button });
    return { success: true };
  }

  async type(text) {
    await this._ensurePage();
    await this.page.keyboard.type(text);
    return { success: true };
  }

  async key(key) {
    await this._ensurePage();
    await this.page.keyboard.press(key);
    return { success: true };
  }

  async scroll(deltaX, deltaY) {
    await this._ensurePage();
    await this.page.mouse.wheel(Number(deltaX) || 0, Number(deltaY) || 0);
    return { success: true };
  }

  // CUỘN LIÊN TỤC — nhịp rAF trong page (mượt thật, không phụ thuộc sự kiện wheel)
  // (TikTok/shorts: màn hình đổi liên tục → screencast sinh frame đều ~fps mục tiêu).
  // Chạy NỀN, không chặn request: trả về ngay, client theo dõi qua stream.
  async scrollContinuous(opts = {}) {
    await this._ensurePage();
    const deltaY = Number(opts.deltaY) || 260;
    const durationMs = Math.min(120000, Math.max(200, Number(opts.durationMs) || 8000));
    const intervalMs = Math.min(500, Math.max(16, Number(opts.intervalMs) || 25));
    const steps = Math.max(1, Math.ceil(durationMs / intervalMs));
    const perFrame = Math.max(0.5, (deltaY * 16) / intervalMs);
    const mode = String(opts.mode || 'raf');
    const wait = opts.wait === true;   // mặc định chạy nền, không chặn request
    let lastErr = '';

    const readY = async () => {
      try {
        return await this.page.evaluate(() => Math.round(window.scrollY || 0));
      } catch (e) { return null; }
    };
    const scrollY0 = await readY();

    const job = async () => {
      try {
        await this.page.evaluate(async ({ py, dur }) => {
          window.__rexiStopScroll = false;
          const start = performance.now();
          await new Promise((resolve) => {
            const tick = () => {
              const elapsed = performance.now() - start;
              if (window.__rexiStopScroll) { resolve(false); return; }
              window.scrollBy(0, py);
              if (elapsed < dur) requestAnimationFrame(tick);
              else resolve(true);
            };
            requestAnimationFrame(tick);
          });
        }, { py: perFrame, dur: durationMs });
      } catch (e) {
        lastErr = e.message;
        // fallback: bánh xe chuột rời rạc
        const t0 = Date.now();
        while (Date.now() - t0 < durationMs && this.page && !this.page.isClosed()) {
          try { await this.page.mouse.wheel(Number(opts.deltaX) || 0, deltaY); }
          catch (e2) { lastErr = e2.message; break; }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
      const scrollY1 = await readY();
      this._scrollStats = {
        scrollY0, scrollY1,
        moved: (scrollY0 != null && scrollY1 != null) ? (scrollY1 - scrollY0) : null,
        durationMs, frames: steps, error: lastErr || undefined, at: Date.now(),
      };
      return this._scrollStats;
    };
    this._scrollJob = job();

    if (wait) {
      try { await this._scrollJob; } catch (e) { lastErr = e.message; }
    }

    return {
      success: true, mode, started: true, steps, durationMs, intervalMs, perFrame: Math.round(perFrame * 100) / 100,
      scrollY0, scrollY1: this._scrollStats ? this._scrollStats.scrollY1 : null,
      moved: this._scrollStats ? this._scrollStats.moved : null,
      error: lastErr || undefined,
      message: 'Đã cuộn liên tục ' + durationMs + 'ms' +
        (this._scrollStats && this._scrollStats.moved != null ? ' (dịch chuyển ' + this._scrollStats.moved + 'px)' : ''),
    };
  }

  // Dừng cuộn liên tục (job rAF chạy nền)
  async stopScrollContinuous() {
    if (!this._scrollJob) return { success: false, error: 'Không có tác vụ cuộn nào đang chạy.' };
    try { await this.page.evaluate(() => { window.__rexiStopScroll = true; }); } catch (e) { /* ignore */ }
    this._scrollStopped = true;
    this._scrollJob = null;
    return { success: true, stats: this._scrollStats || null };
  }

  async close() {
    if (this._autoCloseTimer) {
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
    try { await this.stopScreencast(); } catch (e) { /* ignore */ }
    this._screencastOn = false;
    if (this._screencastHandler && this.cdpSession) {
      try { this.cdpSession.off('Page.screencastFrame', this._screencastHandler); } catch (e) { /* ignore */ }
    }
    this._screencastHandler = null;
    this.subscribers.forEach((res) => { try { if (!res.writableEnded) res.end(); } catch (e) {} });
    this.subscribers.clear();
    // Mỗi bước độc lập — 1 bước fail không chặn bước sau (tránh browser kẹt không đóng được → "toggle lỗi")
    if (this.cdpSession) {
      try { await this.cdpSession.detach(); } catch (e) { console.log('[close] cdp detach:', e.message); }
      this.cdpSession = null;
    }
    if (this.stagehand) {
      try { await this.stagehand.close(); } catch (e) { console.log('[close] stagehand:', e.message); }
      this.stagehand = null;
    }
    if (this.page) {
      try { await this.page.close(); } catch (e) { console.log('[close] page:', e.message); }
      this.page = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch (e) { console.log('[close] browser:', e.message); }
      this.browser = null;
    }
    this.clients.forEach(c => { try { c.close(); } catch (e) {} });
    this.clients.clear();

    // Force-kill any zombie chrome-headless-shell / chromium processes
    // (browser.close() đôi khi không kill hết trên Windows)
    try {
      await execPromise('taskkill /F /IM chrome-headless-shell.exe 2>nul & taskkill /F /IM chromium.exe 2>nul');
      console.log('[BrowserStream] Force-killed any remaining browser processes');
    } catch (e) {
      // Ignore — nếu không có process nào thì taskkill vẫn lỗi, không sao
    }

    console.log('[BrowserStream] Closed — RAM freed');
  }

  getStatus() {
    return {
      running: !!this.browser,
      url: this.page?.url() || null,
      clients: this.clients.size,
      totalConnections: this._totalConnections || 0,
      stagehand: !!this.stagehand,
      stream: {
        ...this.streamOpts,
        subscribers: this.subscribers.size,
        screencast: this._screencastOn,
        droppedFrames: this._droppedFrames,
        encodedFrames: this._encodeCount,
        lastFrameAt: this._lastFrameAt || null,
      },
      scroll: this._scrollStats || null,
    };
  }

  // Debug: chụp 1 frame trả JSON — test screenshot server hoạt động không
  async debugFrame() {
    if (!this.page) return { success: false, error: 'Browser chưa chạy (gõ URL + Enter trong tab để launch).' };
    try {
      let shotBuf = null;
      if (this.cdpSession) {
        try {
          const result = await this.cdpSession.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 });
          shotBuf = Buffer.from(result.data, 'base64');
        } catch (cdpErr) {
          shotBuf = await this.page.screenshot({ type: 'jpeg', quality: 50 });
        }
      } else {
        shotBuf = await this.page.screenshot({ type: 'jpeg', quality: 50 });
      }
      return { success: true, len: shotBuf.length, b64: shotBuf.toString('base64'), url: this.page.url() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

const browserStream = new BrowserStreamService();
// Task runner (tác vụ dài, nhiều bước) dùng chung browser + stream của Browser Agent
browserTask.init(browserStream);
module.exports = browserStream;