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
// Cách lấy: mở tiktok.com (đã đăng nhập) → F12 console → gõ document.cookie → copy.
// FE: POST /tiktok/session {cookies} → {token}; token đi kèm feed/media.
const _sessions = new Map(); // token -> { cookieString, exp }
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
function createSession(cookieString) {
  const list = parseCookieString(cookieString);
  if (list.length < 3) throw new Error('Cookie quá ngắn — copy cả chuỗi document.cookie trên tiktok.com');
  const token = require('crypto').randomBytes(16).toString('hex');
  _sessions.set(token, { cookieString: String(cookieString), exp: Date.now() + 1000 * 60 * 60 * 24 });
  if (_sessions.size > 100) _sessions.delete(_sessions.keys().next().value);
  return { token, cookieCount: list.length, logged: /sessionid|sid_tt|sid_guard/i.test(String(cookieString)) };
}
function getSession(token) {
  const s = _sessions.get(String(token || ''));
  if (!s || s.exp < Date.now()) return null;
  return s;
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
  const ses = getSession(session);
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
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
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

module.exports = { fetchFeed, streamHeaders, cleanUser, cleanTag, resolvePlayUrl, createSession, getSession, fetchDirect };

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
