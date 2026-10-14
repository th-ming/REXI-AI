/**
 * TikTokFeedTab.jsx — Xem TikTok dạng khung dọc (feed) + LỌC CHỦ ĐỀ TỰ ĐỘNG.
 *
 * Đặt chủ đề muốn xem (vd: "váy", "mèo cute", "gym") → app tự xem từng video:
 *   - Lớp 1: lọc caption/hashtag theo chủ đề (khớp từ → giữ)
 *   - Lớp 2: AI nhìn khung hình (vision) — chụp frame giây ~0.6s gửi backend
 *     classify (Gemini/mistral/gemma vision) → không khớp → TỰ LƯỚT sang video kế.
 * Kết quả mỗi video hiện badge xanh (giữ) / đỏ (bỏ qua + lý do), log đầy đủ bên panel.
 *
 * Backend: GET /services/tiktok/feed (Playwright scrape) · GET /services/tiktok/stream
 * (proxy CDN kèm Referer/Range — same-origin nên canvas chụp frame không bị taint)
 * · POST /services/tiktok/classify (vision LLM).
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { apiFetchPublic } from '../config';
import { getLang } from '../i18n';
import {
  Music2, Search, Loader2, AlertTriangle, ChevronUp, ChevronDown,
  Filter, RotateCcw, CheckCircle2, XCircle, Sparkles, Settings2, X, Eye,
  Heart, MessageCircle, UserCheck,
} from 'lucide-react';

const MODES = [
  { id: 'off', label: 'Tắt lọc — xem hết' },
  { id: 'keyword', label: 'Lọc caption/hashtag' },
  { id: 'vision', label: 'AI nhìn hình (vision)' },
  { id: 'both', label: 'Caption + AI nhìn hình' },
];

// Normalize: bỏ dấu tiếng Việt + lowercase để khớp cả caption không dấu
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}
function captionMatches(caption, topics) {
  const c = norm(caption);
  return topics.some((tp) => { const k = norm(tp); return k && c.includes(k); });
}
function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function parseTopics(text) {
  return String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
}
// Đường phát chính: backend giải link qua tikwm rồi pipe (CDN TikTok chặn IP → 403).
// Có session nick + playAddr gốc thì backend thử tải trực tiếp bằng cookie trước.
// Cùng origin nên canvas chụp frame không bị chặn.
function mediaUrl(v, ses) {
  let s = `/api/services/tiktok/media?id=${encodeURIComponent(v.id)}&user=${encodeURIComponent(String(v.author || '').replace(/^@/, ''))}`;
  if (v.playAddr) s += `&u=${encodeURIComponent(v.playAddr)}`;
  if (ses) s += `&session=${encodeURIComponent(ses)}`;
  return s;
}
// Ảnh bìa: thử qua proxy stream cũ (ảnh thường không bị chặn gắt như video).
function coverUrl(u) {
  return `/api/services/tiktok/stream?u=${encodeURIComponent(u)}`;
}
function captureFrame(el) {
  try {
    if (!el || !el.videoWidth) return null;
    const w = 320;
    const h = Math.max(2, Math.round(w * (el.videoHeight / el.videoWidth)));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(el, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.65);
  } catch (e) { return null; }
}

// ─── 1 video trong feed ──────────────────────────────────────────────────────
function FeedVideo({ video, active, session, onRef, onTime, onError }) {
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    // Không pause/play trực tiếp ở đây — <video> chỉ mount khi gần đang xem
  }, [active]);
  return (
    <div className="relative w-full h-full flex items-center justify-center bg-black">
      {waiting && <Loader2 size={28} className="absolute text-white/50 animate-spin z-10" />}
      <video
        ref={(el) => { onRef(el); }}
        src={mediaUrl(video, session)}
        className="max-h-full max-w-full object-contain"
        loop muted playsInline preload={active ? 'auto' : 'metadata'}
        onCanPlay={() => setWaiting(false)}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onTimeUpdate={(e) => onTime && onTime(video, e.target)}
        onError={() => { setWaiting(false); onError && onError(video); }}
      />
    </div>
  );
}

export default function TikTokFeedTab({ showToast, active }) {
  const lang = getLang();
  const [panelOpen, setPanelOpen] = useState(true);
  const [src, setSrc] = useState('foryou');
  const [srcUser, setSrcUser] = useState('');
  const [srcTag, setSrcTag] = useState('');
  // Lướt vô hạn như TikTok thật: không hỏi số lượng, gần hết tự tải thêm
  const BATCH = 12;
  const [topicsText, setTopicsText] = useState('váy\nđầm xinh\nmèo cute');
  const [mode, setMode] = useState('both');

  const [videos, setVideos] = useState([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verdicts, setVerdicts] = useState({});   // id -> {match, reason, via, checking}
  const [skipLog, setSkipLog] = useState([]);     // {id, caption, match, reason, via, at}
  const [endReached, setEndReached] = useState(false);
  const [cdnErr, setCdnErr] = useState({});       // id -> true
  // Phiên nick thật (token từ POST /tiktok/session, giữ trong máy này)
  const [sessionToken, setSessionToken] = useState(() => {
    try { return localStorage.getItem('tt_session') || ''; } catch (e) { return ''; }
  });
  const [sessionInfo, setSessionInfo] = useState(null); // {logged, cookieCount}
  const [cookieText, setCookieText] = useState('');
  const [sessionMsg, setSessionMsg] = useState('');
  // Đăng nhập bằng QR (quét bằng app TikTok trên điện thoại)
  const [qrLogin, setQrLogin] = useState(null); // {loginId, qr, status}
  const qrTimer = useRef(null);

  const luuPhien = useCallback((data) => {
    setSessionToken(data.token);
    setSessionInfo({ logged: data.logged, cookieCount: data.cookieCount });
    setCookieText('');
    setQrLogin(null);
    clearInterval(qrTimer.current);
    try { localStorage.setItem('tt_session', data.token); } catch (e) {}
    setSessionMsg(data.logged ? 'Đã gắn nick TikTok ✓ — lướt Dành cho bạn như nick thật' : 'Đã lưu phiên (chưa rõ đăng nhập — thử tải feed)');
  }, []);

  const startQr = useCallback(async () => {
    setSessionMsg('Đang mở mã QR...');
    try {
      const data = await apiFetchPublic('/services/tiktok/qr/start', { method: 'POST', body: '{}' });
      if (!data.success) throw new Error(data.error || 'Không mở được QR');
      if (data.qr) {
        setQrLogin({ loginId: data.loginId, qr: data.qr, status: 'waiting' });
        setSessionMsg('');
      } else {
        // QR chưa chụp xong (browser đang mở) — poll chờ
        setQrLogin({ loginId: data.loginId, qr: null, status: 'starting' });
        setSessionMsg('');
      }
      clearInterval(qrTimer.current);
      qrTimer.current = setInterval(async () => {
        try {
          const st = await apiFetchPublic(`/services/tiktok/qr/status?loginId=${encodeURIComponent(data.loginId)}`);
          if (!st.success) return;
          if (st.status === 'done' && st.token) {
            luuPhien(st);
          } else if (st.status === 'expired') {
            clearInterval(qrTimer.current);
            setQrLogin(null);
            setSessionMsg('Mã hết hạn (150s) — bấm lại để lấy mã mới');
          } else if (st.status === 'error') {
            clearInterval(qrTimer.current);
            setQrLogin(null);
            setSessionMsg('Lỗi mở QR: ' + (st.error || 'thử lại'));
          } else {
            setQrLogin((q) => (q ? { ...q, qr: st.qr || q.qr, status: st.status, daQuet: st.daQuet } : q));
          }
        } catch (e) { /* poll lỗi thì thôi, lượt sau */ }
      }, 2000);
    } catch (e) {
      setSessionMsg('Lỗi: ' + (e.message || 'không mở được QR'));
    }
  }, [luuPhien]);

  useEffect(() => () => clearInterval(qrTimer.current), []);

  const videoEls = useRef({});                    // id -> <video> element (chụp frame)
  const classifiedRef = useRef(new Set());        // id đã classify vision
  const loadingMoreRef = useRef(false);           // đang tải thêm (chặn gọi chồng)
  const hasMoreRef = useRef(true);                // còn video mới để tải thêm
  const hetMoiRef = useRef(0);                    // đếm lượt tải thêm không ra video mới
  const videosRef = useRef([]);                   // mirror videos cho logic tải thêm
  const skipTimerRef = useRef(null);
  const navLock = useRef(0);
  const touchY = useRef(null);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const topics = useMemo(() => parseTopics(topicsText), [topicsText]);
  const topicsRef = useRef(topics);
  useEffect(() => { topicsRef.current = topics; }, [topics]);

  const current = videos[idx] || null;
  videosRef.current = videos;
  const kept = skipLog.filter((l) => l.match).length;
  const skipped = skipLog.filter((l) => !l.match).length;

  const pushLog = useCallback((video, entry) => {
    setSkipLog((s) => [{ id: video.id, caption: video.caption, author: video.author, ...entry, at: Date.now() }, ...s].slice(0, 60));
  }, []);

  const go = useCallback((dir) => {
    clearTimeout(skipTimerRef.current); // người dùng tự điều khiển → hủy auto-skip đang chờ
    setEndReached(false); // lướt tay khỏi màn hình cuối → mở lại feed
    setIdx((i) => {
      const next = Math.min(Math.max(i + dir, 0), Math.max((videos.length || 1) - 1, 0));
      return next;
    });
  }, [videos.length]);

  // Cầu trung gian: cho khối trên gọi loadFeed mà không dính thứ tự khai báo
  const loadFeedRef = useRef(null);

  // Auto-skip khi tới video cuối KHÔNG khớp (còn video mới thì tải thêm thay vì hết)
  const scheduleSkip = useCallback((fromId) => {
    clearTimeout(skipTimerRef.current);
    skipTimerRef.current = setTimeout(() => {
      setIdx((i) => {
        const v = videos[i];
        if (v && v.id === fromId) {
          if (i < videos.length - 1) return i + 1;
          if (!hasMoreRef.current) setEndReached(true);
          else if (loadFeedRef.current) loadFeedRef.current(true);
        }
        return i;
      });
    }, 750);
  }, [videos]);

  // ── Lớp 1: lọc caption/hashtag (chạy ngay khi vào video) ──
  useEffect(() => {
    const v = videos[idx];
    if (!v) return undefined;
    if (mode !== 'keyword' && mode !== 'both') return undefined;
    if (!topics.length) return undefined;
    if (!captionMatches(v.caption, topics)) {
      const entry = { match: false, reason: 'caption/hashtag không khớp', via: 'caption' };
      setVerdicts((s) => ({ ...s, [v.id]: entry }));
      pushLog(v, entry);
      const timer = setTimeout(() => scheduleSkip(v.id), 850);
      return () => clearTimeout(timer);
    }
    setVerdicts((s) => ({ ...s, [v.id]: s[v.id] || { match: true, reason: 'caption khớp chủ đề', via: 'caption' } }));
    return undefined;
  }, [idx, videos, mode, topics, pushLog, scheduleSkip]);

  // ── Lớp 2: AI nhìn hình — chụp frame khi video phát được ~0.6s ──
  const handleTime = useCallback(async (video, el) => {
    if (el.currentTime < 0.6) return;
    const m = modeRef.current;
    if (m !== 'vision' && m !== 'both') return;
    if (classifiedRef.current.has(video.id)) return;
    classifiedRef.current.add(video.id);
    const frame = captureFrame(el);
    if (!frame) return;
    setVerdicts((s) => ({ ...s, [video.id]: s[video.id] && !s[video.id].checking ? s[video.id] : { checking: true, via: 'ai' } }));
    try {
      const data = await apiFetchPublic('/services/tiktok/classify', {
        method: 'POST',
        body: JSON.stringify({ image: frame, topics: topicsRef.current, caption: video.caption }),
      });
      if (!data.success) throw new Error(data.error || 'classify lỗi');
      const entry = { match: data.match !== false, reason: data.reason || '', via: 'ai' };
      setVerdicts((s) => ({ ...s, [video.id]: entry }));
      pushLog(video, entry);
      if (!entry.match) scheduleSkip(video.id);
    } catch (e) {
      // AI lỗi → fail-open: giữ video, ghi lý do
      const entry = { match: true, reason: 'AI lỗi: ' + String(e.message || '').slice(0, 40), via: 'ai' };
      setVerdicts((s) => ({ ...s, [video.id]: entry }));
      pushLog(video, entry);
    }
  }, [pushLog, scheduleSkip]);

  // Video lỗi mạng (không tải được) → ghi log + tự lướt, không kẹt spinner
  const handleVideoError = useCallback((video) => {
    setCdnErr((s) => ({ ...s, [video.id]: true }));
    const entry = { match: false, reason: 'không tải được video', via: 'net' };
    setVerdicts((s) => ({ ...s, [video.id]: entry }));
    pushLog(video, entry);
    scheduleSkip(video.id);
  }, [pushLog, scheduleSkip]);

  // ── Tải feed (append=false: tải mới; append=true: tải thêm nối đuôi, lọc trùng) ──
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadFeed = useCallback(async (append = false) => {
    if (src === 'user' && !srcUser.trim()) { setError('Nhập @username'); return; }
    if (src === 'tag' && !srcTag.trim()) { setError('Nhập #hashtag'); return; }
    if (append) {
      if (loadingMoreRef.current || !hasMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true); setError(''); setEndReached(false);
      setVideos([]); setIdx(0); setVerdicts({}); setSkipLog([]); setCdnErr({});
      classifiedRef.current = new Set();
      clearTimeout(skipTimerRef.current);
    }
    try {
      const q = new URLSearchParams({ limit: String(BATCH) });
      if (src === 'user') q.set('user', srcUser.trim());
      else if (src === 'tag') q.set('tag', srcTag.trim().replace(/^#/, ''));
      else q.set('foryou', '1');
      if (sessionToken) q.set('session', sessionToken);
      const data = await apiFetchPublic(`/services/tiktok/feed?${q.toString()}`);
      if (!data.success) throw new Error(data.error || 'Lỗi feed');
      const moi = data.videos || [];
      if (append) {
        const co = new Set(videosRef.current.map((v) => v.id));
        const loc = moi.filter((v) => v.id && !co.has(v.id));
        if (loc.length) setVideos((cu) => [...cu, ...loc]);
        // Hết video mới 2 lượt liền thì thôi (tránh tải vòng tròn)
        hetMoiRef.current = loc.length === 0 ? hetMoiRef.current + 1 : 0;
        if (hetMoiRef.current >= 2) setHasMore(false);
      } else {
        setVideos(moi);
        setHasMore(true);
        hetMoiRef.current = 0;
        if (!moi.length) setError('Feed rỗng — thử nguồn khác hoặc gắn nick rồi tải lại');
        setPanelOpen(false);
      }
    } catch (e) {
      if (!append) setError(e.message || 'Không tải được feed');
    } finally {
      if (append) { loadingMoreRef.current = false; setLoadingMore(false); }
      else setLoading(false);
    }
  }, [src, srcUser, srcTag, sessionToken]);

  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  loadFeedRef.current = loadFeed;

  // Mở tab là tự chạy (không bấm gì), đổi nguồn/nick thì tải mới
  const daTuChay = useRef(false);
  useEffect(() => {
    if (active && !daTuChay.current) {
      daTuChay.current = true;
      loadFeed(false);
    }
  }, [active, loadFeed]);
  const nguonTruoc = useRef(src + '|' + sessionToken);
  useEffect(() => {
    const hien = src + '|' + sessionToken;
    if (daTuChay.current && hien !== nguonTruoc.current) {
      nguonTruoc.current = hien;
      loadFeed(false);
    }
  }, [src, sessionToken, loadFeed]);

  // Lướt gần hết → tự tải thêm (vô hạn như TikTok)
  useEffect(() => {
    if (videos.length > 0 && idx >= videos.length - 3) loadFeed(true);
  }, [idx, videos.length, loadFeed]);

  // ── Gắn nick TikTok thật (cách thủ công: copy document.cookie) ──
  const connectNick = useCallback(async () => {
    if (!cookieText.trim()) { setSessionMsg('Dán chuỗi cookie trước đã'); return; }
    setSessionMsg('Đang kết nối...');
    try {
      const data = await apiFetchPublic('/services/tiktok/session', {
        method: 'POST',
        body: JSON.stringify({ cookies: cookieText.trim() }),
      });
      if (!data.success) throw new Error(data.error || 'Kết nối lỗi');
      luuPhien(data);
    } catch (e) {
      setSessionMsg('Lỗi: ' + (e.message || 'không kết nối được'));
    }
  }, [cookieText, luuPhien]);

  const disconnectNick = useCallback(() => {
    setSessionToken('');
    setSessionInfo(null);
    setSessionMsg('');
    try { localStorage.removeItem('tt_session'); } catch (e) {}
  }, []);

  // autoplay video đang xem
  useEffect(() => {
    Object.entries(videoEls.current).forEach(([id, el]) => {
      if (!el) return;
      if (current && id === current.id) {
        el.muted = true;
        el.play().catch(() => {});
      } else {
        el.pause();
      }
    });
  }, [idx, videos, current]);

  useEffect(() => () => clearTimeout(skipTimerRef.current), []);

  // bàn phím: ↑↓ lướt
  useEffect(() => {
    const h = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [go]);

  const onWheel = (e) => {
    const now = Date.now();
    if (now - navLock.current < 650 || Math.abs(e.deltaY) < 24) return;
    navLock.current = now;
    go(e.deltaY > 0 ? 1 : -1);
  };
  const onTouchStart = (e) => { touchY.current = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (touchY.current == null) return;
    const dy = touchY.current - e.changedTouches[0].clientY;
    touchY.current = null;
    if (Math.abs(dy) > 45) go(dy > 0 ? 1 : -1);
  };

  const verdict = current ? verdicts[current.id] : null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-main)]">
      {/* ─── PANEL CÀI ĐẶT / LỌC ─── */}
      {panelOpen && (
        <div className="w-80 shrink-0 border-r border-white/5 bg-[var(--bg-sidebar)] p-4 overflow-y-auto space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Music2 size={16} className="text-pink-400" /> TikTok Feed — Lọc chủ đề
            </h3>
            <button onClick={() => setPanelOpen(false)} className="text-slate-400 hover:text-white"><X size={16} /></button>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-slate-400">Nguồn lướt (y như TikTok thật)</label>
            <div className="flex gap-1.5">
              {[
                { id: 'foryou', label: 'Dành cho bạn' },
                { id: 'user', label: '@user' },
                { id: 'tag', label: '#tag' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSrc(t.id)}
                  className={`flex-1 px-2 py-1.5 rounded-xl text-[11px] font-medium border ${src === t.id ? 'bg-pink-500/20 border-pink-500/40 text-pink-200' : 'bg-[#131417] border-white/5 text-slate-400 hover:text-white'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {src === 'user' && (
              <input
                value={srcUser} onChange={(e) => setSrcUser(e.target.value)}
                placeholder="@username" className="w-full px-3 py-2 rounded-xl bg-[#131417] border border-white/5 text-xs text-white focus:outline-none focus:border-pink-500/40"
              />
            )}
            {src === 'tag' && (
              <input
                value={srcTag} onChange={(e) => setSrcTag(e.target.value)}
                placeholder="#hashtag" className="w-full px-3 py-2 rounded-xl bg-[#131417] border border-white/5 text-xs text-white focus:outline-none focus:border-pink-500/40"
              />
            )}
            {src === 'foryou' && (
              <p className="text-[10px] text-slate-500 leading-relaxed">
                {sessionToken
                  ? 'Lướt Dành cho bạn bằng nick đã gắn — đúng video của mày.'
                  : 'Chưa gắn nick → Dành cho bạn chung. Gắn nick bên dưới để lướt đúng gu của mày.'}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => loadFeed(false)} disabled={loading}
                className="ml-auto px-3 py-1.5 rounded-xl bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 text-white text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} Tải lại
              </button>
            </div>
          </div>

          <div className="space-y-2 border-t border-white/5 pt-3">
            <label className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
              <UserCheck size={12} className="text-pink-400" /> Nick TikTok của mày
            </label>
            {sessionToken ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-emerald-400 flex-1">
                  ✓ Đã gắn nick{sessionInfo && sessionInfo.cookieCount ? ` (${sessionInfo.cookieCount} cookie)` : ''} — lướt đúng gu của mày
                </span>
                <button onClick={disconnectNick} className="text-[11px] text-slate-500 hover:text-rose-400 underline">Gỡ</button>
              </div>
            ) : qrLogin ? (
              <div className="space-y-2 text-center">
                {qrLogin.qr ? (
                  <>
                    <img src={qrLogin.qr} alt="Mã QR đăng nhập TikTok" className="mx-auto rounded-xl border border-white/10 max-w-[220px]" />
                    <p className="text-[11px] text-slate-300">Mở app TikTok trên điện thoại → quét mã này → bấm <b>Xác nhận đăng nhập</b> trên điện thoại là tự vào</p>
                    {qrLogin.daQuet && (
                      <p className="text-[11px] font-semibold text-emerald-400">✓ Đã quét mã rồi! Bấm Xác nhận trên điện thoại đi là vào</p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-slate-400 flex items-center justify-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Đang mở mã QR...
                  </p>
                )}
                <button
                  onClick={() => { clearInterval(qrTimer.current); setQrLogin(null); setSessionMsg(''); }}
                  className="text-[11px] text-slate-500 hover:text-white underline"
                >
                  Hủy
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={startQr}
                  className="w-full px-3 py-2 rounded-xl bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 text-white text-xs font-medium"
                >
                  Đăng nhập bằng QR
                </button>
                <details className="text-[10px] text-slate-500">
                  <summary className="cursor-pointer hover:text-slate-300">Cách khác: dán cookie thủ công</summary>
                  <textarea
                    value={cookieText} onChange={(e) => setCookieText(e.target.value)} rows={2}
                    placeholder="Dán chuỗi document.cookie ở đây..."
                    className="mt-1.5 w-full px-3 py-2 rounded-xl bg-[#131417] border border-white/5 text-xs text-white focus:outline-none focus:border-pink-500/40 resize-y"
                  />
                  <button
                    onClick={connectNick}
                    className="mt-1 w-full px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-slate-200 text-xs font-medium hover:bg-white/10"
                  >
                    Kết nối
                  </button>
                  <p className="mt-1 leading-relaxed">Mở tiktok.com (đã đăng nhập) → F12 → Console → gõ document.cookie → copy dán vào đây.</p>
                </details>
              </>
            )}
            {sessionMsg && <p className="text-[10px] text-amber-400">{sessionMsg}</p>}
          </div>

          <div className="space-y-2 border-t border-white/5 pt-3">
            <label className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
              <Filter size={12} className="text-cyan-400" /> Kiểu lọc
            </label>
            <select value={mode} onChange={(e) => { clearTimeout(skipTimerRef.current); setMode(e.target.value); }} className="w-full px-3 py-2 rounded-xl bg-[#131417] border border-white/5 text-xs text-white focus:outline-none focus:border-cyan-500/40">
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <label className="text-[11px] font-semibold text-slate-400 block pt-1">Chủ đề muốn xem (mỗi dòng/comma 1 chủ đề)</label>
            <textarea
              value={topicsText} onChange={(e) => setTopicsText(e.target.value)} rows={5}
              placeholder={'váy\nđầm\nmèo cute'}
              className="w-full px-3 py-2 rounded-xl bg-[#131417] border border-white/5 text-xs text-white focus:outline-none focus:border-cyan-500/40 resize-y"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              <Sparkles size={10} className="inline text-cyan-400 mr-1" />
              Không khớp → app <b className="text-slate-300">tự lướt</b> sang video kế. "AI nhìn hình" chụp frame giây 0.6s gửi vision model nhận diện (mặc váy/quần, bối cảnh...).
            </p>
          </div>

          <div className="border-t border-white/5 pt-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 size={12} /> Giữ: {kept}</span>
              <span className="text-rose-400 flex items-center gap-1"><XCircle size={12} /> Bỏ qua: {skipped}</span>
            </div>
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {skipLog.length === 0 && <p className="text-[10px] text-slate-500">Chưa có log — tải feed và xem đi.</p>}
              {skipLog.map((l, i) => (
                <div key={`${l.id}-${i}`} className={`p-2 rounded-lg border text-[10px] leading-snug ${l.match ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-300' : 'bg-rose-500/5 border-rose-500/20 text-slate-300'}`}>
                  <span className={`inline-flex items-center gap-1 font-semibold ${l.match ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {l.match ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                    {l.match ? 'GIỮ' : 'BỎ'} ({l.via === 'ai' ? 'AI' : 'caption'})
                  </span>
                  <span className="text-slate-500"> {l.reason}</span>
                  <p className="text-slate-500 truncate mt-0.5">{l.author} · {l.caption.slice(0, 60) || '(không caption)'}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── SÂN KHẤU FEED ─── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          {!panelOpen && (
            <button onClick={() => setPanelOpen(true)} className="px-2.5 py-1.5 rounded-xl bg-white/5 border border-white/5 text-slate-300 text-xs flex items-center gap-1.5 hover:text-white">
              <Settings2 size={13} /> Lọc chủ đề
            </button>
          )}
          {current && (
            <span className="text-[11px] text-slate-400 ml-auto flex items-center gap-2">
              {loadingMore && <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Đang tải thêm...</span>}
              <span>{idx + 1}/{videos.length} · <Eye size={11} className="inline" /> {fmtCount(current.views)} · {current.author}</span>
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 px-3 pb-3">
          <div
            className="relative h-full w-full overflow-hidden rounded-2xl bg-black border border-white/5 select-none"
            onWheel={onWheel} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          >
            {!current && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
                <Music2 size={44} className="text-pink-400/60" />
                <p className="text-sm font-semibold text-white">Xem TikTok + lọc theo chủ đề của bạn</p>
                <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
                  Chọn <b className="text-slate-300">Dành cho bạn</b> (gắn nick để đúng gu), @user hoặc #tag → chọn kiểu lọc → nhập chủ đề muốn xem.
                  Video không đúng chủ đề sẽ <b className="text-slate-300">tự lướt đi</b>. Lăn chuột / phím ↑↓ để tự lướt.
                </p>
                {loading && <Loader2 size={22} className="text-pink-400 animate-spin" />}
                {error && (
                  <p className="text-xs text-rose-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {error}</p>
                )}
              </div>
            )}

            {current && (
              <>
                <div
                  className="h-full transition-transform duration-500 ease-out"
                  style={{ transform: `translateY(-${idx * 100}%)` }}
                >
                  {videos.map((v, i) => (
                    <div key={v.id} className="h-full w-full">
                      {Math.abs(i - idx) <= 1 && !cdnErr[v.id] ? (
                        <FeedVideo
                          video={v} active={i === idx} session={sessionToken}
                          onRef={(el) => { videoEls.current[v.id] = el; }}
                          onTime={handleTime}
                          onError={handleVideoError}
                        />
                      ) : (                        <div className="w-full h-full flex items-center justify-center bg-black">
                          {v.cover && !cdnErr[v.id] ? (
                            <img src={coverUrl(v.cover)} alt="" className="max-h-full max-w-full object-contain opacity-60" loading="lazy" onError={(e) => { e.target.style.display = 'none'; }} />
                          ) : (
                            <Music2 size={30} className="text-white/20" />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* badge kết quả lọc */}
                {mode !== 'off' && verdict && (
                  <div className={`absolute top-3 left-3 px-2.5 py-1.5 rounded-xl text-[11px] font-medium flex items-center gap-1.5 backdrop-blur-md border ${
                    verdict.checking ? 'bg-white/10 border-white/20 text-white/80'
                      : verdict.match ? 'bg-emerald-500/25 border-emerald-400/40 text-emerald-200'
                        : 'bg-rose-500/25 border-rose-400/40 text-rose-200'}`}>
                    {verdict.checking ? <Loader2 size={12} className="animate-spin" />
                      : verdict.match ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    {verdict.checking ? 'AI đang xem...'
                      : `${verdict.match ? 'GIỮ' : 'TỰ LƯỚT'}${verdict.reason ? ` — ${verdict.reason}` : ''}`}
                  </div>
                )}

                {/* caption overlay */}
                <div className="absolute bottom-0 inset-x-0 p-4 pb-6 bg-gradient-to-t from-black/80 via-black/30 to-transparent pointer-events-none">
                  <p className="text-xs font-bold text-white">{current.author}{current.nickname ? ` · ${current.nickname}` : ''}</p>
                  <p className="text-[11px] text-slate-200 line-clamp-2 mt-0.5">{current.caption || '(không có caption)'}</p>
                  <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-3">
                    <span className="flex items-center gap-1"><Heart size={11} className="text-rose-400" /> {fmtCount(current.likes) || '–'}</span>
                    <span className="flex items-center gap-1"><MessageCircle size={11} className="text-cyan-300" /> {fmtCount(current.comments) || '–'}</span>
                  </p>
                </div>

                {/* nút lướt */}
                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col gap-2">
                  <button onClick={() => go(-1)} disabled={idx === 0} className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center disabled:opacity-30"><ChevronUp size={18} /></button>
                  <button onClick={() => go(1)} disabled={idx >= videos.length - 1} className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center disabled:opacity-30"><ChevronDown size={18} /></button>
                </div>

                {endReached && (
                  <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                    <p className="text-sm font-semibold text-white">Hết feed 🎉</p>
                    <p className="text-xs text-slate-300">Giữ {kept} · Tự lướt {skipped} video không đúng chủ đề</p>
                    <button onClick={() => loadFeed(false)} className="px-4 py-2 rounded-xl bg-pink-500/80 hover:bg-pink-500 text-white text-xs font-medium flex items-center gap-1.5">
                      <RotateCcw size={13} /> Tải lại feed
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
