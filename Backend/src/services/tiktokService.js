/**
 * tiktokService.js — TikTok Feed (xem dọc + lọc chủ đề AI)
 *
 * Vì sao Playwright mà không yt-dlp:
 *   - yt-dlp (kể cả nightly 2026.10) gãy extractor tiktok:user
 *     ("Unable to extract secondary user ID").
 *   - API /api/post/item_list gọi thô cần signature (msToken/X-Bogus)
 *     → trả 200 nhưng body rỗng.
 *   - Browser thật (Playwright chromium) qua được bot wall, tự gọi
 *     item_list với signature đầy đủ → bắt response mạng là có data.
 *
 * playAddr lấy từ feed sống vài giờ; phát qua /tiktok/stream của backend
 * (piped kèm Referer + UA + Range) nên FE không dính CORS/hotlink.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FEED_TIMEOUT = 35000;

const TT_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage', // container RAM nhỏ (/dev/shm bé → sập) — dùng /tmp thay
  '--disable-gpu',
  '--no-zygote',
];

// Serialize các lần scrape feed (mỗi lần launch 1 browser — free tier không chịu 2 browser song song)
let _chain = Promise.resolve();
function serialize(task) {
  const run = _chain.then(task, task);
  _chain = run.catch(() => {});
  return run;
}

function cleanUser(u) {
  return String(u || '').trim().replace(/^@/, '')
    .replace(/^https?:\/\/(www\.|m\.)?tiktok\.com\/@?/i, '')
    .split(/[/?#&]/)[0];
}
function cleanTag(t) {
  return String(t || '').trim().replace(/^#/, '')
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/tag\//i, '')
    .split(/[/?#&]/)[0];
}

// ─── Phiên đăng nhập (cookie TikTok của user) ──────────────────────────────
// Lướt "Dành cho bạn" như nick thật + tăng độ tin cậy qua bot wall.
// 2 cách: quét QR (khuyên dùng) hoặc dán document.cookie thủ công.
// FE: POST /tiktok/session {cookies} → {token}; token đi kèm feed/media.
const _sessions = new Map(); // token -> { cookieString, exp }
// Lưu phiên xuống DB (sống qua restart/deploy — quét 1 lần dùng nhiều tuần)
const _db = require('../config/db');
const _runSql = (sql, params = []) => new Promise((res, rej) => _db.run(sql, params, (e) => e ? rej(e) : res()));
const _getRow = (sql, params = []) => new Promise((res, rej) => _db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
const _cryptoKeys = (() => { try { return require('../utils/cryptoKeys'); } catch (e) { return null; } })();
let _daTaoBang = false;
async function damBaoBangPhien() {
  if (_daTaoBang) return;
  _daTaoBang = true;
  try {
    await _runSql('CREATE TABLE IF NOT EXISTS tiktok_phien ( token TEXT PRIMARY KEY, cookie_ma_hoa TEXT NOT NULL, het_han INTEGER NOT NULL )', []);
  } catch (e) { /* DB chưa sẵn — lần sau */ _daTaoBang = false; }
}
// ─── Đăng nhập bằng QR (quét bằng app TikTok trên điện thoại) ───────────────
// FE: POST /tiktok/qr/start → {loginId}; hiện QR; poll GET /tiktok/qr/status
// → done: {token} (phiên như createSession). Hết 150s không quét thì expired.
const _logins = new Map(); // loginId -> { status, qr, token, logged, cookieCount, error }
const QR_TIMEOUT = 150000;

// Trình duyệt QR chạy nền sẵn (hâm nóng): bấm là chụp mã ngay, khỏi chờ mở mới.
// Giữ đúng 1 browser + 1 trang login; chết thì lần sau mở lại (đường chậm cũ).
let _qrNong = null;
async function layTrangQrNong() {
  if (_qrNong && _qrNong.page && !_qrNong.page.isClosed()) return _qrNong;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: TT_ARGS });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 500, height: 760 }, locale: 'vi-VN' });
  await ctx.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  }).catch(() => {});
  const page = await ctx.newPage();
  _qrNong = { browser, ctx, page };
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
  await page.getByText(/mã QR|QR Code/i).first().click({ timeout: 15000 }).catch(() => {});
  return _qrNong;
}
// Hâm sẵn sau khi server lên 20s (chạy nền, không chặn boot)
setTimeout(() => { layTrangQrNong().catch(() => { _qrNong = null; }); }, 20000);

