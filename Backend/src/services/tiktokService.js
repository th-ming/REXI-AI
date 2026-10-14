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
  };
}

// Fallback: JSON SSR nhúng trong trang (khi lỡ không bắt được response mạng)
function extractFromUniversalData(raw) {
  try {
    const obj = JSON.parse(raw);
    const scope = (obj.__DEFAULT_SCOPE__) || {};
    const buckets = ['webapp.user-detail', 'webapp.video-detail'];
    for (const b of buckets) {
      const bucket = scope[b];
      if (!bucket) continue;
      const itemList = (bucket.itemList || (bucket.userInfo && bucket.userInfo.itemList)) || [];
      if (itemList.length) return itemList;
    }
  } catch (e) { /* JSON giữa chừng hoặc không có — bỏ qua */ }
  return null;
}

/**
 * Lấy feed video của 1 @user hoặc #hashtag.
 * @returns {Promise<{source, count, videos: Array}>}
 */
async function fetchFeed({ user, tag, limit = 20 } = {}) {
  const u = cleanUser(user);
  const h = cleanTag(tag);
  if (!u && !h) throw new Error('Nhập @username hoặc #hashtag');
  const pageUrl = u ? `https://www.tiktok.com/@${u}` : `https://www.tiktok.com/tag/${h}`;
  const maxItems = Math.min(30, Math.max(1, parseInt(limit, 10) || 20));

  // TikTok chập chờn (bot wall theo IP/lượt) → thử tối đa 2 lần, mỗi lần browser mới.
  // Mỗi lượt tối đa ~60s (proxy cắt kết nối chờ lâu) — FE bấm "Tải lại" để thử tiếp.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await serialize(() => scrapeOnce(pageUrl, maxItems, u || '', h));
    } catch (e) {
      lastErr = e;
      console.warn(`[TikTok] feed lần ${attempt} lỗi: ${(e.message || e).toString().slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function scrapeOnce(pageUrl, maxItems, u, h) {
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
      // Chặn tài nguyên nặng cho nhanh, giữ script/XHR để qua challenge
      await ctx.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        return route.continue();
      });
      const page = await ctx.newPage();

      // Gom TẤT CẢ response item_list (lượt đầu hay trả body rỗng).
      // IP datacenter hay bị trả rỗng lúc đầu — chờ tới 60s, hết thì reload
      // (lúc này đã có cookie challenge) rồi chờ tiếp 45s.
      const apiHits = [];
      page.on('response', (r) => {
        if (r.url().includes('/api/post/item_list') || r.url().includes('/api/challenge/item_list')) apiHits.push(r);
      });
      const layItemDauTien = async () => {
        for (const resp of apiHits) {
          if (resp._daDoc) continue;
          resp._daDoc = true;
          const data = await resp.json().catch(() => null);
          if (data && Array.isArray(data.itemList) && data.itemList.length) return data.itemList;
        }
        return null;
      };

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: FEED_TIMEOUT }).catch(() => {});
      let items = await layItemDauTien();
      const han = Date.now() + 30000;
      let lanCuon = 0;
      while (!items && Date.now() < han) {
        await page.waitForTimeout(3000);
        items = await layItemDauTien();
        if (!items && Date.now() - lanCuon > 8000) {
          lanCuon = Date.now();
          await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
        }
      }
      if (!items) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: FEED_TIMEOUT }).catch(() => {});
        const han2 = Date.now() + 25000;
        while (!items && Date.now() < han2) {
          await page.waitForTimeout(3000);
          items = await layItemDauTien();
          if (!items) await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
        }
      }
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

      return { source: u ? `@${u}` : `#${h}`, count: videos.length, videos };
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

module.exports = { fetchFeed, streamHeaders, cleanUser, cleanTag, resolvePlayUrl };

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
