const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth.middleware');
const fs = require('fs');
const { execSync } = require('child_process');
const { safeExecSync } = require('../utils/safeExec');
const { encryptKey, decryptKey } = require('../utils/cryptoKeys');
// Require top-level (model-scanner chỉ cần db/cryptoKeys → không circular)
const { scanAllProviders, scanProvider, getWeeklySchedule, setWeeklySchedule, scheduleWeeklyReset, resetWeeklySchedule } = require('../model-scanner.scheduler');

// Biểu thức thời gian theo loại DB (SQLite local / PostgreSQL trên Render)
const dbNow = () => (db.type === 'sqlite' ? "datetime('now')" : 'NOW()');

// Helper chạy query trả promise từ adapter callback-based
const runQ = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
const allQ = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));

const OPENCODE_BIN_PATH = process.env.OPENCODE_BIN_PATH || (process.env.USERPROFILE ? require("path").join(process.env.USERPROFILE, ".opencode", "bin", "opencode.exe") : "");
const IS_OPENCODE_AVAILABLE = fs.existsSync(OPENCODE_BIN_PATH);

// Đồng bộ dữ liệu: xóa các provider đã loại bỏ khỏi hệ thống
try {
  db.run(`DELETE FROM khoa_api WHERE ten_nha_cung_cap IN ('bazaarlink', 'kiraai', 'ollama', 'freellmapi', 'tokenrouter')`);
  db.run(`DELETE FROM model_scan_cache WHERE ma_nha_cung_cap IN ('bazaarlink', 'kiraai', 'ollama', 'freellmapi', 'tokenrouter')`);
  db.run(`UPDATE ai_models SET kich_hoat = 0 WHERE ma_nha_cung_cap IN ('bazaarlink', 'kiraai', 'ollama', 'freellmapi', 'tokenrouter')`);
  db.run(`UPDATE ai_providers SET kich_hoat = 0 WHERE ma_nha_cung_cap IN ('tokenrouter')`);
} catch(e) {}

