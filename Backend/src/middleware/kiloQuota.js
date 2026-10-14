/**
 * KILO QUOTA — chia lượt Kilo gateway theo TỪNG NGƯỜI (Kilo-style rolling 1h).
 *
 * Bối cảnh: Kilo (kilo.ai/api/openrouter, model :free KEYLESS) giới hạn 200
 * request/giờ THEO IP MÁY GỌI. Rexi AI gọi hộ mọi user từ 1 IP server → tất cả
 * user dùng chung 1 kho 200 req/h, ai vào trước nấy lấy → cần chia kho theo
 * từng người:
 *   - User đăng nhập : theo account (req.user.id)
 *   - Guest          : theo IP (req.ip)
 * Rolling window 1 giờ (trượt theo lượt dùng, không reset theo giờ tròn).
 *
 * In-memory (reset khi restart server — chấp nhận được cho rate limit).
 * Tunning qua env: KILO_WINDOW_MS, KILO_USER_LIMIT, KILO_GUEST_LIMIT.
 */
const WINDOW_MS = parseInt(process.env.KILO_WINDOW_MS || '3600000', 10); // 1 giờ
const USER_LIMIT = parseInt(process.env.KILO_USER_LIMIT || '60', 10);   // user đăng nhập
const GUEST_LIMIT = parseInt(process.env.KILO_GUEST_LIMIT || '20', 10); // khách

const buckets = new Map(); // key -> number[] (timestamps các lượt đã dùng)
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 600000) return; // dọn mỗi 10 phút là đủ
  lastSweep = now;
  for (const [k, hits] of buckets) {
    const kept = hits.filter(t => now - t < WINDOW_MS);
    if (kept.length) buckets.set(k, kept); else buckets.delete(k);
  }
}

function identity(req) {
  if (req.user && req.user.id) return 'u:' + req.user.id;
  return 'ip:' + (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * Kiểm tra + TRỪ 1 lượt nếu còn (atomic).
 * Trả { ok, limit, remaining, resetMs } — resetMs = bao lâu nữa có lượt mới.
 */
function allow(req) {
  const now = Date.now();
  sweep(now);
  const limit = (req.user && req.user.id) ? USER_LIMIT : GUEST_LIMIT;
  const key = identity(req);
  let hits = buckets.get(key);
  if (!hits) { hits = []; buckets.set(key, hits); }
  while (hits.length && now - hits[0] > WINDOW_MS) hits.shift();
  if (hits.length >= limit) {
    return { ok: false, limit, remaining: 0, resetMs: Math.max(1000, WINDOW_MS - (now - hits[0])) };
  }
  hits.push(now);
  return { ok: true, limit, remaining: limit - hits.length, resetMs: 0 };
}

/** Thông báo hết quota (dùng cho cả route thường lẫn SSE). */
function message(kq, isGuest) {
  const minutes = Math.max(1, Math.ceil(kq.resetMs / 60000));
  let m = '🔒 **Hết lượt Kilo miễn phí trong khung giờ này!**\n\n'
    + 'Bạn đã dùng hết **' + kq.limit + ' tin nhắn/giờ** trên model Kilo (miễn phí).\n\n'
    + '⏳ Lượt được nạp lại dần theo khung trôi — thử lại sau ~' + minutes + ' phút, hoặc chọn model khác trong hộp chọn model.';
  if (isGuest) m += '\n\n💡 **Đăng nhập** để nhận quota riêng cao hơn và lưu lịch sử chat.';
  return m;
}

module.exports = { allow, message, WINDOW_MS, USER_LIMIT, GUEST_LIMIT };
