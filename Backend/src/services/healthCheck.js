// ─────────────────────────────────────────────────────────────
// HEALTH CHECK — kiểm tra key provider còn sống hay chết
// Gọi 1 request nhỏ tới từng provider có key, ghi nhận trạng thái.
// ─────────────────────────────────────────────────────────────
'use strict';

const db = require('../config/db');
const { decryptKey } = require('../utils/cryptoKeys');

// Truy vấn qua adapter db.js (SQLite local / PG trên Render — adapter tự đổi ? → $1)
function queryDb(sql, params = []) {
  return new Promise((resolve) => {
    try {
      db.all(sql, params, (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
    } catch (e) { resolve([]); }
  });
}

// Endpoint + model test nhanh cho từng provider
const TEST_PLAN = {
  xnvidia:      { url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'nvidia/nemotron-mini-4b-instruct', auth: 'bearer' },
  mistral:     { url: 'https://api.mistral.ai/v1/chat/completions',         model: 'mistral-small-latest',       auth: 'bearer' },
  groq:        { url: 'https://api.groq.com/openai/v1/chat/completions',    model: 'openai/gpt-oss-120b',        auth: 'bearer' },
  openrouter:  { url: 'https://openrouter.ai/api/v1/chat/completions',      model: 'nvidia/nemotron-3.5-lightning:free', auth: 'bearer' },
  mintrouter:  { url: 'https://mintrouter.ai/v1/chat/completions',           model: 'muse-spark-1.3-contributor-free', auth: 'bearer' },
  agentrouter: { url: 'https://agentrouter.org/v1/chat/completions',        model: 'gpt-5.6-sol',                 auth: 'bearer' },
  bai:         { url: 'https://api.b.ai/v1/chat/completions',               model: 'qwen3.8-flash',               auth: 'bearer' },
  kiosapi:     { url: 'https://kiosapi.com/v1/chat/completions',     model: 'sensenova-6.8-flash-lite',    auth: 'bearer' },
  gemini:      { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent', model: null, auth: 'query' },
  // kilo: KEYLESS — không cần key; nếu test không có key thì gửi không Authorization
  kilo:        { url: 'https://kilo.ai/api/openrouter/chat/completions', model: 'nvidia/nemotron-3.5-lightning:free', auth: 'bearer' },
};

// Lấy toàn bộ key từ DB (đã decrypt)
async function getAllKeys() {
  const rows = await queryDb("SELECT ten_nha_cung_cap, gia_tri_khoa FROM khoa_api WHERE gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> ''");
  const out = {};
  for (const r of rows) {
    const p = r.ten_nha_cung_cap.toLowerCase();
    try { out[p] = decryptKey(r.gia_tri_khoa).trim(); }
    catch (e) { out[p] = r.gia_tri_khoa.trim(); }
  }
  return out;
}

// Test 1 provider — trả { provider, ok, status, ms, detail }
async function testProvider(provider, apiKey) {
  const plan = TEST_PLAN[provider];
  if (!plan) return { provider, ok: true, status: 'skip', detail: 'không có plan test' };
  const start = Date.now();
  try {
    let url = plan.url;
    const headers = { 'Content-Type': 'application/json' };
    if (plan.auth === 'bearer' && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    // agentrouter chặn client lạ → phải giả lập UA của opencode
    if (provider === 'agentrouter') headers['User-Agent'] = 'opencode/1.17.12';
    if (plan.auth === 'query' && apiKey) {
      url = url.replace('generateContent', `generateContent?key=${encodeURIComponent(apiKey)}`);
    }
    const body = plan.model
      ? { model: plan.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }
      : { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 5 } };

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - start;
    const txt = await resp.text().catch(() => '');
    let detail = '';
    try { const j = JSON.parse(txt); detail = (j.error && (j.error.message || j.error.type)) || (j.choices ? 'ok' : txt.slice(0, 120)); }
    catch (e) { detail = txt.slice(0, 120); }

    const ok = resp.ok;
    return { provider, ok, status: resp.status, ms, detail };
  } catch (e) {
    return { provider, ok: false, status: 'ERR', ms: Date.now() - start, detail: e.message };
  }
}

// Chạy health check toàn bộ provider có key
async function runHealthCheck() {
  const keys = await getAllKeys();
  const results = [];
  for (const [provider, apiKey] of Object.entries(keys)) {
    if (provider === 'opencode' || provider === 'github') {
      results.push({ provider, ok: true, status: 'skip', detail: 'provider đặc biệt (agent/github)' });
      continue;
    }
    if (!TEST_PLAN[provider]) {
      results.push({ provider, ok: true, status: 'skip', detail: 'không có trong test plan' });
      continue;
    }
    const r = await testProvider(provider, apiKey);
    results.push(r);
  }
  return results;
}

module.exports = { runHealthCheck, testProvider, getAllKeys, TEST_PLAN };
