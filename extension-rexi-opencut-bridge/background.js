/* background.js — service worker: poll backend, chạy lệnh trên tab OpenCut.
 * Endpoints (backend/src/services/opencutBridge.js):
 *   POST {base}/api/services/opencut-bridge/poll   {hasTab} -> {commands:[{id,action,args}]}
 *   POST {base}/api/services/opencut-bridge/result {id, result}
 *
 * Chống MV3 suspend: vòng poll chạy bằng setInterval 1.5s (tự giữ SW sống),
 * watchdog alarm 1 phút hồi sinh khi cần; MỌI lệnh đều post result trong
 * finally (kể cả khi tab đóng giữa chừng) nên server không bao giờ kẹt.
 */
const DEFAULT_BASE = 'https://rexiai.bot.cd';
const POLL_MS = 1500;

async function cfg() {
  const s = await chrome.storage.local.get(['base', 'token']);
  return { base: (s.base || DEFAULT_BASE).replace(/\/$/, ''), token: s.token || null };
}
async function saveCfg(patch) { await chrome.storage.local.set(patch); }
async function log(...a) {
  const line = new Date().toLocaleTimeString() + ' ' + a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(' ');
  try {
    const s = await chrome.storage.local.get(['elog']);
    const arr = (s.elog || []).concat([line]).slice(-40);
    await chrome.storage.local.set({ elog: arr });
  } catch (e) {}
}

// Lấy token: ưu tiên đã lưu, nếu không hỏi content-script trên tab Rexi đang mở.
async function ensureToken(base, token) {
  if (token) return token;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://rexiai.bot.cd/*', base + '/*'] });
    for (const t of tabs) {
      try {
        const r = await chrome.tabs.sendMessage(t.id, { type: 'GET_TOKEN' });
        if (r && r.token) { await saveCfg({ token: r.token }); await log('đã lấy token từ tab Rexi'); return r.token; }
      } catch (e) { /* tab chưa sẵn sàng */ }
    }
  } catch (e) {}
  return null;
}

async function findOpenCutTab() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://opencut.app/*', 'http://localhost:3000/*'] });
    return tabs[0] || null;
  } catch (e) { return null; }
}

function runInPage(action, args, tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (action, args) => {
      const q = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
      const byText = (text) => {
        const els = [...document.querySelectorAll('button, a, [role=button], input, textarea')];
        const t = String(text || '').toLowerCase();
        return els.find(e => ((e.innerText || e.value || e.placeholder || '') + '').toLowerCase().includes(t)) || null;
      };
      const vis = (el) => { if (!el) return null; try { el.scrollIntoView({ block: 'center' }); } catch (e) {} return el; };
      switch (action) {
        case 'eval': {
          try { return { ok: true, value: String(eval(args.code)).slice(0, 6000) }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case 'click': {
          const el = vis(args.selector ? q(args.selector) : byText(args.text));
          if (!el) return { ok: false, error: 'Không thấy phần tử' };
          el.click(); return { ok: true };
        }
        case 'type': {
          const el = vis(args.selector ? q(args.selector) : byText(args.text));
          if (!el) return { ok: false, error: 'Không thấy ô nhập' };
          el.focus();
          try {
            const st = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (st) st.call(el, args.text || '');
            else el.value = args.text || '';
          } catch (e) { el.value = args.text || ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        }
        case 'text': {
          try { return { ok: true, value: String(document.body.innerText || '').slice(0, 6000) }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case 'list': {
          const btns = [...document.querySelectorAll('button, a, [role=button]')]
            .filter(e => e.offsetParent !== null)
            .map(e => ((e.innerText || e.getAttribute('aria-label') || e.title || '') + '').replace(/\s+/g, ' ').trim())
            .filter(Boolean).slice(0, 60);
          return { ok: true, value: btns };
        }
        default: return { ok: false, error: 'action lạ: ' + action };
      }
    },
    args: [action, args || {}],
  }).then(r => (r && r[0] && r[0].result) || { ok: false, error: 'Không có kết quả' })
    .catch(e => ({ ok: false, error: String(e && e.message || e) }));
}

async function doScreenshot(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(r => setTimeout(r, 400));
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { success: true, screenshot: url };
  } catch (e) { return { success: false, error: String(e && e.message || e) }; }
}

async function postResult(base, token, id, result) {
  try {
    await fetch(base + '/api/services/opencut-bridge/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ id, result }),
    });
  } catch (e) { await log('post result lỗi:', e && e.message || e); }
}

let tickRunning = false;
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const { base } = await cfg();
    let { token } = await cfg();
    token = await ensureToken(base, token);
    if (!token) return; // chưa đăng nhập Rexi ở đâu cả → chờ
    const tab = await findOpenCutTab();
    let commands = [];
    try {
      const r = await fetch(base + '/api/services/opencut-bridge/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ hasTab: !!tab }),
      });
      const j = await r.json().catch(() => ({}));
      commands = (j && j.commands) || [];
    } catch (e) { await log('poll lỗi:', e && e.message || e); return; }
    for (const cmd of commands) {
      let result;
      try {
        if (cmd.action === 'wait') {
          await new Promise(r => setTimeout(r, Math.min(Number((cmd.args || {}).ms) || 1000, 15000)));
          result = { ok: true };
        } else if (cmd.action === 'screenshot') {
          result = tab ? await doScreenshot(tab) : { success: false, error: 'Chưa mở tab opencut.app' };
        } else {
          result = tab
            ? await runInPage(cmd.action, cmd.args || {}, tab.id)
            : { ok: false, error: 'Chưa mở tab opencut.app' };
        }
      } catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
      try { await postResult(base, token, cmd.id, result); }
      catch (e) { await log('post result lỗi:', e && e.message || e); }
    }
  } catch (e) { await log('tick lỗi:', e && e.message || e); }
  finally { tickRunning = false; }
}

let timer = null;
function arm() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, POLL_MS);
}
chrome.runtime.onInstalled.addListener(() => { arm(); log('installed'); });
chrome.runtime.onStartup.addListener(() => { arm(); log('startup'); });
chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { arm(); tick(); });
arm();
tick();
