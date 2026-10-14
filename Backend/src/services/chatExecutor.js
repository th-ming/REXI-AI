// ─────────────────────────────────────────────────────────────
// CHAT EXECUTOR — gọi API chat với FALLBACK CHUỖI tự động
// Nhận danh sách candidates (từ modelRouter) → thử lần lượt,
// provider lỗi → tự chuyển sang candidate kế tiếp.
// ─────────────────────────────────────────────────────────────
'use strict';

const { resolveProvider, recordLatency } = require('./modelRouter');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const quota = require('./quotaManager');

const OPENAI_COMPAT = ['openai', 'deepseek', 'groq', 'github', 'custom', 'xkiro', 'agentrouter', 'bai', 'kiosapi', 'unorouter', 'nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kilo',];

function stripProviderPrefix(provider, model) {
  let m = String(model || '');
  if (provider === 'agentrouter') m = m.replace(/^agentrouter\//, '');
  if (provider === 'opencode') m = m.replace(/^opencode\//, '');
  if (['nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter'].includes(provider)) m = m.replace(new RegExp('^' + provider + '/'), '');
  if (provider === 'gemini') m = m.replace(/^models\//, '');
  return m;
}

function endpointFor(provider, baseUrl) {
  const map = {
    deepseek: 'https://api.deepseek.com/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    github: 'https://models.github.ai/inference/chat/completions',
  };
  if (map[provider]) return map[provider];
  const base = (baseUrl || defaultBase(provider)).replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function defaultBase(provider) {
  const map = {
    xnvidia: 'https://integrate.api.nvidia.com/v1',
    mistral: 'https://api.mistral.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    cohere: 'https://api.cohere.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    mintrouter: 'https://mintrouter.ai/v1',
    agentrouter: 'https://agentrouter.org/v1',
    bai: 'https://api.b.ai/v1',
    kiosapi: 'https://kiosapi.com/v1',
    unorouter: 'https://api.unorouter.com/v1',
    kilo: 'https://kilo.ai/api/openrouter',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return map[provider] || 'https://api.openai.com/v1';
}

function buildOpenAIContent(noiDung) {
  const text = String(noiDung || '');
  const parts = [];
  const imgRe = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;
  let last = 0, m, buf = '';
  while ((m = imgRe.exec(text)) !== null) {
    buf += text.slice(last, m.index);
    if (buf.trim()) { parts.push({ type: 'text', text: buf.trim() }); buf = ''; }
    parts.push({ type: 'image_url', image_url: { url: m[1] } });
    last = m.index + m[0].length;
  }
  buf += text.slice(last);
  if (buf.trim() || parts.length === 0) parts.push({ type: 'text', text: buf.trim() || '...' });
  return parts;
}

// Gemini nhận ảnh qua inlineData (base64 + mimeType), KHÔNG phải image_url kiểu OpenAI.
// QA 17/9: thiếu hàm này nên nhánh Gemini của auto-router luôn gửi text thuần → vision mù.
function buildGeminiParts(noiDung) {
  const text = String(noiDung || '');
  const parts = [];
  const imgRe = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;
  let last = 0, m, buf = '';
  while ((m = imgRe.exec(text)) !== null) {
    buf += text.slice(last, m.index);
    if (buf.trim()) { parts.push({ text: buf.trim() }); buf = ''; }
    const dm = /^data:([^;,]+);base64,(.+)$/s.exec(m[1]);
    if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2].replace(/\s+/g, '') } });
    last = m.index + m[0].length;
  }
  buf += text.slice(last);
  if (buf.trim() || parts.length === 0) parts.push({ text: buf.trim() || '...' });
  return parts;
}

// ─── RETRY BACKOFF: lỗi tạm thời (429/5xx/network) → thử lại trước khi bỏ ───
const RETRYABLE = [408, 429, 500, 502, 503, 504];
const RETRY_DELAYS = [1200, 3000]; // chờ 1.2s → 3s

async function withRetry(fn, attempts = RETRY_DELAYS.length + 1) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e && (e.retryable || RETRYABLE.includes(e.status));
      if (!retryable || i >= RETRY_DELAYS.length) break;
      const delay = RETRY_DELAYS[i];
      console.log(`[Retry] thử lại lần ${i + 1} sau ${delay}ms (${e.message})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── P1-10: timeout theo độ khó (đồng bộ với chat.routes.js streamTimeoutMs) ───
// general 20s, complex 30s, deep 60s — tránh abort oan câu phức tạp.
function timeoutForLevel(level) {
  const l = String(level || 'general').toLowerCase();
  if (l === 'deep') return 60000;
  if (l === 'complex') return 30000;
  return 20000;
}

// ─── P2-20(2): max_tokens theo thinking_level (đồng bộ với Claude trong chat.routes.js) ───
// Trước đây cứng 1024 → câu dài/deep bị cụt. Giờ: 4096 thường / 16384 deep.
function maxTokensForLevel(level) {
  return String(level || '').toLowerCase() === 'deep' ? 16384 : 4096;
}

// ─── M7: history gửi lên API — chỉ giữ 12 tin gần nhất, bỏ base64 ảnh CŨ ───
// (payload base64 dồn cục làm request chậm + 400 Payload Too Large trên
// nhiều provider. Tin CUỐI giữ nguyên ảnh — đó là ảnh user vừa gửi.)
function stripOldImages(s) {
  return String(s || '').replace(/!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g, '[ảnh đính kèm]');
}

function buildHistoryOpenAI(history) {
  const list = (history || []).slice(-12);
  return list.map((h, i) => {
    const isLast = i === list.length - 1;
    const nd = isLast ? h.noi_dung : stripOldImages(h.noi_dung);
    return {
      role: h.vai_tro === 'user' ? 'user' : 'assistant',
      content: h.vai_tro === 'user' ? buildOpenAIContent(nd) : nd,
    };
  });
}

function buildHistoryGemini(history) {
  const list = (history || []).slice(-12);
  return list.map((h, i) => {
    const isLast = i === list.length - 1;
    const nd = isLast ? h.noi_dung : stripOldImages(h.noi_dung);
    return {
      role: h.vai_tro === 'user' ? 'user' : 'model',
      parts: h.vai_tro === 'user' ? buildGeminiParts(nd) : [{ text: nd }],
    };
  });
}

// Gọi 1 provider (không fallback) — trả { ok, content, error, status }
async function callOnce(candidate, { systemPrompt, history, thinkingLevel }) {
  const { provider, model } = candidate;
  const { apiKey, baseUrl } = await resolveProvider(provider);
  // opencode + kilo KEYLESS — không cần API key (verify 10/2026: kilo.ai/api/openrouter
  // không 401 khi không có Authorization)
  if (!apiKey && !['opencode', 'kilo'].includes(provider)) {
    return { ok: false, error: `[${provider}] thiếu API key` };
  }
  const finalModel = stripProviderPrefix(provider, model);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...buildHistoryOpenAI(history),
  ];

  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(apiKey);
    const gmodel = genAI.getGenerativeModel({ model: finalModel });
    const contents = buildHistoryGemini(history);
    const genConfig = thinkingLevel === 'deep' ? { thinkingConfig: { thinkingBudget: 8192 } } : {};
    const result = await gmodel.generateContent({ contents, systemInstruction: systemPrompt, generationConfig: genConfig });
    const text = result.response.text();
    return { ok: true, content: text };
  }

  const endpoint = endpointFor(provider, baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
  };
  // opencode Zen free + kilo gateway KHÔNG BAO GIỜ gửi Authorization (key trong DB là key khác — gửi vào sẽ bị 401)
  if (!['opencode', 'kilo'].includes(provider)) headers['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'agentrouter') headers['User-Agent'] = 'opencode/1.17.12';

  const t0 = Date.now();
  let resp;
  try {
    resp = await withRetry(async () => {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: finalModel, messages, temperature: 0.7, max_tokens: maxTokensForLevel(thinkingLevel) }),
        signal: AbortSignal.timeout(timeoutForLevel(thinkingLevel)), // P1-10: fail-fast theo level
      });
      if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${r.status}`;
      const err = new Error(errMsg);
      err.status = r.status;
      err.retryable = RETRYABLE.includes(r.status);
      const retryAfter = r.headers.get('retry-after');
      err.retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
        throw err;
      }
      return r;
    });
  } catch (e) {
    // P2-20(1): phạt throttle ĐÚNG 1 lần, CHỈ khi 429/5xx thật.
    // M6: bỏ timeout/abort khỏi throttle — timeout thường do câu quá dài/max_tokens,
    // không phải provider chết → phạt oan làm provider rơi vào cooldown 1-4 phút.
    const _st = e && e.status;
    if (_st === 429 || (_st >= 500 && _st <= 599)) {
      quota.recordThrottle(provider, (e && e.retryAfterMs) || undefined);
    }
    throw e;
  }
  // Thành công → ghi nhận lượt dùng (P2-20(1)) + reset backoff + ghi nhận tốc độ
  quota.recordUse(provider);
  quota.recordSuccess(provider);
  recordLatency(provider, Date.now() - t0);
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    return { ok: false, status: resp.status, error: errData.error?.message || `HTTP ${resp.status}` };
  }
  const data = await resp.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (msg) {
    let content = msg.content;
    if (Array.isArray(content)) content = content.map(p => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('');
    if (typeof content !== 'string') content = '';
    if (!content) content = msg.reasoning || (msg.reasoning_details && msg.reasoning_details.map(r => r.text).join('\n')) || '';
    return { ok: true, content: content || '[không có nội dung trả về]' };
  }
  return { ok: false, error: 'phản hồi không có choices' };
}