async function startLogin() {
  for (const [id, rec] of _logins) {
    if (rec.status === 'waiting') return { loginId: id, qr: rec.qr, reused: true };
  }
  const loginId = require('crypto').randomBytes(8).toString('hex');
  const rec = { status: 'starting', qr: null, token: null, logged: false, cookieCount: 0, error: null, daQuet: false, exp: Date.now() + QR_TIMEOUT + 30000 };
  _logins.set(loginId, rec);
  if (_logins.size > 10) _logins.delete(_logins.keys().next().value);
  chayLogin(loginId).catch((e) => {
    const r = _logins.get(loginId);
    if (r && r.status !== 'done') { r.status = 'error'; r.error = String((e && e.message) || e).slice(0, 150); }
  });
  return { loginId };
}

async function chayLogin(loginId) {
  const rec = _logins.get(loginId);
  if (!rec) return;
  // Ưu tiên trang hâm sẵn (bấm là có mã ngay); hỏng thì mở browser riêng
  let browser = null;
  let dungChung = false;
  let ctx = null;
  let page = null;
  try {
    try {
      const nong = await layTrangQrNong();
      page = nong.page; ctx = nong.ctx; dungChung = true;
      // Tải mới mã QR trên trang nóng (mã cũ có thể hết hạn)
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await page.getByText(/mã QR|QR Code/i).first().click({ timeout: 15000 }).catch(() => {});
    } catch (eNong) {
      const { chromium } = require('playwright');
      browser = await chromium.launch({
        headless: true,
        args: TT_ARGS,
      });
      ctx = await browser.newContext({ userAgent: UA, viewport: { width: 500, height: 760 }, locale: 'vi-VN' });
      // Chặn ảnh/media/font cho nhẹ (mã QR là khung canvas, không phải thẻ ảnh;
      // nếu khung chụp ra quá bé thì chụp cả trang bù)
      await ctx.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        return route.continue();
      }).catch(() => {});
      page = await ctx.newPage();
      await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      // Chờ trang login hiện (theo tín hiệu, không chờ cứng) rồi bấm mục "mã QR"
      await page.getByText(/mã QR|QR Code/i).first().waitFor({ timeout: 25000 }).catch(() => {});
      await page.getByText(/mã QR|QR Code/i).first().click({ timeout: 8000 }).catch(() => {});
    }
  const han = Date.now() + QR_TIMEOUT;
  try {
    // Chờ khung mã QR hiện rồi chụp ngay
    const khungQr = page.locator('canvas, img[src*="qr" i], div[class*="qr" i] canvas').first();
    await khungQr.waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200); // cho mã render nét
    // Chụp mã QR (ưu tiên đúng khung QR, rớt thì cả trang)
    let anh = await khungQr.screenshot().catch(() => null);
    if ((!anh || anh.length < 2000) && !page.isClosed()) anh = await page.screenshot().catch(() => null);
    if (!anh) throw new Error('Không chụp được mã QR');
    rec.qr = 'data:image/png;base64,' + anh.toString('base64');
    rec.status = 'waiting';
    // Chờ user quét + XÁC NHẬN trên điện thoại: đăng nhập xong là có cookie
    // sessionid/sid_tt (rời trang login) → gom cookie thành phiên
    while (Date.now() < han) {
      await page.waitForTimeout(3000);
      const url = page.url();
      const cookies = await ctx.cookies('https://www.tiktok.com').catch(() => []);
      const chuoi = cookies.map((c) => c.name + '=' + c.value).join('; ');
      if (!rec.daQuet) {
        // Đã quét mã thì trang đổi chữ sang chờ xác nhận — báo cho user biết
        const chu = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
        if (/xác nhận|confirm|verify it.s you|đăng nhập trên thiết bị/i.test(chu)) rec.daQuet = true;
      }
      if (!url.includes('/login') || /sessionid|sid_tt|sid_guard|uid_tt/i.test(chuoi)) {
        if (/sessionid|sid_tt/i.test(chuoi)) {
          const ses = await createSession(chuoi);
          rec.token = ses.token;
          rec.logged = ses.logged;
          rec.cookieCount = ses.cookieCount;
          rec.status = 'done';
          return;
        }
      }
    }
    rec.status = 'expired';
  } finally {
    // Trang dùng chung thì KHÔNG đóng browser (giữ hâm cho lần sau)
    if (!dungChung && browser) await browser.close().catch(() => {});
    const r = _logins.get(loginId);
    if (r && r.status === 'waiting') r.status = 'expired';
    setTimeout(() => _logins.delete(loginId), 60000);
  }
  } catch (eNgoai) {
    const r = _logins.get(loginId);
    if (r && r.status !== 'done') { r.status = 'error'; r.error = String((eNgoai && eNgoai.message) || eNgoai).slice(0, 150); }
    if (!dungChung && browser) await browser.close().catch(() => {});
  }
}

