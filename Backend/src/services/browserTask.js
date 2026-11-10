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
        type: { type: 'string', description: 'click | clickAt | type | press | scroll | goto | wait | read | vision' },
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

        // CHỐNG LẶP: nếu hành động giống hệt bước trước → ép đọc nội dung (hoặc kết luận nếu đã đọc rồi)
        const sig = action.type + '|' + (action.selector || action.url || action.text || action.key || action.direction || '');
        if (task.lastSig && task.lastSig === sig) {
          task.repeatCount = (task.repeatCount || 0) + 1;
          if (task.repeatCount >= 2) {
            if (task.readText) {
              action = { type: 'wait', amount: 200 };
              decision.done = true;
              decision.summary = 'Đã lặp hành động — dừng. Đọc được: ' + task.readText.replace(/\s+/g, ' ').slice(0, 200);
            } else {
              action = { type: 'read' };
              thought = (thought ? thought + ' ' : '') + '(ép đọc nội dung vì lặp hành động)';
            }
          }
        } else {
          task.repeatCount = 0;
        }
        task.lastSig = action.type + '|' + (action.selector || action.url || action.text || action.key || action.direction || '');

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
    return { url, title, els, vp, scrollY, scrollHeight };
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
      '- Cuộn → {"type":"scroll","direction":"down","amount":600}.\n' +
      '- Đọc nội dung đang hiển thị (text) → {"type":"read"} — dùng khi cần trích câu trả lời/tên mục.\n' +
      '- Cần đọc hình/canvas/game → {"type":"vision","text":"<câu hỏi cụ thể>"} (chỉ khi thật sự cần).\n' +
      '- Nhiệm vụ đã xong → done=true, summary ngắn gọn. KHÔNG giả vờ xong khi chưa xác nhận.\n' +
      'CHỐNG LẶP: tuyệt đối không lặp lại đúng hành động của bước ngay trước. Nếu trang đã ở đúng trạng thái,\n' +
      'hãy {"type":"read"} để lấy nội dung rồi kết luận done=true (kèm summary).\n' +
      'Đây là lần chạy TỰ ĐỘNG LIÊN TỤC: cứ trả về bước tiếp theo, đừng dừng lại để hỏi.';

    const user = 'MỤC TIÊU: ' + task.goal + '\n' +
      'URL: ' + obs.url + '\n' +
      'TIÊU ĐỀ: ' + obs.title + '\n' +
      'VỊ TRÍ CUỘN: scrollY=' + obs.scrollY + '/' + obs.scrollHeight + '\n' +
      'LỊCH SỬ:\n' + (task.history.join('\n') || '(bước đầu)') + '\n\n' +
      (task.readText ? 'NỘI DUNG ĐÃ ĐỌC (từ bước read):\n' + task.readText.slice(-900) + '\n\n' : '') +
      'PHẦN TỬ TƯƠNG TÁC:\n' + (elList || '(không thấy)') + '\n\n' +
      'NỘI DUNG ĐANG NHÌN THẤY:\n' + (obs.vp.slice(0, 1500) || '(trống)');

    const fullPrompt = system + '\n\n' + user +
      '\n\nCHỈ trả về MỘT đối tượng JSON đúng schema sau, không thêm chữ khác:\n' +
      JSON.stringify({ thought: '<câu>', done: false, summary: '<khi done>', action: { type: 'click|clickAt|type|press|scroll|goto|wait|read|vision', selector: '', text: '', key: '', direction: '', url: '', x: 0, y: 0, amount: 0 } });

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
          await page.mouse.wheel(dx, dy);
          await page.waitForTimeout(150).catch(() => {});
          return { ok: true, message: `Cuộn ${a.direction || 'down'} ${amount}px` };
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