// Gọi với fallback chuỗi — trả { ok, content, provider, model, attempts, errors }
async function callWithFallback(candidates, opts) {
  const errors = [];
  const used = [];
  for (const c of candidates || []) {
    used.push(`${c.provider}/${c.model}`);
    // Bỏ qua provider đang bị throttle hoặc hết quota
    if (quota.isQuotaExceeded(c.provider)) {
      errors.push(`[${c.provider}/${c.model}] quota exceeded/throttled — skipped`);
      continue;
    }
    try {
      const r = await callOnce(c, opts);
      if (r.ok) {
        return { ok: true, content: r.content, provider: c.provider, model: c.model, attempts: used, errors };
      }
      errors.push(`[${c.provider}/${c.model}] ${r.error || r.status}`);
      // Nếu lỗi 429 → đánh dấu throttle ngay (dù retry đã xử lý)
      if (r.status === 429) quota.recordThrottle(c.provider);
    } catch (e) {
      errors.push(`[${c.provider}/${c.model}] ${e.message}`);
    }
  }
  return { ok: false, content: '', provider: null, model: null, attempts: used, errors };
}

// Báo cáo lỗi gọn cho người dùng
function friendlyFail({ errors, candidates }) {
  const first = (errors && errors[0]) || '';
  const tried = (candidates || []).map(c => `${c.provider}/${c.model}`).join(', ');
  return `⚠️ **Không gọi được AI (đã thử ${(candidates || []).length} lựa chọn: ${tried}).**\n\nLỗi cuối: ${first}\n\n_Đây thường do key hết quota hoặc nhà cung cấp đang lỗi. Thử lại sau ít phút hoặc chọn model khác._`;
}

module.exports = { callWithFallback, callOnce, stripProviderPrefix, endpointFor, OPENAI_COMPAT, maxTokensForLevel, timeoutForLevel, stripOldImages, buildHistoryOpenAI, buildHistoryGemini, buildGeminiParts };