// ─── Public: lấy danh sách models đang hoạt động ─────────────
// GET /api/models?provider=gemini
router.get('/', (req, res) => {
  const provider = (req.query.provider || '').trim();
  let sql = `
    SELECT m.ma_model, m.ma_nha_cung_cap, COALESCE(p.ten_hien_thi, m.ma_nha_cung_cap) as provider_name,
           m.ten_hien_thi, m.loai, COALESCE(m.modality, 'chat') as modality, m.thu_tu_hien_thi,
           COALESCE((SELECT c.agent_ok FROM model_agent_cap c WHERE LOWER(c.ma_nha_cung_cap) = LOWER(m.ma_nha_cung_cap) AND c.ma_model = m.ma_model), 0) as agent_ok
    FROM ai_models m
    LEFT JOIN ai_providers p ON LOWER(m.ma_nha_cung_cap) = LOWER(p.ma_nha_cung_cap)
    WHERE m.kich_hoat = 1
      -- CHỈ hiển thị model của provider CÓ key trong khoa_api (hoặc provider keyless như opencode)
      -- tránh hiện "model ma" của provider đã bị xóa key
      AND (
        EXISTS (SELECT 1 FROM khoa_api k WHERE LOWER(k.ten_nha_cung_cap) = LOWER(m.ma_nha_cung_cap))
        OR EXISTS (SELECT 1 FROM ai_providers p2 WHERE LOWER(p2.ma_nha_cung_cap) = LOWER(m.ma_nha_cung_cap) AND p2.can_api_key = 0 AND p2.kich_hoat = 1)
      )
      -- FREE-ALL (QA 22/9/2026): hệ thống free hoàn toàn cho người dùng — ẩn model paid
      -- (needs_balance) khỏi picker: user không có cách nạp tiền, giữ lại chỉ gây click-lỗi.
      -- Scanner vẫn upsert vào DB (admin còn thấy), chỉ /api/models công khai lọc đi.
      AND LOWER(m.loai) != 'paid'
  `;
  const params = [];
  if (provider) {
    sql += ' AND LOWER(m.ma_nha_cung_cap) = LOWER(?)';
    params.push(provider);
  }
  // Agent Mode: chi hien model da verify chay duoc agent (ReAct JSON probe, bang model_agent_cap)
  if (String(req.query.for_agent || '') === '1') {
    sql += ` AND EXISTS (SELECT 1 FROM model_agent_cap c WHERE LOWER(c.ma_nha_cung_cap) = LOWER(m.ma_nha_cung_cap) AND c.ma_model = m.ma_model AND c.agent_ok = 1)`;
  }
  // Sắp xếp: provider theo thứ tự key trong khoa_api (giống trang Admin),
  // model dùng được (working) trước, model trả phí sau, rồi tên A→Z.
  // (Trước đây paid xếp lẫn/trên working vì sort thuần theo tên.)
  sql += ` ORDER BY
    COALESCE((SELECT MIN(k.ngay_tao) FROM khoa_api k WHERE LOWER(k.ten_nha_cung_cap) = LOWER(m.ma_nha_cung_cap)), '9999-12-31') ASC,
    CASE WHEN m.loai = 'paid' THEN 1 ELSE 0 END ASC,
    m.ten_hien_thi ASC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    // State mới nhất từ scanner để status hiển thị đúng (needs_balance dù loai cũ = free)
    db.all(`SELECT ma_model, ma_nha_cung_cap, trang_thai FROM model_scan_cache`, [], (errC, cacheRows) => {
    const cacheState = new Map();
    for (const c of (cacheRows || [])) cacheState.set(`${String(c.ma_nha_cung_cap).toLowerCase()}|${c.ma_model}`, c.trang_thai);

    // Nếu CSDL ai_models rỗng → Fallback sang model_scan_cache hoặc danh sách mặc định uy tín
    if (!rows || rows.length === 0) {
      const keyOrKeyless = `(
        EXISTS (SELECT 1 FROM khoa_api k WHERE LOWER(k.ten_nha_cung_cap) = LOWER(c.ma_nha_cung_cap))
        OR EXISTS (SELECT 1 FROM ai_providers p2 WHERE LOWER(p2.ma_nha_cung_cap) = LOWER(c.ma_nha_cung_cap) AND p2.can_api_key = 0 AND p2.kich_hoat = 1)
      )`;
      const orderBy = `ORDER BY COALESCE((SELECT MIN(k.ngay_tao) FROM khoa_api k WHERE LOWER(k.ten_nha_cung_cap) = LOWER(c.ma_nha_cung_cap)), '9999-12-31') ASC, c.ma_model ASC`;
      const cacheSql = provider
        ? `SELECT ma_model, ma_nha_cung_cap FROM model_scan_cache c WHERE trang_thai = 'working' AND LOWER(c.ma_nha_cung_cap) = LOWER(?) AND ${keyOrKeyless} ${orderBy}`
        : `SELECT ma_model, ma_nha_cung_cap FROM model_scan_cache c WHERE trang_thai = 'working' AND ${keyOrKeyless} ${orderBy}`;
      const cacheParams = provider ? [provider] : [];

      return db.all(cacheSql, cacheParams, (err2, cacheRows) => {
        if (!err2 && cacheRows && cacheRows.length > 0) {
          const map = new Map();
          for (const r of cacheRows) {
            const pKey = r.ma_nha_cung_cap.toLowerCase();
            if (!map.has(pKey)) map.set(pKey, []);
            map.get(pKey).push({
              id: r.ma_model,
              name: r.ma_model.includes('/') ? r.ma_model.split('/').pop() : r.ma_model,
              type: r.ma_model.includes('pro') || r.ma_model.includes('gpt-4') ? 'pro' : 'free',
            provider: pKey,
            providerName: pKey.toUpperCase(),
            agent: 0,
          });
          }
          return res.json({ success: true, models: Object.fromEntries(map) });
        }

        // KHÔNG dùng dữ liệu mẫu — trả danh sách rỗng để UI hiển thị "chưa có model hoạt động"
        return res.json({ success: true, models: {} });
      });
    }

    const modFilter = (req.query.modality || '').trim().toLowerCase();
    const map = new Map();
    for (const r of rows) {
      const mod = r.modality || 'chat';
      if (modFilter && mod !== modFilter) continue;
      const pKey = r.ma_nha_cung_cap.toLowerCase();
      const cached = cacheState.get(`${pKey}|${r.ma_model}`);
      if (!map.has(pKey)) map.set(pKey, []);
      // FREE-ALL: loại bỏ paid + model scanner kết luận needs_balance khỏi picker.
      // FIX picker-leak (9/10/2026): 'error' (lỗi khi quét) và 'dead' (chết hẳn) cũng
      // phải ẩn — user click vào là lỗi kết nối, không có retry thủ công.
      // 'working' + chưa quét (no cache row) vẫn hiện đúng như trạng thái thật.
      if (r.loai === 'paid' || cached === 'needs_balance' || cached === 'error' || cached === 'dead') continue;
      map.get(pKey).push({
        id: r.ma_model,
        name: r.ten_hien_thi,
        type: 'free',
        modality: mod,
        provider: pKey,
        providerName: r.provider_name,
        agent: r.agent_ok ? 1 : 0,
      });
    }
    res.json({ success: true, models: Object.fromEntries(map) });
    });
  });
});

// ─── Public: kiểm tra SELECT từ bảng khoa_api ─────────────
// GET /api/models/test-db-select
router.get('/test-db-select', [authMiddleware, adminMiddleware], (req, res) => {
  db.all("SELECT ma_khoa, ten_nha_cung_cap, gia_tri_khoa FROM khoa_api", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Lỗi truy vấn SQL: ' + err.message });
    }
    const safeList = (rows || []).map(r => ({
      ma_khoa: r.ma_khoa,
      provider: r.ten_nha_cung_cap,
      hasKey: !!r.gia_tri_khoa // chỉ trả boolean — KHÔNG trả key thô ra ngoài
    }));
    res.json({
      success: true,
      query: "SELECT ma_khoa, ten_nha_cung_cap, gia_tri_khoa FROM khoa_api",
      totalKeys: safeList.length,
      data: safeList
    });
  });
});

// [removed] startup debug block da log toan bo API key ra console + ssms_check_result.txt (don dep bao mat)

// ─── Public: Lấy danh sách Nhà cung cấp (Providers) động ─────────────
// GET /api/models/providers hoặc GET /api/providers
router.get('/providers', async (req, res) => {
  const sql = `
    SELECT p.ma_nha_cung_cap, p.ten_hien_thi, p.base_url, p.can_api_key, p.placeholder, p.thu_tu,
           k.gia_tri_khoa AS api_key_value
    FROM ai_providers p
    LEFT JOIN khoa_api k ON LOWER(p.ma_nha_cung_cap) = LOWER(k.ten_nha_cung_cap)
    WHERE p.kich_hoat = 1
    ORDER BY p.thu_tu ASC
  `;
  db.all(sql, [], async (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    const providers = (rows || []).map(r => ({
      ma_nha_cung_cap: r.ma_nha_cung_cap,
      ten_hien_thi: r.ten_hien_thi,
      base_url: r.base_url,
      can_api_key: r.can_api_key,
      placeholder: r.placeholder,
      thu_tu: r.thu_tu,
      hasKey: !!r.api_key_value
    }));

    res.json({ success: true, providers });
  });
});

// ─── Admin: danh sách providers ─────────────────────────────
// GET /api/admin/providers?provider=xyz
router.get('/admin/providers', [authMiddleware, adminMiddleware], (req, res) => {
  const provider = (req.query.provider || '').trim();
  let sql = 'SELECT * FROM ai_providers';
  const params = [];
  if (provider) { sql += ' WHERE ma_nha_cung_cap = ?'; params.push(provider); }
  sql += ' ORDER BY thu_tu ASC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, providers: rows });
  });
});

// ─── Admin: cập nhật provider ────────────────────────────────
// PUT /api/admin/providers/:providerId
router.put('/admin/providers/:providerId', [authMiddleware, adminMiddleware], (req, res) => {
  const { providerId } = req.params;
  const { ten_hien_thi, base_url, can_api_key, placeholder, thu_tu, kich_hoat } = req.body;
  db.run(
    `UPDATE ai_providers
     SET ten_hien_thi = ?, base_url = ?, can_api_key = ?, placeholder = ?,
         thu_tu = ?, kich_hoat = ?, ngay_cap_nhat = CURRENT_TIMESTAMP
     WHERE ma_nha_cung_cap = ?`,
    [ten_hien_thi, base_url, can_api_key ? 1 : 0, placeholder, thu_tu, kich_hoat ? 1 : 0, providerId],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      if (this.changes === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy provider' });
      if (typeof global !== 'undefined' && global.__modelScanComplete) {
        global.__modelScanComplete({ provider: providerId, action: 'provider_updated' });
      }
      res.json({ success: true, message: 'Đã cập nhật provider' });
    }
  );
});

// ─── Admin: danh sách models ─────────────────────────────────
// GET /api/admin/models?provider=xyz
router.get('/admin/models', [authMiddleware, adminMiddleware], (req, res) => {
  const provider = (req.query.provider || '').trim();
  let sql = `
    SELECT m.ma_model, m.ma_nha_cung_cap, p.ten_hien_thi as provider_name,
           m.ten_hien_thi, m.loai, m.kich_hoat, m.thu_tu_hien_thi, m.ngay_cap_nhat
    FROM ai_models m
    JOIN ai_providers p ON m.ma_nha_cung_cap = p.ma_nha_cung_cap
  `;
  const params = [];
  if (provider) { sql += ' WHERE m.ma_nha_cung_cap = ?'; params.push(provider); }
  sql += ' ORDER BY m.thu_tu_hien_thi ASC, m.ten_hien_thi ASC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, models: rows });
  });
});

// ─── Admin: thêm/sửa model thủ công ──────────────────────────
// POST /api/admin/models
router.post('/admin/models', [authMiddleware, adminMiddleware], (req, res) => {
  const { ma_model, ma_nha_cung_cap, ten_hien_thi, loai, thu_tu_hien_thi, kich_hoat } = req.body;
  if (!ma_model || !ma_nha_cung_cap || !ten_hien_thi) {
    return res.status(400).json({ success: false, error: 'Thiếu ma_model / ma_nha_cung_cap / ten_hien_thi.' });
  }
  db.run(
    `INSERT INTO ai_models (ma_model, ma_nha_cung_cap, ten_hien_thi, loai, thu_tu_hien_thi, kich_hoat)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
       ma_nha_cung_cap = excluded.ma_nha_cung_cap,
       ten_hien_thi = excluded.ten_hien_thi,
       loai = excluded.loai,
       thu_tu_hien_thi = excluded.thu_tu_hien_thi,
       kich_hoat = excluded.kich_hoat,
       ngay_cap_nhat = CURRENT_TIMESTAMP`,
    [ma_model, ma_nha_cung_cap, ten_hien_thi, loai || 'free', thu_tu_hien_thi || 0, kich_hoat ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      if (typeof global !== 'undefined' && global.__modelScanComplete) {
        global.__modelScanComplete({ provider: ma_nha_cung_cap, action: 'model_updated' });
      }
      res.json({ success: true, message: 'Đã lưu model' });
    }
  );
});

// ─── Admin: xóa model ────────────────────────────────────────
// DELETE /api/admin/models/:modelId
router.delete('/admin/models/:modelId', [authMiddleware, adminMiddleware], (req, res) => {
  const { modelId } = req.params;
  db.run('DELETE FROM ai_models WHERE ma_model = ?', [modelId], function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, error: 'Không tìm thấy model' });
    if (typeof global !== 'undefined' && global.__modelScanComplete) {
      global.__modelScanComplete({ action: 'model_deleted', modelId });
    }
    res.json({ success: true, message: 'Đã xóa model' });
  });
});

// ─── Admin: quét model từ API key của provider ───────────────
// POST /api/admin/models/sync
router.post('/admin/models/sync', [authMiddleware, adminMiddleware], async (req, res) => {
  const { provider, api_key, base_url } = req.body;
  if (!provider) return res.status(400).json({ success: false, error: 'Thiếu tên nhà cung cấp (provider).' });

  try {
    // Key ưu tiên từ body; nếu rỗng thì dùng key đã lưu trong CSDL (AdminPage gửi api_key rỗng)
    let effKey = (api_key || '').trim();
    if (!effKey) {
      const row = await new Promise((resolve) => {
        db.get('SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = LOWER(?) LIMIT 1', [provider], (err, r) => resolve(err ? null : r));
      });
      if (row && row.gia_tri_khoa) {
        try { effKey = decryptKey(row.gia_tri_khoa).trim(); } catch { effKey = ''; }
      }
    }
    if (!effKey) return res.json({ success: false, error: `Chưa có API key cho ${provider}. Nhập key rồi quét lại.` });
    const result = await fetchModelsFromProvider(provider, effKey, (base_url || '').trim());
    if (!result.success) return res.json({ success: false, error: result.error });

    // LƯU Ý: sync chỉ fetch danh sách KHÔNG verify health → KHÔNG xóa model cũ (tránh mất model working);
    // dùng scan-provider / verify-and-scan (có health check) để áp dụng chính sách thay thế model.
    for (const modelId of result.models) {
      const displayName = modelId.includes('/') ? modelId.split('/').pop() : modelId;
      db.run(
        `INSERT INTO ai_models (ma_model, ma_nha_cung_cap, ten_hien_thi, loai, thu_tu_hien_thi)
         VALUES (?, ?, ?, 'free', 0)
         ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
           ten_hien_thi = excluded.ten_hien_thi,
           ngay_cap_nhat = CURRENT_TIMESTAMP`,
        [modelId, provider, displayName]
      );
    }
    res.json({ success: true, provider, count: result.models.length, samples: result.models.slice(0, 30) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi quét model: ' + err.message });
  }
});

// ─── Public: quét model từ Base URL + API Key người dùng dán vào Settings ───
// POST /api/models/scan — KHÔNG ghi CSDL, chỉ trả danh sách model cho FE chọn
router.post('/scan', async (req, res) => {
  const { provider, api_key, base_url } = req.body;
  const prov = (provider || 'custom').trim();
  const baseUrl = (base_url || '').trim();

  // Chặn SSRF: không cho quét host nội bộ
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      const blocked = host === 'localhost' || host === '::1' || host.endsWith('.internal')
        || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host);
      if (blocked) return res.status(400).json({ success: false, error: 'Không được quét địa chỉ nội bộ.' });
    } catch {
      return res.status(400).json({ success: false, error: 'Base URL không hợp lệ.' });
    }
  }

  try {
    const result = await fetchModelsFromProvider(prov, (api_key || '').trim(), baseUrl);
    if (!result.success) return res.json({ success: false, error: result.error });
    if (!result.models || result.models.length === 0) {
      return res.json({ success: false, error: 'Không tìm thấy model nào từ link API này.' });
    }
    res.json({ success: true, provider: prov, count: result.models.length, models: result.models });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi quét model: ' + err.message });
  }
});

// ─── Utility: quét model từ provider ─────────────────────────
async function fetchModelsFromProvider(provider, apiKey, baseUrl) {
  let modelsList = [];

  if (provider === 'gemini') {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await resp.json();
    if (data.models && Array.isArray(data.models)) {
      modelsList = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    } else if (data.error) return { success: false, error: 'Gemini: ' + data.error.message };
  } else if (provider === 'groq') {
    const resp = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.filter(m => (!m.output_modalities || (m.output_modalities || []).includes('text'))).map(m => m.id);
    else if (data.error) return { success: false, error: 'Groq: ' + (data.error.message || JSON.stringify(data.error)) };
  } else if (provider === 'openai') {
    const resp = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id).filter(id => /^(gpt|o1|o3|o4|chatgpt)/i.test(id)).sort();
    else if (data.error) return { success: false, error: 'OpenAI: ' + data.error.message };
  } else if (provider === 'deepseek') {
    const resp = await fetch('https://api.deepseek.com/models', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id);
    else if (data.error) return { success: false, error: 'DeepSeek: ' + (data.error.message || JSON.stringify(data.error)) };
  } else if (provider === 'claude') {
    const resp = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id);
    else if (data.models && Array.isArray(data.models)) modelsList = data.models.map(m => m.id || m.name);
    else if (data.error) return { success: false, error: 'Claude: ' + (data.error.message || JSON.stringify(data.error)) };
  } else if (provider === 'github') {
    const resp = await fetch('https://models.github.ai/inference/models', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (Array.isArray(data)) modelsList = data.map(m => m.name || m.id);
    else if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id || m.name);
    else if (data.error) return { success: false, error: 'GitHub Models: ' + (data.error.message || JSON.stringify(data.error)) };
    // KHÔNG dùng danh sách model mẫu — trả lỗi để Admin thấy API trả sai định dạng
    else return { success: false, error: 'GitHub Models: API trả về định dạng không hợp lệ (không dùng dữ liệu mẫu)' };
  } else if (provider === 'opencode') {
    try {
      if (!IS_OPENCODE_AVAILABLE) throw new Error('OpenCode binary not found.');
      const stdout = safeExecSync(`"${OPENCODE_BIN_PATH}" models`, { timeout: 5000, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
      const rawList = stdout.split('\n').map(m => m.trim()).filter(m => m.length > 0);
      modelsList = [...rawList.filter(m => m.toLowerCase().includes('free')), ...rawList.filter(m => !m.toLowerCase().includes('free'))];
    } catch (errModels) {
      // KHÔNG chèn model mẫu khi CLI lỗi — báo lỗi rõ ràng
      return { success: false, error: 'OpenCode: ' + (errModels.message || 'CLI lỗi — không thể lấy danh sách model') };
    }
  } else if (provider === 'xkiro') {
    const resp = await fetch('https://api.xkiro.com/v1/models', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id);
    else if (data.error) return { success: false, error: 'xKiro: ' + (data.error.message || JSON.stringify(data.error)) };
  } else if (provider === 'kilo') {
    // Kilo Code gateway — KEYLESS (không cần Authorization), OpenRouter-style data[]
    const kiloBase = (baseUrl || 'https://kilo.ai/api/openrouter').replace(/\/+$/, '');
    const kiloUrl = kiloBase.endsWith('/models')
      ? kiloBase
      : kiloBase.replace('/openrouter', '/gateway') + '/models';
    const resp = await fetch(kiloUrl, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
    const data = await resp.json().catch(() => ({}));
    if (data.data && Array.isArray(data.data)) {
      modelsList = data.data.map(m => m.id).filter(m => typeof m === 'string' && (m.endsWith(':free') || m.startsWith('kilo-auto/')));
    } else if (data.error) {
      return { success: false, error: 'Kilo: ' + (data.error.message || data.error) };
    } else {
      return { success: false, error: 'Kilo: API trả về định dạng không hợp lệ' };
    }
  } else if (provider === 'agentrouter') {
    const resp = await fetch('https://agentrouter.org/v1/models', { headers: { 'Authorization': 'Bearer ' + apiKey, 'User-Agent': 'opencode/1.17.12' } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id);
    else if (data.error) return { success: false, error: 'AgentRouter: ' + (data.error.message || JSON.stringify(data.error)) };
  } else if (['nvidia', 'nvidia-nim', 'cerebras', 'cohere', 'mistral', 'bai', 'kiosapi', 'unorouter'].includes(provider)) {
    const OPENAI_COMPAT_BASES = {
      'nvidia': 'https://integrate.api.nvidia.com/v1',
      'nvidia-nim': 'https://integrate.api.nvidia.com/v1',
      'cerebras': 'https://api.cerebras.ai/v1',
      'cohere': 'https://api.cohere.com/compatibility/v1',
      'mistral': 'https://api.mistral.ai/v1',
      'bai': 'https://api.b.ai/v1',
      'kiosapi': 'https://kiosapi.com/v1',
      'unorouter': 'https://api.unorouter.com/v1'
    };
    const cleanedBase = (baseUrl || OPENAI_COMPAT_BASES[provider]).replace(/\/+$/, '');
    const endpoint = cleanedBase.endsWith('/models') ? cleanedBase : cleanedBase + '/models';
    const resp = await fetch(endpoint, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await resp.json();
    if (data.data && Array.isArray(data.data)) modelsList = data.data.map(m => m.id);
    else if (data.error) return { success: false, error: provider + ': ' + (data.error.message || JSON.stringify(data.error)) };
  } else {
    // custom — thử {base}/models rồi {base}/v1/models (phòng URL thiếu /v1)
    const cleanedBase = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const headers = apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {};
    const candidates = cleanedBase.endsWith('/models')
      ? [cleanedBase]
      : [cleanedBase + '/models', cleanedBase + '/v1/models'];
    for (let i = 0; i < candidates.length; i++) {
      const endpoint = candidates[i];
      const isLast = i === candidates.length - 1;
      try {
        const resp = await fetch(endpoint, { headers });
        const data = await resp.json();
        if (data.data && Array.isArray(data.data)) { modelsList = data.data.map(m => m.id); break; }
        if (Array.isArray(data)) { modelsList = data.map(m => m.id || m.name || m); break; }
        if (data.error && isLast) return { success: false, error: (provider === 'custom' ? 'Custom' : provider) + ': ' + (data.error.message || JSON.stringify(data.error)) };
      } catch (e) {
        if (isLast) return { success: false, error: (provider === 'custom' ? 'Custom' : provider) + ': ' + (e.message || 'Kết nối thất bại') };
      }
    }
  }

  return { success: true, models: modelsList };
}

const Groq = require('groq-sdk');

// Khởi tạo Groq client làm nền tảng AI phân tích
const getGroqClient = async () => {
  let key = process.env.GROQ_API_KEY;
  if (!key || key === 'YOUR_GROQ_API_KEY_HERE') {
    key = await new Promise((resolve) => {
      db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'groq'", [], (err, row) => {
        if (err || !row || !row.gia_tri_khoa) return resolve(null);
        resolve(decryptKey(row.gia_tri_khoa).trim());
      });
    });
  }
  if (!key) return null;
  return new Groq({ apiKey: key });
};

let cachedGroqAnalyzerModel = null;
let lastGroqModelScanTime = 0;

// Tự động quét API Groq để lấy Model mới nhất & mạnh nhất đang hoạt động (không cố định cứng)
async function getDynamicGroqAnalyzerModel(groq) {
  const now = Date.now();
  // Cache model trong 24 giờ
  if (cachedGroqAnalyzerModel && (now - lastGroqModelScanTime < 24 * 60 * 60 * 1000)) {
    return cachedGroqAnalyzerModel;
  }

  try {
    const list = await groq.models.list();
    if (list && Array.isArray(list.data) && list.data.length > 0) {
      // Tìm các model text đang hoạt động
      const activeTextModels = list.data
        .filter(m => m.active !== false && !m.id.includes('whisper') && !m.id.includes('guard'))
        .map(m => m.id);

      const preferred = activeTextModels.find(m => /llama-3.3-70b|llama-3.4-70b|llama-4|llama-3.1-70b/i.test(m))
        || activeTextModels.find(m => /70b|versatile/i.test(m))
        || activeTextModels[0];

      if (preferred) {
        cachedGroqAnalyzerModel = preferred;
        lastGroqModelScanTime = now;
        console.log(`[GroqDynamicModel] Tự động cập nhật Groq Analyzer Model mới nhất: ${preferred}`);
        return preferred;
      }
    }
  } catch (e) {
    console.log('[GroqDynamicModel] Fallback default model:', e.message);
  }

  return cachedGroqAnalyzerModel || 'llama-3.3-70b-versatile';
}

// Background Task: Tự động quét và làm mới model Groq mỗi 24 giờ
setInterval(async () => {
  try {
    const groq = await getGroqClient();
    if (groq) {
      lastGroqModelScanTime = 0;
      await getDynamicGroqAnalyzerModel(groq);
    }
  } catch (e) {}
}, 24 * 60 * 60 * 1000);

// Groq AI Bot Provider Analyzer: Dùng Groq AI tự động phân tích bất kỳ từ khóa tiếng Việt / gõ tắt / lỗi chính tả
async function aiAnalyzeProviderWithGroq(providerInput) {
  const cleanInput = (providerInput || '').trim().toLowerCase();

  const FAST_MAP = {
    'gemini': { providerId: 'gemini', providerName: 'Google Gemini', modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models' },
    'gg': { providerId: 'gemini', providerName: 'Google Gemini', modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models' },
    'google': { providerId: 'gemini', providerName: 'Google Gemini', modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models' },

    'groq': { providerId: 'groq', providerName: 'Groq Cloud', modelsEndpoint: 'https://api.groq.com/openai/v1/models' },
    'grop': { providerId: 'groq', providerName: 'Groq Cloud', modelsEndpoint: 'https://api.groq.com/openai/v1/models' },

    'grok': { providerId: 'grok', providerName: 'xAI Grok', modelsEndpoint: 'https://api.x.ai/v1/models' },
    'xai': { providerId: 'grok', providerName: 'xAI Grok', modelsEndpoint: 'https://api.x.ai/v1/models' },
    'x.ai': { providerId: 'grok', providerName: 'xAI Grok', modelsEndpoint: 'https://api.x.ai/v1/models' },

    'openai': { providerId: 'openai', providerName: 'OpenAI GPT-4o', modelsEndpoint: 'https://api.openai.com/v1/models' },
    'gpt': { providerId: 'openai', providerName: 'OpenAI GPT-4o', modelsEndpoint: 'https://api.openai.com/v1/models' },
    'chatgpt': { providerId: 'openai', providerName: 'OpenAI GPT-4o', modelsEndpoint: 'https://api.openai.com/v1/models' },

    'claude': { providerId: 'claude', providerName: 'Anthropic Claude', modelsEndpoint: 'https://api.anthropic.com/v1/models' },
    'anthropic': { providerId: 'claude', providerName: 'Anthropic Claude', modelsEndpoint: 'https://api.anthropic.com/v1/models' },

    'deepseek': { providerId: 'deepseek', providerName: 'DeepSeek AI', modelsEndpoint: 'https://api.deepseek.com/models' },
    'ds': { providerId: 'deepseek', providerName: 'DeepSeek AI', modelsEndpoint: 'https://api.deepseek.com/models' },

    'github': { providerId: 'github', providerName: 'GitHub Models', modelsEndpoint: 'https://models.github.ai/inference/models' },
    'gh': { providerId: 'github', providerName: 'GitHub Models', modelsEndpoint: 'https://models.github.ai/inference/models' },

    'openrouter': { providerId: 'custom', providerName: 'OpenRouter Gateway', modelsEndpoint: 'https://openrouter.ai/api/v1/models' },
    'opencode': { providerId: 'opencode', providerName: 'OpenCode Agent Engine', modelsEndpoint: 'opencode://models' },
    'mistral': { providerId: 'mistral', providerName: 'Mistral AI', modelsEndpoint: 'https://api.mistral.ai/v1/models' },
    'cerebras': { providerId: 'cerebras', providerName: 'Cerebras', modelsEndpoint: 'https://api.cerebras.ai/v1/models' },
    'cohere': { providerId: 'cohere', providerName: 'Cohere AI', modelsEndpoint: 'https://api.cohere.ai/v2/models' },
    'nvidia': { providerId: 'nvidia', providerName: 'Nvidia NIM', modelsEndpoint: 'https://integrate.api.nvidia.com/v1/models' },
    'agentrouter': { providerId: 'agentrouter', providerName: 'AgentRouter (GPT-5.6 Sol)', modelsEndpoint: 'https://agentrouter.org/v1/models' },
    'bai': { providerId: 'bai', providerName: 'B.AI', modelsEndpoint: 'https://api.b.ai/v1/models' },
    'b.ai': { providerId: 'bai', providerName: 'B.AI', modelsEndpoint: 'https://api.b.ai/v1/models' },
    'kiosapi': { providerId: 'kiosapi', providerName: 'KiosAPI', modelsEndpoint: 'https://kiosapi.com/v1/models' },
    'unorouter': { providerId: 'unorouter', providerName: 'UnoRouter', modelsEndpoint: 'https://api.unorouter.com/v1/models' }
  };

  if (FAST_MAP[cleanInput]) {
    return FAST_MAP[cleanInput];
  }

  // Dùng Groq AI Bot làm nền tảng phân tích từ khóa tự do (Tự động dùng model Groq mới nhất đang sống)
  try {
    const groq = await getGroqClient();
    if (groq) {
      const dynamicModelName = await getDynamicGroqAnalyzerModel(groq);
      const prompt = `Phân tích từ khóa nhà cung cấp AI: "${providerInput}". Xác định chính xác API Endpoint URL để fetch danh sách /models. Trả về định dạng JSON thuần túy:
{
  "providerId": "mã_chuẩn (groq|gemini|grok|openai|claude|deepseek|github|custom)",
  "providerName": "Tên hiển thị chuẩn",
  "modelsEndpoint": "https://... URL endpoint"
}`;
      const completion = await groq.chat.completions.create({
        model: dynamicModelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 150
      });

      const content = completion.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.providerId && parsed.modelsEndpoint) {
          return {
            providerId: parsed.providerId,
            providerName: parsed.providerName || providerInput,
            modelsEndpoint: parsed.modelsEndpoint,
            isAiAnalyzed: true
          };
        }
      }
    }
  } catch (e) {
    console.log('[GroqAIAnalyzer] Error:', e.message);
  }

  return {
    providerId: cleanInput.replace(/[^a-z0-9]/g, '') || 'custom',
    providerName: providerInput || 'Custom Provider',
    modelsEndpoint: 'https://openrouter.ai/api/v1/models',
    isAiAnalyzed: false
  };
}

// ─── Utility: Test sức khỏe (Health Verification) từng model ─────────────
async function verifyModelHealth(provider, apiKey, baseUrl, modelId) {
  const startTime = Date.now();
  const cleanKey = (apiKey || '').trim();
  const cleanBase = (baseUrl || '').replace(/\/+$/, '');



  try {
    if (provider === 'gemini') {
      const cleanModelId = modelId.replace(/^models\//, '');
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}?key=${cleanKey}`, { signal: AbortSignal.timeout(12000) });
      const latency = Date.now() - startTime;
      if (resp.ok) {
        return { id: modelId, name: modelId, provider, status: 'working', latency_ms: latency, message: 'Hoạt động tốt' };
      } else {
        const err = await resp.json().catch(() => ({}));
        return { id: modelId, name: modelId, provider, status: 'failed', latency_ms: latency, error: err.error?.message || `HTTP ${resp.status}` };
      }
    }

    if (['openai', 'groq', 'grok', 'deepseek', 'github', 'custom', 'xkiro', 'agentrouter', 'bai', 'kiosapi', 'unorouter', 'kilo',].includes(provider)) {
      let endpoint = 'https://api.openai.com/v1/chat/completions';
      if (provider === 'groq') endpoint = 'https://api.groq.com/openai/v1/chat/completions';
      if (provider === 'grok') endpoint = 'https://api.x.ai/v1/chat/completions';
      if (provider === 'deepseek') endpoint = 'https://api.deepseek.com/chat/completions';
      if (provider === 'github') endpoint = 'https://models.github.ai/inference/chat/completions';
      if (provider === 'custom') {
        const base = cleanBase || 'https://openrouter.ai/api/v1';
        endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      }
      if (provider === 'xkiro') {
        const base = cleanBase || 'https://api.xkiro.com/v1';
        endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      }
      if (provider === 'kilo') {
        const base = cleanBase || 'https://kilo.ai/api/openrouter';
        endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      }
      if (provider === 'agentrouter') {
        const base = cleanBase || 'https://agentrouter.org/v1';
        endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      }
      if (['bai', 'kiosapi', 'unorouter'].includes(provider)) {
        const NEW_BASES = { bai: 'https://api.b.ai/v1', kiosapi: 'https://kiosapi.com/v1', unorouter: 'https://api.unorouter.com/v1' };
        const base = cleanBase || NEW_BASES[provider];
        endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cleanKey ? { 'Authorization': 'Bearer ' + cleanKey } : {}), ...(provider === 'agentrouter' ? { 'User-Agent': 'opencode/1.17.12' } : {}) },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(12000)
      });
      const latency = Date.now() - startTime;
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && (data.choices || data.id)) {
        return { id: modelId, name: modelId, provider, status: 'working', latency_ms: latency, message: 'Hoạt động tốt' };
      } else {
        const errMsg = data.error?.message || data.detail || data.message || (typeof data === 'string' ? data : `HTTP ${resp.status}`);
        return { id: modelId, name: modelId, provider, status: 'failed', latency_ms: latency, error: errMsg };
      }
    }

    if (provider === 'claude') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cleanKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(7000)
      });
      const latency = Date.now() - startTime;
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && (data.content || data.id)) {
        return { id: modelId, name: modelId, provider, status: 'working', latency_ms: latency, message: 'Hoạt động tốt' };
      } else {
        return { id: modelId, name: modelId, provider, status: 'failed', latency_ms: latency, error: data.error?.message || `HTTP ${resp.status}` };
      }
    }

    return { id: modelId, name: modelId, provider, status: 'working', latency_ms: Date.now() - startTime, message: 'Khả dụng' };
  } catch (err) {
    return { id: modelId, name: modelId, provider, status: 'failed', latency_ms: Date.now() - startTime, error: err.message || 'Timeout / Connection error' };
  }
}

