// Lazy-load: CHỈ require khi thực sự cần, tiết kiệm ~300-500MB RAM
let chromium = null;
const WebSocket = require('ws');
const { exec } = require('child_process');
const util = require('util');
const { decryptKey } = require('../utils/cryptoKeys');
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

    // Capture frames at ~2fps (was 30fps — 93% reduction in CPU/GC pressure)
    if (this.frameInterval) clearInterval(this.frameInterval);
    this.frameInterval = setInterval(async () => {
      if (!this.page || this.clients.size === 0) return;

      try {
        let screenshot;
        // CDP session hoạt động ổn định hơn page.screenshot() với headless-shell
        if (this.cdpSession) {
          try {
            const result = await this.cdpSession.send('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
            screenshot = Buffer.from(result.data, 'base64');
          } catch (cdpErr) {
            // Fallback sang page.screenshot() nếu CDP fail
            screenshot = await this.page.screenshot({ type: 'jpeg', quality: 40 });
          }
        } else {
          screenshot = await this.page.screenshot({ type: 'jpeg', quality: 40 });
        }

        const frameData = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
        const message = JSON.stringify({ type: 'frame', data: frameData });

        let sent = 0;
        this.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
          }
        });
      } catch (e) {
        console.error('[FrameCapture] Error:', e.message);
      }
    }, 500); // 2fps thay vì 30fps
    console.log('[BrowserStream] frameInterval started (2fps mode — RAM optimized)');
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
    if (this.browser) return { success: true };

    try {
      console.log('[BrowserStream] Launching chromium (bundled, headless — KHÔNG mở cửa sổ Chrome thật)...');
      const pw = getChromium();
      // Dùng Chromium đi kèm Playwright (KHÔNG dùng channel:'chrome')
      // → chạy 100% headless, không mở cửa sổ Chrome thật, không xung đột profile user, nhẹ hơn.
      this.browser = await pw.launch({
        headless: true,
        args: [
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
        ],
      }).catch(async (e) => {
        // Fallback: launch tối giản nếu bộ args đầy đủ fail (vd: arg không hỗ trợ)
        console.log('[BrowserStream] Default launch failed, retrying minimal:', e.message);
        return await pw.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,720'],
        });
      });

      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
      });

      this.page = await context.newPage();
      console.log('[BrowserStream] Page created, this.page:', !!this.page);

      // CDP session for frame capture
      this.cdpSession = await this.page.context().newCDPSession(this.page);
      console.log('[BrowserStream] CDP session created');

      await this.cdpSession.send('Page.enable');
      // Bỏ Animation.enable — không cần, tiết kiệm memory
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
              type: { type: 'string', description: 'click | type | press | scroll | goto | wait | done' },
              selector: { type: 'string', description: 'CSS selector hoặc text=... (chỉ cho click/type)' },
              text: { type: 'string', description: 'nội dung cần gõ (chỉ cho type)' },
              key: { type: 'string', description: 'phím như Enter/Backspace (chỉ cho press)' },
              direction: { type: 'string', description: 'up/down/left/right (chỉ cho scroll)' },
              url: { type: 'string', description: 'URL cần mở (chỉ cho goto)' },
              description: { type: 'string' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    };

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            {
              role: 'system',
              content: 'Bạn là trợ lý điều khiển trình duyệt. Dịch chỉ dẫn của người dùng thành danh sách hành động JSON để thực hiện trên trang hiện tại. Ưu tiên dùng text=... hoặc CSS selector chính xác. Nếu chỉ dẫn là câu chào hoặc không cần thao tác, trả về actions rỗng. Trang hiện tại: ' + (this.page?.url() || 'chưa mở')
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

      for (const a of actions) {
        try {
          switch (a.type) {
            case 'click':
              if (a.selector) await this.page.locator(a.selector).first().click({ timeout: 10000 });
              break;
            case 'type':
              if (a.selector) await this.page.locator(a.selector).first().fill(a.text || '', { timeout: 10000 });
              else await this.page.keyboard.type(a.text || '');
              break;
            case 'press':
              await this.page.keyboard.press(a.key || 'Enter');
              break;
            case 'scroll':
              await this.page.mouse.wheel(0, a.direction === 'up' ? -600 : 600);
              break;
            case 'goto':
              if (a.url) await this.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              break;
            case 'wait':
              await this.page.waitForTimeout(1200);
              break;
            case 'done':
              return { success: true, result: { message: '✅ Đã hoàn tất: ' + (a.description || instruction) } };
          }
        } catch (e) {
          console.log('[BrowserAction] Bỏ qua action lỗi:', a.type, e.message);
        }
      }
      return { success: true, result: { message: `✅ Đã thực hiện ${actions.length} hành động: ${instruction}` } };
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

  // Đọc lại nội dung trang hiện tại dưới dạng text (cho agent).
  async readText(maxChars = 6000) {
    if (!this.page) return { success: false, error: 'Chưa mở trang nào.' };
    try {
      const title = await this.page.title();
      const text = await this.page.evaluate((m) =>
        String((document.body && document.body.innerText) || '')
          .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, m), maxChars);
      return { success: true, url: this.page.url(), title, text };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async act(instruction) {
    if (!this.page) await this.launch();

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
    if (!this.page) await this.launch();
    await this.page.mouse.click(x, y);
    return { success: true };
  }

  async type(text) {
    if (!this.page) await this.launch();
    await this.page.keyboard.type(text);
    return { success: true };
  }

  async key(key) {
    if (!this.page) await this.launch();
    await this.page.keyboard.press(key);
    return { success: true };
  }

  async scroll(deltaX, deltaY) {
    if (!this.page) await this.launch();
    await this.page.mouse.wheel(Number(deltaX) || 0, Number(deltaY) || 0);
    return { success: true };
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

module.exports = new BrowserStreamService();