function loginStatus(loginId) {
  const r = _logins.get(String(loginId || ''));
  if (!r) return { status: 'unknown' };
  return { status: r.status, qr: r.qr, token: r.token, logged: r.logged, cookieCount: r.cookieCount, error: r.error, daQuet: !!r.daQuet };
}
function parseCookieString(s) {
  return String(s || '').split(/;\s*/).map((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return null;
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (!name || !value) return null;
    return { name, value, domain: '.tiktok.com', path: '/' };
  }).filter(Boolean);
}
async function createSession(cookieString) {
  const list = parseCookieString(cookieString);
  if (list.length < 3) throw new Error('Cookie quá ngắn — copy cả chuỗi document.cookie trên tiktok.com');
  const token = require('crypto').randomBytes(16).toString('hex');
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 ngày (lưu DB, qua restart/deploy)
  _sessions.set(token, { cookieString: String(cookieString), exp });
  if (_sessions.size > 100) _sessions.delete(_sessions.keys().next().value);
  try {
    await damBaoBangPhien();
    const maHoa = _cryptoKeys ? _cryptoKeys.encryptKey(String(cookieString)) : String(cookieString);
    await _runSql(
      'INSERT INTO tiktok_phien (token, cookie_ma_hoa, het_han) VALUES (?, ?, ?)',
      [token, maHoa, exp]
    ).catch(async () => {
      await _runSql('UPDATE tiktok_phien SET cookie_ma_hoa = ?, het_han = ? WHERE token = ?', [maHoa, exp, token]);
    });
  } catch (e) { /* DB lỗi thì phiên chỉ sống trong RAM */ }
  return { token, cookieCount: list.length, logged: /sessionid|sid_tt|sid_guard/i.test(String(cookieString)) };
}
async function getSession(token) {
  const key = String(token || '');
  if (!key) return null;
  const nho = _sessions.get(key);
  if (nho && nho.exp > Date.now()) return nho;
  try {
    await damBaoBangPhien();
    const hang = await _getRow('SELECT cookie_ma_hoa, het_han FROM tiktok_phien WHERE token = ?', [key]);
    if (!hang || !hang.het_han || Number(hang.het_han) < Date.now()) return null;
    let chuoi = hang.cookie_ma_hoa;
    if (_cryptoKeys && String(chuoi).startsWith('enc:v1:')) {
      try { chuoi = _cryptoKeys.decryptKey(chuoi); } catch (e) { return null; }
    }
    const ses = { cookieString: chuoi, exp: Number(hang.het_han) };
    _sessions.set(key, ses);
    return ses;
  } catch (e) { return null; }
}
// Thử tải trực tiếp playAddr bằng cookie đăng nhập (CDN nới tay với nick thật)
async function fetchDirect(playAddr, cookieString, range) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch(playAddr, {
      headers: {
        ...streamHeaders(range ? { Range: range } : {}),
        Cookie: cookieString,
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) throw new Error('CDN trả ' + r.status);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function mapItem(it, fallbackAuthor) {
  const v = it.video || {};
  const a = it.author || {};
  return {
    id: String(it.id || ''),
    caption: String(it.desc || ''),
    url: it.id ? `https://www.tiktok.com/@${a.uniqueId || fallbackAuthor}/video/${it.id}` : '',
    playAddr: String(v.playAddr || v.downloadAddr || ''),
    cover: String(v.cover || v.originCover || v.dynamicCover || ''),
    duration: v.duration || null,
    author: a.uniqueId ? `@${a.uniqueId}` : (fallbackAuthor ? `@${fallbackAuthor}` : ''),
    nickname: String(a.nickname || ''),
    views: (it.stats && it.stats.playCount) || null,
    likes: (it.stats && it.stats.diggCount) || null,
    comments: (it.stats && it.stats.commentCount) || null,
    shares: (it.stats && it.stats.shareCount) || null,
  };
}

// Fallback: JSON SSR nhúng trong trang (khi lỡ không bắt được response mạng).
// Quét MỌI bucket (user-detail, video-detail, for-you...) tìm mảng itemList.
function extractFromUniversalData(raw) {
  try {
    const obj = JSON.parse(raw);
    const scope = (obj.__DEFAULT_SCOPE__) || {};
    const tim = (node, sau = 0) => {
      if (!node || typeof node !== 'object' || sau > 4) return null;
      if (Array.isArray(node.itemList) && node.itemList.length
        && node.itemList[0] && (node.itemList[0].video || node.itemList[0].id)) return node.itemList;
      if (Array.isArray(node)) {
        for (const phan of node.slice(0, 40)) {
          const kq = tim(phan, sau + 1);
          if (kq) return kq;
        }
        return null;
      }
      for (const khoa of Object.keys(node).slice(0, 60)) {
        if (khoa === '__proto__') continue;
        try {
          const kq = tim(node[khoa], sau + 1);
          if (kq) return kq;
        } catch (e) { /* bỏ qua nhánh lỗi */ }
      }
      return null;
    };
    return tim(scope);
  } catch (e) { /* JSON giữa chừng hoặc không có — bỏ qua */ }
  return null;
}

/**
 * Lấy feed video: "Dành cho bạn" (foryou, cần cookie đăng nhập để cá nhân hoá),
 * 1 @user, hoặc 1 #hashtag.
 * @returns {Promise<{source, count, videos: Array}>}
 */
async function fetchFeed({ user, tag, foryou, session, limit = 20 } = {}) {
  const u = cleanUser(user);
  const h = cleanTag(tag);
  const fy = foryou === true || foryou === '1' || foryou === 1;
  if (!u && !h && !fy) throw new Error('Chọn nguồn: Dành cho bạn, @username hoặc #hashtag');
  const pageUrl = fy ? 'https://www.tiktok.com/foryou' : (u ? `https://www.tiktok.com/@${u}` : `https://www.tiktok.com/tag/${h}`);
  const maxItems = Math.min(30, Math.max(1, parseInt(limit, 10) || 20));
  const ses = await getSession(session);
  const cookieList = ses ? parseCookieString(ses.cookieString) : [];

  // TikTok chập chờn (bot wall theo IP/lượt) → 1 lượt duy nhất (~60s, proxy cắt
  // kết nối chờ lâu). Thất bại thì FE bấm "Tải lại" là 1 lượt mới (sạch browser).
  // Chặn cứng 90s/lượt: quá giờ là bỏ, trả lỗi gọn thay vì treo tới khi proxy cắt.
  let lastErr = null;
  for (let attempt = 1; attempt <= 1; attempt++) {
    try {
      return await Promise.race([
        serialize(() => scrapeOnce(pageUrl, maxItems, u || '', h, cookieList, fy)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Hết 90s chờ TikTok — thử bấm Tải lại')), 90000)),
      ]);
    } catch (e) {
      lastErr = e;
      console.warn(`[TikTok] feed lần ${attempt} lỗi: ${(e.message || e).toString().slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function scrapeOnce(pageUrl, maxItems, u, h, cookieList, fy) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: TT_ARGS,
    });
    try {
      const ctx = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
      });
      if (cookieList && cookieList.length) {
        await ctx.addCookies(cookieList).catch(() => {});
      }
      // Chặn tài nguyên nặng cho nhanh, giữ script/XHR để qua challenge
      await ctx.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        return route.continue();
      });
      const page = await ctx.newPage();

      // Gom DỒN từ mọi response item_list (lượt đầu hay trả body rỗng; foryou mỗi
      // lượt chỉ trả vài video nên phải gom nhiều lượt + cuộn liên tục).
      // IP datacenter hay bị trả rỗng lúc đầu — hết lượt 1 thì reload (đã có
      // cookie challenge) rồi gom tiếp. Đủ maxItems là về sớm.
      const apiHits = [];
      page.on('response', (r) => {
        // MỌI item_list: post (user), challenge (tag), recommend (foryou), prefetch/preload...
        if (r.url().includes('item_list')) apiHits.push(r);
      });
      const gom = new Map(); // id video -> item (giữ thứ tự xuất hiện)
      const hutResponseMoi = async () => {
        for (const resp of apiHits) {
          if (resp._daDoc) continue;
          resp._daDoc = true;
          // response treo (không bao giờ xong) → bỏ qua sau 8s, không kẹt cả request
          const data = await Promise.race([
            resp.json().catch(() => null),
            new Promise((r) => setTimeout(() => r(null), 8000)),
          ]);
          const list = data && Array.isArray(data.itemList) ? data.itemList : null;
          if (list) {
            for (const it of list) {
              if (it && it.id && !gom.has(String(it.id))) gom.set(String(it.id), it);
              if (gom.size >= maxItems * 2) break;
            }
          }
        }
      };

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: FEED_TIMEOUT }).catch(() => {});
      const han = Date.now() + 30000;
      let lanCuon = 0;
      while (gom.size < maxItems && Date.now() < han) {
        await page.waitForTimeout(2500);
        await hutResponseMoi();
        if (gom.size < maxItems && Date.now() - lanCuon > 4000) {
          lanCuon = Date.now();
          await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
        }
      }
      if (gom.size < 3) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: FEED_TIMEOUT }).catch(() => {});
        const han2 = Date.now() + 25000;
        while (gom.size < maxItems && Date.now() < han2) {
          await page.waitForTimeout(2500);
          await hutResponseMoi();
          await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
        }
      }
      let items = gom.size ? Array.from(gom.values()) : null;
      let author = u || '';
      if (items && items.length) {
        const au = items[0] && items[0].author;
        if (au && au.uniqueId) author = au.uniqueId;
      }
      if (!items) {
        // Fallback: đọc JSON SSR trong DOM
        const raw = await page.evaluate(() => {
          const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
          return el ? el.textContent : null;
        }).catch(() => null);
        if (raw) items = extractFromUniversalData(raw);
      }

      if (!items || !items.length) {
        const title = await page.title().catch(() => '');
        throw new Error(`Không lấy được feed TikTok (bot wall hoặc tài khoản rỗng) — thử lại sau ít phút [title=${title.slice(0, 40)}, apiHits=${apiHits.length}]`);
      }

      const videos = items.slice(0, maxItems)
        .map((it) => mapItem(it, author))
        .filter((v) => v.id && v.playAddr);
      if (!videos.length) {
        throw new Error('Feed có data nhưng không tách được link phát — thử lại');
      }

      return { source: fy ? 'Dành cho bạn' : (u ? `@${u}` : `#${h}`), count: videos.length, videos, foryou: !!fy };
    } finally {
      await browser.close().catch(() => {});
    }
}

// GHI CHÚ: playAddr từ feed phát qua /tiktok/stream, nhưng CDN TikTok trả 403
// ngay cả link vừa scrape (IP máy bị đánh dấu) → đường phát chính là /tiktok/media:
// giải link qua tikwm (bên trung gian công khai) rồi pipe về FE.
// Link tikwm cho Range (206) + CORS *, test thật ra file mp4 (ftyp).

// Headers để stream playAddr từ CDN TikTok (CDN chặn hotlink thiếu Referer)
function streamHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Referer': 'https://www.tiktok.com/',
    'Origin': 'https://www.tiktok.com',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

module.exports = { fetchFeed, streamHeaders, cleanUser, cleanTag, resolvePlayUrl, createSession, getSession, fetchDirect, startLogin, loginStatus };

// ─── Giải link phát qua tikwm (CDN TikTok chặn IP máy này → 403) ────────────
// Cache theo id video 2 giờ (link tikwm sống vài giờ, đỡ gọi lại mỗi lần xem).
const _playCache = new Map();
const PLAY_TTL = 1000 * 60 * 60 * 2;

async function resolvePlayUrl(videoId, author) {
  const id = String(videoId || '').trim();
  if (!id) throw new Error('Thiếu id video');
  const hit = _playCache.get(id);
  if (hit && hit.exp > Date.now() && hit.url) return hit;
  const a = cleanUser(author);
  const pageUrl = a ? `https://www.tiktok.com/@${a}/video/${id}` : `https://www.tiktok.com/video/${id}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(pageUrl), {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('tikwm HTTP ' + r.status);
    const j = await r.json();
    if (!j || j.code !== 0 || !j.data || !j.data.play) {
      throw new Error('tikwm: ' + ((j && j.msg) || 'không có link phát'));
    }
    const entry = { url: String(j.data.play), cover: String((j.data && j.data.cover) || ''), exp: Date.now() + PLAY_TTL };
    _playCache.set(id, entry);
    if (_playCache.size > 200) _playCache.delete(_playCache.keys().next().value);
    return entry;
  } finally {
    clearTimeout(timer);
  }
}
