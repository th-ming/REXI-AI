/**
 * init-db.js — Tự động tạo schema (CREATE TABLE IF NOT EXISTS) khi server khởi động.
 * Hỗ trợ cả SQLite (local) và PostgreSQL (Render) — FIX lỗi "chỉ chạy trên máy local"
 * vì trước đây schema chỉ tồn tại sẵn trong file SQLite, Postgres trên prod bị rỗng bảng.
 */
const crypto = require('crypto');
const db = require('./config/db');

// Promise helpers cho adapter (callback-based)
function runSql(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}
function getRow(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

// ─── Schema gốc (dump từ SQLite chuẩn) — sắp theo thứ tự FK ─────────
const TABLES = [
  `CREATE TABLE ai_providers (ma_nha_cung_cap TEXT PRIMARY KEY, ten_hien_thi TEXT NOT NULL, base_url TEXT, can_api_key INTEGER DEFAULT 1, placeholder TEXT, thu_tu INTEGER DEFAULT 0, kich_hoat INTEGER DEFAULT 1, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP, ngay_cap_nhat TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE nguoi_dung ( ma_nguoi_dung TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, mat_khau_ma_hoa TEXT NOT NULL, ten_day_du TEXT, phan_quyen TEXT DEFAULT 'user', anh_dai_dien TEXT, otp_code TEXT, otp_expiry INTEGER, otp_attempts INTEGER DEFAULT 0, token_version INTEGER DEFAULT 0, trang_thai TEXT DEFAULT 'active', ngay_tao DATETIME DEFAULT CURRENT_TIMESTAMP , _sync_at DATETIME)`,
  `CREATE TABLE ai_models (ma_model TEXT NOT NULL, ma_nha_cung_cap TEXT NOT NULL, ten_hien_thi TEXT NOT NULL, loai TEXT DEFAULT 'free', modality TEXT DEFAULT 'chat', thu_tu_hien_thi INTEGER DEFAULT 0, kich_hoat INTEGER DEFAULT 1, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP, ngay_cap_nhat TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (ma_model, ma_nha_cung_cap), FOREIGN KEY (ma_nha_cung_cap) REFERENCES ai_providers(ma_nha_cung_cap))`,
  `CREATE TABLE cuoc_hoi_thoai ( ma_hoi_thoai TEXT PRIMARY KEY, ma_nguoi_dung TEXT NOT NULL, ma_thu_muc TEXT, tieu_de TEXT DEFAULT 'Trò chuyện mới', ten_mo_hinh_ai TEXT DEFAULT 'Gemini 3.5 Flash', trang_thai TEXT DEFAULT 'dang_mo', ngay_tao DATETIME DEFAULT CURRENT_TIMESTAMP, ngay_cap_nhat DATETIME DEFAULT CURRENT_TIMESTAMP, ngay_xoa DATETIME, ma_phien TEXT, da_ghim INTEGER DEFAULT 0, _sync_at DATETIME, FOREIGN KEY (ma_nguoi_dung) REFERENCES nguoi_dung(ma_nguoi_dung) )`,
  `CREATE TABLE tin_nhan ( ma_tin_nhan TEXT PRIMARY KEY, ma_hoi_thoai TEXT NOT NULL, vai_tro TEXT NOT NULL, noi_dung TEXT NOT NULL, ngay_gui DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (ma_hoi_thoai) REFERENCES cuoc_hoi_thoai(ma_hoi_thoai) )`,
  `CREATE TABLE khoa_api ( ma_khoa TEXT PRIMARY KEY, ma_nguoi_dung TEXT, ten_nha_cung_cap TEXT NOT NULL, gia_tri_khoa TEXT NOT NULL, ngay_tao DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (ma_nguoi_dung) REFERENCES nguoi_dung(ma_nguoi_dung) )`,
  `CREATE TABLE ky_nang ( ma_ky_nang TEXT PRIMARY KEY, ten_ky_nang TEXT NOT NULL, tieu_de TEXT, mo_ta TEXT, trang_thai TEXT DEFAULT 'kich_hoat' )`,
  `CREATE TABLE bo_nho_dai_han ( ma_bo_nho TEXT PRIMARY KEY, loai TEXT DEFAULT 'thong_tin_user', noi_dung TEXT NOT NULL, do_uu_tien INTEGER DEFAULT 5, ngay_tao DATETIME DEFAULT CURRENT_TIMESTAMP , ma_nguoi_dung TEXT, _sync_at DATETIME)`,
  `CREATE TABLE app_settings ( khoa TEXT PRIMARY KEY, gia_tri TEXT )`,
  `CREATE TABLE model_scan_cache ( ma_model TEXT NOT NULL, ma_nha_cung_cap TEXT NOT NULL, trang_thai TEXT NOT NULL, do_tre_ms INTEGER DEFAULT 0, loi_chi_tiet TEXT, thoi_gian_quet TEXT DEFAULT (datetime('now')), PRIMARY KEY (ma_model, ma_nha_cung_cap) )`,
  `CREATE TABLE provider_scan_log ( ma_nha_cung_cap TEXT PRIMARY KEY, lan_quet_cuoi TEXT DEFAULT (datetime('now')), tong_model INTEGER DEFAULT 0, model_hoat_dong INTEGER DEFAULT 0 )`,
  `CREATE TABLE model_agent_cap ( ma_model TEXT NOT NULL, ma_nha_cung_cap TEXT NOT NULL, agent_ok INTEGER DEFAULT 0, thoi_gian_test TEXT DEFAULT (datetime('now')), PRIMARY KEY (ma_model, ma_nha_cung_cap) )`,
  `CREATE TABLE _sync_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, operation TEXT NOT NULL, row_id TEXT, target_db TEXT NOT NULL, status TEXT NOT NULL, error TEXT, synced_at TEXT DEFAULT CURRENT_TIMESTAMP )`,
  `CREATE TABLE _sync_queue ( id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, operation TEXT NOT NULL, row_id TEXT, row_data TEXT, status TEXT DEFAULT 'pending', error TEXT, retry_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP )`,
  `CREATE TABLE iptv_scan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT DEFAULT 'running', total_channels INTEGER DEFAULT 0, online_channels INTEGER DEFAULT 0, offline_channels INTEGER DEFAULT 0, countries_scanned INTEGER DEFAULT 0, new_channels INTEGER DEFAULT 0, lost_channels INTEGER DEFAULT 0)`,
  `CREATE TABLE iptv_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, country_name TEXT DEFAULT '', group_name TEXT DEFAULT '', channel_name TEXT NOT NULL, url TEXT NOT NULL, logo TEXT DEFAULT '', status TEXT DEFAULT 'unknown', latency_ms INTEGER DEFAULT 0, http_code INTEGER DEFAULT 0, last_checked TEXT, last_online TEXT, first_seen TEXT DEFAULT (datetime('now')), scan_id INTEGER REFERENCES iptv_scan_log(id))`,
  `CREATE TABLE iptv_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT DEFAULT '', data TEXT DEFAULT '{}', is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE repo_summaries ( full_name TEXT PRIMARY KEY, summary TEXT DEFAULT '', language TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now', 'localtime')) )`,
  `CREATE TABLE saved_repos ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT UNIQUE NOT NULL, owner TEXT, name TEXT, description TEXT, language TEXT, stars INTEGER DEFAULT 0, forks INTEGER DEFAULT 0, stars_gained INTEGER DEFAULT 0, period TEXT DEFAULT '', url TEXT, saved_at TEXT DEFAULT (datetime('now', 'localtime')) )`,
  `CREATE TABLE star_snapshots ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, stars INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now', 'localtime')), UNIQUE(full_name, created_at) )`,
  `CREATE TABLE starred_repos ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT UNIQUE NOT NULL, owner TEXT, name TEXT, starred_at TEXT DEFAULT (datetime('now', 'localtime')) )`,
  `CREATE TABLE trending_cache ( id INTEGER PRIMARY KEY AUTOINCREMENT, language TEXT NOT NULL DEFAULT '', since TEXT NOT NULL DEFAULT 'daily', repos_json TEXT NOT NULL, fetched_at TEXT DEFAULT (datetime('now', 'localtime')), UNIQUE(language, since) )`,
  `CREATE TABLE trending_notifications ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, owner TEXT, name TEXT, description TEXT DEFAULT '', language TEXT DEFAULT '', stars INTEGER DEFAULT 0, stars_gained INTEGER DEFAULT 0, period TEXT DEFAULT '', url TEXT, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now', 'localtime')) )`,
  `CREATE TABLE audit_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, thoi_gian DATETIME DEFAULT CURRENT_TIMESTAMP, phuong_thuc TEXT, duong_dan TEXT, dia_chi_ip TEXT, ma_nguoi_dung TEXT, ma_trang_thai INTEGER, thoi_luong_ms INTEGER, tai_lieu TEXT )`,
  `CREATE TABLE context_sessions ( ma_nguoi_dung TEXT PRIMARY KEY, du_lieu TEXT NOT NULL, ngay_cap_nhat DATETIME DEFAULT CURRENT_TIMESTAMP )`,
  `CREATE TABLE sessions_store ( sid TEXT PRIMARY KEY, du_lieu TEXT NOT NULL,
expires_at TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
  `CREATE TABLE tiktok_phien ( token TEXT PRIMARY KEY, cookie_ma_hoa TEXT NOT NULL, het_han INTEGER NOT NULL )`,
  // P2-20(8): gom từ services.routes.js (đợt 4 làm migration — đợt này chỉ gom, KHÔNG đổi schema)
  `CREATE TABLE chia_se_hoi_thoai (ma_chia_se TEXT PRIMARY KEY, ma_hoi_thoai TEXT NOT NULL, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE lich_nhac (ma_nhac TEXT PRIMARY KEY, ma_nguoi_dung TEXT NOT NULL, noi_dung TEXT NOT NULL, thoi_gian TEXT NOT NULL, da_nhac INTEGER DEFAULT 0, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE thong_bao (ma_tb TEXT PRIMARY KEY, ma_nguoi_dung TEXT NOT NULL, noi_dung TEXT NOT NULL, da_doc INTEGER DEFAULT 0, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE nhat_ky (ma_ky TEXT PRIMARY KEY, ma_nguoi_dung TEXT, hanh_dong TEXT NOT NULL, chi_tiet TEXT, ngay_tao TEXT DEFAULT CURRENT_TIMESTAMP)`,
  // M3: state throttle provider nằm trên DB — restart server không mất backoff
  `CREATE TABLE provider_throttle ( provider TEXT PRIMARY KEY, until BIGINT DEFAULT 0, backoff_ms INTEGER DEFAULT 30000, failures INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )`,
];

const INDEXES = [
  'CREATE INDEX idx_iptv_country ON iptv_channels(country)',
  'CREATE INDEX idx_iptv_status ON iptv_channels(status)',
  'CREATE INDEX idx_iptv_url ON iptv_channels(url)',
  'CREATE INDEX idx_notif_created ON iptv_notifications(created_at DESC)',
  'CREATE INDEX idx_notif_read ON iptv_notifications(is_read)',
  'CREATE INDEX idx_sync_queue_status ON _sync_queue(status, created_at)',
  'CREATE INDEX idx_memory_user_type ON bo_nho_dai_han(ma_nguoi_dung, loai)',
  'CREATE INDEX idx_memory_user_priority ON bo_nho_dai_han(ma_nguoi_dung, do_uu_tien DESC, ngay_tao DESC)',
  // 2/10/2026: index cho query nóng còn thiếu (thêm sau migrate Neon) — idempotent
  'CREATE INDEX idx_tin_nhan_hoi_thoai ON tin_nhan(ma_hoi_thoai, ngay_gui)',
  'CREATE INDEX idx_cuoc_hoi_thoai_user ON cuoc_hoi_thoai(ma_nguoi_dung, ngay_cap_nhat DESC)',
  'CREATE INDEX idx_khoa_api_provider_lc ON khoa_api(LOWER(ten_nha_cung_cap))',
  'CREATE INDEX idx_khoa_api_user ON khoa_api(ma_nguoi_dung)',
  'CREATE INDEX idx_thong_bao_user_read ON thong_bao(ma_nguoi_dung, da_doc, ngay_tao DESC)',
  'CREATE INDEX idx_lich_nhac_due ON lich_nhac(da_nhac, thoi_gian)',
  'CREATE INDEX idx_lich_nhac_user ON lich_nhac(ma_nguoi_dung, thoi_gian)',
  'CREATE INDEX idx_nhat_ky_time ON nhat_ky(ngay_tao DESC)',
  'CREATE INDEX idx_audit_log_time ON audit_log(thoi_gian DESC)',
  'CREATE INDEX idx_audit_log_user ON audit_log(ma_nguoi_dung)',
  'CREATE INDEX idx_sessions_expires ON sessions_store(expires_at)',
  'CREATE INDEX idx_iptv_channels_scan ON iptv_channels(scan_id)',
  'CREATE INDEX idx_tai_lieu_rag_user ON tai_lieu_rag(ma_nguoi_dung)',
];

// Chuyển DDL SQLite → PostgreSQL
function toPg(ddl) {
  return ddl
    .replace(/,? *--[^\n]*/g, '')                                   // bỏ comment inline
    .replace(/AUTOINCREMENT/gi, '')                                 // PG: SERIAL thay autoincrement
    .replace(/INTEGER PRIMARY KEY/gi, 'SERIAL PRIMARY KEY')
    .replace(/DEFAULT \(datetime\('now', *'localtime'\)\)/gi, 'DEFAULT NOW()')
    .replace(/DEFAULT \(datetime\('now'\)\)/gi, 'DEFAULT NOW()')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\bBLOB\b/gi, 'BYTEA');
}

function execSql(sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
}

function allRows(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}

// Tách các phần tử trong (...) ngoài cùng, tôn trọng ngoặc + quote (để lấy định nghĩa cột)
function splitTopLevel(body) {
  const parts = [];
  let cur = '', depth = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch; cur += ch;
    } else if (ch === '(') {
      depth++; cur += ch;
    } else if (ch === ')') {
      depth--; cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// P2-17 migration: DB cũ thiếu cột mới → ALTER TABLE ADD COLUMN (idempotent, 2 chiều SQLite/PG)
async function migrateMissingColumns() {
  const isPg = db.type === 'postgresql';
  let added = 0;
  for (const ddl of TABLES) {
    const m = ddl.match(/CREATE TABLE\s+(\w+)\s*\(([\s\S]*)\)\s*$/);
    if (!m) continue;
    const [, table, body] = m;
    const colDefs = [];
    for (const part of splitTopLevel(body)) {
      const up = part.trim().toUpperCase();
      // Bỏ constraint mức bảng (giữ lại định nghĩa cột, kể cả UNIQUE inline / REFERENCES inline)
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\s*\(|CHECK\s*\(|CONSTRAINT\s)/.test(up)) continue;
      const nameM = part.trim().match(/^["'`\[]?(\w+)["'`\]]?/);
      if (!nameM) continue;
      // Cột PRIMARY KEY không ADD được về sau — bảng đã có thì bỏ qua
      if (/\bPRIMARY\s+KEY\b/i.test(part)) continue;
      colDefs.push({ name: nameM[1], def: part.trim() });
    }
    if (!colDefs.length) continue;
    let existing = new Set();
    try {
      if (isPg) {
        const rows = await allRows('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
        existing = new Set(rows.map((r) => String(r.column_name).toLowerCase()));
      } else {
        const rows = await allRows(`PRAGMA table_info(${table})`);
        existing = new Set(rows.map((r) => String(r.name).toLowerCase()));
      }
    } catch {
      continue; // bảng chưa có (sẽ tạo ở vòng CREATE) hoặc lỗi quyền — bỏ qua
    }
    for (const c of colDefs) {
      if (existing.has(c.name.toLowerCase())) continue;
      let def = isPg ? toPg(c.def) : c.def;
      try {
        await execSql(`ALTER TABLE ${table} ADD COLUMN ${def}`);
        added++;
        console.log(`[init-db] migration: ${table} + cột ${c.name}`);
      } catch (e) {
        console.warn('[init-db] migration bỏ qua:', table, c.name, (e.message || e).slice(0, 100));
      }
    }
  }
  if (added) console.log(`[init-db] migration: đã thêm ${added} cột thiếu`);
}

/**
 * Khởi tạo schema — chạy mỗi lần server khởi động (idempotent, IF NOT EXISTS).
 * Gọi TRƯỚC ensureAdmin/ensureGuestUser để bảng đã tồn tại.
 */
// JWT_SECRET tự động: nếu chưa set env → tạo + lưu app_settings (ổn định giữa restart, không cần set tay)
async function ensureJwtSecret() {
  if (process.env.JWT_SECRET) {
    global.__JWT_SECRET = process.env.JWT_SECRET;
    return;
  }
  try {
    const row = await getRow("SELECT gia_tri FROM app_settings WHERE khoa = 'jwt_secret'");
    if (row && row.gia_tri) {
      global.__JWT_SECRET = row.gia_tri;
      console.log('[init-db] JWT_SECRET đọc từ DB (ổn định giữa restart)');
      return;
    }
    const secret = crypto.randomBytes(32).toString('hex');
    await runSql("INSERT INTO app_settings (khoa, gia_tri) VALUES ('jwt_secret', ?) ON CONFLICT(khoa) DO UPDATE SET gia_tri = excluded.gia_tri", [secret]);
    global.__JWT_SECRET = secret;
    console.log('[init-db] Đã tự tạo JWT_SECRET và lưu vào DB — set env JWT_SECRET nếu muốn override');
  } catch (e) {
    console.warn('[init-db] Không lưu được JWT_SECRET vào DB (fallback random):', e.message);
    global.__JWT_SECRET = crypto.randomBytes(32).toString('hex');
  }
}

async function initDatabase() {
  const isPg = db.type === 'postgresql';
  let created = 0;
  for (const ddl of TABLES) {
    const sql = (isPg ? toPg(ddl) : ddl)
      .replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ');
    try { await execSql(sql); created++; } catch (e) { console.warn('[init-db] Bảng đã tồn tại/bỏ qua:', (e.message || e).slice(0, 120)); }
  }
  for (const idx of INDEXES) {
    const sql = idx.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ');
    try { await execSql(sql); } catch (e) { /* index đã có */ }
  }
  await migrateMissingColumns();
  await ensureJwtSecret();
  console.log(`[init-db] Schema sẵn sàng (${isPg ? 'PostgreSQL' : db.type}): ${created}/${TABLES.length} bảng`);
}

module.exports = { initDatabase };
