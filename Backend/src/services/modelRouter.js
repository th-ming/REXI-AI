// ─────────────────────────────────────────────────────────────
// SMART MODEL ROUTER — tự phân loại câu hỏi + chọn model + fallback
// Trung tâm định tuyến model của Rexi AI: quyết định dùng provider
// nào + model nào cho từng câu hỏi, kèm chuỗi fallback tự động.
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const { decryptKey } = require('../utils/cryptoKeys');

// ─── Định nghĩa capability của từng provider (đã test thật) ───
const PROVIDER_CAPS = {
  xnvidia:      { free: true,  vision: true,  fast: false, strong: true,  vi: true },
  mistral:     { free: true,  vision: false, fast: true,  strong: true,  vi: true },
  gemini:      { free: true,  vision: true,  fast: true,  strong: true,  vi: true },
  groq:        { free: true,  vision: false, fast: true,  strong: true,  vi: true },
  cerebras:    { free: true,  vision: false, fast: true,  strong: true,  vi: true },
  cohere:      { free: false, vision: true,  fast: false, strong: true,  vi: true },
  openrouter:  { free: true,  vision: true,  fast: false, strong: true,  vi: true },
  mintrouter:  { free: true,  vision: false, fast: true,  strong: false, vi: true },
  agentrouter: { free: false, vision: false, fast: true,  strong: true,  vi: false },
  opencode:    { free: true,  vision: false, fast: false, strong: true,  vi: true },
  bai:         { free: false, vision: false, fast: true,  strong: false, vi: false },
  kiosapi:     { free: false, vision: false, fast: true,  strong: false, vi: false },
  unorouter:   { free: false, vision: false, fast: false, strong: false, vi: false },
};

// ─── Bảng model ưu tiên theo LOẠI câu hỏi ───
// Mỗi entry: { provider, model } — model phải tồn tại thật trong DB
// (router sẽ kiểm tra + lọc theo key có sẵn).
const ROUTES = {
  // 💬 Trò chuyện thường / hỏi đáp nhanh
  general: [
    { provider: 'opencode', model: 'nemotron-3.5-lightning-free' },
    { provider: 'opencode', model: 'laguna-s-2.1-free' },
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
    { provider: 'xkiro', model: 'mistralai/ministral-8b' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'mistral', model: 'mistral-small-2603' },
  ],
  // 🧠 Câu hỏi phức tạp / phân tích / giải thích
  complex: [
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'opencode', model: 'nemotron-3-ultra-free' },
    { provider: 'xkiro', model: 'mistralai/mistral-large-2512' },
    { provider: 'agentrouter', model: 'claude-opus-4-8' },
    { provider: 'xkiro', model: 'mistralai/mistral-medium-3.5' },
    { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
    { provider: 'groq', model: 'groq/compound' },
    { provider: 'mistral', model: 'mistral-medium-2505' },
  ],
  // 💻 Code / lập trình / sửa lỗi
  code: [
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'opencode', model: 'hy3-free' },
    { provider: 'xkiro', model: 'mistralai/codestral-2508' },
    { provider: 'agentrouter', model: 'gpt-5.6-sol' },
    { provider: 'xkiro', model: 'mistralai/devstral-medium' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'mistral', model: 'codestral-2508' },
  ],
  // ✍️ Viết lách / content dài
  writing: [
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'opencode', model: 'laguna-s-2.1-free' },
    { provider: 'opencode', model: 'muse-spark-1.2-contributor-free' },
    { provider: 'xkiro', model: 'mistralai/mistral-medium-3.5' },
    { provider: 'mistral', model: 'mistral-small-2603' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  ],
  // 🧮 Toán / logic
  math: [
    { provider: 'opencode', model: 'nemotron-3-ultra-free' },
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'xkiro', model: 'mistralai/mistral-large-2512' },
  ],
  // 🌐 Dịch thuật
  translate: [
    { provider: 'opencode', model: 'mimo-v2.5-free' },
    { provider: 'opencode', model: 'nemotron-3.5-lightning-free' },
    { provider: 'xkiro', model: 'mistralai/ministral-8b' },
    { provider: 'mistral', model: 'mistral-small-2603' },
  ],
  // 🖼️ Vision (có ảnh)
  vision: [
    { provider: 'gemini', model: 'models/gemini-3-flash-preview' },
    { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
    { provider: 'nvidia', model: 'google/gemma-4-31b-it' },
  ],
  // 🧠 Suy luận sâu (nút 🧠)
  deep: [
    { provider: 'opencode', model: 'nemotron-3-ultra-free' },
    { provider: 'opencode', model: 'big-pickle' },
    { provider: 'xkiro', model: 'mistralai/mistral-large-2512' },
    { provider: 'nvidia', model: 'stepfun-ai/step-3.7-flash' },
    { provider: 'xkiro', model: 'mistralai/mistral-medium-3.5' },
  ],
};