// ─── Admin: Quét & Tự Động Kiểm Tra Sức Khỏe Model Qua Groq AI Analyzer ─────
// POST /api/admin/models/verify-and-scan
router.post('/admin/models/verify-and-scan', [authMiddleware, adminMiddleware], async (req, res) => {
  const { provider, api_key, base_url } = req.body;
  if (!provider) return res.status(400).json({ success: false, error: 'Thiếu thông tin nhà cung cấp (provider).' });

  try {
    // 1. Phân tích từ khóa người dùng qua Groq AI Bot
    const aiAnalysis = await aiAnalyzeProviderWithGroq(provider);
    const resolvedProvider = aiAnalysis.providerId;
    const resolvedEndpoint = base_url || aiAnalysis.modelsEndpoint;

    // 2. Fetch danh sách model từ Endpoint mà Groq AI Bot đã tìm thấy
    const fetchRes = await fetchModelsFromProvider(resolvedProvider, (api_key || '').trim(), resolvedEndpoint);
    if (!fetchRes.success) return res.json({ success: false, error: fetchRes.error, analysis: aiAnalysis });

    const rawModels = fetchRes.models || [];
    if (rawModels.length === 0) {
      return res.json({ success: false, error: 'Không tìm thấy model nào từ link API này.', analysis: aiAnalysis });
    }

    // Giới hạn kiểm tra tối đa 25 models hàng đầu để phản hồi nhanh
    const modelsToVerify = rawModels.slice(0, 25);

    // 3. Chạy kiểm tra health song song 5 request/lượt
    const verifiedResults = [];
    const chunkSize = 5;
    for (let i = 0; i < modelsToVerify.length; i += chunkSize) {
      const chunk = modelsToVerify.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(mId => verifyModelHealth(resolvedProvider, api_key, resolvedEndpoint, mId))
      );
      verifiedResults.push(...chunkResults);
    }

    const workingResults = verifiedResults.filter(m => m.status === 'working');
    const workingCount = workingResults.length;

    // TỰ ĐỘNG LƯU VÀO CSDL VÀ KÍCH HOẠT TRÊN TRANG CHỦ
    if (workingCount > 0) {
      if (api_key && api_key.trim()) {
        const keyId = 'k_' + resolvedProvider;
        db.run(
          `INSERT INTO khoa_api (ma_khoa, ma_nguoi_dung, ten_nha_cung_cap, gia_tri_khoa)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(ma_khoa) DO UPDATE SET gia_tri_khoa = excluded.gia_tri_khoa`,
          [keyId, req.user.id, resolvedProvider, encryptKey(api_key.trim())]
        );
      }

      // 🔄 K4 UPSERT POLICY: KHÔNG xóa model cũ — upsert giữ nguyên kich_hoat
      // admin đã bật/tắt thủ công; chỉ refresh cache quét của provider
      db.run('DELETE FROM model_scan_cache WHERE ma_nha_cung_cap = ?', [resolvedProvider]);

      for (const m of workingResults) {
        const modelId = m.id;
        const displayName = modelId.includes('/') ? modelId.split('/').pop() : modelId;
        const type = (modelId.includes('pro') || modelId.includes('gpt-4') || modelId.includes('sonnet')) ? 'pro' : 'free';

        db.run(
          `INSERT INTO ai_models (ma_model, ma_nha_cung_cap, ten_hien_thi, loai, thu_tu_hien_thi, kich_hoat)
           VALUES (?, ?, ?, ?, 0, 1)
           ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
             ma_nha_cung_cap = excluded.ma_nha_cung_cap,
             ten_hien_thi = excluded.ten_hien_thi,
             loai = excluded.loai,
             kich_hoat = ai_models.kich_hoat,
             ngay_cap_nhat = CURRENT_TIMESTAMP`,
          [modelId, resolvedProvider, displayName, type]
        );

        db.run(
          `INSERT INTO model_scan_cache (ma_model, ma_nha_cung_cap, trang_thai, do_tre_ms, loi_chi_tiet, thoi_gian_quet)
           VALUES (?, ?, 'working', ?, NULL, ${dbNow()})
           ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
             trang_thai = 'working', do_tre_ms = excluded.do_tre_ms, loi_chi_tiet = NULL, thoi_gian_quet = ${dbNow()}`,
          [modelId, resolvedProvider, m.latency_ms || 0]
        );
      }

      // Phát thông báo SSE Real-time cập nhật Trang Chủ lập tức không cần F5
      if (typeof global !== 'undefined' && global.__modelScanComplete) {
        global.__modelScanComplete({ working: workingCount, total: verifiedResults.length, provider: resolvedProvider });
      }
    }

    res.json({
      success: true,
      analysis: aiAnalysis,
      provider: resolvedProvider,
      providerName: aiAnalysis.providerName,
      modelsEndpoint: resolvedEndpoint,
      totalScanned: rawModels.length,
      verifiedCount: verifiedResults.length,
      workingCount,
      models: verifiedResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi kiểm tra model: ' + err.message });
  }
});

// ─── Admin: Đẩy Các Model Đang Hoạt Động Lên Trang Chủ ───────
// POST /api/admin/models/publish-active
router.post('/admin/models/publish-active', [authMiddleware, adminMiddleware], async (req, res) => {
  const { provider, api_key, models } = req.body;
  if (!provider || !Array.isArray(models)) {
    return res.status(400).json({ success: false, error: 'Thiếu dữ liệu provider hoặc danh sách models.' });
  }

  try {
    // 1. Lưu API key vào CSDL nếu người dùng gửi key mới
    if (api_key && api_key.trim()) {
      const keyId = 'k_' + provider;
      db.run(
        `INSERT INTO khoa_api (ma_khoa, ma_nguoi_dung, ten_nha_cung_cap, gia_tri_khoa)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ma_khoa) DO UPDATE SET gia_tri_khoa = excluded.gia_tri_khoa`,
        [keyId, req.user.id, provider, encryptKey(api_key.trim())]
      );
    }

    // 2. 🔄 K4 UPSERT POLICY: KHÔNG xóa model cũ của provider — upsert
    // giữ nguyên kich_hoat admin bật thủ công (DELETE làm model thủ công mất)
    let savedCount = 0;
    for (const m of models) {
      const modelId = typeof m === 'string' ? m : m.id;
      const displayName = modelId.includes('/') ? modelId.split('/').pop() : modelId;
      const type = (modelId.includes('pro') || modelId.includes('gpt-4') || modelId.includes('sonnet')) ? 'pro' : 'free';

      db.run(
        `INSERT INTO ai_models (ma_model, ma_nha_cung_cap, ten_hien_thi, loai, thu_tu_hien_thi, kich_hoat)
         VALUES (?, ?, ?, ?, 0, 1)
         ON CONFLICT(ma_model, ma_nha_cung_cap) DO UPDATE SET
           ma_nha_cung_cap = excluded.ma_nha_cung_cap,
           ten_hien_thi = excluded.ten_hien_thi,
           loai = excluded.loai,
           kich_hoat = ai_models.kich_hoat,
           ngay_cap_nhat = CURRENT_TIMESTAMP`,
        [modelId, provider, displayName, type]
      );
      savedCount++;
    }

    if (typeof global !== 'undefined' && global.__modelScanComplete) {
      global.__modelScanComplete({ provider, publishedCount: savedCount, action: 'published' });
    }
    res.json({
      success: true,
      provider,
      publishedCount: savedCount,
      message: `🎉 Đã đăng tải thành công ${savedCount} model đang hoạt động của ${provider.toUpperCase()} lên Menu Trang Chủ!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi cập nhật trang chủ: ' + err.message });
  }
});


// ─── Admin: Quét tất cả providers (scan-all) ────────────────────
// POST /api/admin/models/scan-all
router.post('/admin/models/scan-all', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const summary = await scanAllProviders();
    const totalWorking = summary.reduce((acc, s) => acc + (s.working || 0), 0);
    const totalModels = summary.reduce((acc, s) => acc + (s.total || 0), 0);
    const scannedProviders = summary.filter(s => s.success !== false || !s.skipped);
    res.json({
      success: true,
      message: `Quét hoàn tất! ${totalWorking}/${totalModels} model hoạt động từ ${scannedProviders.length} providers.`,
      summary
    });
  } catch(e) {
    res.status(500).json({ success: false, error: 'Lỗi quét: ' + e.message });
  }
});

// ─── Admin: Xóa sạch toàn bộ model chèn cứng và cache để thiết lập lại ──────
// POST /api/admin/models/clear-and-reset
router.post('/admin/models/clear-and-reset', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    // Xóa tuần tự qua adapter db.js (cùng DB với scanner + /api/models)
    await runQ('DELETE FROM model_scan_cache');
    await runQ('DELETE FROM provider_scan_log');
    await runQ('DELETE FROM ai_models');
    if (typeof global !== 'undefined' && global.__modelScanComplete) {
      global.__modelScanComplete({ action: 'reset' });
    }
    res.json({ success: true, message: '🧹 Đã xóa sạch toàn bộ model cũ và lịch sử cache! Bấm Quét để kiểm tra lại.' });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: Quét một provider đơn lẻ ─────────────────────────
// POST /api/admin/models/scan-provider
router.post('/admin/models/scan-provider', [authMiddleware, adminMiddleware], async (req, res) => {
  const { provider } = req.body;
  if (!provider) return res.status(400).json({ success: false, error: 'Thiếu provider' });
  try {
    const result = await scanProvider(provider);
    // Push SSE event to connected frontends
    if (typeof global !== 'undefined' && global.__modelScanComplete) {
      global.__modelScanComplete({ working: result.working || 0, total: result.total || 0, providers: 1, provider });
    }
    res.json(result);
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: Lấy kết quả scan cache từ CSDL ────────────────────
// GET /api/admin/models/scan-cache?provider=gemini
router.get('/admin/models/scan-cache', [authMiddleware, adminMiddleware], async (req, res) => {
  const { provider } = req.query;
  try {
    const models = provider
      ? await allQ(`SELECT ma_model, ma_nha_cung_cap, trang_thai, do_tre_ms, loi_chi_tiet, thoi_gian_quet
          FROM model_scan_cache WHERE ma_nha_cung_cap = ? ORDER BY trang_thai DESC, do_tre_ms ASC`, [provider])
      : await allQ(`SELECT ma_model, ma_nha_cung_cap, trang_thai, do_tre_ms, loi_chi_tiet, thoi_gian_quet
          FROM model_scan_cache ORDER BY ma_nha_cung_cap, trang_thai DESC, do_tre_ms ASC`);
    const providers = await allQ('SELECT * FROM provider_scan_log');

    // Group by provider — 4 bucket để UI không hiện "Lỗi" oan:
    // working = gọi thật được; skipped = non-chat (embed/stt/tts/ảnh) hoặc chưa cần test;
    // needs_balance = model tồn tại nhưng trả phí; failed = lỗi thật (chết/timeout)
    const grouped = {};
    for (const m of models) {
      if (!grouped[m.ma_nha_cung_cap]) {
        grouped[m.ma_nha_cung_cap] = { working: [], failed: [], skipped: [], needs_balance: [] };
      }
      const g = grouped[m.ma_nha_cung_cap];
      if (m.trang_thai === 'working') g.working.push(m);
      else if (m.trang_thai === 'skipped') g.skipped.push(m);
      else if (m.trang_thai === 'needs_balance') g.needs_balance.push(m);
      else g.failed.push(m);
    }

    res.json({ success: true, grouped, providers, total: models.length });
  } catch(e) {
    res.json({ success: true, grouped: {}, providers: [], total: 0, note: 'No scan data yet' });
  }
});

// ─── Admin: Lịch quét tuần (mặc định CN→T2 00:00, chỉnh được) ──
const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

router.get('/admin/models/weekly-schedule', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const s = await getWeeklySchedule();
    res.json({ success: true, day: s.day, time: s.time, label: `${DAY_NAMES[s.day]} ${s.time}` });
  } catch(e) {
    res.json({ success: true, day: 1, time: '00:00', label: 'CN → T2 00:00' });
  }
});

router.post('/admin/models/weekly-schedule', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { day, time } = req.body || {};
    if (typeof day !== 'number' || day < 0 || day > 6) {
      return res.status(400).json({ success: false, message: 'Ngày không hợp lệ (0=CN,1=T2,...,6=T7)' });
    }
    if (typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time)) {
      return res.status(400).json({ success: false, message: 'Giờ không hợp lệ (VD: 00:00, 03:30)' });
    }
    const ok = await setWeeklySchedule(day, time);
    if (!ok) return res.status(500).json({ success: false, message: 'Không lưu được lịch quét' });
    try { await scheduleWeeklyReset(); } catch(e) { /* scheduler chưa bật */ }
    res.json({ success: true, day, time, label: `${DAY_NAMES[day]} ${time}`, message: `Đã lưu: quét tự động ${DAY_NAMES[day]} ${time}` });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/admin/models/weekly-schedule/reset', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    await resetWeeklySchedule();
    try { await scheduleWeeklyReset(); } catch(e) { /* scheduler chưa bật */ }
    res.json({ success: true, day: 1, time: '00:00', label: 'CN → T2 00:00', message: 'Đã reset về mặc định: CN → T2 00:00' });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
