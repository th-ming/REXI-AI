// BROWSER TASK RUNNER — chạy tác vụ dài nhiều bước trên Browser Agent.
//
// Vòng lặp:  observe (DOM + ảnh) → LLM quyết định 1 hành động → thực thi → ghi bước → lặp tiếp.
// Mỗi bước emit qua SSE (type:'step') để UI hiện "đang làm gì / xong chưa", kèm type:'task_done' khi kết thúc.
//
// Yêu cầu tốc độ: không chờ cứng (dùng wait ngắn + chờ điều hướng có timeout thấp) để tác vụ chạy liên tục.

const { assertPublicUrlAsync } = require('../utils/urlSafety');

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'Một câu tiếng Việt: đang làm gì bước này' },
    done: { type: 'boolean', description: 'true khi nhiệm vụ đã hoàn tất' },
    summary: { type: 'string', description: 'Tóm tắt kết quả khi done=true' },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'click | clickAt | type | press | scroll | goto | wait | read | vision | find' },
        selector: { type: 'string', description: 'CSS selector hoặc text=... (cho click/type)' },
        text: { type: 'string', description: 'text cần gõ, hoặc câu hỏi cho vision' },
        key: { type: 'string', description: 'phím (Enter, Space, ArrowDown...)' },
        direction: { type: 'string', description: 'up | down | left | right (cho scroll)' },
        url: { type: 'string', description: 'URL cần mở (cho goto)' },
        x: { type: 'number', description: 'toạ độ X (cho clickAt)' },
        y: { type: 'number', description: 'toạ độ Y (cho clickAt)' },
        amount: { type: 'number', description: 'khoảng cách cuộn (px) hoặc thời gian chờ (ms)' },
        description: { type: 'string' },
      },
      required: ['type'],
    },
  },
  required: ['thought', 'action'],
};

class BrowserTaskRunner {
  constructor(stream) {
    this.stream = stream;
    this.task = null;     // { id, goal, steps, startedAt, status }
    this.stopped = false;
  }

  isRunning() { return !!this.task && this.task.status === 'running'; }

  status() {
    if (!this.task) return { running: false };
    return {
      running: this.task.status === 'running',
      id: this.task.id,
      goal: this.task.goal,
      status: this.task.status,
      steps: this.task.steps,
      startedAt: this.task.startedAt,
    };
  }

  stop(reason = 'Người dùng dừng') {
    if (!this.task) return { success: false, error: 'Không có tác vụ nào đang chạy.' };
    this.stopped = true;
    this.task.status = 'stopped';
    this.task.stopReason = reason;
    this.stream._sendEvent({ type: 'task_stopped', taskId: this.task.id, reason });
    return { success: true };
  }

  // Bắt đầu tác vụ (chạy nền, trả về ngay).
  async start(goal, opts = {}) {
    const text = String(goal || '').trim();
    if (!text) return { success: false, error: 'Thiếu mục tiêu (goal).' };
    if (this.isRunning()) return { success: false, error: 'Đang có tác vụ chạy — dừng tác vụ cũ trước.' };
    if (!this.stream.page) await this.stream._ensurePage();

    this.stopped = false;
    this.task = {
      id: `bt_${Date.now().toString(36)}`,
      goal: text,
      status: 'running',
      steps: [],
      startedAt: Date.now(),
      maxSteps: Math.min(200, Math.max(1, Number(opts.maxSteps) || 60)),
      intervalMs: Math.min(3000, Math.max(0, Number(opts.intervalMs) || 250)),
      history: [],
    };

    this.stream._sendEvent({ type: 'task_start', taskId: this.task.id, goal: text, maxSteps: this.task.maxSteps });
    this._loop().catch((e) => {
      this.stream._sendEvent({ type: 'task_error', taskId: this.task?.id, error: e.message });
    });

    return { success: true, taskId: this.task.id, goal: text, maxSteps: this.task.maxSteps };
  }

