// NVIDIA chat proxy — chạy phía server để giấu key + tránh CORS.
// Tự luân model trong POOL và luân 2 key khi model/key lỗi (429/hết quota/5xx).
// Có ảnh trong messages -> chỉ dùng model vision.
const BASE = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Key lấy từ env (KHÔNG nhúng vào repo public). Nhiều key: ngăn bằng dấu phẩy.
const KEYS = (process.env.NVIDIA_KEYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Thứ tự luân: deepseek v4.1 -> glm -> glm flash -> step 5 -> nemotron 3
const POOL = [
  { id: 'deepseek-ai/deepseek-v4.1-flash', vision: false },
  { id: 'z-ai/glm-5.3', vision: false },
  { id: 'z-ai/glm-5.3-flash', vision: false },
  { id: 'step-5-preview', vision: false },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', vision: false },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', vision: true },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', vision: true },
];

const COOLDOWN_MS = 90 * 1000;
const cooldown = {};
let lastGood = POOL[0].id;

const cooled = (id) => (cooldown[id] || 0) > Date.now();

function hasImage(messages) {
  return messages.some((m) => Array.isArray(m.content) &&
    m.content.some((p) => p && p.type === 'image_url'));
}

function order(selected, visionOnly) {
  const pool = visionOnly ? POOL.filter((m) => m.vision) : POOL;
  const ids = pool.map((m) => m.id);
  if (selected && selected !== '__auto__' && ids.includes(selected)) {
    return [selected, ...ids.filter((x) => x !== selected)];
  }
  const i = Math.max(0, ids.indexOf(lastGood));
  const rot = [ids[i], ...ids.slice(i + 1), ...ids.slice(0, i)];
  return rot.sort((a, b) => (cooled(a) ? 1 : 0) - (cooled(b) ? 1 : 0));
}

async function call(model, key, messages) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 4096, stream: false }),
      signal: ctrl.signal,
    });
    const raw = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + raw.slice(0, 180));
    const j = JSON.parse(raw);
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const out = msg.content || msg.reasoning_content;
    if (!out) throw new Error('empty response');
    return out;
  } finally {
    clearTimeout(t);
  }
}

async function handle({ model, messages } = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const visionOnly = hasImage(msgs);
  const tried = [];
  if (!KEYS.length) return { ok: false, tried: ['NVIDIA_KEYS chưa cấu hình trên server'] };
  for (const m of order(model, visionOnly)) {
    for (let ki = 0; ki < KEYS.length; ki++) {
      try {
        const out = await call(m, KEYS[ki], msgs);
        lastGood = m;
        return { ok: true, model: m, key: ki + 1, content: out };
      } catch (e) {
        tried.push(`${m} [k${ki + 1}]: ${e.message}`);
      }
    }
    cooldown[m] = Date.now() + COOLDOWN_MS;
  }
  return { ok: false, tried };
}

module.exports = { handle, POOL };
