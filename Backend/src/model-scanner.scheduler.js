/**
 * model-scanner.scheduler.js
 * Cron Job tự động quét tất cả providers mỗi 24h (lúc 3:00 AM)
 * và publish các model đang hoạt động lên CSDL
 *
 * FIX PROD: dùng adapter db.js (SQLite local / PostgreSQL trên Render) thay vì
 * better-sqlite3 file cứng — trước đây chỉ chạy đúng trên máy local.
 */
const db = require('./config/db');
const { decryptKey } = require('./utils/cryptoKeys');

// Biểu thức thời gian theo loại DB
const isSqlite = db.type === 'sqlite';
const NOW = () => (isSqlite ? "datetime('now')" : 'NOW()');

// ─── Promise helpers cho adapter (callback-based) ─────────────
function runSql(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this && this.changes != null ? this.changes : 0); }));
}
function getRow(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function allRows(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
// Chuyển giá trị thời gian từ DB (SQLite text / PG Date) về ms
function toTimeMs(t) {
  if (!t) return NaN;
  if (t instanceof Date) return t.getTime();
  return new Date(String(t).replace(' ', 'T') + 'Z').getTime();
}

// Danh sách tất cả providers và endpoint của chúng
const PROVIDER_ENDPOINTS = {
  gemini:      { name: 'Google Gemini',     endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'key' },
  openrouter:  { name: 'OpenRouter',        endpoint: 'https://openrouter.ai/api/v1/models',                   auth: 'bearer' },
  mintrouter:  { name: 'MinRouter',         endpoint: 'https://mintrouter.ai/v1/models',                     auth: 'bearer' },
  groq:        { name: 'Groq Cloud',        endpoint: 'https://api.groq.com/openai/v1/models',                 auth: 'bearer' },
  nvidia:      { name: 'Nvidia NIM',        endpoint: 'https://integrate.api.nvidia.com/v1/models',            auth: 'bearer' },
  mistral:     { name: 'Mistral AI',        endpoint: 'https://api.mistral.ai/v1/models',                      auth: 'bearer' },
  cerebras:    { name: 'Cerebras',          endpoint: 'https://api.cerebras.ai/v1/models',                     auth: 'bearer' },
  cohere:      { name: 'Cohere AI',         endpoint: 'https://api.cohere.ai/v2/models',                       auth: 'bearer' },
  openai:      { name: 'OpenAI',            endpoint: 'https://api.openai.com/v1/models',                      auth: 'bearer' },
  deepseek:    { name: 'DeepSeek',          endpoint: 'https://api.deepseek.com/models',                       auth: 'bearer' },
  xkiro:       { name: 'xKiro',             endpoint: 'https://api.xkiro.com/v1/models',                       auth: 'bearer' },
  opencode:    { name: 'OpenCode',          endpoint: 'https://opencode.ai/api/v1/models',                     auth: 'bearer' },
  // github: XÓA khỏi map — GitHub Models retirement (catalog + inference trả 410
  // github_models_retirement_brownout, verify 9/2026). Giữ key trong DB, khi nào
  // Microsoft mở lại thì thêm lại endpoint mới.
  grok:        { name: 'xAI Grok',          endpoint: 'https://api.x.ai/v1/models',                            auth: 'bearer' },
  claude:      { name: 'Anthropic Claude',  endpoint: 'https://api.anthropic.com/v1/models',                   auth: 'anthropic' },
  // P0-fix: xkiro từng vắng mặt ở đây → 21 model chết nằm lì trong DB, scanner không bao giờ đụng tới.
  // Chỉ thêm provider CÓ key (kiraai/bazaarlink chưa có key → thêm vào sẽ bị cleanupStaleModels xóa rows).
  xagentrouter: { name: 'AgentRouter',        endpoint: 'https://agentrouter.org/v1/models',                    auth: 'bearer' },
  // 3 router mới (key lấy từ opencode config của user, 9/2026 — opencode dùng hằng ngày):
  bai:         { name: 'B.AI',               endpoint: 'https://api.b.ai/v1/models',                           auth: 'bearer' },
  kiosapi:     { name: 'KiosAPI Free',       endpoint: 'https://kiosapi.com/v1/models',                 auth: 'bearer' },
  // trustCatalog: free tier 1 req/phút TOÀN ACCOUNT (verify 9/2026) → health-test hàng loạt
  // chỉ gây bão 429, vô nghĩa. Đăng ký thẳng theo listing (:free = active), quotaManager
  // giới hạn 1/phút lúc chat thật.
  unorouter:   { name: 'UnoRouter',          endpoint: 'https://api.unorouter.com/v1/models',                  auth: 'bearer', trustCatalog: true },
  // kilo: Kilo Code gateway — KEYLESS hoàn toàn (verify 10/2026: /api/gateway/models +
  // /api/openrouter/chat/completions KHÔNG 401 khi không có Authorization). Base chat là
  // 2 path segments (https://kilo.ai/api/openrouter) — KHÔNG /v1.
  kilo:        { name: 'Kilo Code',          endpoint: 'https://kilo.ai/api/gateway/models',                   auth: 'bearer' },
  // kiro: KiroForge (kiroforge.cloud) — New API instance, CÓ key (lưu khoa_api encrypted).
  // /v1/models trả EMPTY {"data":[]} → fetchModels hardcode 23-model list (từ /api/pricing, 10/2026).
  };

// Lấy API key từ CSDL cho một provider (key lưu mã hóa — phải decryptKey)
async function getKeyForProvider(providerId) {
  try {
    const row = await getRow("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = LOWER(?)", [providerId]);
    if (!row || !row.gia_tri_khoa) return null;
    try {
      return decryptKey(row.gia_tri_khoa).trim() || null;
    } catch (e) {
      return String(row.gia_tri_khoa).trim() || null;
    }
  } catch (e) { return null; }
}

// Fetch danh sách model từ endpoint
async function fetchModels(providerId, apiKey, endpoint, authType) {
try {
    // OpenCode là CLI local (opencode.exe) — gọi opencode models để lấy danh sách động
    if (providerId === 'opencode') {
      const { spawn } = require('child_process');
      const os = require('os');
      const opencodeBin = process.env.OPENCODE_BIN_PATH || (os.homedir() ? require('path').join(os.homedir(), '.opencode', 'bin', 'opencode.exe') : '');
      const modelsRaw = await new Promise(resolve => {
        let out = '';
        try {
          const proc = spawn(opencodeBin, ['models'], { windowsHide: true, timeout: 20000 });
          const timer = setTimeout(() => { try { proc.kill(); } catch(e){} resolve(''); }, 20000);
          proc.stdout.on('data', d => { out += d.toString(); });
          proc.on('error', () => { clearTimeout(timer); resolve(''); });
          proc.on('close', () => { clearTimeout(timer); resolve(out); });
        } catch(e) { resolve(''); }
      });
      const models = modelsRaw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('/') && l.startsWith('opencode/'));
      if (models.length === 0) return { success: false, error: 'No opencode local models found via CLI' };
      // FIX: 'tiers' khai báo dưới TDZ → opencode scan lỗi 'Cannot access tiers before initialization'
      return { success: true, models, tiers: {} };
    }

    const headers = { 'Accept': 'application/json' };
    if (authType === 'bearer' && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    // Anthropic không dùng Bearer — /v1/models cần x-api-key + anthropic-version
    if (authType === 'anthropic' && apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    let url = endpoint;
    if (authType === 'key' && apiKey) url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };

    const data = await resp.json();
    let rawItems = [];
    if (Array.isArray(data)) rawItems = data;
    else if (Array.isArray(data.data)) rawItems = data.data;
    else if (Array.isArray(data.models)) rawItems = data.models;
    let models = rawItems.map(m => (m && typeof m === 'object' ? (m.id || m.name || m) : m));

    // Filter only string IDs + chuan hoa: Gemini tra ve 'models/xxx' -> strip prefix
    // (de lai la goi API double-prefix + lech key cache/DB).
    models = models.filter(m => typeof m === 'string' && m.length > 0).map(m => m.replace(/^models\//, ''));

    // Tier từ listing (vd xkiro: access_tier = free|paid|premium) — scanner dùng để
    // khỏi đốt call test từng model trả phí (probe 1 cái là đủ, xem scanProvider).
    // Provider không có field này → tiers rỗng → test từng model như cũ.
    const tiers = {};
    for (const m of rawItems) {
      if (!m || typeof m !== 'object') continue;
      const id = m.id || m.name;
      const tier = m.access_tier || m.tier || m.access || null;
      if (typeof id === 'string' && id && typeof tier === 'string' && tier) tiers[id] = tier;
    }

    // OpenRouter: CHỈ quét model :free (giá $0) — vì tài khoản có thể chưa nạp credits,
    // model trả phí sẽ fail 'Insufficient credits' + quét 400 model sẽ đốt hết quota free 50/ngày
    if (providerId === 'openrouter') {
      const before = models.length;
      models = models.filter(m => m.endsWith(':free') || m.includes(':free'));
      if (models.length > 0 && models.length < before) {
        console.log(`[ModelScanner] OpenRouter: lọc ${before} model → chỉ giữ ${models.length} model :free (trả phí bỏ qua)`);
      }
    }

    // Kilo: 401 model, gần như toàn bộ trả phí → chỉ giữ :free + kilo-auto/* (routing).
    // Paid sẽ 402 'Insufficient credits' + đốt call test vô nghĩa.
    if (providerId === 'kilo') {
      const before = models.length;
      models = models.filter(m => m.endsWith(':free') || m.startsWith('kilo-auto/'));
      if (models.length > 0 && models.length < before) {
        console.log(`[ModelScanner] Kilo: lọc ${before} model → chỉ giữ ${models.length} (:free + kilo-auto/*, trả phí bỏ qua)`);
      }
    }

    // FIX: If no models found, check for error messages in response
    if (models.length === 0) {
      const errMsg = data.error || data.message || data.detail || '';
      if (errMsg) return { success: false, error: errMsg };
      return { success: false, error: 'No models returned from API' };
    }

    return { success: true, models, tiers };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// Test health một model cụ thể (quick ping)
async function quickHealthCheck(providerId, apiKey, modelId) {
  const start = Date.now();

  try {
    const CHAT_ENDPOINTS = {
      gemini: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`,
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      mintrouter: 'https://mintrouter.ai/v1/chat/completions',
      nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      cerebras: 'https://api.cerebras.ai/v1/chat/completions',
      cohere: 'https://api.cohere.ai/v2/chat',
      openai: 'https://api.openai.com/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/chat/completions',
      opencode: 'https://opencode.ai/api/v1/chat/completions',
      // github: retirement (410) — xem PROVIDER_ENDPOINTS
      grok: 'https://api.x.ai/v1/chat/completions',
      claude: 'https://api.anthropic.com/v1/messages',
      // xkiro/agentrouter OpenAI-compatible → dùng block generic bên dưới
      xagentrouter: 'https://agentrouter.org/v1/chat/completions',
      bai: 'https://api.b.ai/v1/chat/completions',
      kiosapi: 'https://kiosapi.com/v1/chat/completions',
      unorouter: 'https://api.unorouter.com/v1/chat/completions',
      kilo: 'https://kilo.ai/api/openrouter/chat/completions',
    };

    const endpoint = CHAT_ENDPOINTS[providerId];
    if (!endpoint) return { status: 'working', latency_ms: 1, reason: 'no_test' };

    // Gemini uses a different format
    if (providerId === 'gemini') {
      const cleanModelId = modelId.replace(/^models\//, '');
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(geminiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
        signal: AbortSignal.timeout(12000)
      });
      const latency = Date.now() - start;
      return resp.ok ? { status: 'working', latency_ms: latency } : { status: 'failed', latency_ms: latency, error: `HTTP ${resp.status}` };
    }

    // Cohere uses different format
    if (providerId === 'cohere') {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
        signal: AbortSignal.timeout(12000)
      });
      const latency = Date.now() - start;
      const data = await resp.json().catch(() => ({}));
      return resp.ok ? { status: 'working', latency_ms: latency } : { status: 'failed', latency_ms: latency, error: data.message || `HTTP ${resp.status}` };
    }

    // OpenCode là CLI local — không cần API key, chỉ cần opencode.exe hoạt động
    if (providerId === 'opencode') {
      const { spawn } = require('child_process');
      const os = require('os');
      const opencodeBin = process.env.OPENCODE_BIN_PATH || (os.homedir() ? require('path').join(os.homedir(), '.opencode', 'bin', 'opencode.exe') : '');
      return await new Promise(resolve => {
        let proc;
        try {
          proc = spawn(opencodeBin, ['--version'], { windowsHide: true, timeout: 8000 });
        } catch(e) {
          return resolve({ status: 'failed', latency_ms: Date.now() - start, error: 'opencode.exe not found' });
        }
        const timer = setTimeout(() => { try { proc.kill(); } catch(e){} resolve({ status: 'failed', latency_ms: Date.now() - start, error: 'timeout' }); }, 8000);
        proc.stdout.on('data', () => {});
        proc.on('error', err => { clearTimeout(timer); resolve({ status: 'failed', latency_ms: Date.now() - start, error: err.message }); });
        proc.on('close', code => {
          clearTimeout(timer);
          resolve(code === 0 ? { status: 'working', latency_ms: Date.now() - start } : { status: 'failed', latency_ms: Date.now() - start, error: 'exit ' + code });
        });
      });
    }

    // Claude dùng Messages API riêng (x-api-key, không phải Bearer)
    if (providerId === 'claude') {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(12000)
      });
      const latency = Date.now() - start;
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && (data.content || data.id)) return { status: 'working', latency_ms: latency };
      return { status: 'failed', latency_ms: latency, error: data.error?.message || `HTTP ${resp.status}` };
    }

    // max_tokens hơi rộng tay (50): router mới (b.ai/tencent) nhét reasoning/manifest vào
    // token đầu khiến choices rỗng nếu max_tokens=1.
    // Authorization chỉ gửi khi CÓ key — kilo keyless gửi 'Bearer ' rỗng sẽ 401.
    const healthHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) healthHeaders['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: healthHeaders,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }),
      signal: AbortSignal.timeout(12000)
    });
    const latency = Date.now() - start;
    // new-api style router (kiosapi/bai) nhiều model trả SSE thay vì JSON → parse cả 2 kiểu,
    // có content hoặc choices rỗng nhưng id object hợp lệ vẫn tính là model TỒN TẠI.
    const raw = await resp.text();
    let data = {};
    let content = '';
    try { data = JSON.parse(raw); } catch {
      const line = raw.split('\n').map(l => l.trim()).find(l => l.startsWith('data:') && l.includes('{'));
      if (line) { try { data = JSON.parse(line.slice(5)); } catch {} }
    }
    content = data.choices?.[0]?.message?.content || data.choices?.[0]?.delta?.content || '';
    if (resp.ok && (content.trim() || (Array.isArray(data.choices) && data.choices.length))) return { status: 'working', latency_ms: latency };
    if (resp.ok && data.object === 'chat.completion') return { status: 'working', latency_ms: latency }; // 200 + object hợp lệ, empty choices (reasoning-only) → vẫn alive
    return { status: 'failed', latency_ms: latency, error: (data.error && (data.error.message || data.error)) || raw.slice(0, 120) || `HTTP ${resp.status}` };
  } catch(e) {
    return { status: 'failed', latency_ms: Date.now() - start, error: e.message };
  }
}

// Lưu kết quả quét vào CSDL (bảng đã được tạo bởi init-db khi khởi động)
// trang_thai ∈ working | needs_balance | dead | error | skipped
async function saveScanResult(providerId, modelId, status, latencyMs, errorMsg, fuseUntested = false) {
  try {
    // Fuse (chua test do rate-limit): KHONG ghi de — model working giu nguyen trang thai,
    // model moi chua co row thi khong tao row 'error' (picker hien + luot sau test).
    // Dung lenh y thiet ke: error tam thoi thi "khong dung DB".
    if (fuseUntested) {
      await runSql(`
        INSERT INTO model_scan_cache (ma_model, ma_nha_cung_cap, trang_thai, do_tre_ms, loi_chi_tiet, thoi_gian_quet)
        VALUES (?, ?, ?, ?, ?, ${NOW()})
        ON CONFLICT(ma_model, ma_nha_cung_cap) DO NOTHING
      `, [modelId, providerId, status, latencyMs || 0, errorMsg || null]);
      return;
    }
    await runSql(`
      INSERT INTO model_scan_cache (ma_model, ma_nha_cung_cap, trang_thai, do_tre_ms, loi_chi_tiet, thoi_gian_quet)
      VALUES (?, ?, ?, ?, ?, ${NOW()})
      ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
        trang_thai = excluded.trang_thai,
        do_tre_ms = excluded.do_tre_ms,
        loi_chi_tiet = excluded.loi_chi_tiet,
        thoi_gian_quet = ${NOW()}
    `, [modelId, providerId, status, latencyMs || 0, errorMsg || null]);
  } catch(e) {
    console.error('[ModelScanner] Save error:', e.message);
  }
}

// Lưu log thời gian quét gần nhất của provider
async function saveProviderScanTime(providerId, total = 0, working = 0) {
  try {
    await runSql(`
      INSERT INTO provider_scan_log (ma_nha_cung_cap, lan_quet_cuoi, tong_model, model_hoat_dong)
      VALUES (?, ${NOW()}, ?, ?)
      ON CONFLICT(ma_nha_cung_cap) DO UPDATE SET
        lan_quet_cuoi = ${NOW()},
        tong_model = excluded.tong_model,
        model_hoat_dong = excluded.model_hoat_dong
    `, [providerId, total, working]);
  } catch(e) {}
}

// Phân loại lý do khi lượt quét ra 0 model working — để Admin hiển thị rõ cho người dùng
function classifyZeroWorkingReason(results) {
  if (!results || results.length === 0) return 'Không có model nào để kiểm tra';
  const errs = results.map(r => String(r.error || '').toLowerCase());
  const allFailed = results.every(r => r.status === 'failed');
  if (allFailed) {
    // Chịu đựng lỗi hỗn hợp: nếu ≥1 nửa số lỗi là rate-limit → kết luận rate-limit
    const rateLimitedCount = errs.filter(e => e.includes('429') || e.includes('rate limit') || e.includes('quota')).length;
    if (rateLimitedCount >= Math.ceil(errs.length / 2)) {
      return 'Rate limit (429) — hết quota free, chờ reset hoặc nạp credits';
    }
    if (errs.some(e => e.includes('401') || e.includes('403') || e.includes('unauthorized') || e.includes('invalid') || e.includes('forbidden'))) {
      return 'API key bị từ chối (401/403) — kiểm tra lại key';
    }
  }
  return 'Không model nào trả lời được (provider đang lỗi / hết hạn)';
}

// Phân loại kết quả health-check thành bucket để Smart Reset xử lý đúng:
// - working: gọi thật được → active trong picker
// - needs_balance: model TỒN TẠI upstream nhưng key hiện tại thiếu tiền/quyền (403-balance/402/paid)
//   → GIỮ trong picker, gắn cờ paid (xóa đi là mất oan, user nạp tiền là dùng được)
// - dead: upstream báo không tồn tại (404/does-not-exist) → tắt (giữ row, kich_hoat=0)
// - error: rate-limit/5xx/timeout/key hỏng → TẠM THỜI, không đụng DB (đụng vào là mất oan)
function classifyHealth(health) {
  if (!health || health.status === 'working') return 'working';
  const e = String(health.error || '').toLowerCase();
  // 429/rate-limit trước tiên (kể cả message chứa chữ quota/balance mà là 429 → tạm thời)
  if (/(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests/.test(e)) return 'error';
  // Key hỏng (401/invalid key) mà KHÔNG nhắc tiền → lỗi key, không đụng model
  if (/(401|unauthorized|invalid.*(key|api)|incorrect.*key|authentication failed)/.test(e)
      && !/(balance|billing|payment|deposited|paid|subscribe|credit|quota)/.test(e)) return 'error';
  // Model không tồn tại upstream → chết thật
  if (/(^|[^0-9])404([^0-9]|$)|not found|does not exist|no such (model|deployment)|model_not_found|invalid model/.test(e)) return 'dead';
  // Tồn tại nhưng đòi nạp tiền/quyền
  if (/(^|[^0-9])402([^0-9]|$)|payment|billing|balance|deposit|paid plan|paying customers|subscribe|insufficient|available on the.*(ultra|pro|premium|plan)|requires an? active|upgrade|premium models/.test(e)) return 'needs_balance';
  return 'error';
}

// Quét toàn bộ một provider
// Phân loại modality theo tên model. chat = test thật; image/tts/stt/embed = đăng ký catalog,
// không gọi chat probe (gọi sai endpoint vừa waste quota vừa fail oan).
function modalityOf(modelId) {
  const m = String(modelId).toLowerCase();
  if (/embed|rerank|\bbge-|e5-|multilingual-gemma2|retrieval|balingua/.test(m)) return 'embed';
  if (/(sdxl|-xl|xl-|pony|dreamshaper|\bshaper\b|animerge|absolutereality|cyberrealistic|anything-v\d|nsfw|illustrious|furry|\bdeliberate\b|flat-2d|icbinp|autismmix|swamp|ampony|tunix|wai-|prefect|midjourney|stable-diffusion|seedream|dall|imagen-|\bimage|\bflux\b|cute-|realistic|mix-v\d|-flax|diffusionmodel)/.test(m)) return 'image';
  if (/whisper|transcribe|-asr\b|speech-to-text|voxtral|audio-input|audio\.in/.test(m)) return 'stt';
  if (/(^|-|\b)tts(\b|-|$)|kokoro|speech-\d|piper|bark|elevenlabs|\bvoice\b|talking/.test(m)) return 'tts';
  return 'chat';
}

function isKnownAgentCapable(modelId) {
  const m = String(modelId).toLowerCase();
  if (m.includes('gpt-4') || m.includes('gpt-3.5-turbo')) return true;
  if (m.includes('claude-3') || m.includes('claude-3.5') || m.includes('claude-3.7') || m.includes('claude-4')) return true;
  if (m.includes('gemini-1.5') || m.includes('gemini-2') || m.includes('gemini-2.5')) return true;
  if (m.includes('mistral-large') || m.includes('mistral-medium') || m.includes('mistral-small')) return true;
  if (m.includes('command-r') || m.includes('command-a')) return true;
  if (m.includes('llama-3.1') || m.includes('llama-3.2') || m.includes('llama-3.3') || m.includes('llama-4')) return true;
  if (m.includes('nemotron') || m.includes('nemotron-3')) return true;
  if (m.includes('deepseek-v3') || m.includes('deepseek-v4') || m.includes('deepseek-r1')) return true;
  if (m.includes('qwen-2.5') || m.includes('qwen-3') || m.includes('qwen2.5') || m.includes('qwen3')) return true;
  if (m.includes('yi-1.5') || m.includes('yi-34b') || m.includes('yi-large')) return true;
  if (m.includes('glm-4') || m.includes('glm-4.5') || m.includes('glm-5')) return true;
  if (m.includes('kimi') || m.includes('moonshot') || m.includes('muse') || m.includes('laguna')) return true;
  if (m.includes('doubao') || m.includes('deepseek-coder')) return true;
  return false;
}

// Dem fetch-fail lien tiep theo provider (luu app_settings, khoi migration DB).
// Fetch fail 3 lan lien tiep -> model khong kiem chung duoc -> TAT (song lai tu bat).
async function getFailCount(providerId) {
  try {
    const row = await getRow('SELECT gia_tri FROM app_settings WHERE khoa = ?', ['scan_fail_' + providerId]);
    const n = row ? parseInt(row.gia_tri, 10) : 0;
    return isNaN(n) ? 0 : n;
  } catch { return 0; }
}
async function setFailCount(providerId, n) {
  try {
    if (n <= 0) { await runSql('DELETE FROM app_settings WHERE khoa = ?', ['scan_fail_' + providerId]); return; }
    await runSql(`INSERT INTO app_settings (khoa, gia_tri) VALUES (?, ?)
      ON CONFLICT(khoa) DO UPDATE SET gia_tri = excluded.gia_tri`, ['scan_fail_' + providerId, String(n)]);
  } catch { /* ignore */ }
}

// Agent-capability probe: model co tra JSON ReAct dung format khong.
// Dung de picker Agent Mode chi hien model that su chay duoc agent (thay vi doan mo).
async function probeAgentJson(providerId, apiKey, modelId) {
  const sys = 'You are a test harness. Reply with EXACTLY one JSON object and nothing else.';
  const usr = 'Reply {"thought":"probe","answer":"ok"}';
  try {
    let url, headers = { 'Content-Type': 'application/json' }, payload;
    if (providerId === 'gemini') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
      payload = { contents: [{ role: 'user', parts: [{ text: sys + '\n' + usr }] }], generationConfig: { maxOutputTokens: 120, temperature: 0 } };
    } else if (providerId === 'claude') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      payload = { model: modelId, max_tokens: 120, temperature: 0, system: sys, messages: [{ role: 'user', content: usr }] };
    } else {
      const cfg = PROVIDER_ENDPOINTS[providerId];
      if (!cfg || !cfg.endpoint) return { ok: false };
      url = cfg.endpoint.replace(/\/models\/?$/, '') + '/chat/completions';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      payload = { model: modelId, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0, max_tokens: 120 };
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    if (res.status === 429) return { ok: false, rateLimited: true };
    if (!res.ok) return { ok: false };
    const j = await res.json().catch(() => null);
    let text = '';
    if (providerId === 'gemini') {
      text = ((((j || {}).candidates || [])[0] || {}).content?.parts || []).map(p => p.text || '').join('');
    } else if (providerId === 'claude') {
      text = (((j || {}).content || []).map(b => b.text || '').join('')) || '';
    } else {
      text = (j && j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) || '';
    }
    const obj = extractAgentJson(String(text || ''));
    if (obj && typeof obj === 'object' && ('answer' in obj || 'tool' in obj)) return { ok: true };
    return { ok: false };
  } catch (e) {
    if (/429|rate.?limit/i.test(e.message || '')) return { ok: false, rateLimited: true };
    return { ok: false };
  }
}

// Trich JSON object dau tien (ban gon, khong require internalAgent de tranh vong tron)
function extractAgentJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fence ? fence[1] : s;
  const start = cand.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cand.length; i++) {
    const ch = cand[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(cand.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

async function scanProvider(providerId) {
  const cfg = PROVIDER_ENDPOINTS[providerId];
  if (!cfg) return { success: false, error: 'Unknown provider' };

  let apiKey = await getKeyForProvider(providerId);
  if (!apiKey && !['opencode', 'kilo'].includes(providerId)) {
    return { success: false, error: 'No API key configured', skipped: true };
  }
  // kilo keyless: giữ chuỗi rỗng → mọi request KHÔNG gửi Authorization (gửi 'Bearer free_key' sẽ 401).
  // opencode đi CLI riêng không tới đây.
  if (!apiKey && providerId !== 'kilo') apiKey = 'free_key';

  console.log(`[ModelScanner] Scanning ${cfg.name}...`);

  // ⏱️ Ghi thời điểm thử quét NGAY từ đầu (kể cả fetch fail) để cooldown startup áp dụng cho mọi provider
  await saveProviderScanTime(providerId, 0, 0);

  let { success, models, tiers, error } = await fetchModels(providerId, apiKey, cfg.endpoint, cfg.auth);
  if (!success) {
    console.error(`[ModelScanner] ${cfg.name} fetch failed: ${error}`);
    const fails = await getFailCount(providerId) + 1;
    await setFailCount(providerId, fails);
    if (fails >= 3) {
      const n = await runSql('UPDATE ai_models SET kich_hoat = 0 WHERE ma_nha_cung_cap = ? AND kich_hoat <> 0', [providerId]);
      if (n) console.log(`[ModelScanner] ${cfg.name}: fetch fail ${fails} lan lien tiep -> tat ${n} model khong kiem chung duoc (endpoint/key song lai se tu bat)`);
    }
    return { success: false, error };
  }
  await setFailCount(providerId, 0);
  tiers = tiers || {};

  // Tier-aware (đọc từ listing, khỏi đốt call): free → lấy thẳng (không test);
  // paid/premium → probe đúng 1 cái (đủ tiền thì test tiếp, thiếu thì gắn cờ cả đám);
  // không có tier → test từng cái như cũ.
  // REXI_FULL_TEST=1 → TIN KEY Fakta hơn TIN LABEL: test thật MỌI model 1 lượt
  // (tier upstream có thể nói láo — xkiro: model "free" 403, model "paid" chạy được).
  const FULL_TEST = process.env.REXI_FULL_TEST === '1';
  const tierOf = (id) => String((tiers && tiers[id]) || '').toLowerCase();
  const isFreeTier = (id) => !FULL_TEST && tierOf(id) === 'free';
  const isPaidTier = (id) => !FULL_TEST && /^(premium|paid)$/.test(tierOf(id));
  let paidProbe = null; // null=chưa probe, true=key đủ tiền, false=thiếu tiền
  let tierSavedCalls = 0;

  if (models.length === 0) {
    console.error(`[ModelScanner] ${cfg.name}: no models returned`);
    return { success: false, error: 'No models returned from API', provider: providerId };
  }

  console.log(`[ModelScanner] ${cfg.name}: ${models.length} models found. Optimizing scan...`);

  // Giữ nguyên live list upstream (trước mọi filter) để Smart Reset so sánh model biến mất
  const models_all = [...models];

  // ─── TỐI UU HÓA 1: Filter model không phải chat ──────────────
  const SKIP_PATTERNS = [];  // deprecated: chuyển sang modalityOf() — non-chat giờ đăng ký catalog thay vì lọc bỏ
  const nonChatModels = [];
  const chatModels = [];
  for (const m of models) (modalityOf(m) === 'chat' ? chatModels : nonChatModels).push(m);
  models = chatModels;
  if (nonChatModels.length > 0) {
    console.log(`[ModelScanner] ${cfg.name}: ${nonChatModels.length} non-chat models (image/tts/stt/embed) -> catalog only, khong health-test`);
  }

  // ─── TỐI UU HOA 2: Skip model đã test gần đây ───────────────
  const results = [];   // khai báo sớm để cả 2 luồng (skip + health test) cùng dùng
  let skipCount = 0;
  const needsTestFirst = new Set();  // model chua co row test that -> uu tien test truoc (model moi len dau)
  for (const m of nonChatModels) {
    try { await saveScanResult(providerId, m, 'skipped', 0, `modality:${modalityOf(m)}`); } catch { /* ignore */ }
    results.push({ id: m, status: 'skipped', latency_ms: 0, reason: 'non_chat', tested: false, modality: modalityOf(m), tier: tierOf(m) || null });
  }
  try {
    const recent = await allRows(`
      SELECT ma_model, trang_thai, thoi_gian_quet
      FROM model_scan_cache WHERE ma_nha_cung_cap = ?
    `, [providerId]);

    const now = Date.now();
    const WORKING_TTL = 24 * 60 * 60 * 1000;  // 24h — working model giữ nguyên
    const FAILED_TTL = 6 * 60 * 60 * 1000;    // 6h — failed model bỏ qua, không retry sớm
    const recentMap = new Map();
    for (const row of recent) {
      recentMap.set(row.ma_model, { status: row.trang_thai, time: toTimeMs(row.thoi_gian_quet) });
    }

    const modelsToKeep = [];
    const skippedModels = [];  // track models skipped vì vừa test xong
    for (const m of models) {
      const prev = recentMap.get(m);
      if (!prev || FULL_TEST) { needsTestFirst.add(m); modelsToKeep.push(m); continue; }  // chưa test (hoặc full-test) → cần test
      const age = now - prev.time;
      if (prev.status === 'working' && age < WORKING_TTL) { skippedModels.push(m); continue; } // working 24h → skip
      if (prev.status === 'failed' && age < FAILED_TTL) { skipCount++; continue; }    // failed 6h → skip
      modelsToKeep.push(m);  // hết TTL → test lại
    }
    models = modelsToKeep;

    // Lưu skipped models (vừa test < 24h, đang working) để giữ lại trong DB
    if (skippedModels.length > 0) {
      for (const m of skippedModels) {
        results.push({ id: m, status: 'working', latency_ms: 0, skipped: true });
      }
      console.log(`[ModelScanner] ${cfg.name}: preserved ${skippedModels.length} recently-working models`);
    }
  } catch { /* ignore — scan bình thường nếu DB fail */ }
  if (skipCount > 0) {
    console.log(`[ModelScanner] ${cfg.name}: skipped ${skipCount} recently tested → ${models.length} to scan`);
  }

  // Ưu tiên: MODEL MỚI/CHƯA TEST trước (quet phai dung duoc — test pass moi active);
  // rồi tier free trước, paid sau cùng (probe 1 cái là đủ); rồi mới tới keyword cũ
  const priorityKeywords = ['mini', 'free', 'flash', '70b', 'small', 'lite'];
  models.sort((a, b) => {
    const aNew = needsTestFirst.has(a) ? 0 : 1, bNew = needsTestFirst.has(b) ? 0 : 1;
    if (aNew !== bNew) return aNew - bNew;
    const aPaid = isPaidTier(a) ? 1 : 0, bPaid = isPaidTier(b) ? 1 : 0;
    if (aPaid !== bPaid) return aPaid - bPaid;
    const aPri = priorityKeywords.some(kw => a.toLowerCase().includes(kw));
    const bPri = priorityKeywords.some(kw => b.toLowerCase().includes(kw));
    if (aPri && !bPri) return -1;
    if (!aPri && bPri) return 1;
    return 0;
  });

  // ─── Test health: batch 8, early exit khi provider ổn định ────
  const BATCH = 8;
  const BATCH_DELAY_MS = 600;
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
  const EARLY_SUCCESS_THRESHOLD = 12; // 12 model liên tiếp working → provider ổn, bỏ qua phần còn lại

  // SMART PACING 429: rate-limit per-minute/per-second (Gemini "HTTP 429", Mistral "1300")
  // → backoff rồi quét tiếp, delay batch tăng dần — nạp ĐẦY ĐỦ model thay vì fuse sớm.
  // Per-day (OpenRouter "free-models-per-day", MinRouter "daily free quota resets at...")
  // → fuse cứng như cũ: backoff vô nghĩa, chờ quota ngày reset.
  const RATE_LIMIT_RE = /429|rate.?limit|too many requests/i;
  const DAILY_QUOTA_RE = /per[-_ ]?day|free-models-per-day|daily free quota|resets at \d{4}-\d{2}-\d{2}/i;
  const RATE_BACKOFF_MS = 45 * 1000;
  const MAX_RATE_BACKOFFS = 4;   // tối đa ~3 phút chờ/provider, lố thì fuse như cũ
  let rateBackoffs = 0;
  let batchDelay = BATCH_DELAY_MS;

  let quotaFuse = false;
  for (let i = 0; i < models.length; i += BATCH) {
    const batch = models.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async modelId => {
      // FUSE 429: provider đã báo hết quota/rate-limit → không đốt thêm call, chờ lượt sau
      if (quotaFuse) {
        const err = 'Chưa test lượt này — provider hết quota/rate-limit (fuse)';
        await saveScanResult(providerId, modelId, 'error', 0, err, true);
        return { id: modelId, status: 'failed', bucket: 'error', latency_ms: 0, error: err, tested: false, tier: tierOf(modelId) || null };
      }
      // TRUST-CATALOG (vd unorouter): free tier 1 req/phút TOÀN ACCOUNT → health-check
      // hàng loạt = tất yếu 429 không có ý nghĩa gì về model availability. Đăng ký theo
      // nhãn :free — model không có ':free' → needs_balance (chờ key có tiền / hết throttle).
      if (cfg.trustCatalog) {
        if ((modelId.endsWith(':free') || modelId.includes(':free'))) {
          await saveScanResult(providerId, modelId, 'working', 0, null);
          return { id: modelId, status: 'working', bucket: 'working', latency_ms: 0, error: null, tested: false, tier: 'free' };
        }
        const err = 'Không có nhãn :free — chỉ dùng được khi trả phí hoặc account đã nâng cấp tier';
        await saveScanResult(providerId, modelId, 'needs_balance', 0, err);
        return { id: modelId, status: 'failed', bucket: 'needs_balance', latency_ms: 0, error: err, tested: false, tier: null };
      }
      // TIER-FREE: upstream có thể nói láo tier (xkiro: glm-5.3-flash "free" nhưng 403
      // đòi paid plan) → vẫn test THẬT 1 lần; cache TTL 24h nên model free đã confirm
      // không bị đốt call lại ở các lượt quét sau.
      if (isFreeTier(modelId)) {
        const health = await quickHealthCheck(providerId, apiKey, modelId);
        const bucket = classifyHealth(health);
        await saveScanResult(providerId, modelId, bucket, health.latency_ms, health.error, RATE_LIMIT_RE.test(String(health.error || '')));
        return { id: modelId, ...health, bucket, tested: true, tier: 'free' };
      }
      // TIER-PAID mà probe đã kết luận thiếu tiền → gắn cờ thẳng, không call
      if (isPaidTier(modelId) && paidProbe === false) {
        tierSavedCalls++;
        const err = 'Model trả phí — key thiếu tiền (kết luận từ probe, không đốt call test)';
        await saveScanResult(providerId, modelId, 'needs_balance', 0, err);
        return { id: modelId, status: 'failed', bucket: 'needs_balance', latency_ms: 0, error: err, tested: false, tier: tierOf(modelId) };
      }
      const health = await quickHealthCheck(providerId, apiKey, modelId);
      const bucket = classifyHealth(health);
      await saveScanResult(providerId, modelId, bucket, health.latency_ms, health.error);
      const out = { id: modelId, ...health, bucket, tested: true, tier: tierOf(modelId) || null };
      // Probe: model paid đầu tiên cho biết key có đủ tiền không
      if (isPaidTier(modelId) && paidProbe === null) {
        if (health.status === 'working') {
          paidProbe = true;
          console.log(`[ModelScanner] ${cfg.name}: probe paid OK (${modelId}) — key đủ tiền, test tiếp các model paid`);
        } else {
          const e = String(health.error || '').toLowerCase();
          if (/balance|billing|payment|deposited|paid plan|paying customers|subscribe|(^|[^0-9])402([^0-9]|$)/.test(e)) {
            paidProbe = false;
            console.log(`[ModelScanner] ${cfg.name}: probe paid FAIL thiếu tiền (${modelId}) — gắn cờ paid còn lại, không test`);
          }
        }
      }
      return out;
    }));
    results.push(...batchResults);

    // Fuse/PACING 429: batch có ≥2 model TESTED thật fail vì rate-limit
    const rateResults = batchResults.filter(r => r.tested && RATE_LIMIT_RE.test(r.error || ''));
    if (rateResults.length >= 2 && !quotaFuse) {
      const isDailyQuota = rateResults.some(r => DAILY_QUOTA_RE.test(r.error || ''));
      if (!isDailyQuota && rateBackoffs < MAX_RATE_BACKOFFS) {
        rateBackoffs++;
        batchDelay = Math.min(Math.max(batchDelay * 4, 3000), 15000);
        console.log(`[ModelScanner] ${cfg.name}: ${rateResults.length} model 429 per-minute/second — backoff ${RATE_BACKOFF_MS / 1000}s, delay batch ${batchDelay}ms, quét tiếp (${rateBackoffs}/${MAX_RATE_BACKOFFS})`);
        await new Promise(r => setTimeout(r, RATE_BACKOFF_MS));
        consecutiveFailures = 0;  // 429 không phải lỗi thật, không cộng chuỗi fail
        continue;  // batch kế; model 429 vừa rồi không ghi DB (giữ trạng thái cũ)
      }
      quotaFuse = true;
      const rest = models.slice(i + BATCH);
      console.log(`[ModelScanner] ${cfg.name}: ${rateResults.length} model 429${isDailyQuota ? ' (hết quota NGÀY)' : ''} — FUSE, dừng gọi API (${rest.length} model giữ nguyên DB, lượt sau quét tiếp)`);
      for (const m of rest) {
        const err = 'Chưa test lượt này — provider hết quota/rate-limit (fuse)';
        await saveScanResult(providerId, m, 'error', 0, err, true);
        results.push({ id: m, status: 'failed', bucket: 'error', latency_ms: 0, error: err, tested: false, tier: tierOf(m) || null });
      }
      break;
    }

    // Early bail-out: batch đầu TESTED toàn fail auth → key invalid (chỉ xét model đã test thật).
    // CHU Y: 'Invalid model'/'no such model' la MODEL chet (se phan loai dead), KHONG phai key hong
    // nen loai khoi dieu kien — keo ca provider bi abort oan nhu vu mistral-ocr.
    const testedResults = batchResults.filter(r => r.tested);
    const batchFailed = testedResults.filter(r => r.status === 'failed').length;
    const hasAuthError = testedResults.some(r => {
      const e = (r.error || '').toLowerCase();
      if (/no such (model|deployment)|invalid model|model_not_found|does not exist/.test(e)) return false;
      return e.includes('401') || e.includes('unauthorized') || /invalid (api )?key|incorrect.*key|authentication failed/.test(e);
    });
    const allFailed = testedResults.length > 0 && batchFailed === testedResults.length;
    consecutiveFailures = allFailed && hasAuthError ? consecutiveFailures + batch.length : (allFailed ? consecutiveFailures : 0);
    if (i === 0 && consecutiveFailures >= batch.length) {
      console.log(`[ModelScanner] ${cfg.name}: first batch all auth errors — key invalid, stopping`);
      break;
    }

    // Early success: nếu 12+ model liên tiếp working → provider ổn, bỏ qua phần còn lại
    // (chỉ khi KHÔNG full-test; full-test phải test hết để tìm model paid dùng được thật)
    const batchSuccesses = batchResults.filter(r => r.status === 'working').length;
    consecutiveSuccesses = batchSuccesses > 0 ? consecutiveSuccesses + batchSuccesses : 0;
    if (!FULL_TEST && !cfg.trustCatalog && consecutiveSuccesses >= EARLY_SUCCESS_THRESHOLD && i + BATCH < models.length) {
      console.log(`[ModelScanner] ${cfg.name}: ${consecutiveSuccesses} consecutive working — provider healthy, skipping remaining ${models.length - i - BATCH} models`);
      // Mark skipped models as "skipped" (không gọi API)
      const skipped = models.slice(i + BATCH);
      for (const m of skipped) {
        await saveScanResult(providerId, m, 'skipped', 0, 'provider_healthy');
        results.push({ id: m, status: 'skipped', latency_ms: 0, reason: 'provider_healthy', tested: false, tier: tierOf(m) || null });
      }
      break;
    }

    // Pacing (delay tăng dần khi gặp rate-limit)
    if (i + BATCH < models.length) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  const workingList = results.filter(r => r.status === 'working');
  const working = workingList.length;
  const paidList = results.filter(r => r.bucket === 'needs_balance');
  const deadList = results.filter(r => r.bucket === 'dead');

  // Only save scan time if we actually tested models (lưu kèm tổng + số working vào provider_scan_log)
  if (results.length > 0) {
    await saveProviderScanTime(providerId, results.length, working);
  }

  console.log(`[ModelScanner] ${cfg.name}: ${working} working / ${paidList.length} needs_balance / ${deadList.length} dead / ${results.length} total (tiết kiệm ${tierSavedCalls} call nhờ tier)`);

  // 🔄 SMART RESET (v2 — không DELETE-all nữa):
  // - working → upsert active (kiểm chứng gọi thật được)
  // - needs_balance → upsert active, loai='paid' (tồn tại upstream, nạp tiền là dùng)
  // - dead (404 upstream) → kich_hoat=0, GIỮ row (không xóa trắng)
  // - error/skipped (rate-limit/5xx/timeout/chưa test) → KHÔNG ĐỤNG (đụng là mất oan)
  // - model trong DB nhưng đã biến mất khỏi live list upstream → kich_hoat=0
  // - 0 working NHƯNG có paid/dead (key/balance lỗi, không phải mạng chết) → vẫn áp dụng
  //   phân loại trên; chỉ GIỮ NGUYÊN khi toàn bộ là error/transient.
  let keptOld = false;
  let keptOldReason = '';
  let newWorkingIds = [];
  const hasSignal = working > 0 || paidList.length > 0 || deadList.length > 0;
  if (hasSignal) {
    try {
      const liveSet = new Set(models_all.map(String));
      const existingRows = await allRows('SELECT ma_model FROM ai_models WHERE ma_nha_cung_cap = ?', [providerId]);
      const existingSet = new Set((existingRows || []).map(r => String(r.ma_model)));
      const guessType = (modelId) => {
        const m = String(modelId);
        if (m.includes('pro') || m.includes('gpt-4') || m.includes('opus') || m.includes('sonnet') || m.includes('paid')) return 'pro';
        return 'free';
      };
      await db.withTransaction(async (tx) => {
        // Dam bao provider row ton tai (MinRouter tung FK-fail vi thieu row) truoc khi upsert models
        await tx.run(`INSERT INTO ai_providers (ma_nha_cung_cap, ten_hien_thi, kich_hoat) VALUES (?, ?, 1) ON CONFLICT(ma_nha_cung_cap) DO NOTHING`, [providerId, cfg.name]);
        const upsert = (modelId, loai) => {
          const displayName = modelId.includes('/') ? modelId.split('/').pop() : modelId;
          return tx.run(
            `INSERT INTO ai_models (ma_model, ma_nha_cung_cap, ten_hien_thi, loai, modality, thu_tu_hien_thi, kich_hoat)
             VALUES (?, ?, ?, ?, ?, 0, 1)
             ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET ten_hien_thi = excluded.ten_hien_thi, loai = excluded.loai, modality = excluded.modality, kich_hoat = 1`,
            [modelId, providerId, displayName, loai, modalityOf(modelId)]
          );
        };
        for (const m of workingList) await upsert(m.id, guessType(m.id));
        for (const m of paidList) await upsert(m.id, 'paid');
        for (const m of deadList) {
          await tx.run('UPDATE ai_models SET kich_hoat = 0 WHERE ma_model = ? AND ma_nha_cung_cap = ?', [m.id, providerId]);
        }
        // Model trong DB nhưng đã biến khỏi live list upstream → tắt (giữ row)
        for (const oldId of existingSet) {
          if (!liveSet.has(oldId)) {
            await tx.run('UPDATE ai_models SET kich_hoat = 0 WHERE ma_model = ? AND ma_nha_cung_cap = ?', [oldId, providerId]);
          }
        }
        // Chua test that thi KHONG active (tieu chi: model quet phai dung duoc) — model
        // moi cho den khi health-test pass o luot nay hoac luot sau. Row cu giu nguyen.
        newWorkingIds = workingList.filter(m => !existingSet.has(String(m.id))).map(m => String(m.id));
        if (newWorkingIds.length) console.log(`[ModelScanner] ${cfg.name} MODEL MOI DUNG DUOC: ${newWorkingIds.join(', ')}`);
      });
      console.log(`[ModelScanner] ${cfg.name}: upsert xong (working ${workingList.length}, paid ${paidList.length}, dead-tắt ${deadList.length})`);
    } catch (repErr) {
      console.error(`[ModelScanner] ${cfg.name} replace models error:`, repErr.message);
    }
  } else {
    keptOld = true;
    keptOldReason = classifyZeroWorkingReason(results);
    console.warn(`[ModelScanner] ${cfg.name}: toàn bộ lỗi tạm thời — giữ nguyên model cũ. Lý do: ${keptOldReason}`);
}

  // �"?�"?�"? AGENT-CAP PROBE: working model nao tra JSON ReAct dung format -> agent_ok=1.
  // Picker Agent Mode chi hien model co flag (thay vi doan mo). TTL 30d, cap 8/provider/luot,
  // dung ngay khi fuse/429, model chua probe bao gio test truoc. Bo qua neu health phase da fuse.
  try {
    if (!quotaFuse) {
      const AGENT_TTL = 30 * 24 * 3600 * 1000, AGENT_CAP = 20;
      const probed = await allRows('SELECT ma_model, thoi_gian_test FROM model_agent_cap WHERE ma_nha_cung_cap = ?', [providerId]);
      const probedMap = new Map((probed || []).map(r => [String(r.ma_model), toTimeMs(r.thoi_gian_test)]));
      const now2 = Date.now();
      const cands = workingList
        .map(m => String(m.id))
        .filter(id => { const t = probedMap.get(id); return t === undefined || isNaN(t) || (now2 - t) > AGENT_TTL; });
      // Pre-mark known agent-capable models (tool-calling families) without API probe
      const knownAgentOk = [];
      const needProbe = [];
      for (const id of cands) {
        if (isKnownAgentCapable(id)) {
          knownAgentOk.push(id);
        } else {
          needProbe.push(id);
        }
      }
      if (knownAgentOk.length) {
        await runSql(`INSERT INTO model_agent_cap (ma_model, ma_nha_cung_cap, agent_ok, thoi_gian_test)
          VALUES ${knownAgentOk.map(() => '(?, ?, 1, ' + NOW() + ')').join(', ')}
          ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET agent_ok = excluded.agent_ok, thoi_gian_test = ${NOW()}`,
          knownAgentOk.flatMap(id => [id, providerId]));
        console.log(`[ModelScanner] ${cfg.name} AGENT-OK (static): ${knownAgentOk.join(', ')}`);
      }
      // Model agent mac dinh (AGENT_MODEL) probe TRUOC TIEN �?" dam bao con agent that su
      // dung luon co flag som, khong cho doi sau hang doi throttle.
      const agentPrio = process.env.AGENT_MODEL || 'deepseek-v4-flash:free';
      const isPrio = (id) => id === agentPrio || id.endsWith('/' + agentPrio);
      needProbe.sort((a, b) => ((isPrio(b) ? 0 : 1) - (isPrio(a) ? 0 : 1)) || ((probedMap.has(a) ? 1 : 0) - (probedMap.has(b) ? 1 : 0)));
      let done = 0;
      for (const id of needProbe) {
        if (done >= AGENT_CAP) { console.log(`[ModelScanner] ${cfg.name}: agent-probe ${done}/${needProbe.length} (con lai luot sau)`); break; }
        const r = await probeAgentJson(providerId, apiKey, id);
        await runSql(`INSERT INTO model_agent_cap (ma_model, ma_nha_cung_cap, agent_ok, thoi_gian_test)
          VALUES (?, ?, ?, ${NOW()})
          ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET agent_ok = excluded.agent_ok, thoi_gian_test = ${NOW()}`,
          [id, providerId, r.ok ? 1 : 0]);
        if (r.ok) console.log(`[ModelScanner] ${cfg.name} AGENT-OK: ${id}`);
        done++;
        if (r.rateLimited) { console.log(`[ModelScanner] ${cfg.name}: agent-probe 429 -> dung, luot sau tiep`); break; }
      }
    }
  } catch (e) { console.error('[ModelScanner] agent-probe error:', e.message); }

  return { success: true, provider: providerId, total: results.length, working, results, keptOld, keptOldReason, newModels: newWorkingIds };
}

// Quét tất cả providers tuần tự
async function scanAllProviders() {
  console.log('[ModelScanner] Starting full scan of all providers...');
  const summary = [];
  for (const providerId of Object.keys(PROVIDER_ENDPOINTS)) {
    try {
      const result = await scanProvider(providerId);
      summary.push({ providerId, ...result });
    } catch(e) {
      console.error(`[ModelScanner] Error scanning ${providerId}:`, e.message);
      summary.push({ providerId, success: false, error: e.message });
    }
  }
  console.log('[ModelScanner] Full scan complete.');

  // Notify connected frontends via SSE
  const working = summary.reduce((a, s) => a + (s.working || 0), 0);
  const total = summary.reduce((a, s) => a + (s.total || 0), 0);
  const newModels = summary.flatMap(s => (s.newModels || []).map(id => s.providerId + '/' + id));
  if (newModels.length) console.log(`[ModelScanner] MODEL MOI DUNG DUOC (full): ${newModels.join(', ')}`);
  if (typeof global !== 'undefined' && global.__modelScanComplete) {
    global.__modelScanComplete({ working, total, providers: summary.length, newModels });
  }

  return summary;
}

// Dọn "model ma": model của provider không còn key thì không thể hoạt động → xóa sạch
async function cleanupStaleModels(providerId) {
  try {
    const del1 = await runSql('DELETE FROM ai_models WHERE ma_nha_cung_cap = ?', [providerId]);
    const del2 = await runSql('DELETE FROM model_scan_cache WHERE ma_nha_cung_cap = ?', [providerId]);
    if (del1 || del2) {
      console.log(`[ModelScanner] Đã dọn model ma của provider '${providerId}' (không còn key)`);
    }
  } catch(e) { /* ignore */ }
}

// ⏱️ Cooldown quét khi khởi động server: nếu provider vừa được quét trong khoảng thời gian này
// (mặc định 6h) thì bỏ qua — tránh đốt quota free + không làm gián đoạn người dùng khi restart.
const STARTUP_SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Kiểm tra provider có được quét gần đây chưa (dựa trên provider_scan_log)
async function wasRecentlyScanned(providerId, cooldownMs) {
  try {
    const row = await getRow('SELECT lan_quet_cuoi, tong_model FROM provider_scan_log WHERE ma_nha_cung_cap = ?', [providerId]);
    if (!row || !row.lan_quet_cuoi) return false;
    if (!row.tong_model) return false;  // lan truoc fetch fail (0 model) -> cho retry, khong tinh cooldown
    const last = toTimeMs(row.lan_quet_cuoi);
    if (isNaN(last)) return false;
    return (Date.now() - last) < cooldownMs;
  } catch (e) { return false; }
}

// Quét khi server khởi động — chỉ scan provider có key, bỏ qua provider không có key
async function scanOnStartup() {
  console.log('[ModelScanner] Startup scan: checking providers with keys...');
  const summary = [];
  for (const providerId of Object.keys(PROVIDER_ENDPOINTS)) {
    const apiKey = await getKeyForProvider(providerId);
    // Bỏ qua provider KHÔNG có key, TRỪ các provider không cần key (local CLI / keyless gateway)
    if (!apiKey && !['opencode', 'kilo'].includes(providerId)) {
      await cleanupStaleModels(providerId); // provider không có key → dọn model ma cũ của họ
      continue;
    }
    // ⏱️ Cooldown: provider vừa quét < 6h trước → bỏ qua (không đốt quota, không làm phiền người dùng)
    if (await wasRecentlyScanned(providerId, STARTUP_SCAN_COOLDOWN_MS)) {
      console.log(`[ModelScanner] Startup: bỏ qua ${providerId} — đã quét gần đây (cooldown 6h)`);
      continue;
    }
    try {
      const result = await scanProvider(providerId);
      summary.push({ providerId, ...result });
    } catch(e) {
      console.error(`[ModelScanner] Startup scan error ${providerId}:`, e.message);
    }
  }
  const working = summary.reduce((a, s) => a + (s.working || 0), 0);
  const total = summary.reduce((a, s) => a + (s.total || 0), 0);
  const newModels = summary.flatMap(s => (s.newModels || []).map(id => s.providerId + '/' + id));
  if (newModels.length) console.log(`[ModelScanner] MODEL MOI DUNG DUOC (startup): ${newModels.join(', ')}`);
  console.log(`[ModelScanner] Startup scan complete: ${working}/${total} working models from ${summary.length} providers`);

  // Notify connected frontends
  if (typeof global !== 'undefined' && global.__modelScanComplete) {
    global.__modelScanComplete({ working, total, providers: summary.length, startup: true, newModels });
  }

  return summary;
}

// ─── Startup + Weekly Reset (chỉ quét khi server khởi động + mỗi CN→T2 00:00) ──
let schedulerStarted = false;

async function startModelScannerScheduler() {
  // Startup scan MAC DINH BAT (tat qua env ENABLE_STARTUP_SCAN=false): chay background sau boot 5s,
  // co cooldown 6h/provider (wasRecentlyScanned) nen khong dot quota + khong cham boot.
  // Catch-up: tuan truoc miss (server sleep/tat dung T2 00:00) -> quet bu full khi boot.
  // Neu catch-up chay thi startup scan bo qua (tranh quet trung; cooldown cung chan).
  let catchupPlanned = false;
  try {
    const lastRun = await getWeeklyLastRun();
    if (!lastRun || Date.now() - lastRun > 7 * 24 * 3600 * 1000) {
      catchupPlanned = true;
      console.log('[ModelScanner] Weekly catch-up: qua 7 ngay chua quet tuan -> chay bu background');
      setTimeout(() => {
        (async () => {
          try {
            await resetScanCache();
            await scanAllProviders();
            await setWeeklyLastRun();
          } catch (e) { console.error('[ModelScanner] Weekly catch-up failed:', e.message); }
        })();
      }, 15000);
    }
  } catch (e) { /* ignore */ }
  if (process.env.ENABLE_STARTUP_SCAN !== 'false') {
    setTimeout(() => {
      if (catchupPlanned) { console.log('[ModelScanner] Startup scan: skipped (weekly catch-up chay thay)'); return; }
      scanOnStartup().catch(e => console.error('[ModelScanner] Startup scan failed:', e.message));
    }, 5000);
  }

  schedulerStarted = true;
  // Migration 1 lan: xoa row 'error' do fuse cu de lai (model chua test that) — model hien
  // lai picker + duoc test o luot sau. Chi xoa dung text fuse, khong dung loi test that.
  try {
    const n = await runSql(`DELETE FROM model_scan_cache WHERE loi_chi_tiet LIKE '%fuse%'`);
    if (n) console.log(`[ModelScanner] Migration: xoa ${n} row fuse-error cu (model chua test se hien lai)`);
    const n2 = await runSql(`DELETE FROM model_scan_cache WHERE ma_model LIKE 'models/%'`);
    if (n2) console.log(`[ModelScanner] Migration: xoa ${n2} row cache prefix cu 'models/*' (Gemini doi sang id sach)`);
  } catch (e) { console.error('[ModelScanner] Migration fuse-cleanup error:', e.message); }
  try {
    await scheduleWeeklyReset();  // ← Weekly reset: CN → T2 00:00 VN
    const schedule = await getWeeklySchedule();
    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    console.log(`[ModelScanner] Scheduler started: startup scan ${process.env.ENABLE_STARTUP_SCAN === 'false' ? 'DISABLED (env)' : 'in 5s (cooldown 6h/provider)'}, weekly reset ${dayNames[schedule.day]} ${schedule.time}`);
  } catch (e) {
    console.error('[ModelScanner] Scheduler init error:', e.message);
  }
}

// ─── WEEKLY SCHEDULE: get/set từ DB ─────────────────────────────
// Mặc định: day=1 (Thứ 2), time='00:00'
const DEFAULT_SCHEDULE = { day: 1, time: '00:00' }; // 0=CN,1=T2,...,6=T7

async function getWeeklySchedule() {
  try {
    const row = await getRow("SELECT gia_tri FROM app_settings WHERE khoa = 'weekly_scan_schedule'");
    if (row && row.gia_tri) {
      const parsed = JSON.parse(row.gia_tri);
      if (typeof parsed.day === 'number' && typeof parsed.time === 'string') return parsed;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SCHEDULE };
}

async function setWeeklySchedule(day, time) {
  try {
    const val = JSON.stringify({ day, time });
    await runSql(`INSERT INTO app_settings (khoa, gia_tri) VALUES ('weekly_scan_schedule', ?)
      ON CONFLICT(khoa) DO UPDATE SET gia_tri = excluded.gia_tri`, [val]);
    return true;
  } catch { return false; }
}

// Luu lan weekly full-scan gan nhat (de catch-up khi miss: server sleep/tat dung gio)
async function getWeeklyLastRun() {
  try {
    const row = await getRow("SELECT gia_tri FROM app_settings WHERE khoa = 'weekly_last_run'");
    if (row && row.gia_tri) { const t = Date.parse(row.gia_tri); if (!isNaN(t)) return t; }
  } catch { /* ignore */ }
  return 0;
}
async function setWeeklyLastRun() {
  try {
    await runSql(`INSERT INTO app_settings (khoa, gia_tri) VALUES ('weekly_last_run', ?)
      ON CONFLICT(khoa) DO UPDATE SET gia_tri = excluded.gia_tri`, [new Date().toISOString()]);
  } catch { /* ignore */ }
}

async function resetWeeklySchedule() {
  await setWeeklySchedule(DEFAULT_SCHEDULE.day, DEFAULT_SCHEDULE.time);
}

// ─── WEEKLY RESET: clear cache + scan full mỗi tuần ─────────────
let weeklyResetTimer = null;

async function resetScanCache() {
  try {
    const row = await getRow('SELECT COUNT(*) as cnt FROM model_scan_cache');
    const count = row?.cnt || 0;
    await runSql('DELETE FROM model_scan_cache');
    console.log(`[ModelScanner] Weekly reset: cleared ${count} cached scan results`);
    return count;
  } catch (e) {
    console.error('[ModelScanner] Weekly reset failed:', e.message);
    return 0;
  }
}

async function msUntilNextWeeklyScan() {
  const { day, time } = await getWeeklySchedule(); // day: 0=CN,1=T2,...,6=T7
  const [hourStr, minStr] = time.split(':');
  const targetHour = parseInt(hourStr, 10);
  const targetMin = parseInt(minStr, 10);

  const now = new Date();
  // So sanh theo wall-clock VN (UTC+7): tranh lech ngay khi doi UTC tho (T2 00:00 VN = CN 17:00 UTC)
  const vn = new Date(now.getTime() + 7 * 3600 * 1000);
  const vnDay = vn.getUTCDay();
  let daysUntilTarget;
  if (vnDay === day && (vn.getUTCHours() < targetHour || (vn.getUTCHours() === targetHour && vn.getUTCMinutes() < targetMin))) {
    daysUntilTarget = 0;
  } else {
    daysUntilTarget = ((day - vnDay) + 7) % 7;
    if (daysUntilTarget === 0) daysUntilTarget = 7;
  }

  const target = new Date(Date.UTC(
    vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + daysUntilTarget,
    targetHour - 7, targetMin, 0, 0
  ));

  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  return target.getTime() - now.getTime();
}

async function scheduleWeeklyReset() {
  if (weeklyResetTimer) clearTimeout(weeklyResetTimer);
  const waitMs = await msUntilNextWeeklyScan();
  const days = Math.floor(waitMs / 86400000);
  const hours = Math.floor((waitMs % 86400000) / 3600000);
  const schedule = await getWeeklySchedule();
  const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  console.log(`[ModelScanner] Weekly reset scheduled: ${dayNames[schedule.day]} ${schedule.time} (${days}d ${hours}h from now)`);

  weeklyResetTimer = setTimeout(async () => {
    try {
      console.log('[ModelScanner] ═══ WEEKLY RESET START ═══');
      await resetScanCache();
      await scanAllProviders();
      console.log('[ModelScanner] ═══ WEEKLY RESET COMPLETE ═══');
      await setWeeklyLastRun();
    } catch (e) {
      console.error('[ModelScanner] Weekly reset scan failed:', e.message);
    }
    // Quét xong → reset về mặc định (CN→T2 00:00)
    await resetWeeklySchedule();
    console.log('[ModelScanner] Schedule reset to default: CN → T2 00:00');
    await scheduleWeeklyReset(); // Lên lịch tuần tiếp theo (mặc định)
  }, waitMs);
}

module.exports = { modalityOf, startModelScannerScheduler, scanAllProviders, scanOnStartup, scanProvider, PROVIDER_ENDPOINTS, getWeeklySchedule, setWeeklySchedule, resetWeeklySchedule, scheduleWeeklyReset };
