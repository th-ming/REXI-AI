const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { safeExec, safeExecSync } = require('../utils/safeExec');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../config/db');
const { stripAnsi, AnsiStreamCleaner } = require('../utils/stripAnsi');
const { authMiddleware, adminMiddleware, guestMiddleware, guestAgentMiddleware, getGuestLimits } = require('../middleware/auth.middleware');
const { GUEST_USER_ID } = require('../ensure-admin');
const { encryptKey, decryptKey } = require('../utils/cryptoKeys');
const { searchDocuments } = require('../services/ragService');
const { rateLimit } = require('../middleware/rateLimit');
const kiloQuota = require('../middleware/kiloQuota');
const { logActivity } = require('../utils/activityLog');
const agentEngine = require('../services/agentEngine');
const modelRouter = require('../services/modelRouter');
const healthCheck = require('../services/healthCheck');
const chatExecutor = require('../services/chatExecutor');
const quotaManager = require('../services/quotaManager');
const telemetry = require('../services/telemetry');
// ─── Helper: lấy API key xKiro từ DB qua adapter (SQLite local / PG trên Render) ───
function getXkiroApiKey() {
  return getProviderApiKey('xkiro');
}
// ─── Helper chung: lấy API key bất kỳ provider nào (env trước, khoa_api sau) ───
function getProviderApiKey(prov) {
  return new Promise((resolve) => {
    const p = String(prov || '').toLowerCase();
    const envHit = process.env[p.toUpperCase() + '_API_KEY'] || process.env['REXI_' + p.toUpperCase() + '_KEY'];
    if (envHit && envHit.trim()) return resolve(envHit.trim());
    db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = ?", [p], (err, row) => {
      if (err || !row || !row.gia_tri_khoa) return resolve('');
      try { resolve(decryptKey(row.gia_tri_khoa).trim()); }
      catch (de) { resolve(String(row.gia_tri_khoa).trim()); }
    });
  });
}


// ─── P1-09: kiểm tra chủ sở hữu cuộc hội thoại (admin bypass) ───
// Trả null nếu được phép; trả { status, error } nếu bị chặn (404/403/500).
// Mẫu theo DELETE /conversations/:id (WHERE ma_hoi_thoai + ma_nguoi_dung).
function assertConvOwner(maHoiThoai, req) {
  return new Promise((resolve) => {
    if (req.user && (req.user.role === 'admin' || req.user.phan_quyen === 'admin')) return resolve(null);
    // P0-privacy: guest chỉ được chạm conv gắn đúng session mình (ma_phien).
    // Conv guest cũ (ma_phien NULL, tạo trước fix) → từ chối để không rò rỉ chéo.
    if (!req.user) {
      if (!req.sessionID) return resolve({ status: 403, error: 'Không có quyền truy cập cuộc hội thoại này.' });
      db.get("SELECT ma_nguoi_dung FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ? AND ngay_xoa IS NULL AND ma_nguoi_dung = ? AND ma_phien = ?", [maHoiThoai, GUEST_USER_ID, req.sessionID], (err, row) => {
        if (err) return resolve({ status: 500, error: err.message });
        if (!row) return resolve({ status: 403, error: 'Không có quyền truy cập cuộc hội thoại này.' });
        resolve(null);
      });
      return;
    }
    const expectedOwner = req.user.id;
    db.get("SELECT ma_nguoi_dung FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ? AND ngay_xoa IS NULL", [maHoiThoai], (err, row) => {
      if (err) return resolve({ status: 500, error: err.message });
      if (!row) return resolve({ status: 404, error: 'Không tìm thấy cuộc hội thoại.' });
      if (row.ma_nguoi_dung !== expectedOwner) return resolve({ status: 403, error: 'Không có quyền truy cập cuộc hội thoại này.' });
      resolve(null);
    });
  });
}

// ─── Xử lý lỗi AgentRouter → thông báo tiếng Việt thân thiện cho người dùng ───
function agentRouterFriendlyError(rawMsg) {
  const m = String(rawMsg || '').toLowerCase();
  if (m.includes('content-blocked')) {
    return '⚠️ Model GPT-5.6 Sol (AgentRouter) đang CHẶN nội dung tiếng Việt (giới hạn phía nhà cung cấp). Vui lòng chuyển sang model xKiro để chat tiếng Việt hoặc dùng tiếng Anh cho model này.';
  }
  if (m.includes('budget pool') || m.includes('quota has been exhausted') || m.includes('insufficient')) {
    return '⚠️ Model này trên AgentRouter đang tạm ngừng do hết hạn mức phía nhà cung cấp. Vui lòng chọn model khác.';
  }
  return null;
}

// ─── SMART MODEL ROUTER: tự chọn model theo độ khó câu hỏi ──────────
function smartModelOverride(provider, model, text, thinkingLevel) {
  const m = String(model || '').trim();
  const t = String(text || '');
  // Chế độ suy luận sâu → model reasoning (verify live 9/2026 trên key xkiro free)
  if (thinkingLevel === 'deep') {
    if (provider === 'xkiro') return 'mistralai/mistral-large-2512';
    return m;
  }
  // Auto router: câu đơn giản → model nhanh; câu phức tạp → model mạnh
  if (m === 'auto' || m === 'auto/' + provider) {
    if (provider === 'xkiro') {
      const complex = /tại sao|vì sao|giải thích|phân tích|so sánh|viết|code|lập trình|thuật toán|debug|sửa lỗi|đánh giá|tổng hợp|bài văn|bài toán|logic|chi tiết|hướng dẫn/i.test(t) || t.length > 150;
      return complex ? 'mistralai/mistral-large-2512' : 'mistralai/ministral-8b';
    }
    return m;
  }
  return m;
}