  async _loop() {
    const task = this.task;
    while (!this.stopped && task.steps.length < task.maxSteps) {
      const n = task.steps.length + 1;
      let thought = '', action = null, ok = false, message = '', error = '';

      try {
        const obs = await this._observe();
        // Quyết định: thử lại nhiều lần (backoff) nếu provider lỗi/quota — KHÔNG đốt step.
        let decision = null;
        let lastErr = null;
        for (let att = 0; att < 3 && !decision; att++) {
          try {
            decision = await this._decide(task, obs);
            lastErr = null;
          } catch (e) {
            lastErr = e;
            console.warn('[BrowserTask] quyết định lỗi (lần ' + (att + 1) + '):', e.message);
            await new Promise((r) => setTimeout(r, 1200 * (att + 1)));
          }
        }
        if (!decision) throw lastErr || new Error('Không lấy được quyết định từ LLM');
        thought = decision.thought || '';
        action = decision.action || { type: 'wait', amount: 300 };

        // CHỐNG LẶP — đếm theo chữ ký hành động.
        // Với `scroll`, chữ ký KÈM vị trí scrollY → cuộn vẫn tiến triển sẽ KHÔNG bị coi là lặp
        // (trước đây task dừng sớm vì mọi lần cuộn đều trùng chữ ký).
        // Chỉ khi trang đã cuộn tới cuối (scrollY đứng yên) mới bị ép đọc rồi kết luận.
        const sigPayload = action.selector || action.url || action.text || action.key || action.direction || '';
        const sig = action.type + '|' + sigPayload +
          (action.type === 'scroll' ? '@' + Math.round((Number(obs.scrollY) || 0) / 40) : '');
        task.sigCounts = task.sigCounts || {};
        const repeatCount = (task.sigCounts[sig] || 0) + 1;
        task.sigCounts[sig] = repeatCount;
        if (Object.keys(task.sigCounts).length > 60) {
          // giữ 30 chữ ký có tần suất cao nhất, xoá phần còn lại (tránh phình bộ nhớ)
          const keys = Object.keys(task.sigCounts).sort((a, b) => task.sigCounts[b] - task.sigCounts[a]);
          keys.slice(30).forEach((k) => delete task.sigCounts[k]);
        }
        if (repeatCount >= 3) {
          const stuckType = action.type;
          if (task.readText) {
            action = { type: 'wait', amount: 200 };
            decision.done = true;
            decision.summary = 'Không tiến triển thêm (lặp ' + stuckType + ' ' + repeatCount + ' lần). Đọc được: ' +
              String(task.readText).replace(/\s+/g, ' ').slice(-260);
          } else {
            action = { type: 'read' };
            thought = (thought ? thought + ' ' : '') + '(ép đọc nội dung vì lặp ' + stuckType + ')';
          }
        }

        const ex = await this._exec(action);
        ok = ex.ok !== false;
        message = ex.message || '';
        error = ex.error || '';
        if (decision.done) {
          task.status = 'done';
          const step = { n, thought, action: action.type, ok, message, url: obs.url, title: obs.title, ts: Date.now(), done: true, summary: decision.summary || message };
          task.steps.push(step);
          this.stream._sendEvent({ type: 'step', taskId: task.id, ...step });
          this.stream._sendEvent({ type: 'task_done', taskId: task.id, ok, summary: decision.summary || message, steps: task.steps.length });
          return;
        }
      } catch (e) {
        error = e.message;
        message = 'Lỗi bước: ' + e.message;
      }

      const step = { n, thought, action: action ? action.type : 'none', ok, message, error: error || undefined, ts: Date.now() };
      task.steps.push(step);
      task.history.push(`${n}. ${thought} → ${step.action}${error ? ' (LỖI: ' + error + ')' : ''}`);
      if (task.history.length > 8) task.history.shift();
      this.stream._sendEvent({ type: 'step', taskId: task.id, ...step });

      if (error) await new Promise((r) => setTimeout(r, 400));
      else await new Promise((r) => setTimeout(r, task.intervalMs));
    }

    if (!this.stopped && task.status === 'running') {
      task.status = 'maxsteps';
      this.stream._sendEvent({ type: 'task_done', taskId: task.id, ok: false, summary: `Đạt giới hạn ${task.maxSteps} bước.`, steps: task.steps.length });
    }
  }

