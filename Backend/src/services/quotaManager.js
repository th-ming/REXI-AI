// ─────────────────────────────────────────────────────────────
// QUOTA MANAGER THÔNG MINH — xoay vòng provider dựa trên
// response THẬT từ API (429/throttle), không dùng timer ngu.
//
// Khi provider bị 429 → tự đánh dấu "đang bị chặn" với exponential
// backoff (30s → 60s → 120s → ...). Provider khác được ưu tiên.
// Tự reset khi hết cooldown.
// ─────────────────────────────────────────────────────────────
'use strict';

const db = require('../config/db');

// ─── Throttle state: provider nào đang bị chặn, đến khi nào ───
// { provider: { until: timestamp, backoffMs: number, consecutiveFailures: number } }
const _throttled = new Map();

// M3: persist throttle state xuống DB — restart server không mất backoff
function _saveThrottleToDb(p, state) {
  db.run(
    `INSERT INTO provider_throttle (provider, until, backoff_ms, failures) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET until = excluded.until, backoff_ms = excluded.backoff_ms, failures = excluded.failures, updated_at = CURRENT_TIMESTAMP`,
    [p, state.until, state.backoffMs, state.consecutiveFailures],
    (err) => { if (err) console.warn('[Quota] Lưu throttle lỗi:', err.message); }
  );
}

function _loadThrottleFromDb() {
  db.all('SELECT provider, until, backoff_ms, failures FROM provider_throttle', [], (err, rows) => {
    if (err || !rows || !rows.length) return;
    let loaded = 0;
    for (const r of rows) {
      const p = String(r.provider || '').toLowerCase();
      const until = Number(r.until) || 0;
      if (!p || until <= _now() || _throttled.has(p)) continue;
      _throttled.set(p, {
        until,
        backoffMs: Number(r.backoff_ms) || 30000,
        consecutiveFailures: Number(r.failures) || 1,
      });
      loaded++;
    }
    if (loaded > 0) console.log(`[Quota] Nạp lại ${loaded} provider đang bị throttle từ DB`);
  });
}
_loadThrottleFromDb();

// ─── Usage tracking: đếm request trong cửa sổ thời gian ───
const _usage = new Map(); // provider -> [ {ts, ok} ]

// ─── Rules cơ bản (dùng làm fallback khi chưa có data thật) ───
const BASE_RULES = {
  gemini:     { max: 5,   windowMs: 60 * 1000 },          // ~5 req/phút
  openrouter: { max: 45,  windowMs: 24 * 60 * 60 * 1000 },
  mintrouter: { max: 45,  windowMs: 24 * 60 * 60 * 1000 }, // ~50/ngày
  cohere:     { max: 8,   windowMs: 60 * 1000 },
  groq:       { max: 25,  windowMs: 60 * 1000 },
  mistral:    { max: 30,  windowMs: 60 * 1000 },           // mistral generous
  nvidia:     { max: 15,  windowMs: 60 * 1000 },
  cerebras:   { max: 20,  windowMs: 60 * 1000 },
  xkiro:      { max: 999, windowMs: 60 * 1000 },           // unlimited-ish
  agentrouter:{ max: 5,   windowMs: 60 * 1000 },
  opencode:   { max: 999, windowMs: 60 * 1000 },           // local CLI
  bai:        { max: 15,  windowMs: 60 * 1000 },
  kiosapi:    { max: 5,   windowMs: 60 * 1000 },          // verified 10/2026: 5 req/minute
  unorouter:  { max: 1,   windowMs: 60 * 1000 },           // free tier = 1 req/phút — chặn từ app khỏi ăn 429 của upstream
};

const _now = () => Date.now();

// ─── GHI NHẬN LƯỢT DÙNG ───
function recordUse(provider, amount = 1) {
  const p = String(provider || '').toLowerCase();
  if (!_usage.has(p)) _usage.set(p, []);
  const list = _usage.get(p);
  list.push({ ts: _now(), amount, ok: true });
  if (list.length > 200) _usage.set(p, list.slice(-200));
}