// ─── VISION: tách ảnh markdown trong tin nhắn → OpenAI content parts ───
function buildOpenAIContent(noiDung) {
  const text = String(noiDung || '');
  const parts = [];
  const imgRe = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;
  let last = 0;
  let m;
  let buf = '';
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

// ─── VISION: tách ảnh markdown trong tin nhắn → Gemini parts (inlineData) ───
// QA 17/9: nhánh Gemini chỉ gửi parts [{ text }] nên ảnh KHÔNG bao giờ tới model
// (vision trả lời nhảm, ví dụ ảnh chữ "REXI 7391" → "MAI"). Google nhận ảnh qua
// inlineData (base64 + mimeType), không phải image_url kiểu OpenAI.
function buildGeminiParts(noiDung) {
  const text = String(noiDung || '');
  const parts = [];
  const imgRe = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;
  let last = 0;
  let m;
  let buf = '';
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

// ─── Rexi AI BRAIN INTEGRATION ────────────────────────────────
const brain = require('../services/brain/intelligence/intelligence');
const { extractEntities } = require('../services/brain/nlp/entity-extractor');
const { loadSmartMemory, updateProfileFromMessage, saveMemoryAuto } = brain;

// --- CONFIGURATION ---
const OPENCODE_BIN_PATH = process.env.OPENCODE_BIN_PATH || (process.env.USERPROFILE ? require("path").join(process.env.USERPROFILE, ".opencode", "bin", "opencode.exe") : "");
const IS_OPENCODE_AVAILABLE = fs.existsSync(OPENCODE_BIN_PATH);

// Env chuẩn cho mọi spawn opencode/agent: tắt màu ANSI ở NGUỒN để tránh rò rỉ mã "[[35m..." vào chat.
// (stripAnsi + AnsiStreamCleaner ở các handler là lớp an toàn phụ khi tool vẫn phun mã màu.)
const NO_COLOR_ENV = { ...process.env, LANG: 'en_US.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CLICOLOR: '0', CLICOLOR_FORCE: '0' };

// ─── HEALTH CHECK: chay ngay khi server khoi dong + moi 10 phut ───
// Loai provider che (het quota/loi) khoi danh sach tu chon cua modelRouter
(async () => {
  try {
    const results = await healthCheck.runHealthCheck();
    modelRouter.setHealth(results);
    console.log('[HealthCheck] initial:', results.map(r => r.provider + ':' + (r.ok ? 'OK' : 'FAIL')).join(', '));
  } catch (e) { console.log('[HealthCheck] init error:', e.message); }
})();
setInterval(async () => {
  try {
    const results = await healthCheck.runHealthCheck();
    modelRouter.setHealth(results);
    console.log('[HealthCheck] refresh done');
  } catch (e) { console.log('[HealthCheck] refresh error:', e.message); }
}, 10 * 60 * 1000);

// E5: purge hội thoại soft-delete quá 30 ngày (cả tin nhắn con) — DB không phình vô hạn.
// ngay_xoa là TEXT/TIMESTAMP (CURRENT_TIMESTAMP) — hàm datetime() chỉ có SQLite → tính cutoff bằng JS.
const purgeExpiredConvs = () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.all('SELECT ma_hoi_thoai FROM cuoc_hoi_thoai WHERE ngay_xoa IS NOT NULL AND ngay_xoa < ?', [cutoff], (err, rows) => {
    if (err || !rows || !rows.length) return;
    const ids = rows.map(r => r.ma_hoi_thoai);
    let done = 0;
    for (const id of ids) {
      db.run('DELETE FROM tin_nhan WHERE ma_hoi_thoai = ?', [id], () => {
        db.run('DELETE FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?', [id], () => {
          done++;
          if (done === ids.length) console.log(`[ChatPurge] Đã xóa ${ids.length} hội thoại hết hạn (>30 ngày)`);
        });
      });
    }
  });
};
purgeExpiredConvs();
setInterval(purgeExpiredConvs, 24 * 60 * 60 * 1000);

// --- CACHING FOR MODELS ---
const modelCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // P3: thống nhất cache models 1h (trước 6h — lệch với modelRouter)

// Cleanup cache định kỳ để tránh memory leak
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, cached] of modelCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL) {
      modelCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[ModelCache] Cleaned ${cleaned} expired entries. Active: ${modelCache.size}`);
  }
}, 30 * 60 * 1000); // Cleanup mỗi 30 phút

function getModelCacheKey(provider, apiKey, baseUrl) {
    if (provider === 'opencode') {
        return `${provider}:${baseUrl || 'default'}`;
    }
    if (!apiKey) return null;
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
    return `${provider}:${keyHash}`;
}

// ADMIN: Lấy tất cả cuộc hội thoại của mọi người dùng
router.get('/conversations/all', [authMiddleware, adminMiddleware], (req, res) => {
  db.all("SELECT c.*, u.email FROM cuoc_hoi_thoai c JOIN nguoi_dung u ON c.ma_nguoi_dung = u.ma_nguoi_dung WHERE c.ngay_xoa IS NULL ORDER BY ngay_cap_nhat DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ADMIN: Lấy tất cả cuộc hội thoại của MỘT người dùng cụ thể
router.get('/admin/conversations/:userId', [authMiddleware, adminMiddleware], (req, res) => {
  const { userId } = req.params;
  db.all("SELECT * FROM cuoc_hoi_thoai WHERE ma_nguoi_dung = ? AND ngay_xoa IS NULL ORDER BY ngay_cap_nhat DESC", [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ADMIN: Lấy tất cả cuộc hội thoại đã xóa mềm
router.get('/admin/conversations/trash', [authMiddleware, adminMiddleware], (req, res) => {
  db.all("SELECT c.*, u.email FROM cuoc_hoi_thoai c JOIN nguoi_dung u ON c.ma_nguoi_dung = u.ma_nguoi_dung WHERE c.ngay_xoa IS NOT NULL ORDER BY ngay_xoa DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// USER: Lấy cuộc hội thoại của chính mình
router.get('/conversations', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return guestMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, (req, res) => {
  // P0-privacy: guest chỉ thấy conv của ĐÚNG session mình (ma_phien), không thấy conv guest khác.
  // (Trước đây: guest luôn nhận [] — mất sidebar; nhưng biết ID conv người khác vẫn đọc được.)
  if (!req.user) {
    if (!req.sessionID) return res.json([]);
    db.all("SELECT * FROM cuoc_hoi_thoai WHERE ma_nguoi_dung = ? AND ma_phien = ? AND ngay_xoa IS NULL ORDER BY da_ghim DESC, ngay_cap_nhat DESC", [GUEST_USER_ID, req.sessionID], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
    return;
  }
  const userId = req.user.id;
  db.all("SELECT * FROM cuoc_hoi_thoai WHERE ma_nguoi_dung = ? AND ngay_xoa IS NULL ORDER BY da_ghim DESC, ngay_cap_nhat DESC", [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Tìm kiếm hội thoại theo NỘI DUNG tin nhắn (full-text LIKE) — trả về danh sách id khớp
router.get('/conversations/search', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return guestMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ ids: [] });
  const like = '%' + q.toLowerCase() + '%';
  let where;
  const params = [];
  if (req.user) {
    where = 'ch.ma_nguoi_dung = ?';
    params.push(req.user.id);
  } else {
    if (!req.sessionID) return res.json({ ids: [] });
    where = 'ch.ma_nguoi_dung = ? AND ch.ma_phien = ?';
    params.push(GUEST_USER_ID, req.sessionID);
  }
  params.push(like);
  const sql = `SELECT DISTINCT ch.ma_hoi_thoai AS id
    FROM cuoc_hoi_thoai ch JOIN tin_nhan tn ON tn.ma_hoi_thoai = ch.ma_hoi_thoai
    WHERE ${where} AND ch.ngay_xoa IS NULL AND LOWER(tn.noi_dung) LIKE ? LIMIT 200`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ids: (rows || []).map((r) => r.id) });
  });
});

router.post('/conversations', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return guestMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, (req, res) => {
  const { tieu_de, ten_mo_hinh_ai } = req.body;
  const maHoiThoai = crypto.randomUUID();
  const userId = req.user ? req.user.id : GUEST_USER_ID;
  // P0-privacy: conv guest gắn ma_phien = session hiện tại → guest khác không sờ được.
  // Tạo conv là hành động thật → khởi tạo session (đánh dấu dirty + save) để cookie/sessionID ổn định.
  const maPhien = req.user ? null : (req.sessionID || null);
  const doInsert = () => {
    const sql = `
      INSERT INTO cuoc_hoi_thoai (ma_hoi_thoai, ma_nguoi_dung, ma_thu_muc, tieu_de, ten_mo_hinh_ai, trang_thai, ma_phien)
      VALUES (?, ?, ?, ?, ?, 'dang_mo', ?)
    `;
    db.run(sql, [maHoiThoai, userId, null, tieu_de || 'Trò chuyện mới', ten_mo_hinh_ai || 'Gemini 3.5 Flash', maPhien], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ma_hoi_thoai: maHoiThoai, tieu_de: tieu_de || 'Trò chuyện mới', ten_mo_hinh_ai: ten_mo_hinh_ai || 'Gemini 3.5 Flash' });
    });
  };
  if (!req.user && req.session) {
    req.session.messageCount = req.session.messageCount || 0;
    req.session.agentTaskCount = req.session.agentTaskCount || 0;
    if (typeof req.session.save === 'function') return req.session.save(() => doInsert());
  }
  doInsert();
});

// Ghim/bỏ ghim cuộc hội thoại (owner-only: user = chính nó, guest = đúng session)
router.post('/conversations/:id/pin', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return guestMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, (req, res) => {
  const { id } = req.params;
  const daGhim = (req.body && (req.body.da_ghim === 1 || req.body.da_ghim === true || req.body.da_ghim === '1')) ? 1 : 0;
  let sql = 'UPDATE cuoc_hoi_thoai SET da_ghim = ? WHERE ma_hoi_thoai = ? AND ngay_xoa IS NULL';
  const params = [daGhim, id];
  if (req.user) {
    sql += ' AND ma_nguoi_dung = ?';
    params.push(req.user.id);
  } else {
    if (!req.sessionID) return res.status(403).json({ error: 'Không có quyền ghim cuộc hội thoại này.' });
    sql += ' AND ma_nguoi_dung = ? AND ma_phien = ?';
    params.push(GUEST_USER_ID, req.sessionID);
  }
  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(403).json({ error: 'Không có quyền ghim cuộc hội thoại này.' });
    res.json({ success: true, id, da_ghim: daGhim });
  });
});

// GUEST: Lấy thông tin giới hạn
router.get('/guest-limits', (req, res) => {
  const limits = getGuestLimits(req);
  res.json({ success: true, limits, isLoggedIn: !!req.user });
});

// USER: Xóa cuộc hội thoại của chính mình
router.delete('/conversations/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // Soft delete: Cập nhật trường ngay_xoa
  db.run("UPDATE cuoc_hoi_thoai SET ngay_xoa = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ? AND ma_nguoi_dung = ?", [id, userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(403).json({ error: 'Không có quyền xóa cuộc hội thoại này.' });
    res.json({ success: true, id });
  });
});


// ADMIN: Phản hồi tin nhắn trong cuộc hội thoại (vai_tro: 'admin')
router.post('/admin/conversations/:id/reply', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  const { noi_dung } = req.body;
  if (!noi_dung || !noi_dung.trim()) {
    return res.status(400).json({ error: 'Nội dung tin nhắn không được trống' });
  }
  const maTinNhan = crypto.randomUUID();
  db.run(
    "INSERT INTO tin_nhan (ma_tin_nhan, ma_hoi_thoai, vai_tro, noi_dung) VALUES (?, ?, 'admin', ?)",
    [maTinNhan, id, noi_dung.trim()],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run("UPDATE cuoc_hoi_thoai SET ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [id]);
      res.json({
        ma_tin_nhan: maTinNhan,
        ma_hoi_thoai: id,
        vai_tro: 'admin',
        noi_dung: noi_dung.trim(),
        admin_name: req.user.ten_day_du || req.user.email
      });
    }
  );
});

// ADMIN: Xóa mềm bất kỳ cuộc hội thoại nào
router.delete('/admin/conversations/:id', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  db.run("UPDATE cuoc_hoi_thoai SET ngay_xoa = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id });
  });
});

// ADMIN: Khôi phục cuộc hội thoại đã xóa mềm
router.post('/admin/conversations/:id/restore', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  db.run("UPDATE cuoc_hoi_thoai SET ngay_xoa = NULL WHERE ma_hoi_thoai = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Không tìm thấy cuộc hội thoại đã xóa mềm.' });
    res.json({ success: true, id });
  });
});


// ADMIN: Xóa vĩnh viễn cuộc hội thoại
router.delete('/admin/conversations/:id/permanent', [authMiddleware, adminMiddleware], (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM tin_nhan WHERE ma_hoi_thoai = ?", [id], (err) => {
    if (err) {
      console.error('[Conversations Delete Messages Error]', err.message);
    }
    db.run("DELETE FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?", [id], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ success: true, id });
    });
  });
});

router.get('/keys', [authMiddleware, adminMiddleware], (req, res) => {
  // Xóa dứt điểm các provider đã loại bỏ khỏi CSDL
  const REMOVED = ['bazaarlink', 'kiraai', 'ollama', 'freellmapi', 'tokenrouter'];
  const ph = REMOVED.map(() => '?').join(',');
  db.run(`DELETE FROM khoa_api WHERE LOWER(ten_nha_cung_cap) IN (${ph})`, REMOVED);
  db.run(`DELETE FROM model_scan_cache WHERE LOWER(ma_nha_cung_cap) IN (${ph})`, REMOVED);
  db.run(`UPDATE ai_models SET kich_hoat = 0 WHERE LOWER(ma_nha_cung_cap) IN (${ph})`, REMOVED);

  db.all("SELECT ma_khoa, ten_nha_cung_cap, gia_tri_khoa FROM khoa_api", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // CHE DẤU API KEY: an toàn với mọi độ dài key
    const maskedRows = rows.map(row => ({
      ma_khoa: row.ma_khoa,
      ten_nha_cung_cap: row.ten_nha_cung_cap,
      gia_tri_khoa: row.gia_tri_khoa
        ? (row.gia_tri_khoa.length > 8
            ? row.gia_tri_khoa.substring(0, 4) + '...' + row.gia_tri_khoa.substring(row.gia_tri_khoa.length - 4)
            : '****')
        : '(trống)'
    }));
    res.json(maskedRows);
  });
});

router.post('/keys', [authMiddleware, adminMiddleware], (req, res) => {
  const { provider, api_key } = req.body;
  if (!provider || !api_key) return res.status(400).json({ error: 'Thiếu thông tin Provider hoặc API Key' });

  const keyId = 'k_' + provider;
  
  db.run(
    `INSERT INTO khoa_api (ma_khoa, ma_nguoi_dung, ten_nha_cung_cap, gia_tri_khoa) 
     VALUES (?, ?, ?, ?) 
     ON CONFLICT(ma_khoa) DO UPDATE SET gia_tri_khoa = excluded.gia_tri_khoa`,
    [keyId, req.user.id, provider, encryptKey(api_key.trim())],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, provider });
    }
  );
});

router.post('/fetch-models', authMiddleware, async (req, res) => {
  const { provider, api_key, base_url } = req.body;

  const cacheKey = getModelCacheKey(provider, api_key, base_url);

  // 1. Check cache first
  if (cacheKey && modelCache.has(cacheKey)) {
    const cachedData = modelCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return res.json({ success: true, models: cachedData.models, fromCache: true });
    }
  }

  // 2. Proceed to fetch if not in cache or expired
  if (!api_key && !['opencode'].includes(provider)) {
    return res.status(400).json({ error: 'Vui lòng nhập API Key để quét models.' });
  }

  try {
    let modelsList = [];

    if (provider === 'gemini') {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key.trim()}`);
      const data = await resp.json();
      if (data.models && Array.isArray(data.models)) {
        modelsList = data.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
          .map(m => m.name.replace(/^models\//, ''));
      } else if (data.error) {
        return res.json({ success: false, error: 'Gemini: ' + data.error.message });
      }

    } else if (provider === 'groq') {
      const resp = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': 'Bearer ' + api_key.trim() }
      });
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        modelsList = data.data
          .filter(m => {
            const outMod = m.output_modalities || [];
            return outMod.includes('text');
          })
          .map(m => m.id);
      } else if (data.error) {
        return res.json({ success: false, error: 'Groq: ' + (data.error.message || JSON.stringify(data.error)) });
      }

    } else if (provider === 'openai') {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': 'Bearer ' + api_key.trim() }
      });
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        modelsList = data.data
          .map(m => m.id)
          .filter(id => /^(gpt|o1|o3|o4|chatgpt)/i.test(id))
          .sort();
      } else if (data.error) {
        return res.json({ success: false, error: 'OpenAI: ' + data.error.message });
      }

    } else if (provider === 'deepseek') {
      const resp = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': 'Bearer ' + api_key.trim() }
      });
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        modelsList = data.data.map(m => m.id);
      } else if (data.error) {
        return res.json({ success: false, error: 'DeepSeek: ' + (data.error.message || JSON.stringify(data.error)) });
      }

    } else if (provider === 'claude') {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': api_key.trim(),
          'anthropic-version': '2023-06-01'
        }
      });
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        modelsList = data.data.map(m => m.id);
      } else if (data.models && Array.isArray(data.models)) {
        modelsList = data.models.map(m => m.id || m.name);
      } else if (data.error) {
        return res.json({ success: false, error: 'Claude: ' + (data.error.message || JSON.stringify(data.error)) });
      }

    } else if (provider === 'github') {
      const resp = await fetch('https://models.github.ai/inference/models', {
        headers: { 'Authorization': 'Bearer ' + api_key.trim() }
      });
      const data = await resp.json();
      if (Array.isArray(data)) {
        modelsList = data.map(m => m.name || m.id);
      } else if (data.data && Array.isArray(data.data)) {
        modelsList = data.data.map(m => m.id || m.name);
      } else if (data.error) {
        return res.json({ success: false, error: 'GitHub Models: ' + (data.error.message || JSON.stringify(data.error)) });
      } else {
        // KHÔNG dùng danh sách model mẫu — trả lỗi để thấy API trả sai định dạng
        return res.json({ success: false, error: 'GitHub Models: API trả về định dạng không hợp lệ (không dùng dữ liệu mẫu)' });
      }

    } else if (provider === 'custom') {
      const cleanedBase = (base_url || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const endpoint = cleanedBase.endsWith('/models') ? cleanedBase : cleanedBase + '/models';
      const resp = await fetch(endpoint, {
        headers: { 'Authorization': 'Bearer ' + api_key.trim() }
      });
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        modelsList = data.data.map(m => m.id);
      } else if (Array.isArray(data)) {
        modelsList = data.map(m => m.id || m.name || m);
      } else if (data.error) {
        return res.json({ success: false, error: 'Custom: ' + (data.error.message || JSON.stringify(data.error)) });
      }

    } else if (provider === 'opencode') {
      try {
        if (!IS_OPENCODE_AVAILABLE) throw new Error('OpenCode binary not found.');
        const stdout = safeExecSync(`"${OPENCODE_BIN_PATH}" models`, { 
          encoding: 'utf8', 
          timeout: 5000,
          env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
        });
        if (stdout) {
          const rawList = stdout.split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);
          
          const freeModels = rawList.filter(m => m.toLowerCase().includes('free'));
          const otherModels = rawList.filter(m => !m.toLowerCase().includes('free'));
          modelsList = [...freeModels, ...otherModels];
        }
      } catch (errModels) {
        // KHÔNG chèn model mẫu khi CLI lỗi — báo lỗi rõ ràng
        return res.json({ success: false, error: 'OpenCode: ' + (errModels.message || 'CLI lỗi — không thể lấy danh sách model') });
      }
    }

    if (modelsList.length > 0) {
      // 3. Store successful fetch in cache
      if (cacheKey) {
        modelCache.set(cacheKey, {
          models: modelsList,
          timestamp: Date.now()
        });
      }
      res.json({ success: true, models: modelsList, fromCache: false });
    } else {
      res.json({ success: false, error: 'Không tìm thấy model nào cho API Key này.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error scanning models: ' + err.message });
  }
});

// ADMIN: Xóa cache models thủ công
router.post('/admin/cache/clear-models', [authMiddleware, adminMiddleware], (req, res) => {
  const cacheSize = modelCache.size;
  modelCache.clear();
  console.log(`[Admin] Đã xóa ${cacheSize} mục khỏi cache models.`);
  res.json({ success: true, message: `Đã xóa thành công ${cacheSize} mục khỏi cache models.` });
});

router.get('/conversations/:id/messages', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return guestMiddleware(req, res, next);
  return authMiddleware(req, res, next);
}, async (req, res) => {
  const { id } = req.params;
  // P1-09: dùng chung assertConvOwner (user + guest qua GUEST_USER_ID, chặn conv đã xóa mềm)
  const ownerErr = await assertConvOwner(id, req);
  if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });
  db.all("SELECT * FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC", [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

function taoTieuDeThongMinh(noiDungUser) {
  if (!noiDungUser) return "Trò chuyện mới";
  let clean = noiDungUser.split('\n')[0].replace(/[#*`!_\[\]()]/g, '').trim();
  if (clean.length > 35) {
    clean = clean.substring(0, 35) + "...";
  }
  return clean || "Trò chuyện mới";
}

function cleanAIThinkingProcess(text) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text;

  // 1. Loại bỏ các thẻ suy luận <think>...</think>
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Loại bỏ đoạn nháp suy luận bằng tiếng Anh "Here's a thinking process: ..."
  if (/Here'?s a thinking process:/i.test(cleaned)) {
    const finalMatch = cleaned.match(/(?:Output matches draft|Final Output|Output):\s*([✅\s\S]+)$/i);
    if (finalMatch && finalMatch[1]) {
      cleaned = finalMatch[1].replace(/^[✅\s]+/, '').trim();
    } else {
      const draftMatch = cleaned.match(/Draft:\s*"([^"]+)"/i);
      if (draftMatch && draftMatch[1]) {
        cleaned = draftMatch[1].trim();
      } else {
        const parts = cleaned.split(/\n\n+/);
        const nonThinkingParts = parts.filter(p => !/Here'?s a thinking process:/i.test(p) && !/^\d+\.\s*\*\*/.test(p.trim()));
        if (nonThinkingParts.length > 0) {
          cleaned = nonThinkingParts.join('\n\n').trim();
        }
      }
    }
  }

  return cleaned || text;
}

// P3: tổng dung lượng ảnh data-URL trong 1 tin nhắn ≤ 5MB (base64 phình ~33% → giữ payload < express.json 10mb)
function validateImageAttachments(noiDung) {
  if (!noiDung || typeof noiDung !== 'string') return null;
  const imgRe = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;
  let total = 0, m, count = 0;
  while ((m = imgRe.exec(noiDung)) !== null) {
    total += m[1].length;
    count++;
  }
  if (count > 4) return 'Tối đa 4 ảnh mỗi tin nhắn.';
  if (total > 5 * 1024 * 1024) return 'Tổng dung lượng ảnh quá lớn (tối đa ~5MB). Hãy nén hoặc giảm số ảnh gửi kèm.';
  return null;
}

function saveAIMessageAndRespond(maHoiThoai, content, res) {
  const cleanContent = cleanAIThinkingProcess(content);
  const maTinNhanAI = crypto.randomUUID();
  db.run(
    "INSERT INTO tin_nhan (ma_tin_nhan, ma_hoi_thoai, vai_tro, noi_dung) VALUES (?, ?, 'assistant', ?)",
    [maTinNhanAI, maHoiThoai, cleanContent],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        ma_tin_nhan: maTinNhanAI,
        ma_hoi_thoai: maHoiThoai,
        vai_tro: 'assistant',
        noi_dung: cleanContent
      });
    }
  );
}