  // Gom trạng thái trang hiện tại (text đang nhìn thấy + bản phần tử tương tác).
  async _observe() {
    const s = this.stream;
    const url = s.page ? s.page.url() : '';
    let title = '';
    try { title = await s.page.title(); } catch (e) { /* ignore */ }
    let scrollY = 0, scrollHeight = 0;
    try {
      const pos = await s.page.evaluate(() => ({
        y: Math.round(window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0),
        h: Math.round(document.body ? document.body.scrollHeight : 0),
      }));
      scrollY = pos.y || 0; scrollHeight = pos.h || 0;
    } catch (e) { /* ignore */ }
    const terms = (String(this.task.goal).toLowerCase().match(/[a-zà-ỹ0-9]+/gi) || []).filter((w) => w.length >= 2);
    const els = await s._interactiveMap(70, terms).catch(() => []);
    const vp = await s._viewportText(2200).catch(() => '');
    // BẢN ĐỒ TRANG: tiêu đề mục + anchor link — KỂ CẢ phần tử đang bị ẩn/collapsed
    // (vd mục lục Wikipedia ở viewport 640px bị thu gọn → _interactiveMap không thấy).
    // Nhờ đó agent biết "History" TỒN TẠI và đi thẳng tới, thay vì cuộn mù.
    const outline = await this._outline().catch(() => ({ headings: [], anchors: [] }));
    return { url, title, els, vp, scrollY, scrollHeight, outline };
  }