// ─── GHI NHẬN THROTTLE (khi nhận 429/rate limit từ API) ───
// retryAfter: số giây server yêu cầu chờ (nếu có)
// P2-20(1): bỏ backoff-on-first-failure — lần đầu phạt đúng 30s (không nhân đôi
// ngay), các lần liên tiếp mới exponential 60s → 120s → 240s (max 4 phút).
// CHỈ gọi khi 429/5xx/timeout thật (caller chịu trách nhiệm — xem chatExecutor).
function recordThrottle(provider, retryAfterMs) {
  const p = String(provider || '').toLowerCase();
  const state = _throttled.get(p) || { until: 0, backoffMs: 30000, consecutiveFailures: 0 };

  const cooldown = retryAfterMs || state.backoffMs;
  state.until = _now() + cooldown;
  // Nhân đôi cho LẦN SAU (không áp ngay lần này)
  state.backoffMs = Math.min(state.backoffMs * 2, 240000);
  state.consecutiveFailures++;
  _throttled.set(p, state);
  _saveThrottleToDb(p, state);

  console.log(`[Quota] ${p} bị throttle ${cooldown/1000}s (thất bại #${state.consecutiveFailures})`);
}

// ─── GHI NHẬN THÀNH CÔNG (reset backoff) ───
function recordSuccess(provider) {
  const p = String(provider || '').toLowerCase();
  const state = _throttled.get(p);
  if (state && state.consecutiveFailures > 0) {
    state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
    // Nếu thành công liên tiếp 3 lần → reset hoàn toàn backoff
    if (state.consecutiveFailures === 0) {
      _throttled.delete(p);
      db.run('DELETE FROM provider_throttle WHERE provider = ?', [p], () => {});
      console.log(`[Quota] ${p} đã hồi phục (hết backoff)`);
    }
  }
}

// ─── KIỂM TRA: provider có đang bị chặn không ───
function isThrottled(provider) {
  const p = String(provider || '').toLowerCase();
  const state = _throttled.get(p);
  if (!state) return false;
  if (_now() >= state.until) {
    // Hết cooldown → cho thử lại
    return false;
  }
  return true;
}

// ─── KIỂM TRA: provider có hết quota không (dựa trên fixed rules) ───
function isQuotaExceeded(provider) {
  const p = String(provider || '').toLowerCase();
  
  // Ưu tiên: bị throttle từ API thật → chặn ngay
  if (isThrottled(p)) return true;
  
  // Fallback: check fixed rules
  const rule = BASE_RULES[p];
  if (!rule) return false;
  const list = _usage.get(p) || [];
  const cutoff = _now() - rule.windowMs;
  const recent = list.filter(x => x.ts >= cutoff).reduce((s, x) => s + (x.amount || 1), 0);
  return recent >= rule.max;
}

// ─── CÒN LẠI BAO NHIÊU LƯỢT ───
function remaining(provider) {
  const p = String(provider || '').toLowerCase();
  if (isThrottled(p)) return 0;
  const rule = BASE_RULES[p];
  if (!rule) return Infinity;
  const list = _usage.get(p) || [];
  const cutoff = _now() - rule.windowMs;
  const recent = list.filter(x => x.ts >= cutoff).reduce((s, x) => s + (x.amount || 1), 0);
  return Math.max(0, rule.max - recent);
}

// ─── LỌC CANDIDATES: bỏ provider bị chặn/hết quota ───
function filterByQuota(candidates) {
  if (!candidates || !candidates.length) return [];
  const filtered = candidates.filter(c => !isQuotaExceeded(c.provider));
  // Nếu tất cả bị loại → giữ nguyên (chọn cái ít bị chặn nhất)
  return filtered.length > 0 ? filtered : candidates;
}

// ─── SNAPSHOT cho admin/telemetry ───
function snapshot() {
  const out = {};
  for (const p of Object.keys(BASE_RULES)) {
    const thrState = _throttled.get(p);
    out[p] = {
      remaining: remaining(p),
      exceeded: isQuotaExceeded(p),
      throttled: isThrottled(p),
      throttleUntil: thrState ? thrState.until : null,
      backoffMs: thrState ? thrState.backoffMs : null,
      consecutiveFailures: thrState ? thrState.consecutiveFailures : 0,
    };
  }
  return out;
}

function reset() { _usage.clear(); _throttled.clear(); db.run('DELETE FROM provider_throttle', [], () => {}); }

module.exports = {
  BASE_RULES, recordUse, recordThrottle, recordSuccess,
  isThrottled, isQuotaExceeded, remaining, filterByQuota, reset, snapshot,
};