// Endpoint cho khách và người đã đăng nhập
router.post('/conversations/:id/messages', rateLimit({ windowMs: 60000, max: 60 }), (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // Nếu không có token -> là khách -> dùng guestMiddleware
    return guestMiddleware(req, res, next);
  }
  // Nếu có token -> là user -> dùng authMiddleware
  return authMiddleware(req, res, next);
}, async (req, res) => {
  const { id } = req.params;
  // P2-19a: vai_tro từ body không đáng tin (user tự gắn 'admin' → bubble admin giả).
  // Ép 'user' — chỉ POST /admin/.../reply mới được tạo vai_tro='admin'.
  const { vai_tro: _roleIgnored, noi_dung, provider, client_api_key, model_name, base_url, mode, execution_mode, thinking_level, skill_id } = req.body;
  const vai_tro = 'user';

  // P3: chặn data-URL ảnh quá lớn — 1 ảnh base64 ~7MB + express.json 10mb → payload 10.5MB bị 413 ẩn
  const oversizeErr = validateImageAttachments(noi_dung);
  if (oversizeErr) return res.status(413).json({ error: oversizeErr });

  // P1-09: chặn IDOR — chỉ chủ sở hữu (hoặc admin) mới được nhắn vào hội thoại này
  const ownerErr = await assertConvOwner(id, req);
  if (ownerErr) return res.status(ownerErr.status).json({ error: ownerErr.error });

  // Logic xử lý tin nhắn giữ nguyên...
  const maTinNhanUser = crypto.randomUUID();
  
  db.run(
    "INSERT INTO tin_nhan (ma_tin_nhan, ma_hoi_thoai, vai_tro, noi_dung) VALUES (?, ?, ?, ?)",
    [maTinNhanUser, id, vai_tro, noi_dung],
    async (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Tăng số lượng tin nhắn đã dùng cho khách CHỈ KHI thực sự gửi tin nhắn thành công
      // P3-fix: saveUninitialized:false → phải save() tay để session (kể cả session mới) được ghi xuống store
      if (!req.user && req.session) {
        req.session.messageCount = (req.session.messageCount || 0) + 1;
        if (typeof req.session.save === 'function') req.session.save(() => {});
      }

      db.get("SELECT tieu_de FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?", [id], (err, convRow) => {
        if (convRow && (convRow.tieu_de === 'Trò chuyện mới' || !convRow.tieu_de)) {
          const newTitle = taoTieuDeThongMinh(noi_dung);
          db.run("UPDATE cuoc_hoi_thoai SET tieu_de = ?, ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [newTitle, id]);
        } else {
          db.run("UPDATE cuoc_hoi_thoai SET ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [id]);
        }
      });

      if (execution_mode === 'agent') {
        // Cho phép tất cả user đã đăng nhập + Guest sử dụng Agent Mode
        const isAdmin = req.user && req.user.role === 'admin';
        const isGuest = !req.user;
        
        if (isGuest && req.session.agentTaskCount >= 3) {
          const errorMessage = "🔒 **Đã hết lượt Agent Mode miễn phí!**\n\nBạn đã sử dụng hết **3 tasks** Agent cho khách.\n\nĐăng nhập để:\n✅ Agent Mode không giới hạn\n✅ Chat không giới hạn\n✅ Lưu lịch sử & Memory";
          return saveAIMessageAndRespond(id, errorMessage, res);
        }

        // Tăng counter cho guest (P3-fix: save() tay cho saveUninitialized:false)
        if (isGuest) {
          req.session.agentTaskCount = (req.session.agentTaskCount || 0) + 1;
          if (typeof req.session.save === 'function') req.session.save(() => {});
        }

        // Engine: 'opencode' / 'dsh' / 'auto' (tự chọn theo độ phức tạp task)
        const requestedEngine = String(req.body.agent_engine || 'auto').trim().toLowerCase();
        const agentEngineName = agentEngine.pickEngine(noi_dung, requestedEngine);

        // Null/empty check cho Agent Mode để tránh spawn process vô nghĩa
        if (!noi_dung || !noi_dung.trim()) {
          const errorMessage = "⚠️ **Lỗi:** Nội dung tin nhắn trống. Vui lòng nhập yêu cầu trước khi chạy Agent Mode.";
          return saveAIMessageAndRespond(id, errorMessage, res);
        }

        if (!agentEngine.isEngineAvailable(agentEngineName)) {
          // G1/G2: opencode.exe/dsh không có trên server (cloud) → chạy Agent nội bộ
          // (ReAct qua API provider — internalAgent) thay vì trả lỗi chết.
          try {
            const { runInternalAgent } = require('../services/internalAgent');
            const result = await runInternalAgent(noi_dung, { model: model_name, provider });
            if (result && result.success && result.answer) {
              return saveAIMessageAndRespond(id, result.answer + '\n\n> ⚙️ _Chạy bằng Agent nội bộ (engine ngoài không có trên server)._', res);
            }
            return saveAIMessageAndRespond(id, '⚠️ Agent nội bộ chưa hoàn thành: ' + ((result && result.error) || 'không rõ lý do'), res);
          } catch (fbErr) {
            return saveAIMessageAndRespond(id, '⛔ **Lỗi hệ thống:** Agent nội bộ cũng lỗi — ' + fbErr.message, res);
          }
        }

        const rootDir = path.join(__dirname, '..', '..', '..');

        // Nếu dùng dsh → resolve provider theo model user chọn (như opencode -m),
        // key lấy từ khoa_api qua env REXI_<PROV>_KEY (giữ XKIRO_API_KEY cho settings.yaml cũ)
        let extraEnv = {};
        let dshProv = '';
        if (agentEngineName === 'dsh') {
          dshProv = await agentEngine.resolveDshProvider(model_name, provider);
          const provKey = await getProviderApiKey(dshProv);
          if (provKey) {
            extraEnv[agentEngine.dshKeyEnvName(dshProv)] = provKey;
            if (dshProv === 'xkiro') extraEnv.XKIRO_API_KEY = provKey;
          }
          if (!provKey) {
            const errorMessage = `⚠️ **Lỗi:** Chưa có API key provider \`${dshProv}\` trong hệ thống. Admin cần lưu key provider này trước khi dùng Agent DSH.`;
            return saveAIMessageAndRespond(id, errorMessage, res);
          }
        }

        // Chạy agent engine (opencode hoặc dsh) — đọc/sửa file, chạy lệnh trong rootDir
        const result = await agentEngine.runAgentEngine(agentEngineName, noi_dung, model_name, rootDir, extraEnv, dshProv);

        let cauTraLoiAgent = "";
        if (result.code !== 0) {
          cauTraLoiAgent = result.stdout.trim() || result.stderr.trim() || `[Agent Error] Process exited with code ${result.code}`;
        } else {
          cauTraLoiAgent = result.stdout.trim() || "Tôi đã tự động thực thi các câu lệnh và cập nhật tệp tin thành công cho bạn.";
        }
        return saveAIMessageAndRespond(id, cauTraLoiAgent, res);
      }

      let selectedProvider = provider || 'gemini';
      let selectedModel = model_name || 'gemini-2.5-flash'; // gemini-1.5-flash đã bị Google khai tử (404)
      let keyToUse = client_api_key;
      
      if (client_api_key && client_api_key.trim()) {
        if (req.user && req.user.role === 'admin') {
          const keyId = 'k_' + selectedProvider;
          db.run(
            `INSERT INTO khoa_api (ma_khoa, ma_nguoi_dung, ten_nha_cung_cap, gia_tri_khoa) VALUES (?, ?, ?, ?) ON CONFLICT(ma_khoa) DO UPDATE SET gia_tri_khoa = excluded.gia_tri_khoa`,
            [keyId, req.user.id, selectedProvider, encryptKey(client_api_key.trim())]
          );
        }
      }

      // Ưu tiên lấy API key:
      // 1. CSDL khoa_api lưu bởi Admin cho đúng provider
      // 2. Client gửi lên (client_api_key)
      // 3. Env var GEMINI_API_KEY (nếu provider là gemini)
      const dbKeyRow = await new Promise((resDb) => {
        db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = LOWER(?)", [selectedProvider], (err, r) => resDb(r));
      });
      if (dbKeyRow && dbKeyRow.gia_tri_khoa && dbKeyRow.gia_tri_khoa.trim()) {
        keyToUse = decryptKey(dbKeyRow.gia_tri_khoa).trim();
      } else if (client_api_key && client_api_key.trim()) {
        keyToUse = client_api_key.trim();
      }

      // Fetch base_url from ai_providers table for custom providers
      const providerRow = await new Promise((resProv) => {
        db.get("SELECT base_url FROM ai_providers WHERE ma_nha_cung_cap = ?", [selectedProvider], (err, r) => resProv(r));
      });
      let baseUrl = providerRow && providerRow.base_url ? providerRow.base_url : null;

      if (!keyToUse && selectedProvider === 'gemini' && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE') {
        keyToUse = process.env.GEMINI_API_KEY;
      }

      if (!keyToUse && !['opencode', 'kilo'].includes(selectedProvider)) {
        // Fallback: nếu đã cài opencode.exe, cho phép dùng miễn phí thay vì chặn
        // kilo keyless (10/2026): không cần API key — cho qua như opencode
        if (IS_OPENCODE_AVAILABLE && selectedProvider !== 'kilo') {
          selectedProvider = 'opencode';
          selectedModel = 'nvidia/google/gemma-4-31b-it';
        } else {
          const fallbackMsg = `Chưa cài đặt API Key cho nhà cung cấp ${selectedProvider.toUpperCase()}. Hãy bấm nút 'Cài đặt hệ thống' ở góc trái để nhập Key và chọn Model!`;
          return saveAIMessageAndRespond(id, fallbackMsg, res);
        }
      }

      // Lấy lịch sử chat: tăng từ 15 lên 30 để giữ ngữ cảnh tốt hơn
      db.all("SELECT vai_tro, noi_dung FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC LIMIT 30", [id], async (err, history) => {
         if (err) { saveAIMessageAndRespond(id, '⚠️ Lỗi đọc lịch sử chat.', res); return; }
         history = history || [];
         history.push({ vai_tro: 'user', noi_dung: noi_dung });
         let cauTraLoiAI = "";

        const { user_location } = req.body;
        const now = new Date();
        const nowFormatted = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const locationStr = user_location || 'Hà Nội, Việt Nam';

        const userIdForBrain = req.user ? req.user.id : GUEST_USER_ID;
        const messageText = noi_dung;

        // --- Rexi AI BRAIN: tự lưu memory + cập nhật profile (fire-and-forget, không chặn chat) ---
        // P0-privacy: CHỈ user đăng nhập mới có memory/profile. Guest dùng chung
        // GUEST_USER_ID → lưu memory guest = rò rỉ thông tin cá nhân cho mọi guest khác.
        if (req.user) {
        try {
          const _brainEnt = extractEntities(messageText);
          if (_brainEnt) {
            Promise.resolve(saveMemoryAuto(userIdForBrain, messageText)).catch(() => {});
            Promise.resolve(updateProfileFromMessage(userIdForBrain, _brainEnt)).catch(() => {});
          }
        } catch (e) { /* brain không bao giờ được chặn chat */ }
        }

        // --- Rexi AI BRAIN: load memory thông minh (priority + keyword match) + profile ---
        // P0-privacy: guest KHÔNG đọc memory/profile chung (chứa dữ liệu người khác).
        let memoryText = '';
        let profileText = '';
        if (req.user) {
        try {
          const memResult = await loadSmartMemory(userIdForBrain, messageText);
          memoryText = memResult ? memResult.text : '';
        } catch (e) {}
        try {
          const profile = await brain.getProfile(userIdForBrain);
          profileText = profile ? brain.formatToPromptText(profile) : '';
        } catch (e) { /* brain không bao giờ được chặn chat */ }
        }
        // ─── RAG: tự tìm FILE liên quan theo NGHĨA (PDF/Word/TXT đã upload) ───
        let ragText = '';
        try {
          const ragHits = await searchDocuments(userIdForBrain, messageText, 3);
          if (ragHits && ragHits.length > 0) {
            ragText = '\n\n📄 TÀI LIỆU CỦA NGƯỜI DÙNG (trả lời dựa trên nội dung này nếu liên quan):\n' +
              ragHits.map(h => `- [${h.ten_file}] ${h.noi_dung}`).join('\n');
          }
        } catch (eRag) { console.log('[RAG] context error:', eRag.message); }

        // ─── AUTO: tìm web khi cần + tóm tắt hội thoại dài ───
        const { webSearchText, summaryText } = await buildAutoContext(req, id, noi_dung);

        const SPECIALTY_PROMPTS = {
          general: 'Bạn là Rexi, Siêu Trợ Lý AI Toàn Năng giúp giải quyết mọi câu hỏi cuộc sống, công việc, văn phòng và phân tích.',
          business: 'Bạn là Chuyên Gia Doanh Nghiệp & Cố Vấn Pháp Lý hàng đầu. Hãy tập trung viết hợp đồng kinh tế, công văn hành chính, kế hoạch tài chính và chiến lược kinh doanh chuyên nghiệp.',
          marketing: 'Bạn là Giám Đốc Marketing & Sáng Tạo Nội Dung Viral. Hãy tập trung viết kịch bản TikTok/Reels triệu view, bài viết SEO, Slogan ấn tượng và kịch bản chốt đơn bán hàng.',
          education: 'Bạn là Giáo Sư & Chuyên Gia Phân Tích Đa Ngành. Hãy tập trung tóm tắt tài liệu, phân tích chuyên sâu, lập lộ trình học tập và giải đáp tri thức.',
          health: 'Bạn là Chuyên Gia Dinh Dưỡng & Huấn Luyện Viên Sức Khỏe. Hãy tập trung lập thực đơn dinh dưỡng, bài tập Gym/Calisthenics và tư vấn tâm lý đời sống.',
          coder: 'Bạn là Senior Software Engineer & System Architect. Tập trung viết code sạch, tối ưu, thiết kế kiến trúc hệ thống và sửa bug.'
        };

        const currentRolePrompt = SPECIALTY_PROMPTS[mode] || SPECIALTY_PROMPTS.general;

        // Load TẤT CẢ skills từ DB và inject vào system prompt
        let skillInstruction = '';
        try {
          const skillRouter = require('../services/skillRouter');
          const allSkills = await new Promise((resolve) => {
            db.all("SELECT ten_ky_nang, tieu_de, mo_ta FROM ky_nang WHERE trang_thai = 'kich_hoat'", [], (err, rows) => resolve(rows || []));
          });
          skillInstruction = await skillRouter.buildSkillPrompt(noi_dung, allSkills);
          if (!skillInstruction) {
            skillInstruction = `

📚 **KỸ NĂNG AGENT CỦA REXI:** Bạn có ${(allSkills || []).length} skills chuyên dụng (thiết kế, code, văn phòng, video, TTS, IPTV...). Nếu người dùng yêu cầu chuyên môn, hãy áp dụng đúng quy trình.`;
          }
        } catch (skillErr) {
          console.log('[Skill] Lỗi load skills:', skillErr.message);
        }

        let systemPrompt = `${currentRolePrompt} Bây giờ là ${nowFormatted} (Giờ Việt Nam). Vị trí địa lý ước tính của người dùng: ${locationStr}.
${ragText}${webSearchText}${summaryText}
${profileText || ''
}
BỘ NHỚ DÀI HẠN VỀ NGƯỜI DÙNG & QUY TẮC CỦA REXI:
${memoryText || '- Người dùng thích làm việc chuyên nghiệp, nội dung ngắn gọn, súc tích, thực tế và chính xác.'}

- NGUYÊN TẮC QUAN TRỌNG: Không lặp lại các câu miễn trừ trách nhiệm. Hãy trả lời thẳng vấn đề, tự nhiên, thân thiện, chu đáo và nâng cao trải nghiệm người dùng đến tận răng.${skillInstruction}`;

        // Giới hạn tổng độ dài system prompt để tránh vượt context limit model
        const MAX_SYSTEM_PROMPT = 6000;
        if (systemPrompt.length > MAX_SYSTEM_PROMPT) {
          systemPrompt = systemPrompt.substring(0, MAX_SYSTEM_PROMPT) + '\n\n[...đã cắt ngắn system prompt để phù hợp context limit...]';
        }

        // AgentRouter chặn nội dung không phải tiếng Anh → gửi system prompt tiếng Anh
        if (selectedProvider === 'agentrouter') {
          systemPrompt = `You are Rexi, an all-in-one AI assistant. Current time: ${nowFormatted} (Vietnam time). User's estimated location: ${locationStr}.\n${ragText}\n${profileText || ''}\nLONG-TERM MEMORY ABOUT THE USER & REXI RULES:\n${memoryText || '- The user prefers professional, concise, practical and accurate answers.'}\n\n- IMPORTANT RULE: Do not repeat disclaimers. Answer directly, naturally, friendly and helpfully.${skillInstruction}`;
        }

        // ─── AUTO-RESEARCH: có link → tự đọc; hỏi thông tin → tự search web (zero-config) ───
        try {
          const research = await require('../services/autoResearch').gather(noi_dung);
          if (research) systemPrompt += `\n\n[DỮ LIỆU TRA CỨU WEB TỰ ĐỘNG — BẮT BUỘC ưu tiên dùng phần này để trả lời chính xác; tóm tắt ý chính và nêu nguồn (URL) khi phù hợp; nếu nội dung không liên quan câu hỏi thì bỏ qua]\n${research}`;
        } catch (e) { /* không chặn chat nếu tra cứu lỗi */ }

        // ─── AUTO ROUTER: model = 'auto' → phân loại câu hỏi + chọn model thông minh ───
        let autoRouteInfo = null;
        const isAutoModel = String(model_name || '').trim() === 'auto' || String(model_name || '').trim() === 'auto/' + selectedProvider;
        if (isAutoModel) {
          const hasImage = /data:image\/(png|jpe?g|gif|webp)/i.test(String(noi_dung || ''));
          const userTier = !req.user ? 'guest' : (req.user.role === 'admin' || req.user.phan_quyen === 'admin' ? 'admin' : 'user');
          const route = await modelRouter.pickRoute(noi_dung, { thinkingLevel: req.body.thinking_level, hasImage, userTier });
          if (route.candidates && route.candidates.length) {
            autoRouteInfo = { route, index: 0 };
            selectedProvider = route.candidates[0].provider;
            selectedModel = route.candidates[0].model;
            // Lấy key + baseUrl cho provider được router chọn
            const rp = await modelRouter.resolveProvider(selectedProvider);
            if (rp.apiKey) keyToUse = rp.apiKey;
            if (rp.baseUrl) baseUrl = rp.baseUrl;
            // Ghi telemetry để admin xem thống kê định tuyến
            telemetry.recordRoute({ provider: selectedProvider, model: selectedModel, category: route.category, userTier });
          }
        }

        try {
          if (selectedProvider === 'gemini') {
            const tempGenAI = new GoogleGenerativeAI(keyToUse);
            let targetModel = selectedModel || 'gemini-2.5-flash';
            let model;
            try {
              model = tempGenAI.getGenerativeModel({ model: targetModel });
            } catch (e) {
              model = tempGenAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            }
            const contents = chatExecutor.buildHistoryGemini(history);
            
            // CHỈ gửi thinkingConfig khi user chọn thinking_level = 'deep'.
            // KHÔNG gửi thinkingBudget: 0 — một số model Gemini mới (3.x)
            // trả lỗi 400 INVALID_ARGUMENT khi nhận thinkingBudget = 0.
            const genConfig = {};
            if (thinking_level === 'deep') {
              genConfig.thinkingConfig = { thinkingBudget: 8192 };
            }

            try {
              const result = await model.generateContent({ contents, systemInstruction: systemPrompt, generationConfig: genConfig });
              cauTraLoiAI = result.response.text();
            } catch (errGen) {
              // P1-10: throttle đúng 429/5xx thật (SDK Gemini không luôn gắn .status → parse từ message)
              const _gm = String(errGen && errGen.message || '');
              const _gst = (errGen && errGen.status) || (parseInt((_gm.match(/\[(429|5\d\d)\D/)||[])[1], 10) || 0);
              if (_gst === 429 || (_gst >= 500 && _gst <= 599)) {
                try { quotaManager.recordThrottle(selectedProvider); } catch {}
              }
              if (IS_OPENCODE_AVAILABLE) {
                const rootDir = path.join(__dirname, '..', '..', '..');
                await new Promise((resOp) => {
                  const fallbackProcess = spawn(
                    OPENCODE_BIN_PATH,
                    ['run', noi_dung, '--auto', '--pure', '--title', 'agent-task'],
                    { cwd: rootDir, timeout: 300000, env: NO_COLOR_ENV, stdio: ['ignore', 'pipe', 'pipe'] }
                  );
                  let stdout = '';
                  fallbackProcess.stdout.on('data', data => { stdout += stripAnsi(data.toString()); });
                  fallbackProcess.on('close', () => {
                      cauTraLoiAI = stdout.trim() || `[OpenCode Fallback] Đã thử thực thi tác vụ.`;
                      resOp();
                  });
                  fallbackProcess.on('error', () => {
                      cauTraLoiAI = `[OpenCode Fallback] Lỗi thực thi tác vụ.`;
                      resOp();
                  });
                });
              } else if (autoRouteInfo && autoRouteInfo.route && autoRouteInfo.route.candidates.length > 1) {
                // FALLBACK CHUỖI: Gemini lỗi → thử candidate kế tiếp (giống path OpenAI-compatible)
                try {
                  const result = await chatExecutor.callWithFallback(autoRouteInfo.route.candidates.slice(1), {
                    systemPrompt,
                    history,
                    thinkingLevel: req.body.thinking_level,
                  });
                  if (result.ok) {
                    cauTraLoiAI = result.content;
                    console.log(`[AutoFallback] ${selectedProvider} lỗi (gemini path) → đã chuyển sang ${result.provider}/${result.model}`);
                  } else {
                    cauTraLoiAI = chatExecutor.friendlyFail({ errors: result.errors, candidates: autoRouteInfo.route.candidates });
                  }
                } catch (fbErr) {
                  console.error('[AutoFallback gemini] error:', fbErr.message);
                  cauTraLoiAI = `Lỗi gọi Gemini và không thể sử dụng OpenCode fallback: ${errGen.message}`;
                }
              } else {
                cauTraLoiAI = `Lỗi gọi Gemini và không thể sử dụng OpenCode fallback: ${errGen.message}`;
              }
            }

          } else if (['openai', 'deepseek', 'groq', 'github', 'custom', 'xkiro', 'agentrouter', 'bai', 'kiosapi', 'unorouter', 'nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kiraai', 'bazaarlink', 'opencode', 'kilo',].includes(selectedProvider)) {
            // ─── KILO QUOTA: chia lượt Kilo free theo từng người (rolling 1h) ───
            if (selectedProvider === 'kilo') {
              const kq = kiloQuota.allow(req);
              if (!kq.ok) {
                return saveAIMessageAndRespond(id, kiloQuota.message(kq, !req.user), res);
              }
            }
            let endpoint = "https://api.openai.com/v1/chat/completions";
            if (selectedProvider === 'deepseek') endpoint = "https://api.deepseek.com/chat/completions";
            else if (selectedProvider === 'groq') endpoint = "https://api.groq.com/openai/v1/chat/completions";
            else if (selectedProvider === 'github') endpoint = "https://models.github.ai/inference/chat/completions";
            else if (selectedProvider === 'custom') {
              const cleanedBase = (baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, '');
              endpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : `${cleanedBase}/chat/completions`;
            } else if (selectedProvider === 'xkiro') {
              const cleanedBase = (baseUrl || "https://api.xkiro.com/v1").replace(/\/+$/, '');
              endpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : `${cleanedBase}/chat/completions`;
            } else if (selectedProvider === 'kilo') {
              // kilo keyless (10/2026): base 2 segment KHÔNG /v1; model ID đầy đủ kiểu OpenRouter
              const cleanedBase = (baseUrl || "https://kilo.ai/api/openrouter").replace(/\/+$/, '');
              endpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : `${cleanedBase}/chat/completions`;
            } else if (['bai', 'kiosapi', 'unorouter'].includes(selectedProvider)) {
              const NEW_BASES = { bai: 'https://api.b.ai/v1', kiosapi: 'https://kiosapi.com/v1', unorouter: 'https://api.unorouter.com/v1' };
              const cleanedBase = (baseUrl || NEW_BASES[selectedProvider]).replace(/\/+$/, '');
              endpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : `${cleanedBase}/chat/completions`;
            } else if (selectedProvider === 'agentrouter') {
              const cleanedBase = (baseUrl || "https://agentrouter.org/v1").replace(/\/+$/, '');
              endpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : `${cleanedBase}/chat/completions`;
            } else if (baseUrl) {
              endpoint = baseUrl + "/chat/completions";
            }

            const formattedMessages = [
              { role: "system", content: systemPrompt },
              ...history.map(h => ({
                role: h.vai_tro === 'user' ? 'user' : 'assistant',
                content: h.vai_tro === 'user' ? buildOpenAIContent(h.noi_dung) : h.noi_dung
              }))
            ];
            let finalModel = smartModelOverride(selectedProvider, selectedModel, noi_dung, req.body.thinking_level);
            if (selectedProvider === 'agentrouter') finalModel = finalModel.replace(/^agentrouter\//, '');
            if (['nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kiraai', 'bazaarlink'].includes(selectedProvider)) finalModel = finalModel.replace(new RegExp('^' + selectedProvider + '/'), '');
            if (selectedProvider === 'opencode') finalModel = finalModel.replace(/^opencode\//, '');

            const fetchHeaders = {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*',
              'Authorization': `Bearer ${keyToUse}`
            };
            if (selectedProvider === 'agentrouter') fetchHeaders['User-Agent'] = 'opencode/1.17.12';
            // opencode Zen free models KHÔNG cần Authorization (gửi key sai sẽ bị 401)
            if (selectedProvider === 'opencode') delete fetchHeaders['Authorization'];
            // kilo KEYLESS — không gửi Authorization (Bearer rỗng/sai → 401 "token invalid")
            if (selectedProvider === 'kilo') delete fetchHeaders['Authorization'];
            // kilo giữ nguyên model ID đầy đủ (nvidia/...:free) — gateway cần full ID, KHÔNG strip prefix

            const response = await fetch(endpoint, {
              method: 'POST',
              headers: fetchHeaders,
              body: JSON.stringify({
                model: finalModel,
                messages: formattedMessages,
                temperature: 0.7,
                max_tokens: thinking_level === 'deep' ? 16384 : 4096
              }),
              signal: AbortSignal.timeout(streamTimeoutMs(req.body.thinking_level)) // P1-10: fail-fast theo level
            });

            const data = await response.json();
            if (data.choices && data.choices.length > 0) {
              const msg = data.choices[0].message;
              // Reasoning models (e.g. BazaarLink deepseek-v4-flash:free) có thể trả content rỗng
              // nhưng nội dung thật nằm trong field reasoning/reasoning_details
              // Model đa phương thức (Qwen omni/vl...): content có thể là MẢNG phần tử → gộp text lại
              let msgContent = msg.content;
              if (Array.isArray(msgContent)) msgContent = msgContent.map(p => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('');
              if (typeof msgContent !== 'string') msgContent = '';
              cauTraLoiAI = msgContent || msg.reasoning || (msg.reasoning_details && msg.reasoning_details.length > 0 ? msg.reasoning_details.map(r => r.text).filter(Boolean).join('\n') : '') || '';
              if (!cauTraLoiAI) {
                cauTraLoiAI = `Phản hồi (chỉ reasoning): ` + JSON.stringify(data).substring(0, 500);
              }
            } else if (data.error) {
              // ⚠️ NÉM LỖI (không nuốt thành chuỗi) để FALLBACK CHUỖI bên dưới tự thử candidate kế tiếp
              const friendlyErr = selectedProvider === 'agentrouter' ? agentRouterFriendlyError(data.error.message) : null;
              const logicErr = new Error(friendlyErr || `${selectedProvider.toUpperCase()}: ${data.error.message || JSON.stringify(data.error)}`);
              // P1-10: gắn status HTTP (nếu có) để catch bên dưới chỉ throttle đúng 429/5xx
              if (!response.ok && response.status) logicErr.status = response.status;
              throw logicErr;
            } else if (!data.choices) {
              cauTraLoiAI = `Phản hồi từ ${selectedProvider.toUpperCase()}: ` + JSON.stringify(data);
            }

          } else if (selectedProvider === 'claude') {
            const claudeBody = {
              model: selectedModel || 'claude-3-5-sonnet-20241022',
              max_tokens: thinking_level === 'deep' ? 16384 : 4096,
              system: systemPrompt,
              messages: history.map(h => ({
                role: h.vai_tro === 'user' ? 'user' : 'assistant',
                content: h.noi_dung
              }))
            };
            if (thinking_level === 'deep') {
              claudeBody.thinking = { type: 'enabled', budget_tokens: 10000 };
            }
            const response = await fetch("https://api.anthropic.com/v1/messages", {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': keyToUse,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify(claudeBody),
              signal: AbortSignal.timeout(30000) // P2-19b (liên quan): non-stream cũng treo nếu Claude đơ
            });
            const data = await response.json();
            if (data.content && data.content.length > 0) {
              const textBlocks = data.content.filter(b => b.type === 'text');
              cauTraLoiAI = textBlocks.map(b => b.text).join('\n') || data.content[0].text || '';
            } else {
              cauTraLoiAI = `Lỗi từ Claude: ` + (data.error?.message || JSON.stringify(data));
            }
          } else if (selectedProvider === 'opencode' && execution_mode === 'agent') {
            if (IS_OPENCODE_AVAILABLE) {
              const opencodeModel = selectedModel && selectedModel !== 'opencode-default' ? selectedModel : 'nvidia/google/gemma-4-31b-it';
              const rootDir = path.join(__dirname, '..', '..', '..');
              const isAgentMode = execution_mode === 'agent';
              
              await new Promise((resolve) => {
                const args = ['run', noi_dung, '-m', opencodeModel];
                if (isAgentMode) args.push('--auto');
                args.push('--pure');
                args.push('--title', 'agent-task');
                
                const opencodeProcess = spawn(
                  OPENCODE_BIN_PATH,
                  args,
                  { cwd: rootDir, timeout: 300000, env: NO_COLOR_ENV, stdio: ['ignore', 'pipe', 'pipe'] }
                );
                let stdout = '';
                opencodeProcess.stdout.on('data', data => { stdout += stripAnsi(data.toString()); });
                opencodeProcess.on('close', () => {
                  const cleanOut = stdout.replace(/\[Agent Error\]/g, '').trim();
                  if (cleanOut && cleanOut.length > 0) {
                    cauTraLoiAI = cleanOut;
                  } else {
                    cauTraLoiAI = `[OpenCode] Đã thực thi xong. Xem kết quả ở phía trên.`;
                  }
                  resolve();
                });
              });
            } else {
              cauTraLoiAI = "⛔ **Lỗi hệ thống:** Không tìm thấy `opencode.exe`. Vui lòng kiểm tra lại đường dẫn cài đặt.";
            }
          }
        } catch (apiErr) {
          console.error(`Lỗi gọi ${selectedProvider}:`, apiErr.message);
          // P1-10 + M6: chỉ throttle khi 429/5xx thật — Abort/timeout cắt do câu hỏi
          // dài hoặc client dừng, KHÔNG phạt provider oan (giống stream path).
          const _st = apiErr && apiErr.status;
          if (_st === 429 || (_st >= 500 && _st <= 599)) {
            quotaManager.recordThrottle(selectedProvider);
          }
          // ─── FALLBACK CHUỖI (chỉ khi chế độ Auto) ───
          // Provider được router chọn lỗi → tự thử các lựa chọn kế tiếp (khác provider/model)
          if (autoRouteInfo && autoRouteInfo.route && autoRouteInfo.route.candidates.length > 1) {
            try {
              const result = await chatExecutor.callWithFallback(autoRouteInfo.route.candidates.slice(1), {
                systemPrompt,
                history,
                thinkingLevel: req.body.thinking_level,
              });
              if (result.ok) {
                cauTraLoiAI = result.content;
                console.log(`[AutoFallback] ${selectedProvider} lỗi → đã chuyển sang ${result.provider}/${result.model}`);
              } else {
                cauTraLoiAI = chatExecutor.friendlyFail({ errors: result.errors, candidates: autoRouteInfo.route.candidates });
              }
            } catch (fbErr) {
              console.error('[AutoFallback] error:', fbErr.message);
              cauTraLoiAI = `Lỗi kết nối tới ${selectedProvider.toUpperCase()} (${selectedModel}): ` + apiErr.message;
            }
          } else {
            cauTraLoiAI = `Lỗi kết nối tới ${selectedProvider.toUpperCase()} (${selectedModel}): ` + apiErr.message;
          }
        }

        logActivity(req.user ? req.user.id : 'guest', 'gui_tin', 'Hỏi: ' + String(noi_dung || '').substring(0, 120));
        saveAIMessageAndRespond(id, cauTraLoiAI, res);
      });
    }
  );
});

// ─── AUTO SMART CHAT: chọn model thông minh + fallback chuỗi ───
// Khi người dùng chọn "Auto (tự chọn thông minh)": phân loại câu hỏi,
// chọn model phù hợp nhất từ TẤT CẢ provider khỏe mạnh, gọi thử lần lượt.
async function autoSmartChat(systemPrompt, history, noiDung, thinkingLevel, opts = {}) {
  try {
    const hasImage = /data:image\/(png|jpe?g|gif|webp)/i.test(String(noiDung || ''));
    const route = await modelRouter.pickRoute(noiDung, { thinkingLevel, hasImage, userTier: opts.userTier });
    if (!route.candidates.length) return { ok: false, content: '⚠️ Không tìm thấy model phù hợp nào đang khỏe mạnh.' };
    const result = await chatExecutor.callWithFallback(route.candidates, { systemPrompt, history, thinkingLevel });
    // ─── TELEMETRY + QUOTA: ghi nhận lần route để admin xem + tránh rate limit ───
    // P2-20(1): recordUse đã gọi trong chatExecutor.callOnce khi success → không gọi lại ở đây (tránh đếm 2 lần).
    if (result.ok) {
      telemetry.recordRoute({ provider: result.provider, model: result.model, category: route.category, userTier: opts.userTier });
      if (result.provider !== route.candidates[0].provider) {
        telemetry.recordFallback({ from: route.candidates[0].provider, to: result.provider, model: result.model, reason: 'provider đầu lỗi' });
      }
      return { ok: true, content: result.content, provider: result.provider, model: result.model, route };
    }
    telemetry.recordError({ provider: route.candidates[0]?.provider, model: route.candidates[0]?.model, reason: result.errors?.join(' | ') });
    return { ok: false, content: chatExecutor.friendlyFail({ errors: result.errors, candidates: route.candidates }), route };
  } catch (e) {
    console.error('[AutoSmartChat] error:', e.message);
    return { ok: false, content: '⚠️ Lỗi hệ thống khi tự chọn model: ' + e.message };
  }
}

// ========== STREAMING HELPERS (dùng chung cho route stream) ==========
// Tách logic lấy API key / fallback provider ra khỏi route để tái sử dụng
async function resolveProviderAndKey(req, provider, model_name, client_api_key) {
  let selectedProvider = provider || 'gemini';
  let selectedModel = model_name || 'gemini-2.5-flash'; // gemini-1.5-flash đã bị Google khai tử (404)
  let keyToUse = null;
  let baseUrl = null;

  // Lấy API key từ CSDL khoa_api của Admin trước
  const dbKeyRow = await new Promise((resDb) => {
    db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = LOWER(?)", [selectedProvider], (err, r) => resDb(r));
  });
  if (dbKeyRow && dbKeyRow.gia_tri_khoa && dbKeyRow.gia_tri_khoa.trim()) {
    keyToUse = decryptKey(dbKeyRow.gia_tri_khoa).trim();
  } else if (client_api_key && client_api_key.trim()) {
    keyToUse = client_api_key.trim();
  }

  // Fetch base_url from ai_providers table for custom providers
  const providerRow = await new Promise((resProv) => {
    db.get("SELECT base_url FROM ai_providers WHERE ma_nha_cung_cap = ?", [selectedProvider], (err, r) => resProv(r));
  });
  if (providerRow && providerRow.base_url) baseUrl = providerRow.base_url;

  if (!keyToUse && selectedProvider === 'gemini' && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE') {
    keyToUse = process.env.GEMINI_API_KEY;
  }

  if (!keyToUse && !['opencode', 'kilo'].includes(selectedProvider)) {
    if (IS_OPENCODE_AVAILABLE && selectedProvider !== 'kilo') {
      selectedProvider = 'opencode';
      selectedModel = 'nvidia/google/gemma-4-31b-it';
    } else {
      return { error: `Chưa cài đặt API Key cho nhà cung cấp ${selectedProvider.toUpperCase()}. Hãy bấm nút 'Cài đặt hệ thống' ở góc trái để nhập Key và chọn Model!` };
    }
  }

  return { selectedProvider, selectedModel, keyToUse, baseUrl };
}

// ─── AUTO WEB SEARCH + TÓM TẮT HỘI THOẠI DÀI (dùng chung cho 2 route) ───
const _webCache = new Map();
function webCacheGet(k) { const e = _webCache.get(k); if (e && Date.now() < e.exp) return e.v; if (e) _webCache.delete(k); return null; }
function webCacheSet(k, v) { _webCache.set(k, { v, exp: Date.now() + 600000 }); if (_webCache.size > 60) { _webCache.delete(_webCache.keys().next().value); } }

async function buildAutoContext(req, id, noi_dung) {
  const out = { webSearchText: '', summaryText: '' };
  // 1) Auto web search: (a) câu hỏi cần thông tin mới, (b) ý định tìm kiếm,
  //    (c) câu hỏi nghi vấn đủ dài. Kết quả cache 10 phút theo query.
  const q = String(noi_dung || '');
  const newsRe = /tin tức|thời sự|giá vàng|giá xăng|thời tiết|dự báo|bão|chứng khoán|tỷ giá|bitcoin|crypto|mới nhất|hôm nay|vừa ra mắt|năm 2026|tin nóng|news|today|latest|weather|forecast|stock market|price of|breaking|election|world cup/i;
  const searchIntentRe = /tìm kiếm|tìm giúp|tìm cho|tìm hộ|search|tra cứu|look ?up|google|kiểm tra|thông tin về|info about|tin về/i;
  const questionRe = /\?|(^|\s)(là ai|là gì|ở đâu|khi nào|bao giờ|bao nhiêu|vì sao|tại sao|như thế nào|ra sao|who is|what is|where is|when is|how much|how many|why is)\b/i;
  const words = q.trim().split(/\s+/).filter(Boolean);
  const shouldSearch = words.length >= 3 && (newsRe.test(q) || searchIntentRe.test(q) || questionRe.test(q));
  if (shouldSearch) {
    try {
      const { searchWebTool } = require('../services/agentService');
      // Query gọn (câu hỏi đầu tiên) cho engine — câu dài tự nhiên làm Bing/DDG trả kém/tin cũ
      const sq = (q.split(/[?!\n]/)[0] || q).trim().slice(0, 120) || q.trim().slice(0, 120);
      const ck = 'ws:' + sq.toLowerCase();
      let s = webCacheGet(ck);
      if (!s) { s = await searchWebTool(sq); webCacheSet(ck, s); }
      const n = (s && s.results && s.results.length) || 0;
      console.log('[AutoWeb] q="' + sq.slice(0, 80) + '" n=' + n + ' src=' + (s && s.source ? s.source : 'none') + ' first=' + (n ? String(s.results[0].title).slice(0, 80) : '-'));
      if (n) {
        out.webSearchText = '\n\n🌐 THÔNG TIN MỚI TỪ WEB — BẮT BUỘC dùng khối này để trả lời câu hỏi (trích số liệu cụ thể, KHÔNG trả lời chung chung, KHÔNG chỉ đưa link):\n' +
          s.results.slice(0, 5).map(r => `- ${r.title}: ${String(r.snippet || '').slice(0, 220)}` + ((r.url && !r.url.includes('news.google.com/rss')) ? ` (Nguồn: ${r.url})` : '')).join('\n');
      }
    } catch (e) { console.log('[AutoWeb] error:', e.message); }
  }
  // 2) Tóm tắt hội thoại dài (> 30 tin) để không quên ngữ cảnh
  try {
    const cnt = await new Promise((res) => db.get("SELECT COUNT(*) AS c FROM tin_nhan WHERE ma_hoi_thoai = ?", [id], (err, r) => res(r ? r.c : 0)));
    if (cnt > 30) {
      const older = await new Promise((res) => db.all("SELECT vai_tro, noi_dung FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC LIMIT ?", [id, cnt - 30], (err, rows) => res(rows || [])));
      const text = older.map(m => (m.vai_tro === 'user' ? 'Người dùng: ' : 'Rexi: ') + String(m.noi_dung || '')).join('\n').substring(0, 5000);
      const summary = await quickSummarize(text);
      if (summary) out.summaryText = '\n\n📋 TÓM TẮT HỘI THOẠI TRƯỚC ĐÂY (hội thoại đã dài, đây là tóm tắt phần cũ):\n' + summary;
    }
  } catch (e) { console.log('[Summarize] error:', e.message); }
  return out;
}

async function quickSummarize(text) {
  try {
    const dbKeyRow = await new Promise((res) => db.get("SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = 'xkiro'", [], (err, r) => res(r)));
    const { decryptKey } = require('../utils/cryptoKeys');
    const key = dbKeyRow && dbKeyRow.gia_tri_khoa ? decryptKey(dbKeyRow.gia_tri_khoa).trim() : null;
    if (!key) return '';
    const r = await fetch('https://api.xkiro.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'mistralai/ministral-8b',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý tóm tắt. Tóm tắt ngắn gọn (dưới 150 từ, tiếng Việt) hội thoại sau, giữ lại thông tin quan trọng về người dùng, quyết định đã thống nhất và ngữ cảnh đang bàn:' },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: 400
      }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { console.log('[Summarize] fail:', e.message); return ''; }
}

// Tách logic build system prompt (lịch sử, memory, role, skills) ra khỏi route
async function buildChatContext(req, id, mode, noi_dung, user_location, provider) {
  const history = await new Promise((resolve) => {
    db.all("SELECT vai_tro, noi_dung FROM tin_nhan WHERE ma_hoi_thoai = ? ORDER BY ngay_gui ASC LIMIT 30", [id], (err, rows) => resolve(rows || []));
  });
  history.push({ vai_tro: 'user', noi_dung });

  const now = new Date();
  const nowFormatted = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const locationStr = user_location || 'Hà Nội, Việt Nam';

  // P0-privacy: guest KHÔNG đọc memory chung (rò rỉ dữ liệu người khác) — chỉ user đăng nhập.
  const memoryRows = req.user ? await new Promise((resMem) => {
    db.all("SELECT noi_dung FROM bo_nho_dai_han WHERE ma_nguoi_dung = ? ORDER BY do_uu_tien DESC LIMIT 5", [req.user.id], (err, r) => resMem(r || []));
  }) : [];
  const memoryText = memoryRows.map(m => "- " + m.noi_dung).join('\n');

  // ─── RAG: tự tìm FILE liên quan theo NGHĨA (PDF/Word/TXT đã upload) ───
  let ragText = '';
  try {
    const ragHits = await searchDocuments(req.user ? req.user.id : GUEST_USER_ID, noi_dung, 3);
    if (ragHits && ragHits.length > 0) {
      ragText = '\n\n📄 TÀI LIỆU CỦA NGƯỜI DÙNG (trả lời dựa trên nội dung này nếu liên quan):\n' +
        ragHits.map(h => `- [${h.ten_file}] ${h.noi_dung}`).join('\n');
    }
  } catch (eRag) { console.log('[RAG] context error:', eRag.message); }

  // ─── AUTO: tìm web khi cần + tóm tắt hội thoại dài ───
  const { webSearchText, summaryText } = await buildAutoContext(req, id, noi_dung);

  const SPECIALTY_PROMPTS = {
    general: 'Bạn là Rexi, Siêu Trợ Lý AI Toàn Năng giúp giải quyết mọi câu hỏi cuộc sống, công việc, văn phòng và phân tích.',
    business: 'Bạn là Chuyên Gia Doanh Nghiệp & Cố Vấn Pháp Lý hàng đầu. Hãy tập trung viết hợp đồng kinh tế, công văn hành chính, kế hoạch tài chính và chiến lược kinh doanh chuyên nghiệp.',
    marketing: 'Bạn là Giám Đốc Marketing & Sáng Tạo Nội Dung Viral. Hãy tập trung viết kịch bản TikTok/Reels triệu view, bài viết SEO, Slogan ấn tượng và kịch bản chốt đơn bán hàng.',
    education: 'Bạn là Giáo Sư & Chuyên Gia Phân Tích Đa Ngành. Hãy tập trung tóm tắt tài liệu, phân tích chuyên sâu, lập lộ trình học tập và giải đáp tri thức.',
    health: 'Bạn là Chuyên Gia Dinh Dưỡng & Huấn Luyện Viên Sức Khỏe. Hãy tập trung lập thực đơn dinh dưỡng, bài tập Gym/Calisthenics và tư vấn tâm lý đời sống.',
    coder: 'Bạn là Senior Software Engineer & System Architect. Tập trung viết code sạch, tối ưu, thiết kế kiến trúc hệ thống và sửa bug.'
  };
  const currentRolePrompt = SPECIALTY_PROMPTS[mode] || SPECIALTY_PROMPTS.general;

    let skillInstruction = '';
  try {
    const skillRouter = require('../services/skillRouter');
    const allSkills = await new Promise((resolve) => {
      db.all("SELECT ten_ky_nang, tieu_de, mo_ta FROM ky_nang WHERE trang_thai = 'kich_hoat'", [], (err, rows) => resolve(rows || []));
    });
    skillInstruction = await skillRouter.buildSkillPrompt(noi_dung, allSkills);
    if (!skillInstruction) {
      skillInstruction = `

📚 **KỸ NĂNG AGENT CỦA REXI:** Bạn có ${(allSkills || []).length} skills chuyên dụng (thiết kế, code, văn phòng, video, TTS, IPTV...). Nếu người dùng yêu cầu chuyên môn, hãy áp dụng đúng quy trình.`;
    }
  } catch (skillErr) {
    console.log('[Skill] Lỗi load skills:', skillErr.message);
  }

  let systemPrompt = `${currentRolePrompt} Bây giờ là ${nowFormatted} (Giờ Việt Nam). Vị trí địa lý ước tính của người dùng: ${locationStr}.
${ragText}${webSearchText}${summaryText}

BỘ NHỚ DÀI HẠN VỀ NGƯỜI DÙNG & QUY TẮC CỦA REXI:
${memoryText || '- Người dùng thích làm việc chuyên nghiệp, nội dung ngắn gọn, súc tích, thực tế và chính xác.'}

- NĂNG LỰC INTERNET: Bạn CÓ khả năng tìm kiếm internet — hệ thống Rexi TỰ ĐỘNG tìm web trước mỗi câu trả lời. Khi có khối "🌐 THÔNG TIN MỚI TỪ WEB", hãy dựa vào nó cho câu hỏi về tin tức, thời tiết, giá cả, sự kiện mới. TUYỆT ĐỐI KHÔNG nói bạn không truy cập được internet.

- NGUYÊN TẮC QUAN TRỌNG: Không lặp lại các câu miễn trừ trách nhiệm. Hãy trả lời thẳng vấn đề, tự nhiên, thân thiện, chu đáo và nâng cao trải nghiệm người dùng đến tận răng.${skillInstruction}`;

  const MAX_SYSTEM_PROMPT = 9000;
  if (systemPrompt.length > MAX_SYSTEM_PROMPT) {
    systemPrompt = systemPrompt.substring(0, MAX_SYSTEM_PROMPT) + '\n\n[...đã cắt ngắn system prompt để phù hợp context limit...]';
  }

  // AgentRouter chặn nội dung không phải tiếng Anh → gửi system prompt tiếng Anh
  if (provider === 'agentrouter') {
    systemPrompt = `You are Rexi, an all-in-one AI assistant. Current time: ${nowFormatted} (Vietnam time). User's estimated location: ${locationStr}.\n${ragText}${webSearchText}${summaryText}\n\nINTERNET ACCESS: You DO have internet access — Rexi's system automatically searches the web before every reply. When a block "🌐 THÔNG TIN MỚI TỪ WEB" (or its English equivalent) is present, base answers about news, weather, prices or recent events on it. NEVER claim you cannot access the internet.\n\nLONG-TERM MEMORY ABOUT THE USER & REXI RULES:\n${memoryText || '- The user prefers professional, concise, practical and accurate answers.'}\n\n- IMPORTANT RULE: Do not repeat disclaimers. Answer directly, naturally, friendly and helpfully.${skillInstruction}`;
  }

  return { history, systemPrompt };
}

// ─── P1-10: timeout theo độ khó câu hỏi (general 20s, complex 30s, deep 60s) ───
// Tránh abort oan câu phức tạp (15s cắt cả câu complex) mà vẫn fail-fast câu đơn giản.
function streamTimeoutMs(level) {
  const l = String(level || 'general').toLowerCase();
  if (l === 'deep') return 60000;
  if (l === 'complex') return 30000;
  return 20000;
}

// P0-fix (stream treo/abort oan): timeout TỔNG (AbortSignal.timeout) giết cả stream
// đang chảy tốt khi câu trả lời dài → token đã gửi thành vô nghĩa + UI báo lỗi.
// Chuẩn đúng cho stream: IDLE timeout (provider im lặng quá lâu mới cắt) + trần tuyệt đối.
const STREAM_IDLE_MS = 20000;   // không có byte nào trong 20s → cắt attempt
const STREAM_TOTAL_MS = 300000; // 1 attempt không bao giờ quá 5 phút
// Đọc 1 chunk với idle-timeout (dùng cho reader của fetch stream)
async function readStreamIdle(reader) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          const err = new Error('stream idle quá 20s (provider ngừng gửi dữ liệu)');
          err.idleTimeout = true;
          rej(err);
        }, STREAM_IDLE_MS);
      })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// ========== STREAMING ENDPOINT (SSE) — token theo thời gian thực ==========
// Frontend gọi route này thay vì route cũ để nhận phản hồi từng phần (cả Chat & Agent)
router.post('/conversations/:id/messages/stream', rateLimit({ windowMs: 60000, max: 120 }), (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return guestMiddleware(req, res, next);
  return authMiddleware(req, res, next);
}, async (req, res) => {
  const { id } = req.params;
  // P2-19a: ép vai_tro='user' (xem route non-stream) — chống bubble admin giả.
  const { vai_tro: _roleIgnored, noi_dung, provider, client_api_key, model_name, base_url, mode, execution_mode, thinking_level, user_location } = req.body;
  const vai_tro = 'user';

  // P3: chặn data-URL ảnh quá lớn (bản stream) — lỗi trả qua SSE thay vì res.status (header SSE đã gửi)
  const oversizeErrSse = validateImageAttachments(noi_dung);
  if (oversizeErrSse) { sendSSE({ type: 'error', message: oversizeErrSse }); return endStream(); }

  // Headers SSE — tắt buffering ở mọi tầng (Express, proxy, nginx)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sendSSE = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  const endStream = () => { try { res.end(); } catch (e) {} };

  // Lưu tin nhắn user vào DB
  const maTinNhanUser = crypto.randomUUID();
  // P1-09: chặn IDOR — stream đã gửi header SSE nên trả lỗi qua SSE, không dùng res.status
  const ownerErrStream = await assertConvOwner(id, req);
  if (ownerErrStream) { sendSSE({ type: 'error', message: ownerErrStream.error }); return endStream(); }
  await new Promise((resolve) => {
    db.run("INSERT INTO tin_nhan (ma_tin_nhan, ma_hoi_thoai, vai_tro, noi_dung) VALUES (?, ?, ?, ?)", [maTinNhanUser, id, vai_tro, noi_dung], () => resolve());
  });

  // FIX GUEST LIMIT: tăng messageCount cho khách khi gửi tin thành công qua stream
  // (trước đây chỉ tăng ở route non-stream /messages nên khách chat được vô hạn)
  if (!req.user && req.session) {
    req.session.messageCount = (req.session.messageCount || 0) + 1;
    if (typeof req.session.save === 'function') req.session.save(() => {});
  }

  // Cập nhật tiêu đề cuộc trò chuyện nếu còn mặc định
  db.get("SELECT tieu_de FROM cuoc_hoi_thoai WHERE ma_hoi_thoai = ?", [id], (err, convRow) => {
    if (convRow && (convRow.tieu_de === 'Trò chuyện mới' || !convRow.tieu_de)) {
      const newTitle = taoTieuDeThongMinh(noi_dung);
      db.run("UPDATE cuoc_hoi_thoai SET tieu_de = ?, ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [newTitle, id]);
    } else {
      db.run("UPDATE cuoc_hoi_thoai SET ngay_cap_nhat = CURRENT_TIMESTAMP WHERE ma_hoi_thoai = ?", [id]);
    }
  });

  // ---------- AGENT MODE (stream stdout của agent engine) ----------
  if (execution_mode === 'agent') {
    const isGuest = !req.user;
    if (isGuest && req.session.agentTaskCount >= 3) {
      sendSSE({ type: 'error', message: "🔒 **Đã hết lượt Agent Mode miễn phí!**\n\nBạn đã sử dụng hết **3 tasks** Agent cho khách.\n\nĐăng nhập để:\n✅ Agent Mode không giới hạn\n✅ Chat không giới hạn\n✅ Lưu lịch sử & Memory" });
      return endStream();
    }
    if (isGuest) {
      req.session.agentTaskCount = (req.session.agentTaskCount || 0) + 1;
      if (typeof req.session.save === 'function') req.session.save(() => {});
    }
    // Engine: 'opencode' / 'dsh' / 'auto' (tự chọn theo độ phức tạp task)
    const requestedEngine = String(req.body.agent_engine || 'auto').trim().toLowerCase();
    const agentEngineName = agentEngine.pickEngine(noi_dung, requestedEngine);
    if (!agentEngine.isEngineAvailable(agentEngineName)) {
      // Cloud (Render) KHÔNG có opencode.exe/dsh → chạy AGENT NỘI BỘ (ReAct qua API provider).
      // Trước đây báo lỗi "không tìm thấy opencode.exe" → nay chạy thật, không chặn user.
      if (!noi_dung || !noi_dung.trim()) {
        sendSSE({ type: 'error', message: '⚠️ **Lỗi:** Nội dung tin nhắn trống.' });
        return endStream();
      }
      sendSSE({ type: 'status', message: '🤖 Agent đang làm việc (tự gọi tool: đọc web, tìm kiếm, chạy code...)...' });
      (async () => {
        try {
          const { runInternalAgent } = require('../services/internalAgent');
          const result = await runInternalAgent(noi_dung, {});
          if (result && result.success && result.answer) {
            sendSSE({ type: 'token', text: result.answer });
            sendSSE({ type: 'done', ma_tin_nhan: crypto.randomUUID(), noi_dung: result.answer });
          } else {
            const steps = (result && result.steps) || [];
            const detail = steps.map(s => `• ${s.tool}${s.args ? '(' + JSON.stringify(s.args).slice(0, 80) + ')' : ''}: ${String(s.result || '').slice(0, 140)}`).join('\n');
            sendSSE({ type: 'error', message: `⛔ Agent chưa hoàn thành: ${(result && result.error) || 'không có câu trả lời'}\n${detail}` });
          }
        } catch (e) {
          sendSSE({ type: 'error', message: '⛔ Agent lỗi: ' + e.message });
        }
        return endStream();
      })();
      return;
    }
    if (!noi_dung || !noi_dung.trim()) {
      sendSSE({ type: 'error', message: "⚠️ **Lỗi:** Nội dung tin nhắn trống. Vui lòng nhập yêu cầu trước khi chạy Agent Mode." });
      return endStream();
    }

    const rootDir = path.join(__dirname, '..', '..', '..');

    // dsh cần key đúng provider user chọn — đọc qua adapter (như endpoint messages)
    let extraEnv = {};
    let dshProv = '';
    if (agentEngineName === 'dsh') {
      dshProv = await agentEngine.resolveDshProvider(model_name, provider);
      const provKey = await getProviderApiKey(dshProv);
      if (provKey) {
        extraEnv[agentEngine.dshKeyEnvName(dshProv)] = provKey;
        if (dshProv === 'xkiro') extraEnv.XKIRO_API_KEY = provKey;
      }
      if (!provKey) {
        sendSSE({ type: 'error', message: `⚠️ **Lỗi:** Chưa có API key provider \`${dshProv}\` trong hệ thống. Admin cần lưu key provider này trước khi dùng Agent DSH.` });
        return endStream();
      }
    }

    sendSSE({ type: 'status', message: agentEngineName === 'dsh'
      ? '🤖 Đang khởi động Agent (DeepSeek Harness)... Vui lòng đợi, agent có thể mất 1–5 phút tùy tác vụ.'
      : '🤖 Đang khởi động Agent (opencode)... Vui lòng đợi, agent có thể mất 1–5 phút tùy tác vụ.' });

    console.log('[Agent-DSH] goi runAgentEngineStream, bin =', agentEngine.DSH_BIN);
    const killAgent = agentEngine.runAgentEngineStream(agentEngineName, noi_dung, model_name, rootDir, extraEnv, sendSSE, endStream, dshProv);
    console.log('[Agent-DSH] da spawn xong');
    // Client ngắt kết nối → kill agent
    req.on('close', () => { try { killAgent(); } catch (e) {} });
    return;
  }

  // ---------- CHAT MODE (stream theo provider) ----------
  (async () => {
    let fullText = '';
    try {
      const resolved = await resolveProviderAndKey(req, provider, model_name, client_api_key);
      if (resolved.error) { sendSSE({ type: 'error', message: resolved.error }); return endStream(); }
      let { selectedProvider, selectedModel, keyToUse, baseUrl } = resolved;

      // ─── AUTO ROUTER (stream): model = 'auto' → chọn model thông minh ───
      let autoRouteInfo = null;
      const isAutoModel = String(model_name || '').trim() === 'auto' || String(model_name || '').trim() === 'auto/' + selectedProvider;
      if (isAutoModel) {
        const hasImage = /data:image\/(png|jpe?g|gif|webp)/i.test(String(noi_dung || ''));
        const userTier = !req.user ? 'guest' : (req.user.role === 'admin' || req.user.phan_quyen === 'admin' ? 'admin' : 'user');
        const route = await modelRouter.pickRoute(noi_dung, { thinkingLevel: thinking_level, hasImage, userTier });
        if (route.candidates && route.candidates.length) {
          autoRouteInfo = { route, index: 0 };
          selectedProvider = route.candidates[0].provider;
          selectedModel = route.candidates[0].model;
          const rp = await modelRouter.resolveProvider(selectedProvider);
          if (rp.apiKey) keyToUse = rp.apiKey;
          if (rp.baseUrl) baseUrl = rp.baseUrl;
        }
      }
      let finalModel = smartModelOverride(selectedProvider, selectedModel, noi_dung, thinking_level);
      if (selectedProvider === 'agentrouter') finalModel = finalModel.replace(/^agentrouter\//, '');
      if (['nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kiraai', 'bazaarlink'].includes(selectedProvider)) finalModel = finalModel.replace(new RegExp('^' + selectedProvider + '/'), '');
      if (selectedProvider === 'opencode') finalModel = finalModel.replace(/^opencode\//, '');
      // ─── THÔNG BÁO ĐỊNH TUYẾN: cho khách biết đang dùng provider/model nào ───
      if (isAutoModel) {
        const routeLabel = autoRouteInfo && autoRouteInfo.route ? autoRouteInfo.route.category : 'auto';
        sendSSE({ type: 'route', provider: selectedProvider, model: finalModel, category: routeLabel, auto: true });
      }
      const { history, systemPrompt } = await buildChatContext(req, id, mode, noi_dung, user_location, selectedProvider);
      if (selectedProvider === 'gemini') {
        try {
          const tempGenAI = new GoogleGenerativeAI(keyToUse);
          let model;
          try { model = tempGenAI.getGenerativeModel({ model: selectedModel || 'gemini-2.5-flash' }); }
          catch (e) { model = tempGenAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); }
          // QA 17/9 + M7: ảnh data-URL → inlineData, history cũ chỉ giữ 12 tin gần nhất + bỏ base64 cũ
          const contents = chatExecutor.buildHistoryGemini(history);
          // CHỈ gửi thinkingConfig khi thinking_level = 'deep' (xem ghi chú BUG 400 INVALID_ARGUMENT)
          const genConfig = thinking_level === 'deep' ? { thinkingConfig: { thinkingBudget: 8192 } } : {};
          const stream = await model.generateContentStream({ contents, systemInstruction: systemPrompt, generationConfig: genConfig });
          for await (const chunk of stream.stream) {
            const t = chunk.text();
            if (t) { fullText += t; sendSSE({ type: 'token', text: t }); }
          }
        } catch (errGenS) {
          // P1-10: throttle đúng 429/5xx thật
          const _gms = String(errGenS && errGenS.message || '');
          const _gsts = (errGenS && errGenS.status) || (parseInt((_gms.match(/\[(429|5\d\d)\D/)||[])[1], 10) || 0);
          if (_gsts === 429 || (_gsts >= 500 && _gsts <= 599)) {
            try { quotaManager.recordThrottle(selectedProvider); } catch {}
          }
          // FALLBACK CHUỖI (stream): Gemini stream lỗi ngay từ đầu (chưa token nào) → thử candidate kế tiếp.
          // Nếu ĐÃ stream một phần → không fallback (tránh resposta trùng lặp), ném lên outer catch.
          if (fullText.length === 0 && autoRouteInfo && autoRouteInfo.route && autoRouteInfo.route.candidates.length > 1) {
            const fb = await chatExecutor.callWithFallback(autoRouteInfo.route.candidates.slice(1), { systemPrompt, history, thinkingLevel: thinking_level });
            if (fb.ok) {
              telemetry.recordFallback({ from: 'gemini', to: fb.provider, model: fb.model, reason: 'gemini stream lỗi (stream path)' });
              fullText += fb.content;
              sendSSE({ type: 'token', text: fb.content });
            } else {
              throw errGenS;
            }
          } else {
            throw errGenS;
          }
        }
      } else if (['openai', 'deepseek', 'groq', 'github', 'custom', 'xkiro', 'agentrouter', 'bai', 'kiosapi', 'unorouter', 'nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kiraai', 'bazaarlink', 'opencode', 'kilo'].includes(selectedProvider)) {
        // ─── FALLBACK CHUỖI (stream): provider lỗi/429 → tự thử candidate kế tiếp ───
        const quotaStream = require('../services/quotaManager');
        const OPENAI_STYLE = ['openai', 'deepseek', 'groq', 'github', 'custom', 'xkiro', 'agentrouter', 'bai', 'kiosapi', 'unorouter', 'nvidia', 'mistral', 'cerebras', 'openrouter', 'mintrouter', 'kiraai', 'bazaarlink', 'opencode', 'kilo'];
        const attempts = [{ provider: selectedProvider, model: finalModel }];
        if (autoRouteInfo && autoRouteInfo.route && autoRouteInfo.route.candidates) {
          for (const c of autoRouteInfo.route.candidates.slice(1)) {
            if (OPENAI_STYLE.includes(c.provider) && !attempts.some(a => a.provider === c.provider)) attempts.push(c);
          }
        }
        const formattedMessages = [{ role: "system", content: systemPrompt }, ...history.map(h => ({ role: h.vai_tro === 'user' ? 'user' : 'assistant', content: h.vai_tro === 'user' ? buildOpenAIContent(h.noi_dung) : h.noi_dung }))];
        const streamCategory = autoRouteInfo && autoRouteInfo.route ? autoRouteInfo.route.category : null;
        const userTierS = !req.user ? 'guest' : (req.user.role === 'admin' || req.user.phan_quyen === 'admin' ? 'admin' : 'user');
        let streamDone = false, lastStreamErr = null;
        for (let ai2 = 0; ai2 < attempts.length && !streamDone; ai2++) {
          const att = attempts[ai2];
          // ─── KILO QUOTA (stream): attempt Kilo cũng ăn quota theo từng người ───
          if (att.provider === 'kilo') {
            const kqS = kiloQuota.allow(req);
            if (!kqS.ok) {
              // Còn attempt khác (auto-router fallback) → bỏ qua Kilo thử candidate kế tiếp
              if (ai2 < attempts.length - 1) continue;
              sendSSE({ type: 'error', message: kiloQuota.message(kqS, !req.user) });
              return endStream();
            }
          }
          let attKey = keyToUse, attBase = baseUrl;
          if (ai2 > 0) {
            const rp2 = await modelRouter.resolveProvider(att.provider);
            attKey = rp2.apiKey; attBase = rp2.baseUrl;
            sendSSE({ type: 'route', provider: att.provider, model: att.model, category: streamCategory || 'auto', auto: true, fallback: true });
            telemetry.recordFallback({ from: attempts[0].provider, to: att.provider, model: att.model, reason: 'provider trước lỗi (stream)' });
          } else {
            telemetry.recordRoute({ provider: att.provider, model: att.model, category: streamCategory, userTier: userTierS });
          }
          // Endpoint RIÊNG cho từng attempt (tránh biến endpoint dùng chung — race condition)
          let attEndpoint = "https://api.openai.com/v1/chat/completions";
          if (att.provider === 'deepseek') attEndpoint = "https://api.deepseek.com/chat/completions";
          else if (att.provider === 'groq') attEndpoint = "https://api.groq.com/openai/v1/chat/completions";
          else if (att.provider === 'github') attEndpoint = "https://models.github.ai/inference/chat/completions";
          else if (att.provider === 'kilo') {
            // kilo keyless: base 2 segment KHÔNG /v1, model ID đầy đủ kiểu OpenRouter, KHÔNG gửi Authorization
            const cleanedBase = String(attBase || 'https://kilo.ai/api/openrouter').replace(/\/+$/, '');
            attEndpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : cleanedBase + '/chat/completions';
          }
          else if (['custom', 'xkiro', 'agentrouter'].includes(att.provider) || attBase) {
            const cleanedBase = String(attBase || '').replace(/\/+$/, '');
            if (cleanedBase) attEndpoint = cleanedBase.endsWith('/chat/completions') ? cleanedBase : cleanedBase + '/chat/completions';
          }
          const attModel = String(att.model || '').replace(/^opencode\//, '');
          const attHeaders = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json, */*' };
          if (att.provider === 'agentrouter') attHeaders['User-Agent'] = 'opencode/1.17.12';
          if (att.provider !== 'opencode' && att.provider !== 'kilo') attHeaders['Authorization'] = `Bearer ${attKey}`; // Zen free + kilo keyless: KHÔNG gửi key
          try {
            const response = await fetch(attEndpoint, {
              method: 'POST',
              headers: attHeaders,
              body: JSON.stringify({ model: attModel, messages: formattedMessages, temperature: 0.7, stream: true }),
              signal: AbortSignal.timeout(STREAM_TOTAL_MS) // trần tuyệt đối; nhịp đọc do idle-timeout bên dưới
            });
            if (!response.ok || !response.body) {
              const errData = await response.json().catch(() => ({}));
              // P1-10: gắn status để catch bên dưới chỉ throttle đúng 429/5xx/Abort
              const httpErr = new Error(`HTTP ${response.status}: ${errData.error?.message || ''}`);
              httpErr.status = response.status;
              throw httpErr;
            }
            let reader = null;
            try {
              reader = response.body.getReader();
              const decoder = new TextDecoder();
              let sseBuffer = '';
              const t0stream = Date.now();
              while (true) {
                if (Date.now() - t0stream > STREAM_TOTAL_MS) {
                  try { await reader.cancel(); } catch {}
                  throw new Error('stream quá lâu (>5 phút)');
                }
                const { done, value } = await readStreamIdle(reader);
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split('\n');
              sseBuffer = lines.pop();
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  let delta = parsed.choices?.[0]?.delta?.content;
                  if (Array.isArray(delta)) delta = delta.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
                  if (typeof delta === 'string' && delta) { fullText += delta; sendSSE({ type: 'token', text: delta }); }
                } catch (e) {}
              }
            }
            } catch (readErr) {
              // Lỗi giữa lúc đọc stream (idle-timeout / abort): hủy reader giải phóng
              // kết nối rồi ném tiếp cho catch ngoài (giữ đáp án từng phần ở đó).
              try { if (reader) await reader.cancel(); } catch {}
              throw readErr;
            }
            if (!fullText.trim()) throw new Error('phản hồi rỗng từ provider');
            streamDone = true;
            quotaStream.recordUse(att.provider); // P2-20(1): ghi lượt dùng sau success
            quotaStream.recordSuccess(att.provider);
          } catch (e) {
            // P0-fix: transport abort (idle-timeout/abort) NHƯNG đã nhận nội dung thật
            // → GIỮ đáp án (lưu + done ở cuối), KHÔNG thử fallback (tránh gửi trùng token
            // đã stream), KHÔNG phạt throttle (provider vẫn khỏe — data vẫn chảy).
            const _st = e && e.status;
            const _abort = e && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.idleTimeout || /timeout|aborted/i.test(e.message || ''));
            if (!_st && _abort && fullText.trim()) {
              streamDone = true;
              quotaStream.recordUse(att.provider);
              quotaStream.recordSuccess(att.provider);
              break;
            }
            lastStreamErr = e;
            // P1-10: chỉ phạt throttle khi 429/5xx/Abort — lỗi logic (phản hồi rỗng,
            // JSON lỗi, 4xx khác) thì KHÔNG phạt, provider vẫn dùng được ở request sau
            if (_st === 429 || (_st >= 500 && _st <= 599) || (!_st && _abort)) {
              quotaStream.recordThrottle(att.provider);
            }
            telemetry.recordError({ provider: att.provider, model: att.model, reason: e.message });
          }
        }
        if (!streamDone) {
          sendSSE({ type: 'error', message: `Lỗi kết nối AI sau khi thử ${attempts.length} provider: ${lastStreamErr?.message || 'không rõ'}` });
          return endStream();
        }
      } else {
        if (selectedProvider === 'claude') {
          const claudeBody = { model: selectedModel || 'claude-3-5-sonnet-20241022', max_tokens: thinking_level === 'deep' ? 16384 : 4096, system: systemPrompt, messages: history.map(h => ({ role: h.vai_tro === 'user' ? 'user' : 'assistant', content: h.noi_dung })), stream: true };
          if (thinking_level === 'deep') claudeBody.thinking = { type: 'enabled', budget_tokens: 10000 };
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': keyToUse, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(claudeBody),
            signal: AbortSignal.timeout(STREAM_TOTAL_MS) // P0-fix: trần tuyệt đối; nhịp đọc do idle-timeout (P2-19b cũ 30s tổng giết stream dài)
          });
          if (!response.ok || !response.body) {
            const errData = await response.json().catch(() => ({}));
            sendSSE({ type: 'error', message: `Lỗi từ Claude: ${errData.error?.message || response.status}` });
            return endStream();
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          const t0claude = Date.now();
          try {
            while (true) {
              if (Date.now() - t0claude > STREAM_TOTAL_MS) { try { await reader.cancel(); } catch {} break; }
              const { done, value } = await readStreamIdle(reader);
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const events = buf.split('\n\n');
              buf = events.pop();
              for (const evt of events) {
                const dataLine = evt.split('\n').find(l => l.startsWith('data: '));
                if (!dataLine) continue;
                try {
                  const parsed = JSON.parse(dataLine.slice(6));
                  if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    fullText += parsed.delta.text;
                    sendSSE({ type: 'token', text: parsed.delta.text });
                  }
                } catch (e) {}
              }
            }
          } catch (readErr) {
            try { await reader.cancel(); } catch {}
            // P0-fix: abort giữa chừng NHƯNG đã nhận nội dung → giữ lại, lưu + done ở dưới.
            // Chưa có gì mới báo lỗi.
            if (!fullText.trim()) {
              sendSSE({ type: 'error', message: `Lỗi từ Claude: ${readErr.message || 'stream gián đoạn'}` });
              return endStream();
            }
          }
        } else if (selectedProvider === 'opencode' && execution_mode === 'agent') {
          const opencodeModel = selectedModel && selectedModel !== 'opencode-default' ? selectedModel : 'nvidia/google/gemma-4-31b-it';
          const rootDir = path.join(__dirname, '..', '..', '..');
          await new Promise((resolve) => {
            const proc = spawn(OPENCODE_BIN_PATH, ['run', noi_dung, '-m', opencodeModel, '--pure', '--title', 'agent-task'], { cwd: rootDir, timeout: 300000, env: NO_COLOR_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            const cleaner = new AnsiStreamCleaner();
            proc.stdout.on('data', (d) => { const t = cleaner.push(d.toString()); if (t) { out += t; sendSSE({ type: 'token', text: t }); } });
            proc.on('error', () => { fullText = 'Lỗi khởi động opencode.'; resolve(); });
            proc.on('close', () => { const f = cleaner.flush(); if (f) out += f; fullText = out.replace(/\[Agent Error\]/g, '').trim() || `[OpenCode] Đã thực thi xong. Xem kết quả ở phía trên.`; resolve(); });
            req.on('close', () => { try { if (!proc.killed) proc.kill(); } catch (e) {} });
          });
        }
      }
      if (!fullText) fullText = '[Không có phản hồi từ AI]';
      const cleanFullText = cleanAIThinkingProcess(fullText);
      const maTinNhanAI = crypto.randomUUID();
      db.run("INSERT INTO tin_nhan (ma_tin_nhan, ma_hoi_thoai, vai_tro, noi_dung) VALUES (?, ?, 'assistant', ?)", [maTinNhanAI, id, cleanFullText], () => {
        sendSSE({ type: 'done', ma_tin_nhan: maTinNhanAI, noi_dung: cleanFullText });
        endStream();
      });
    } catch (apiErr) {
      console.error('[Stream] Error:', apiErr.message);
      sendSSE({ type: 'error', message: `Lỗi kết nối AI: ${apiErr.message}` });
      endStream();
    }
  })();
});

// Long Term Memory APIs
router.get('/memory', authMiddleware, (req, res) => {
  db.all("SELECT * FROM bo_nho_dai_han WHERE ma_nguoi_dung = ? ORDER BY do_uu_tien DESC, ngay_tao DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post('/memory', authMiddleware, (req, res) => {
  const { loai, noi_dung, do_uu_tien } = req.body;
  if (!noi_dung) return res.status(400).json({ error: 'Nội dung bộ nhớ không được trống' });
  const maBoNho = 'mem_' + Date.now();
  db.run(
    "INSERT INTO bo_nho_dai_han (ma_bo_nho, ma_nguoi_dung, loai, noi_dung, do_uu_tien) VALUES (?, ?, ?, ?, ?)",
    [maBoNho, req.user.id, loai || 'thong_tin_user', noi_dung.trim(), do_uu_tien || 5],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, ma_bo_nho: maBoNho, loai, noi_dung });
    }
  );
});

router.delete('/memory/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM bo_nho_dai_han WHERE ma_bo_nho = ? AND ma_nguoi_dung = ?", [id, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id });
  });
});

// Exec API - Cho user đã đăng nhập (yêu cầu confirm header để tránh exec vô tình)
// P2-19c: thống nhất check admin bằng adminMiddleware (role || phan_quyen) thay vì
// chỉ check req.user.role — trước đây token có phan_quyen='admin' nhưng role khác vẫn bị 403 oan.
// GIỮ NGUYÊN localhost check (quyết định đợt 1) — không nới lỏng.
// K5: WHITELIST lệnh an toàn. Chỉ cho phép các lệnh dev/đọc phổ biến; lệnh ngoài
// danh sách bị chặn (kể cả khi đã qua localhost + admin + confirm). Đặt
// EXEC_WHITELIST_DISABLED=1 để tắt (chỉ nên dùng khi thật cần, local).
const EXEC_ALLOWED_BIN = new Set([
  'git', 'node', 'npm', 'npx', 'yarn', 'pnpm', 'python', 'python3', 'pip', 'pip3', 'py',
  'ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'cd', 'find', 'findstr', 'grep', 'head',
  'tail', 'wc', 'sort', 'uniq', 'tree', 'where', 'which',
  'curl', 'wget', 'ffmpeg', 'ffprobe', 'whoami', 'hostname', 'ipconfig', 'netstat',
  'tasklist', 'systeminfo', 'date', 'ver', 'sqlite3', 'psql', 'gh', 'vercel', 'docker',
]);
function execCommandsAllowed(command) {
  if (process.env.EXEC_WHITELIST_DISABLED === '1') return true;
  const segments = String(command).split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  for (const seg of segments) {
    const first = seg.split(/\s+/)[0] || '';
    const base = first.split(/[\\/]/).pop().toLowerCase();
    if (!EXEC_ALLOWED_BIN.has(base)) return false;
  }
  return true;
}

router.post('/exec', authMiddleware, adminMiddleware, (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Thiếu câu lệnh execution' });

  // Chỉ cho phép request từ localhost
  const clientIp = req.ip || req.connection?.remoteAddress || '';
  const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
  
  // Yêu cầu confirm header để tránh exec vô tình
  const confirmed = req.headers['x-exec-confirm'] === 'yes';
  
  if (!isLocalhost) {
    return res.status(403).json({ 
      error: '⛔ Exec API chỉ cho phép từ localhost vì lý do bảo mật.',
      note: 'Hãy dùng terminal thật hoặc truy cập qua localhost.'
    });
  }
  
  if (!confirmed) {
    return res.status(428).json({
      error: '⛔ Yêu cầu xác nhận: gửi header X-Exec-Confirm: yes để thực thi lệnh này.',
      command: command
    });
  }

  // K5: whitelist lệnh an toàn (defense-in-depth, thêm trên blocklist bên dưới)
  if (!execCommandsAllowed(command)) {
    return res.status(403).json({
      error: '⛔ Lệnh không nằm trong danh sách cho phép (whitelist an toàn).',
      hint: 'Chỉ cho phép lệnh dev/đọc phổ biến: git, node, npm, ls, cat, grep, curl...',
      allowed: [...EXEC_ALLOWED_BIN].sort().join(', ')
    });
  }

  // Blocklist mở rộng
  const dangerousPatterns = [
    /rm\s+-rf/i, /format\s+[c-z]:/i, /del\s+\/f/i, /drop\s+database/i,
    /shutdown/i, /restart\s+computer/i, /stop\s+service/i,
    /Remove-Item/i, /Remove-ItemProperty/i, /Clear-Content/i,
    /net\s+user/i, /net\s+localgroup/i, /sc\s+delete/i,
    /wmic/i, /diskpart/i, /reg\s+delete/i
  ];
  
  if (dangerousPatterns.some(p => p.test(command))) {
    return res.status(403).json({ error: '⛔ Câu lệnh bị chặn vì lý do an toàn hệ thống.' });
  }

  const rootDir = path.join(__dirname, '..', '..', '..');

  // FIX PROD: dùng safeExec — timeout + cắt output + chặn lệnh hủy diệt (bổ sung blocklist thủ công bên trên)
  const { safeExec } = require('../utils/safeExec');
  safeExec(command, { timeout: 15000, maxOutput: 100 * 1024, strict: true, cwd: rootDir }).then((r) => {
    res.json({
      success: r.success && !r.timedOut,
      stdout: r.stdout.trim(),
      stderr: r.stderr.trim(),
      error: r.success ? null : (r.timedOut ? 'Lệnh hết thời gian chờ (15s).' : r.stderr || 'Lệnh thất bại.')
    });
  });
});

// Git APIs
// P2-audit: tách lệnh branch khỏi git status — trên Render checkout detached HEAD
// khiến `git branch --show-current` trả rỗng, và lines.pop() cũ nhặt nhầm
// dòng cuối của git status làm tên branch (" M deploy/deploy.sh").
router.get('/git/status', authMiddleware, async (req, res) => {
  const rootDir = path.join(__dirname, '..', '..', '..');
  const { safeExec } = require('../utils/safeExec');
  const result = await safeExec('git status --short', { cwd: rootDir, maxOutput: 10 * 1024 });
  if (!result.success) return res.json({ isGit: false, message: 'Thư mục không phải Git repo' });
  const changes = result.stdout.trim() ? result.stdout.trim().split('\n') : [];

  const br = await safeExec('git rev-parse --abbrev-ref HEAD', { cwd: rootDir, maxOutput: 1024 });
  let branch = (br.stdout || '').trim();
  if (!br.success || !branch || branch === 'HEAD') {
    // Detached HEAD (deploy từ commit cụ thể) → hiện "detached@<hash>" thay vì branch sai
    const h = await safeExec('git rev-parse --short HEAD', { cwd: rootDir, maxOutput: 1024 });
    branch = 'detached@' + ((h.stdout || '').trim() || 'unknown');
  }
  res.json({ isGit: true, branch, changes });
});

router.get('/git/diff', authMiddleware, async (req, res) => {
  const rootDir = path.join(__dirname, '..', '..', '..');
  const { safeExec } = require('../utils/safeExec');
  const result = await safeExec('git diff', { cwd: rootDir, maxOutput: 100 * 1024 });
  res.json({ diff: result.stdout || 'Không có thay đổi chưa commit.' });
});

// Search API - Cho phép mọi người dùng đã đăng nhập
router.post('/search', authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Thiếu từ khóa tìm kiếm' });

  try {
    const { searchWebTool } = require('../services/agentService');
    const out = await searchWebTool(query);
    const results = (out && out.results) || [`Tìm kiếm thông tin cho '${query}' hoàn tất.`];

    res.json({
      success: true,
      query,
      results
    });
  } catch (err) {
    res.json({ success: false, error: 'Lỗi tìm kiếm: ' + err.message });
  }
});

// ─── INTENT ROUTER: nhận diện ý định câu chat → gợi ý tab/service ───
// P2-19d: thêm authMiddleware (FE App.jsx handleSendMessage đã gửi authHeaders).
router.post('/intent', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware, (req, res) => {
  try {
    const intentRouter = require('../services/intentRouter');
    const text = (req.body && (req.body.noi_dung || req.body.text)) || '';
    const result = intentRouter.detectIntent(text);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ROUTING TELEMETRY: thống kê định tuyến cho admin ───
router.get('/routing-stats', [authMiddleware, adminMiddleware], (req, res) => {
  const report = telemetry.getReport();
  res.json({ success: true, ...report });
});

module.exports = router;
