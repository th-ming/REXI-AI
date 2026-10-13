// content-rexi.js — chạy trên trang Rexi, relay token đăng nhập cho background.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'GET_TOKEN') {
    let token = null;
    let base = location.origin;
    try { token = localStorage.getItem('rexi_token'); } catch (e) {}
    reply({ token, base });
  }
  return true;
});
