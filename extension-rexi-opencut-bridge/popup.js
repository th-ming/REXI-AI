const $ = (id) => document.getElementById(id);
async function load() {
  const s = await chrome.storage.local.get(['base', 'token']);
  $('base').value = s.base || 'https://rexiai.bot.cd';
  $('token').value = s.token || '';
  check();
}
async function check() {
  const base = ($('base').value || 'https://rexiai.bot.cd').replace(/\/$/, '');
  const t = chrome.storage.local.get(['token']).then(s => s.token);
  try {
    const token = $('token').value.trim() || await t;
    const r = await fetch(base + '/api/services/opencut-bridge/status', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    const j = await r.json().catch(() => ({}));
    const tabs = await chrome.tabs.query({ url: ['https://opencut.app/*', 'http://localhost:3000/*'] });
    $('st').innerHTML =
      `backend: <span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'OK' : 'HTTP ' + r.status}</span>\n` +
      `connected: <span class="${j.connected ? 'ok' : 'bad'}">${j.connected}</span> (poll ${j.lastPollAgoSec ?? '—'}s trước)\n` +
      `tab opencut.app đang mở: <span class="${tabs.length ? 'ok' : 'bad'}">${tabs.length ? 'có (' + tabs.length + ')' : 'chưa'}</span>`;
  } catch (e) { $('st').textContent = 'Lỗi: ' + (e && e.message || e); }
  try {
    const s = await chrome.storage.local.get(['elog']);
    $('log').textContent = (s.elog || []).slice(-8).join('\n') || '(chưa có log)';
  } catch (e) {}
}
$('save').onclick = async () => {
  const base = ($('base').value || 'https://rexiai.bot.cd').replace(/\/$/, '');
  const patch = { base };
  if ($('token').value.trim()) patch.token = $('token').value.trim();
  if (!/^https:\/\/rexiai\.bot\.cd$/.test(base) && !/^http:\/\/localhost/.test(base)) {
    try { await chrome.permissions.request({ origins: [base + '/*'] }); } catch (e) {}
  }
  await chrome.storage.local.set(patch);
  check();
  setTimeout(check, 2500);
};
load();
setInterval(check, 4000);