// ─── Normalize tiếng Việt: bỏ dấu để khớp cả câu gõ không dấu (telex) ───
function stripDiacritics(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// ─── Từ khóa nhận diện loại câu hỏi (tiếng Việt có dấu + không dấu + Anh) ───
// M5: bỏ `anh ` / `tinh ` / `truyen` rời rạc — overmatch "một anh bạn" / "tinh thần" /
// "truyền hình" thành vision/math/writing. Dùng word-boundary + lookahead.
const PATTERNS = {
  code: /(code|lap trinh|thuat toan|debug|sua loi|viet ham|viet chuong trinh|javascript|python|java|html|css|react|api|backend|frontend|database|sql|script|bug|compile|function|class|cau truc du lieu|regex|terminal|command line)/i,
  math: /(tinh toan|phuong trinh|toan hoc|giai phuong trinh|bai toan|tinh (toan|cong|kieu|trung binh|tong)\b|can bac|logarit|dao ham|tich phan|phan so|so hoc|\b\d+\s*[+\-*/×÷]\s*\d+)/i,
  translate: /(dich|translate|chuyen sang tieng|ban dich|phien dich|vietsub)/i,
  writing: /(viet bai|bai van|bai luan|content|noi dung|kich ban|truy?en(?! hinh)\b|tho\b|email|bai viet|tieu thuyet|slogan|quang cao|bai dang)/i,
  vision: /(hinh anh|hinh nay|\b(anh|hinh) (nay|do|kia|con|cua|chup|cut|cute|ngau|dep|xinh|nho|lon|trong|tren|giup)\b|picture|image|photo|nhin thay|mo ta anh|data:image)/i,
};

const COMPLEX_HINTS = /(tai sao|vi sao|giai thich|phan tich|so sanh|danh gia|tong hop|huong dan chi tiet|neu ro|trinh bay|luan giai|chung minh|y nghia|tại sao|vì sao|giải thích|phân tích|so sánh|đánh giá|tổng hợp)/i;

// Cache danh sách model + key có sẵn (refresh mỗi 1h — P3 thống nhất với chat.routes)
let _cache = { models: null, keys: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // P3: thống nhất cache models 1h (trước 10m, lệch với chat.routes 6h)

// ─── Latency: tốc độ thật từng provider (đo từ health check / request) ───
const _latency = {}; // provider -> { avgMs, count, ts }
function recordLatency(provider, ms) {
  if (!provider || typeof ms !== 'number' || ms <= 0) return;
  const p = String(provider).toLowerCase();
  const cur = _latency[p];
  if (!cur) { _latency[p] = { avgMs: ms, count: 1, ts: Date.now() }; return; }
  cur.avgMs = Math.round((cur.avgMs * cur.count + ms) / (cur.count + 1));
  cur.count++;
  cur.ts = Date.now();
}
function getLatency(provider) {
  const cur = _latency[String(provider || '').toLowerCase()];
  return cur ? cur.avgMs : null;
}
function getLatencyMap() { return { ..._latency }; }

// ─── USER TIER: tất cả user đều được dùng model như nhau ───
// Chỉ phân biệt ở rate limit (guest 60 msg/phút) + agent tasks (guest 3 free)
const TIER_ALLOW = {
  guest: null, // null = tất cả provider khỏe mạnh
  user: null,
  admin: null,
};
function providerAllowedForTier(provider, tier) {
  return true; // mọi user đều được dùng mọi provider — công bằng
}

// ─── Health status: provider nào đang sống/chết (cập nhật từ healthCheck) ───
let _health = {}; // { provider: { ok, ts } }
const HEALTH_TTL = 15 * 60 * 1000; // coi là cũ sau 15 phút

// Ghi nhận kết quả health check
function setHealth(results) {
  const now = Date.now();
  for (const r of results || []) {
    _health[r.provider] = { ok: !!r.ok, ts: now };
  }
}

// Provider có được coi là khỏe không (mặc định: khỏe nếu chưa từng test)
function isHealthy(provider) {
  const h = _health[provider];
  if (!h) return true;
  if (Date.now() - h.ts > HEALTH_TTL) return true; // thông tin cũ → cho thử lại
  return h.ok;
}

function getHealth() { return _health; }

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

// Lấy danh sách model đang kích hoạt + key có sẵn (có cache)
async function getCatalog() {
  const now = Date.now();
  if (_cache.models && (now - _cache.ts) < CACHE_TTL) return _cache;
  const [modelRows, keyRows] = await Promise.all([
    queryDb("SELECT ma_model, ma_nha_cung_cap, ten_hien_thi, loai FROM ai_models WHERE kich_hoat = 1"),
    queryDb("SELECT DISTINCT LOWER(ten_nha_cung_cap) AS p FROM khoa_api WHERE gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> ''"),
  ]);
  const models = modelRows || [];
  const keys = new Set((keyRows || []).map(r => r.p));
  // Provider keyless như opencode cũng coi là có sẵn
  keys.add('opencode');
  _cache = { models, keys, ts: now };
  return _cache;
}

// Model id chuẩn hóa (bỏ prefix provider nếu có)
function normModel(m) { return String(m || '').replace(/^[a-z0-9-_]+\//, ''); }

// Kiểm tra 1 (provider, model) có thật trong DB + provider có key không
function isAvailable(provider, model, models, keys) {
  if (!keys.has(provider.toLowerCase())) return false;
  const want = normModel(model);
  return (models || []).some(m =>
    m.ma_nha_cung_cap.toLowerCase() === provider.toLowerCase() &&
    normModel(m.ma_model) === want
  );
}

// ─── PHÂN LOẠI câu hỏi ───
function classify(text, opts = {}) {
  const t = String(text || '');
  const tNorm = stripDiacritics(t); // khớp cả câu gõ không dấu
  const hasImage = opts.hasImage || /data:image\/(png|jpe?g|gif|webp)/i.test(t);

  // Ưu tiên: ảnh → vision; nút 🧠 → deep
  if (hasImage) return 'vision';
  if (opts.thinkingLevel === 'deep') return 'deep';

  // Độ dài dài + phức tạp → complex
  const isComplex = COMPLEX_HINTS.test(tNorm) || t.length > 200;

  // Kiểm tra từng loại theo độ ưu tiên (trên cả bản có dấu + không dấu)
  if (PATTERNS.code.test(tNorm)) return 'code';
  if (PATTERNS.math.test(tNorm)) return 'math';
  if (PATTERNS.translate.test(tNorm)) return 'translate';
  if (PATTERNS.writing.test(tNorm)) return 'writing';
  if (PATTERNS.vision.test(tNorm)) return 'vision';

  return isComplex ? 'complex' : 'general';
}// ─── CHỌN MODEL: trả về danh sách candidates theo thứ tự ưu tiên ───
// ─── LIVE MODEL DISCOVERY — chống NCC đổi/thay toàn bộ model ───
// Hỏi thẳng /models của provider (cache 6h) để biết model nào CÒN TỒN TẠI thật.
const LIVE_TTL = 6 * 60 * 60 * 1000;
const _liveModels = {}; // provider -> { full: Set<id>, ts } | null

async function fetchLiveModels(provider, force = false) {
  const now = Date.now();
  const cached = _liveModels[provider];
  if (!force && cached && (now - cached.ts) < LIVE_TTL) return cached.full ? cached : null;
  try {
    const { apiKey, baseUrl } = await resolveProvider(provider);
    let url = baseUrl.replace(/\/+$/, '') + '/models';
    const headers = { 'Accept': 'application/json' };
    if (provider === 'gemini') {
      url = `${url}?key=${encodeURIComponent(apiKey)}`;
    } else if (provider !== 'opencode') {
      // opencode Zen free KHÔNG cần và KHÔNG chấp nhận Authorization
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }); // P2-20(3): 12s → 5s
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const raw = Array.isArray(data) ? data : (data.data || data.models || []);
    const ids = raw.map(m => (typeof m === 'string' ? m : (m.id || m.name || ''))).filter(Boolean);
    if (!ids.length) throw new Error('danh sách rỗng');
    const entry = { full: new Set(ids.map(String)), ts: now };
    _liveModels[provider] = entry;
    return entry;
  } catch (e) {
    _liveModels[provider] = { full: null, ts: now }; // không xác minh được → unknown, đừng spam
    return null;
  }
}

// Prefetch live models SONG SONG cho nhiều provider (giữ cache 6h).
// P2-20(3): trước đây pickRoute/pickFromLive await từng provider tuần tự (N×5s).
async function prefetchLiveModels(providers) {
  const uniq = [...new Set((providers || []).map((p) => String(p).toLowerCase()))];
  await Promise.all(uniq.map((p) => fetchLiveModels(p).catch(() => null)));
}

// Model còn tồn tại trong danh sách LIVE không? (entry null = không rõ → cho qua)
function liveHas(entry, model) {
  if (!entry || !entry.full) return true;
  const m = String(model || '');
  if (entry.full.has(m)) return true;
  const tail = m.split('/').pop();
  for (const id of entry.full) {
    if (id === tail || id.endsWith('/' + tail)) return true;
  }
  return false;
}

// Tự chọn model từ danh sách LIVE khi bảng cứng chết sạch (NCC thay hết)
async function pickFromLive(cat, keys) {
  const patterns = {
    code: [/cod(e|er)|deepseek|gpt-oss/i],
    general: [/flash|small|mini|free/i],
    complex: [/max|pro|large|opus|ultra/i],
    writing: [/max|medium|small|spark/i],
    math: [/gpt-oss|glm|deepseek|nemotron/i],
    translate: [/translate|aya|small|mimo/i],
    deep: [/pro|max|ultra|thinking/i],
    vision: [/vl|vision|gemma/i],
  }[cat] || [/flash|small/i];
  const provOrder = ['opencode', 'xkiro', 'groq', 'mistral', 'nvidia', 'gemini', 'openrouter'];
  // P2-20(3): prefetch song song trước, vòng lặp sau ăn cache (không await tuần tự N lần)
  await prefetchLiveModels(provOrder.filter((p) => keys.has(p) && isHealthy(p)));
  for (const p of provOrder) {
    if (!keys.has(p)) continue;
    if (!isHealthy(p)) continue;
    const live = await fetchLiveModels(p);
    if (!live) continue;
    const usable = [...live.full].filter(id => !/embed|rerank|whisper|tts|audio|image|vision|guard|moderation/i.test(id));
    for (const r of patterns) {
      const hit = usable.find(id => r.test(id));
      if (hit) return { provider: p, model: hit };
    }
    if (usable.length) return { provider: p, model: usable[0] };
  }
  // M4: hết provOrder → thử provider BẤT KỲ còn key (cerebras/cohere/bai/kiosapi/...)
  const rest = [...keys].filter((p) => !provOrder.includes(p));
  await prefetchLiveModels(rest);
  for (const p of rest) {
    if (!isHealthy(p)) continue;
    const live = await fetchLiveModels(p);
    if (!live) continue;
    const usable = [...live.full].filter(id => !/embed|rerank|whisper|tts|audio|image|vision|guard|moderation/i.test(id));
    for (const r of patterns) {
      const hit = usable.find(id => r.test(id));
      if (hit) return { provider: p, model: hit };
    }
    if (usable.length) return { provider: p, model: usable[0] };
  }
  return null;
}

async function pickRoute(text, opts = {}) {
  const cat = classify(text, opts);
  const { models, keys } = await getCatalog();
  const tier = opts.userTier || 'guest';
  const table = ROUTES[cat] || ROUTES.general;

  const quota = require('./quotaManager');
  // P2-20(3): fetch live models SONG SONG 1 lần (Promise.all + cache), vòng lặp sau ăn cache
  await prefetchLiveModels(table.map((c) => c.provider));
  const candidates = [];
  for (const c of table) {
    const ok =
      isAvailable(c.provider, c.model, models, keys) &&
      isHealthy(c.provider) &&
      providerAllowedForTier(c.provider, tier) &&
      !quota.isQuotaExceeded(c.provider);
    if (!ok) continue;
    // LIVE CHECK: NCC đã xóa/thay model này chưa? (cache 6h, lỗi mạng thì bỏ qua)
    const live = await fetchLiveModels(c.provider);
    if (!liveHas(live, c.model)) continue;
    candidates.push({ ...c, category: cat });
  }
  // Nếu tất cả bị loại vì health/quota/tier → thử lại chỉ lọc theo available + tier
  if (candidates.length === 0) {
    for (const c of table) {
      if (isAvailable(c.provider, c.model, models, keys) && providerAllowedForTier(c.provider, tier)) {
        const live = await fetchLiveModels(c.provider);
        if (!liveHas(live, c.model)) continue;
        candidates.push({ ...c, category: cat });
      }
    }
  }
  // Nếu vẫn trống (tier guest chặn hết) → nới cho user tier
  if (candidates.length === 0) {
    for (const c of table) {
      if (isAvailable(c.provider, c.model, models, keys)) {
        const live = await fetchLiveModels(c.provider);
        if (!liveHas(live, c.model)) continue;
        candidates.push({ ...c, category: cat });
      }
    }
  }
  // Nếu bảng cứng CHẾT SẠCH theo live (NCC thay toàn bộ model) → tự chọn từ /models thật
  if (candidates.length === 0) {
    const dyn = await pickFromLive(cat, keys);
    if (dyn) candidates.push({ ...dyn, dynamic: true, category: cat });
  }
  // Cuối cùng: DB generic (phòng hờ khi cả live cũng không hỏi được)
  if (candidates.length === 0) {
    const fallback = await findGeneric(models, keys, cat);
    if (fallback) candidates.push({ ...fallback, category: cat });
  }

  // ─── LATENCY-AWARE: sắp xếp lại trong nhóm, provider nhanh hơn lên trước ───
  // Chỉ đổi thứ tự giữa các provider KHÁC nhau, giữ model chính được ưu tiên
  candidates.sort((a, b) => {
    if (a.provider === b.provider) return 0;
    const la = getLatency(a.provider), lb = getLatency(b.provider);
    if (la == null && lb == null) return 0;
    if (la == null) return 1;
    if (lb == null) return -1;
    return la - lb;
  });

  return { category: cat, candidates };
}

// Tự tìm model thay thế khi bảng cứng không khớp
async function findGeneric(models, keys, cat) {
  const preferred = {
    code: [/coder|deepseek-v4-pro|gpt-oss/i],
    deep: [/deepseek-chat|step-3/i],
    vision: [/vl|vision|gemini-3|gemma-4/i],
    general: [/v4-flash|3\.5-flash|small/i],
    complex: [/max|medium|compound|3\.8/i],
    writing: [/max|medium|small/i],
    math: [/gpt-oss|glm|deepseek/i],
    translate: [/translate|aya|small/i],
  }[cat] || [/flash|small/i];

  const order = ['opencode', 'xkiro', 'groq', 'nvidia', 'mistral', 'gemini', 'openrouter'];
  for (const p of order) {
    if (!keys.has(p)) continue;
    const list = models.filter(m => m.ma_nha_cung_cap === p);
    for (const re of preferred) {
      const hit = list.find(m => re.test(m.ma_model));
      if (hit) return { provider: p, model: hit.ma_model };
    }
    const any = list[0];
    if (any) return { provider: p, model: any.ma_model };
  }
  // M4: fallback cuối — provider BẤT KỲ còn key + model kích hoạt (cerebras/cohere/bai/...)
  for (const p of keys) {
    const list = models.filter(m => String(m.ma_nha_cung_cap).toLowerCase() === String(p).toLowerCase());
    if (list.length) return { provider: list[0].ma_nha_cung_cap, model: list[0].ma_model };
  }
  return null;
}

// ─── Lấy key + baseUrl cho 1 provider ───
async function resolveProvider(provider) {
  const keyRow = await queryDb(
    "SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = LOWER(?) LIMIT 1",
    [provider]
  );
  let apiKey = '';
  if (keyRow && keyRow[0] && keyRow[0].gia_tri_khoa) {
    try { apiKey = decryptKey(keyRow[0].gia_tri_khoa).trim(); }
    catch (e) { apiKey = keyRow[0].gia_tri_khoa.trim(); }
  }
  const provRow = await queryDb(
    "SELECT base_url FROM ai_providers WHERE LOWER(ma_nha_cung_cap) = LOWER(?) LIMIT 1",
    [provider]
  );
  const baseUrl = (provRow && provRow[0] && provRow[0].base_url) || defaultBaseUrl(provider);
  return { apiKey, baseUrl };
}

function defaultBaseUrl(provider) {
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
    opencode: 'https://opencode.ai/zen/v1',
  };
  return map[provider] || 'https://api.openai.com/v1';
}

// ─── Báo cáo trạng thái (để test + UI hiển thị) ───
async function getStatus() {
  const { models, keys } = await getCatalog();
  const byProvider = {};
  for (const m of models) {
    byProvider[m.ma_nha_cung_cap] = (byProvider[m.ma_nha_cung_cap] || 0) + 1;
  }
  return {
    providers: Object.keys(byProvider).map(p => ({
      provider: p,
      models: byProvider[p],
      hasKey: keys.has(p),
      caps: PROVIDER_CAPS[p] || { free: true },
    })),
    totalModels: models.length,
  };
}

// ─── CONTEXT/SPECIALTY: câu hỏi thuộc lĩnh vực nào ───
function detectSpecialty(text) {
  const t = stripD(text);
  if (/hop dong|doanh nghiep|kinh doanh|startup|ke hoach kinh doanh|tai chinh|cong ty|thue/i.test(t)) return 'business';
  if (/marketing|content|quang cao|ban hang|sale|slogan|kich ban|viral|seo/i.test(t)) return 'marketing';
  if (/bai giang|giao duc|hoc tap|on thi|luyen thi|gia su|bai tap ve nha/i.test(t)) return 'education';
  if (/suc khoe|dinh duong|thuc don|bai tap|gym|benh|tri lieu|thuoc/i.test(t)) return 'health';
  if (/code|lap trinh|thuat toan|debug|sua loi|javascript|python|java|api|backend|frontend|database|sql/i.test(t)) return 'coder';
  return 'general';
}

function stripD(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

module.exports = {
  classify,
  pickRoute,
  resolveProvider,
  getStatus,
  setHealth,
  getHealth,
  isHealthy,
  recordLatency,
  getLatency,
  getLatencyMap,
  detectSpecialty,
  providerAllowedForTier,
  TIER_ALLOW,
  ROUTES,
  PROVIDER_CAPS,
  _getCatalog: getCatalog, // dùng trong test
};