  // Quét cấu trúc trang: heading h1-h6 + anchor link (#id). Bỏ phần tử ẩn bằng 0 kích thước.
  async _outline() {
    const s = this.stream;
    if (!s.page) return { headings: [], anchors: [] };
    return s.page.evaluate(() => {
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      const headings = [];
      document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
        const text = norm(h.textContent);
        if (text) headings.push({ level: h.tagName, text, id: h.id || '' });
      });
      const anchors = [];
      const seen = new Set();
      document.querySelectorAll('a[href^="#"]').forEach((a) => {
        const text = norm(a.textContent);
        const href = a.getAttribute('href') || '';
        if (text && href.length > 1 && !seen.has(text + href)) {
          seen.add(text + href);
          anchors.push({ text, href });
        }
      });
      return { headings: headings.slice(0, 80), anchors: anchors.slice(0, 80) };
    });
  }

  // LLM quyết định hành động tiếp theo.
  async _decide(task, obs) {
    const elList = obs.els.map((e, i) => `${i + 1}. <${e.tag}${e.role ? ' role=' + e.role : ''}> "${e.text}"${e.id ? ' id=' + e.id : ''}${e.name ? ' name=' + e.name : ''}${e.href ? ' href=' + e.href : ''} @(${e.x},${e.y})${e.onScreen ? '' : ' (ngoài màn hình)'}`).join('\n');

    const system = 'Bạn là Agent điều khiển trình duyệt tự động, chạy tác vụ nhiều bước trong THỜI GIAN THỰC.\n' +
      'Mỗi lần chỉ được chọn ĐÚNG MỘT hành động để tiến triển. Ưu tiên hành động nhỏ, đúng, kiểm chứng được.\n' +
      'QUY TẮC:\n' +
      '- Muốn bấm phần tử trong danh sách → {"type":"click","selector":"<selector>"}; link nhiều chữ → dùng a[href="<href>"].\n' +
      '- Phần tử canvas/không nhãn → {"type":"clickAt","x":..,"y":..}.\n' +
      '- Gõ vào ô → {"type":"type","selector":..,"text":..}; phím → {"type":"press","key":"Enter"}.\n' +
      'GÕ RỒI GỬI LUÔN trong 1 bước (vd điền đáp án + Enter): {"type":"type","text":"<giá trị>","key":"Enter"}.\n' +
      '- Cuộn → {"type":"scroll","direction":"down","amount":600}.\n' +
      '- Đọc nội dung đang hiển thị (text) → {"type":"read"} — dùng khi cần trích câu trả lời/tên mục.\n' +
      '- TÌM & BẤM một mục/đoạn/NÚT có tên trên trang (kể cả mục lục bị thu gọn, hoặc nút như "Start") → {"type":"find","text":"Start"}. ' +
      'find TỰ BẤM nếu khớp là nút/submit, hoặc nhảy tới nếu là chuyên mục; ĐỪNG cuộn mù tìm chữ và ĐỪNG giả vờ không thấy nút.\n' +
      '- Cần đọc hình/canvas/game → {"type":"vision","text":"<câu hỏi cụ thể>"} (chỉ khi thật sự cần).\n' +
      '- Nhiệm vụ đã xong → done=true, summary ngắn gọn. KHÔNG giả vờ xong khi chưa xác nhận.\n' +
      'CÁCH TÌM CHUYÊN MỤC: xem "BẢN ĐỒ TRANG" (danh sách mục/anchor). Nếu mục tiêu nhắc tới một mục ' +
      'có trong bản đồ → dùng {"type":"find"} hoặc click thẳng anchor href tương ứng. CHỈ cuộn khi thực sự cần.\n' +
      'CUỘN: được phép cuộn nhiều lần liên tiếp để đọc hết nội dung — miễn là vị trí scrollY vẫn tăng.\n' +
      'Chỉ khi scrollY không còn tăng (đã tới cuối trang) mới đổi hành động.\n' +
      'CHỐNG LẶP: không lặp lại đúng một hành động khi trang đã ở trạng thái đó.\n' +
      'Nếu trang đã ở đúng trạng thái, hãy {"type":"read"} để lấy nội dung rồi kết luận done=true (kèm summary).\n' +
      'Đây là lần chạy TỰ ĐỘNG LIÊN TỤC: cứ trả về bước tiếp theo, đừng dừng lại để hỏi.';

    const user = 'MỤC TIÊU: ' + task.goal + '\n' +
      'URL: ' + obs.url + '\n' +
      'TIÊU ĐỀ: ' + obs.title + '\n' +
      'VỊ TRÍ CUỘN: scrollY=' + obs.scrollY + '/' + obs.scrollHeight + '\n' +
      'LỊCH SỬ:\n' + (task.history.join('\n') || '(bước đầu)') + '\n\n' +
      (task.readText ? 'NỘI DUNG ĐÃ ĐỌC (từ bước read):\n' + task.readText.slice(-900) + '\n\n' : '') +
      'BẢN ĐỒ TRANG (mục & anchor — gồm cả mục bị thu gọn):\n' + this._formatOutline(obs.outline) + '\n\n' +
      'PHẦN TỬ TƯƠNG TÁC:\n' + (elList || '(không thấy)') + '\n\n' +
      'NỘI DUNG ĐANG NHÌN THẤY:\n' + (obs.vp.slice(0, 1500) || '(trống)');

    const fullPrompt = system + '\n\n' + user +
      '\n\nCHỈ trả về MỘT đối tượng JSON đúng schema sau, không thêm chữ khác:\n' +
      JSON.stringify({ thought: '<câu>', done: false, summary: '<khi done>', action: { type: 'click|clickAt|type|press|scroll|goto|wait|read|vision|find', selector: '', text: '', key: '', direction: '', url: '', x: 0, y: 0, amount: 0 } });

    // 1) Groq với JSON schema (nhanh, chuẩn JSON)
    try {
      const apiKey = await this.stream._getGroqKey();
      if (apiKey) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            response_format: { type: 'json_schema', json_schema: { name: 'browser_step', schema: ACTION_SCHEMA } },
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(45000),
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.choices?.[0]?.message?.content || '';
          const obj = this._parseJson(content);
          if (obj && obj.action && obj.action.type) return obj;
          throw new Error('Groq trả về JSON không hợp lệ');
        }
        throw new Error('Groq HTTP ' + res.status);
      }
    } catch (e) {
      console.warn('[BrowserTask] Groq fail, chuyển provider khác:', e.message);
    }

    // 2) Chuỗi provider dự phòng (xkiro → groq → unorouter → kiosapi) qua agentService.callAI
    const { callAI } = require('./agentService');
    const txt = await callAI(fullPrompt);
    const obj = this._parseJson(txt);
    if (!obj || !obj.action || !obj.action.type) throw new Error('LLM không trả về hành động hợp lệ');
    return obj;
  }

  // Rút gọn bản đồ trang thành text cho prompt (giới hạn độ dài).
  _formatOutline(outline) {
    if (!outline) return '(không có)';
    const parts = [];
    if (outline.headings && outline.headings.length) {
      parts.push('MỤC: ' + outline.headings.slice(0, 40).map((h) => `[${h.level}]${h.text}${h.id ? ' (#' + h.id + ')' : ''}`).join(' | '));
    }
    if (outline.anchors && outline.anchors.length) {
      parts.push('ANCHOR: ' + outline.anchors.slice(0, 40).map((a) => `"${a.text}"→${a.href}`).join(' | '));
    }
    return parts.join('\n') || '(không có)';
  }

  // Bóc JSON từ text (chịu ```json fences và text thừa).
  _parseJson(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fence ? fence[1] : t;
    try { return JSON.parse(raw); } catch (e) { /* noop */ }
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* noop */ } }
    return null;
  }

  // Thực thi 1 hành động — nhanh, không chờ cứng.
  async _exec(a) {
    const s = this.stream;
    const page = s.page;
    if (!page) return { ok: false, error: 'Chưa có trang' };
    try {
      switch (a.type) {
        case 'click': {
          if (!a.selector) return { ok: false, error: 'thiếu selector' };
          const loc = page.locator(a.selector).first();
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
            await loc.click({ timeout: 4000 });
          } catch (e1) {
            try { await loc.evaluate((el) => el.click()); }
            catch (e2) {
              const href = await loc.getAttribute('href').catch(() => null);
              if (href) await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 20000 });
              else throw e1;
            }
          }
          await this._afterNav();
          return { ok: true, message: 'Đã bấm ' + a.selector };
        }
        case 'clickAt': {
          if (typeof a.x !== 'number' || typeof a.y !== 'number') return { ok: false, error: 'thiếu toạ độ' };
          await page.mouse.click(a.x, a.y);
          await this._afterNav();
          return { ok: true, message: `Đã bấm (${a.x},${a.y})` };
        }
        case 'type': {
          if (a.selector) await page.locator(a.selector).first().fill(a.text || '', { timeout: 5000 });
          else await page.keyboard.type(a.text || '');
          // Gõ + nhấn phím trong CÙNG 1 bước (vd điền đáp án rồi Enter để gửi) — giảm nửa số bước.
          if (a.key) {
            await page.keyboard.press(a.key);
            await this._afterNav();
            return { ok: true, message: 'Đã gõ + nhấn ' + a.key };
          }
          return { ok: true, message: 'Đã gõ' };
        }
        case 'press': {
          await page.keyboard.press(a.key || 'Enter');
          await this._afterNav();
          return { ok: true, message: 'Đã nhấn ' + (a.key || 'Enter') };
        }
        case 'scroll': {
          const amount = Math.min(4000, Math.max(100, Number(a.amount) || 600));
          const dy = a.direction === 'up' ? -amount : a.direction === 'left' ? 0 : a.direction === 'right' ? 0 : amount;
          const dx = a.direction === 'left' ? -amount : a.direction === 'right' ? amount : 0;
          const readY = () => page.evaluate(() => Math.round(window.scrollY || 0)).catch(() => null);
          const y0 = await readY();
          await page.mouse.wheel(dx, dy);
          await page.waitForTimeout(180).catch(() => {});
          const y1 = await readY();
          const moved = (y0 != null && y1 != null) ? (y1 - y0) : null;
          return {
            ok: true,
            message: 'Cuộn ' + (a.direction || 'down') + ' ' + amount + 'px' +
              (moved != null ? ' (vị trí ' + y0 + ' → ' + y1 + ', dịch chuyển ' + (moved >= 0 ? '+' : '') + moved + 'px)' : ''),
          };
        }
        case 'goto': {
          const check = await assertPublicUrlAsync(a.url);
          if (!check.ok) return { ok: false, error: check.reason };
          await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          return { ok: true, message: 'Mở ' + a.url };
        }
        case 'wait': {
          await page.waitForTimeout(Math.min(10000, Math.max(50, Number(a.amount) || 500)));
          return { ok: true, message: 'Chờ' };
        }
        case 'find': {
          // Tìm mục/đoạn/NÚT có tên trên trang (kể cả anchor đang bị ẩn) rồi nhảy tới HOẶC bấm.
          // Deterministic — không phụ thuộc agent cuộn mù. Nút/submit khớp nhãn → TỰ BẤM.
          const needle = String(a.text || '').trim();
          if (!needle) return { ok: false, error: 'thiếu text để tìm' };
          const r = await page.evaluate((needle) => {
            const low = needle.toLowerCase();
            const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
            const isControl = (el) => {
              const tag = el.tagName.toLowerCase();
              if (tag === 'button') return true;
              if (tag === 'input') {
                const ty = (el.getAttribute('type') || '').toLowerCase();
                return ty === 'submit' || ty === 'button' || ty === 'reset';
              }
              return (el.getAttribute('role') || '') === 'button';
            };
            // Nhãn hiển thị: input lấy value/aria/placeholder; còn lại lấy text/aria/title.
            const label = (el) => {
              const tag = el.tagName.toLowerCase();
              if (tag === 'input') return norm(el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
              return norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
            };
            // Điểm ưu tiên: NÚT > heading > anchor > container; ngắn hơn > dài hơn; có id > không.
            const score = (el) => {
              const t = label(el).toLowerCase();
              if (!t || t.length > 160 || !t.includes(low)) return -1;
              const tag = el.tagName.toLowerCase();
              let s = 1000 - t.length;
              if (isControl(el)) s += 900;
              else if (/^h[1-6]$/.test(tag)) s += 600;
              else if (tag === 'a') s += 300;
              if (el.id) s += 120;
              return s;
            };
            const cands = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href^="#"],dt,li,p,button,input[type="submit"],input[type="button"],input[type="reset"],[role="button"]'));
            let best = null, bestS = 0;
            for (const el of cands) { const s = score(el); if (s > bestS) { bestS = s; best = el; } }
            if (!best) return null;
            // Dọn marker cũ, đánh dấu phần tử thắng để Playwright bấm bằng locator thật.
            document.querySelectorAll('[data-agent-find]').forEach((e) => e.removeAttribute('data-agent-find'));
            best.setAttribute('data-agent-find', '1');
            const txt = label(best).slice(0, 90);
            if (isControl(best)) return { kind: 'click', text: txt };
            // Không phải nút → cuộn tới chuyên mục: anchor #id → phần tử id đó; ngược lại → tổ tiên có id.
            let target = best;
            if (best.tagName === 'A' && /^#.+/.test(best.getAttribute('href') || '')) {
              const t = document.querySelector(best.getAttribute('href'));
              if (t) target = t;
            } else {
              const c = best.closest('[id]');
              if (c) target = c;
            }
            target.scrollIntoView({ block: 'start' });
            return { kind: 'scroll', text: txt, id: target.id || '', y0: Math.round(window.scrollY || 0) };
          }, needle);
          if (!r) return { ok: false, error: 'Không thấy "' + needle + '" trên trang' };
          if (r.kind === 'click') {
            try { await page.click('[data-agent-find="1"]', { timeout: 5000 }); }
            catch (e1) {
              try { await page.locator('[data-agent-find="1"]').evaluate((el) => el.click()); }
              catch (e2) {
                const href = await page.locator('[data-agent-find="1"]').getAttribute('href').catch(() => null);
                if (href) await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 20000 });
              }
            }
            await page.evaluate(() => { const e = document.querySelector('[data-agent-find]'); if (e) e.removeAttribute('data-agent-find'); }).catch(() => {});
            await this._afterNav();
            return { ok: true, message: 'Đã bấm nút "' + r.text + '"' };
          }
          await page.evaluate(() => { const e = document.querySelector('[data-agent-find]'); if (e) e.removeAttribute('data-agent-find'); }).catch(() => {});
          await page.waitForTimeout(250).catch(() => {});
          const y1 = await page.evaluate(() => Math.round(window.scrollY || 0)).catch(() => r.y0);
          return { ok: true, message: 'Nhảy tới "' + r.text + '"' + (r.id ? ' (#' + r.id + ')' : '') + ' @Y=' + r.y0 + '→' + y1 };
        }
        case 'read': {
          const txt = await s._viewportText(1500).catch(() => '');
          if (!txt) return { ok: false, error: 'Không đọc được text trên trang.' };
          this.task.readText = (this.task.readText ? this.task.readText + '\n---\n' : '') + txt.slice(0, 1200);
          return { ok: true, message: 'Đã đọc: ' + txt.replace(/\s+/g, ' ').slice(0, 220) };
        }
        case 'vision': {
          const v = await s.vision(a.text || 'Đọc nội dung màn hình hiện tại.', { maxTokens: 500 });
          if (!v.success) return { ok: false, error: v.error };
          this.task.history.push('VISION: ' + v.text.slice(0, 400));
          return { ok: true, message: 'Vision: ' + v.text.slice(0, 300) };
        }
        default:
          return { ok: false, error: 'Hành động không rõ: ' + a.type };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Chờ trang vừa điều hướng ổn định (timeout thấp để không bị treo).
  async _afterNav() {
    try { await this.stream.page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (e) { /* ignore */ }
    await this.stream.page.waitForTimeout(250).catch(() => {});
  }
}

module.exports = new BrowserTaskRunner(null);
module.exports.init = (stream) => { module.exports.stream = stream; return module.exports; };
