import React, { useState, useRef, useEffect } from 'react';
import { t, getLang } from '../i18n';
import { Search, Play, Loader2, ArrowLeft, MonitorPlay, Clock, Eye, Sparkles, FileText, ChevronDown, ChevronUp , Subtitles, Download, AlertTriangle, ThumbsUp, ThumbsDown, Share2, MessageSquare, History, PictureInPicture2, Gauge, Check } from 'lucide-react';
import Hls from 'hls.js';
import { API_BASE } from '../config';

// Danh mục trending (tự động tải khi mở tab — không cần gõ từ khóa)
const CATEGORIES = ['nhạc trẻ 2026', 'viral', 'phim chiếu rạp', 'bóng đá highlight', 'công nghệ mới', 'kiến thức hữu ích', 'âm nhạc', 'trò chơi', 'tin tức', 'trực tiếp', 'podcast', 'học tập'];

function fmtDuration(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtViews(n) {
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}${t(getLang(), 'tr lượt xem')}`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}${t(getLang(), 'k lượt xem')}`;
  return `${n} ${t(getLang(), 'lượt xem')}`;
}

// Render markdown tóm tắt (đơn giản: header, bullet, in đậm) thành JSX
function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  const elements = [];
  let list = [];
  const flushList = (key) => {
    if (list.length) {
      elements.push(
        <ul key={key} className="space-y-1.5 my-2">
          {list.map((li, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-slate-300 leading-relaxed">
              <span className="text-red-400 mt-1 shrink-0">▸</span>
              <span>{li}</span>
            </li>
          ))}
        </ul>
      );
      list = [];
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) { flushList('ul' + idx); return; }
    if (line.startsWith('### ')) {
      flushList('ul' + idx);
      elements.push(<h4 key={idx} className="text-[12px] font-bold text-white mt-3 mb-1">{line.slice(4)}</h4>);
    } else if (line.startsWith('## ')) {
      flushList('ul' + idx);
      elements.push(<h3 key={idx} className="text-[13px] font-extrabold text-red-300 mt-4 mb-1">{line.slice(3)}</h3>);
    } else if (line.startsWith('# ')) {
      flushList('ul' + idx);
      elements.push(<h2 key={idx} className="text-[15px] font-extrabold text-white mt-1 mb-2">{line.slice(2)}</h2>);
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      list.push(line.replace(/^[-•]\s*/, ''));
    } else if (/^\d+\.\s/.test(line)) {
      flushList('ul' + idx);
      elements.push(<p key={idx} className="text-[12px] text-slate-300 leading-relaxed my-1">{line}</p>);
    } else {
      flushList('ul' + idx);
      elements.push(<p key={idx} className="text-[12px] text-slate-300 leading-relaxed my-1">{line}</p>);
    }
  });
  flushList('ul-final');
  return elements;
}

// Avatar kênh YouTube thật — hiển thị chữ cái trước, fetch ảnh thật rồi swap
// (progressive enhancement như YouTube). Cache 7 ngày phía BE nên lần sau ăn ngay.
// VẤN ĐỀ THẬT: worker yt-dlp (tunnel IP nhà) xử lý TUẦN TỰ. Grid 16 video bắn
// 16 request cùng lúc → nghẽn worker → avatar mãi không về (user thấy chữ cái).
// Fix: hàng đợi giới hạn concurrency (3) + retry + dedupe request trùng.
const avatarMemCache = new Map();   // channelId -> avatar_url
// Nạp cache từ localStorage (avatar hiếm đổi) — reload không phải fetch lại từ đầu.
try {
  const raw = localStorage.getItem('rexi_yt_avatars');
  if (raw) { const obj = JSON.parse(raw); Object.keys(obj).forEach((k) => avatarMemCache.set(k, obj[k])); }
} catch { /* ignore */ }
let avatarSaveTimer = null;
function persistAvatarCache() {
  if (avatarSaveTimer) return;
  avatarSaveTimer = setTimeout(() => {
    avatarSaveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of avatarMemCache) obj[k] = v;
      localStorage.setItem('rexi_yt_avatars', JSON.stringify(obj));
    } catch { /* ignore */ }
  }, 800);
}
const avatarPending = new Map();    // queryKey -> Promise (dedupe request đang bay)
const avatarQueue = { active: 0, max: 3, q: [] };
function pumpAvatarQueue() {
  while (avatarQueue.active < avatarQueue.max && avatarQueue.q.length) {
    const job = avatarQueue.q.shift();
    avatarQueue.active++;
    job.task().then(job.resolve, job.reject).finally(() => { avatarQueue.active--; pumpAvatarQueue(); });
  }
}
function enqueueAvatar(task) {
  return new Promise((resolve, reject) => { avatarQueue.q.push({ task, resolve, reject }); pumpAvatarQueue(); });
}
async function fetchAvatarAttempt(query) {
  const ctl = new AbortController();
  // Lần đầu resolve kênh qua worker (IP nhà) có thể tới ~22s → 20s cũ quá ngắn.
  const to = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(`${API_BASE}/services/youtube/channel-avatar?${query}`, { signal: ctl.signal });
    const data = await res.json().catch(() => null);
    if (data && data.success && data.avatar_url) return data;
    throw new Error((data && data.error) || 'no avatar');
  } finally { clearTimeout(to); }
}
async function fetchAvatarQueued(query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1200 * attempt));
    try { return await enqueueAvatar(() => fetchAvatarAttempt(query)); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
function loadAvatar(query) {
  if (avatarPending.has(query)) return avatarPending.get(query);
  const p = fetchAvatarQueued(query).finally(() => avatarPending.delete(query));
  avatarPending.set(query, p);
  return p;
}
function ChannelAvatar({ channelId, videoId, author, size = 36, ring = true }) {
  const [src, setSrc] = useState(() => (channelId && avatarMemCache.get(channelId)) || null);
  useEffect(() => {
    if (!channelId && !videoId) return;
    if (channelId && avatarMemCache.get(channelId)) { setSrc(avatarMemCache.get(channelId)); return; }
    let cancelled = false;
    const q = channelId
      ? `channel_id=${encodeURIComponent(channelId)}`
      : `video_id=${encodeURIComponent(videoId)}`;
    loadAvatar(q)
      .then((data) => {
        if (cancelled || !data || !data.avatar_url) return;
        if (data.channel_id) { avatarMemCache.set(data.channel_id, data.avatar_url); persistAvatarCache(); }
        setSrc(data.avatar_url);
      })
      .catch(() => { /* giữ chữ cái fallback */ });
    return () => { cancelled = true; };
  }, [channelId, videoId]);
  const letter = String(author || 'Y').trim().charAt(0).toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt={author || t(getLang(), 'kênh')}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => { avatarMemCache.delete(channelId); setSrc(null); }}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`${ring ? 'bg-slate-600' : 'bg-slate-700'} rounded-full flex items-center justify-center font-semibold text-white shrink-0`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {letter}
    </span>
  );
}

export default function YouTubeTab({ API_BASE: _api, authToken,
showToast, active }) {
  const lang = getLang();
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // video đang xem
  const [streamLoading, setStreamLoading] = useState(false);
  // Autoplay bị chặn khi src về sau fetch async (gesture click hết hạn) → video
  // đứng im ở t=0 dù đã có buffer. Hiện overlay "Bấm để phát" thay vì để kẹt.
  // Fix bổ sung (verify thực tế): autoplay programmatic luôn mute trước rồi mới
  // play — bypass cả autoplay policy lẫn pipeline audio kẹt local (muted video
  // vẫn tăng currentTime; khi muted vẫn kẹt thì mới hiện overlay). Khi user bấm
  // thủ công (gesture thật) thì unmute để có tiếng.
  const [playBlocked, setPlayBlocked] = useState(false);
  const [pipActive, setPipActive] = useState(false); // PiP: phát nền kiểu YouTube
  // Tốc độ phát kiểu YouTube (0.25x–2x) — playbackRate trực tiếp, giữ vị trí phát
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const setRate = (r) => {
    setPlaybackRate(r);
    try { if (videoRef.current) videoRef.current.playbackRate = r; } catch (e) { /* ignore */ }
  };
  const pipCleanupRef = useRef(null);
  const tryPlay = (fromUser) => {
    const v = videoRef.current;
    if (!v) return;
    if (!fromUser && !v.muted) { try { v.muted = true; } catch (e) { /* ignore */ } }
    if (fromUser && v.muted) { try { v.muted = false; } catch (e) { /* ignore */ } }
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true));
    }
  };

  // Phát nền kiểu YouTube: mở Picture-in-Picture → video chạy nổi khi chuyển tab
  // (trình duyệt suspend decode video ở tab background dù đã giữ mount — keep-mount
  // một mình KHÔNG đủ). PiP có gesture thật từ click nên có tiếng.
  // Thêm: khi vào/tắt PiP, dọn listener đúng cách; khi PiP tắt thì đồng bộ state.
  const enterPip = async () => {
    const v = videoRef.current;
    if (!v || !document.pictureInPictureEnabled) {
      showToast?.(t(getLang(), 'Trình duyệt không hỗ trợ Picture-in-Picture.'), 'error');
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      try { v.muted = false; } catch (e) { /* ignore */ }
      await v.play().catch(() => {});
      await v.requestPictureInPicture();
    } catch (e) {
      showToast?.(t(getLang(), 'Không mở được PiP: ') + e.message, 'error');
    }
  };
  useEffect(() => {
    const onChange = () => setPipActive(!!document.pictureInPictureElement);
    document.addEventListener('enterpictureinpicture', onChange);
    document.addEventListener('leavepictureinpicture', onChange);
    return () => {
      document.removeEventListener('enterpictureinpicture', onChange);
      document.removeEventListener('leavepictureinpicture', onChange);
    };
  }, []);
  const [isHlsStream, setIsHlsStream] = useState(false); // stream_url là m3u (Chromium cần hls.js)
  const [comments, setComments] = useState(null); // {comments, count} — bấm mới load (chậm 10-30s)
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsSlow, setCommentsSlow] = useState(false); // quá 12s → báo user kiên nhẫn
  const [commentText, setCommentText] = useState(''); // ô gửi bình luận local
  const [sendingComment, setSendingComment] = useState(false);
  const [history, setHistory] = useState([]); // Video đã xem — localStorage persist
  const [activeCat, setActiveCat] = useState(null);
  // Tóm tắt AI
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState(null); // { title, transcript, summary }
  const [summaryStep, setSummaryStep] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [showSrt, setShowSrt] = useState(false);
  const [liked, setLiked] = useState(false); // nút Thích cục bộ (không cần server)
  const [descOpen, setDescOpen] = useState(false); // mở rộng mô tả
  const videoRef = useRef(null);
  // Số thứ tự lần bấm play: probe/stream nào về chậm hơn lần bấm mới nhất thì
  // bị bỏ qua (tránh race: probe cũ về sau ghi đè isHlsStream của video mới).
  const playSeqRef = useRef(0);
  const [engineReady, setEngineReady] = useState(null);
  const [engineNote, setEngineNote] = useState('');

  const headers = () => {
    const h = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('rexi_token');
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  };

  const handleSearch = async (e, preset) => {
    e?.preventDefault?.();
    const q = (preset !== undefined ? preset : query).trim();
    if (!q) return;
    if (preset !== undefined) setQuery(preset);
    setLoading(true);
    setError(null);
    setSelected(null);
    setSummary(null);
    try {
      const res = await fetch(`${API_BASE}/services/youtube/search?q=${encodeURIComponent(q)}&limit=16`, { headers: headers() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t(getLang(), 'Lỗi tìm kiếm'));
      setVideos(data.videos || []);
      if ((data.videos || []).length === 0) setError(t(getLang(), 'Không tìm thấy video nào.'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCategory = (cat) => {
    setActiveCat(cat);
    handleSearch(null, cat);
  };

  // Tự động tải danh mục đầu tiên khi mở tab (thay cho màn hình trống).
  // Tab giữ mount để phát nền → check khi tab được mở lại (active), không chỉ lúc mount.
  const [checkNonce, setCheckNonce] = useState(0);
  useEffect(() => {
    if (active === false) return;
    if (!activeCat && videos.length === 0) handleSearch(null, CATEGORIES[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (active === false) return; // tab ẩn (phát nền) → không check
    if (engineReady === true) return; // đã sẵn sàng → thôi
    let cancelled = false;
    let retries = 0;
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/services/youtube/status?_=${Date.now()}`, { headers: headers(), cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        if (data.success && !data.ready) {
          // Render free cold-start: instance vừa thức dậy báo chưa ready (binary/pot
          // chưa warm). Tự thử lại thay vì khóa tab bằng banner — thường sẵn sàng sau vài giây.
          if (retries < 4) {
            retries += 1;
            setEngineNote(`${t(getLang(), 'Engine YouTube đang khởi động — tự kiểm tra lại (')}${retries}/4)...`);
            setTimeout(() => { if (!cancelled) check(); }, 5000);
            return;
          }
        }
        setEngineReady(!!(data.success && data.ready));
        setEngineNote(data.note || (data.success && !data.ready ? t(getLang(), 'Engine yt-dlp chưa tải xong. Thử tải lại trang sau ít phút.') : ''));
      } catch {
        if (!cancelled) {
          // Lỗi thoáng chốc (Render restart / mạng) — tự thử lại thay vì khóa banner vĩnh viễn
          if (retries < 4) {
            retries += 1;
            setEngineNote(`${t(getLang(), 'Không kiểm tra được engine YouTube — tự thử lại (')}${retries}/4)...`);
            setTimeout(() => { if (!cancelled) check(); }, 4000);
            return;
          }
          setEngineReady(false);
          setEngineNote(t(getLang(), 'Không kiểm tra được engine YouTube. Có thể cần đăng nhập.'));
        }
      }
    };
    check();
    return () => { cancelled = true; };
  }, [active, checkNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lịch sử xem (Video đã xem) — localStorage persist, tối đa 24 video
  useEffect(() => {
    try {
      const raw = localStorage.getItem('rexi_watch_history');
      if (raw) setHistory(JSON.parse(raw).slice(0, 24));
    } catch (e) { console.warn('[rexi] watch history load failed', e); }
  }, []);

  const clearHistory = () => {
    try { localStorage.removeItem('rexi_watch_history'); } catch (e) { console.warn('[rexi] clear failed', e); }
    setHistory([]);
  };

  // Bình luận — bấm mới load (yt-dlp --write-comments chậm 10-30s, cache 24h server)
  const loadComments = async () => {
    if (!selected || commentsLoading) return;
    if (comments) { setComments(null); return; } // toggle đóng
    setCommentsLoading(true);
    setCommentsSlow(false);
    // yt-dlp --write-comments chậm 10-30s; đôi khi worker nghẽn >60s → phải có
    // timeout client để nút KHÔNG treo vĩnh viễn (finally luôn reset loading).
    const ctl = new AbortController();
    const hardTo = setTimeout(() => ctl.abort(), 90000);
    const slowTo = setTimeout(() => setCommentsSlow(true), 12000);
    try {
      const res = await fetch(`${API_BASE}/services/youtube/comments?url=${encodeURIComponent(selected.id)}`, { headers: headers(), signal: ctl.signal });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error(`${t(getLang(), 'Server phản hồi không hợp lệ (HTTP ')}${res.status}${t(getLang(), '). Thử lại sau ít giây.')}`); }
      if (!data.success) throw new Error(data.error || t(getLang(), 'Lấy bình luận thất bại.'));
      setComments(data);
    } catch (e) {
      if (e.name === 'AbortError') showToast?.(t(getLang(), 'Tải bình luận quá lâu (worker đang bận). Thử lại sau.'), 'error');
      else showToast?.(t(getLang(), 'Lỗi bình luận: ') + e.message, 'error');
    } finally {
      clearTimeout(hardTo);
      clearTimeout(slowTo);
      setCommentsSlow(false);
      setCommentsLoading(false);
    }
  };

  // Dò stream có phải HLS m3u không — worker có thể trả manifest khi video không có mp4 progressive.  // Dùng HEAD (nhẹ, ~1s) thay vì Range GET: Range phải đi qua chuỗi Render→tunnel→
  // googlevideo (~4-20s) rồi mới gán src cho video → video kẹt t=0 rất lâu.
  // Sniff Content-Type; chỉ sniff body khi CT lạ (m3u không Range có thể trả 200 full).
  const probeHls = async (url) => {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 12000);
      const head = await fetch(url, { method: 'HEAD', signal: ctl.signal });
      clearTimeout(to);
      const ct = (head.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return true;
      if (ct.includes('video/') || ct.includes('audio/')) return false;
      // CT lạ hoặc không có → sniff 64 bytes đầu (fallback, có timeout riêng)
      try {
        const ctl2 = new AbortController();
        const to2 = setTimeout(() => ctl2.abort(), 12000);
        const res = await fetch(url, { headers: { Range: 'bytes=0-63' }, signal: ctl2.signal });
        clearTimeout(to2);
        const ct2 = (res.headers.get('content-type') || '').toLowerCase();
        if (ct2.includes('mpegurl') || ct2.includes('x-mpegurl')) return true;
        if (ct2.includes('video/') || ct2.includes('audio/')) return false;
        const txt = await res.text();
        return txt.trimStart().startsWith('#EXTM3U');
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  };

  // Textarea bình luận tự giãn theo nội dung (mặc định 1 dòng cho gọn)
  const commentRows = commentText.trim() ? Math.min(6, Math.max(2, commentText.split('\n').length + Math.floor(commentText.length / 60))) : 1;

  // Gửi bình luận local của app (không cần Google OAuth — xem BE /comments/local)
  // Đồng thời thử gửi lên YouTube thật nếu đã liên kết quyền (tick ô YouTube
  // khi đăng nhập Google). Không liên kết → chỉ lưu local, báo rõ.
  const sendComment = async () => {
    if (!selected || sendingComment) return;
    const text = commentText.trim();
    if (!text) { showToast?.(t(getLang(), 'Nhập nội dung bình luận trước.'), 'error'); return; }
    setSendingComment(true);
    try {
      const res = await fetch(`${API_BASE}/services/youtube/comments/local`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ url: selected.id, text }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t(getLang(), 'Gửi bình luận thất bại.'));
      setCommentText('');
      setComments((prev) => prev
        ? { ...prev, comments: [data.comment, ...(prev.comments || [])], count: (prev.count || 0) + 1, localCount: (prev.localCount || 0) + 1 }
        : { success: true, comments: [data.comment], count: 1, localCount: 1 });
      // Thử gửi lên YouTube thật (không bắt buộc)
      try {
        const yt = await fetch(`${API_BASE}/services/youtube/comments/youtube`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ url: selected.id, text }),
        });
        const ytd = await yt.json().catch(() => ({}));
        if (ytd && ytd.success) showToast?.(t(getLang(), 'Đã gửi cả lên YouTube.'), 'success');
        else if (ytd && ytd.error === 'NO_YOUTUBE_SCOPE') showToast?.(t(getLang(), 'Đã lưu trong app. Muốn hiện lên YouTube thật: đăng nhập Google lại + tick ô YouTube.'), 'info');
        else showToast?.(t(getLang(), 'Đã gửi bình luận.'), 'success');
      } catch (e) {
        showToast?.(t(getLang(), 'Đã gửi bình luận.'), 'success');
      }
    } catch (e) {
      showToast?.(t(getLang(), 'Lỗi gửi bình luận: ') + e.message, 'error');
    } finally {
      setSendingComment(false);
    }
  };

  const handlePlay = async (video) => {
    // Bỏ qua kết quả của lần bấm cũ nếu user bấm video khác khi đang tải
    const seq = playSeqRef.current + 1;
    playSeqRef.current = seq;
    setSelected(video);
    setStreamLoading(true);
    setError(null);
    setSummary(null);
    setIsHlsStream(false);
    setComments(null);
    setPlayBlocked(false);
    setPlaybackRate(1);
    setSpeedOpen(false);
    // Lưu vào lịch sử xem (localStorage) — đầu danh sách, tối đa 24
    try {
      const raw = localStorage.getItem('rexi_watch_history');
      const prev = raw ? JSON.parse(raw) : [];
      const next = [{ id: video.id, title: video.title, thumb: video.thumb, author: video.author, channel_id: video.channel_id || null, views: video.views, duration: video.duration }, ...prev.filter((v) => v.id !== video.id)].slice(0, 24);
      localStorage.setItem('rexi_watch_history', JSON.stringify(next));
      setHistory(next);
    } catch (e) { console.warn('[rexi] watch history save failed', e); }
    try {
      const res = await fetch(`${API_BASE}/services/youtube/stream?url=${encodeURIComponent(video.id)}`, { headers: headers() });
      // 4/10: proxy/Vercel có thể trả non-JSON (vd 502 "An error occurred...") khi
      // upstream quá lâu — đọc text trước, parse thủ công để báo lỗi thân thiện.
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`${t(getLang(), 'Server phản hồi không hợp lệ (HTTP ')}${res.status}${t(getLang(), '). Thử bấm phát lại sau ít giây.')}`);
      }
      if (!data.success) throw new Error(data.error || t(getLang(), 'Không phát được video'));
      // Nếu user đã bấm video khác trong lúc chờ → bỏ kết quả cũ, không ghi đè video mới
      if (seq !== playSeqRef.current) return;
      setSelected((prev) => ({ ...prev, stream_url: data.stream_url, stream_direct: data.stream_client === 'worker:residential', description: data.description, channel_id: data.channel_id || prev.channel_id || null }));
      setStreamLoading(false);
      const _tok = (() => { try { return localStorage.getItem('rexi_token') || ''; } catch { return ''; } })();
      const pUrl = `${API_BASE}/services/youtube/proxy?url=${encodeURIComponent(data.stream_url)}${_tok ? `&token=${encodeURIComponent(_tok)}` : ''}`;
      const hls = await probeHls(pUrl);
      if (seq !== playSeqRef.current) return; // probe cũ về chậm → bỏ, không gắn HLS nhầm
      setIsHlsStream(hls);
    } catch (err) {
      if (seq !== playSeqRef.current) return;
      setError(t(getLang(), 'Lỗi phát video: ') + err.message);
      setStreamLoading(false);
    }
  };

  const handleSummarize = async () => {
    if (!selected || summarizing) return;
    setSummarizing(true);
    setSummary(null);
    setShowTranscript(false);
    setShowSrt(false);
    setSummaryStep(t(getLang(), 'Đang tải audio từ video...'));
    const ctl = new AbortController();
    // Video dài: tải audio + STT (Groq→Gemini) có thể mất 2-3 phút. Cap để nút
    // không treo vô hạn nếu backend/worker kẹt.
    const hardTo = setTimeout(() => ctl.abort(), 240000);
    try {
      const res = await fetch(`${API_BASE}/services/youtube/summarize`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ url: selected.id }),
        signal: ctl.signal,
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error(`${t(getLang(), 'Server phản hồi không hợp lệ (HTTP ')}${res.status}${t(getLang(), '). Thử bấm Tóm tắt lại sau ít giây.')}`); }
      if (!data.success) throw new Error(data.error || t(getLang(), 'Không tóm tắt được video'));
      setSummary({ title: data.title || selected.title, transcript: data.transcript || '', summary: data.summary || '', srt: data.srt || '' });
      if (!data.summary) setError(t(getLang(), 'Video không có lời thoại để tóm tắt.'));
    } catch (err) {
      if (err.name === 'AbortError') setError(t(getLang(), 'Tóm tắt quá lâu (video dài hoặc server bận). Thử lại hoặc chọn video ngắn hơn.'));
      else setError(t(getLang(), 'Lỗi tóm tắt: ') + err.message);
    } finally {
      clearTimeout(hardTo);
      setSummarizing(false);
      setSummaryStep('');
    }
  };

  const handleBack = () => {
    if (videoRef.current) { try { videoRef.current.pause(); videoRef.current.removeAttribute('src'); videoRef.current.load(); } catch (e) { console.warn('[rexi] video cleanup failed', e); } }
    setIsHlsStream(false);
    setPlayBlocked(false);
    setSelected(null);
    setSummary(null);
    setShowTranscript(false);
    setShowSrt(false);
    setComments(null);
  };

  const downloadSrt = () => {
    if (!summary?.srt) return;
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(summary.srt);
    a.download = `${(selected?.title || 'youtube').replace(/[^\w\d]+/g, '_').slice(0, 60)}.srt`;
    a.click();
  };

  // Worker residential: stream_url đã kèm token + worker trả CORS * → <video>/hls.js
  // đi THẲNG worker (browser→tunnel ~1.7MB/s) thay vì vòng qua proxy Render
  // (Render→tunnel ~0.43MB/s = nguyên nhân video kẹt t=0 trên cloud). Fallback
  // googlevideo resolve từ IP Render thì bắt buộc đi proxy (IP-lock googlevideo).
  const _ytToken = (() => { try { return localStorage.getItem('rexi_token') || ''; } catch { return ''; } })();
  const proxyUrl = selected?.stream_url
    ? (selected.stream_direct
        ? selected.stream_url
        : `${API_BASE}/services/youtube/proxy?url=${encodeURIComponent(selected.stream_url)}${_ytToken ? `&token=${encodeURIComponent(_ytToken)}` : ''}`)
    : '';

  // Chia sẻ: copy link YouTube gốc
  const shareVideo = async () => {
    if (!selected) return;
    const url = `https://www.youtube.com/watch?v=${selected.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast?.(t(getLang(), 'Đã copy link video!'));
    } catch {
      showToast?.(url);
    }
  };

  // Tải video về máy: fetch stream → blob → <a download>. Dùng proxyUrl hiện có
  // (worker direct khi worker phục vụ → nhanh; googlevideo → qua proxy Render).
  // Video dài = file lớn: giới hạn 10 phút timeout, báo toast tiến độ.
  const downloadVideo = async () => {
    if (!selected || !proxyUrl || downloading) return;
    setDownloading(true);
    showToast?.(t(getLang(), 'Đang tải video — video dài có thể mất vài phút...'), 'info');
    const ctl = new AbortController();
    const hardTo = setTimeout(() => ctl.abort(), 600000);
    try {
      const res = await fetch(proxyUrl, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(selected.title || 'youtube').replace(/[^\w\d]+/g, '_').slice(0, 60)}.${selected.ext || 'mp4'}`;
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) { /* ignore */ } }, 60000);
      showToast?.(t(getLang(), 'Đã tải video về máy!'), 'success');
    } catch (e) {
      showToast?.(e.name === 'AbortError' ? t(getLang(), 'Tải video quá lâu — thử video ngắn hơn.') : t(getLang(), 'Lỗi tải video: ') + e.message, 'error');
    } finally {
      clearTimeout(hardTo);
      setDownloading(false);
    }
  };

  // HLS m3u: Chromium không chơi trực tiếp — gắn hls.js (như IPTV).
  // Khi đổi video hoặc HLS→MP4, dọn hls.js cũ + gỡ blob URL cũ trước, nếu không
  // thẻ video cũ kẹt (blob detached) và xuất hiện 2 thẻ video (1 kẹt HLS + 1 MP4).
  // Fix bổ sung: thẻ video MP4 KHÔNG bao giờ dùng blob — chặn từ đầu ở đây.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    let hls = null;
    if (isHlsStream && proxyUrl) {
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: false });
        hls.loadSource(proxyUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, (evt, data) => {
          if (data.fatal) setError(t(getLang(), 'Luồng HLS lỗi. Thử video khác.'));
        });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = proxyUrl; // Safari native HLS
      } else {
        setError(t(getLang(), 'Trình duyệt không hỗ trợ luồng HLS.'));
      }
    } else if (proxyUrl) {
      // Nhánh MP4: gỡ sạch blob HLS cũ (nếu có) rồi gán src trực tiếp + phát ngay.
      // Không để video cũ giữ blob detached — đó là "player kẹt t=0" user thấy.
      try {
        const old = v.getAttribute('src') || '';
        if (old.startsWith('blob:')) { v.removeAttribute('src'); v.load(); }
      } catch (e) { /* ignore */ }
      if (v.getAttribute('src') !== proxyUrl) v.setAttribute('src', proxyUrl);
      tryPlay();
    }
    return () => {
      if (hls) { try { hls.destroy(); } catch (e) { console.warn('[rexi] hls cleanup failed', e); } }
      try {
        const old = v.getAttribute('src') || '';
        if (old.startsWith('blob:')) { v.removeAttribute('src'); v.load(); }
      } catch (e) { /* ignore */ }
    };
  }, [isHlsStream, proxyUrl, selected?.id]);

  return (
    <div className="flex flex-col h-full w-full bg-[#0d0e11] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#181920] border-b border-white/5 shrink-0">
        <span className="w-8 h-8 rounded-lg bg-red-600/20 border border-red-500/30 flex items-center justify-center shrink-0">
          <MonitorPlay size={16} className="text-red-400" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-white">YouTube Free</p>
          <p className="text-[10px] text-emerald-400/80">{t(getLang(), 'Không quảng cáo · Không đăng nhập · Không theo dõi')}</p>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-red-600/15 border border-red-500/25 text-[9px] font-semibold text-red-300 shrink-0">
          + {t(getLang(), 'Tóm tắt AI')}
        </span>
      </div>

      {engineReady === false && (
        <div className="mx-4 mt-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2.5 shrink-0">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold mb-0.5">{t(getLang(), 'YouTube chưa sẵn sàng trên server')}</p>
            <p className="text-amber-300/80">{engineNote || t(getLang(), 'Engine yt-dlp chưa tải xong. Thử tải lại trang sau ít phút.')}</p>
          </div>
          <button
            onClick={() => { setEngineReady(null); setCheckNonce((n) => n + 1); }}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[11px] font-semibold transition-all"
          >
            {t(getLang(), 'Thử lại')}
          </button>
        </div>
      )}

      {engineReady !== false && (
      <div id="yt-scroll" className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {!selected ? (
          <>
            {/* Search Box */}
            <form onSubmit={handleSearch} className="max-w-2xl mx-auto">
              <div className="flex items-center gap-2 bg-[#181920] border border-white/10 focus-within:border-red-500/40 rounded-2xl px-4 py-2.5 shadow-xl transition-colors">
                <Search size={16} className="text-slate-500 shrink-0" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t(lang, 'phYtSearch')}
                  className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none"
                />
                <button
                  type="submit"
                  disabled={loading || !query.trim()}
                  className="px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition-all shrink-0"
                >
                  {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                  {loading ? t(getLang(), 'Đang tìm...') : t(getLang(), 'Tìm')}
                </button>
              </div>

              {/* Danh mục trending */}
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleCategory(t(getLang(), c))}
                    className={`px-2.5 py-1 rounded-full border text-[10px] transition-all ${
                      activeCat === t(getLang(), c) || activeCat === c
                        ? 'bg-red-600/20 border-red-500/40 text-red-300 font-semibold'
                        : 'bg-white/5 border-white/10 text-slate-400 hover:text-white hover:bg-white/10 hover:border-red-500/30'
                    }`}
                  >{t(getLang(), c)}</button>
                ))}
              </div>
            </form>

            {error && (
              <div className="max-w-2xl mx-auto mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                {error}
              </div>
            )}

            {/* Lịch sử xem — Video đã xem (kiểu YouTube, localStorage) */}
            {history.length > 0 && (
              <div className="max-w-[1600px] mx-auto mt-5">
                <div className="flex items-center gap-2 mb-2.5">
                  <History size={14} className="text-slate-400" />
                  <span className="text-sm font-bold text-white">{t(getLang(), 'Video đã xem')}</span>
                  <span className="text-[10px] text-slate-500">({history.length})</span>
                  <button onClick={clearHistory} className="ml-auto text-[10px] text-slate-500 hover:text-rose-400 transition-colors">
                    {t(getLang(), 'Xóa lịch sử')}
                  </button>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {history.map((h) => (
                    <button key={h.id} onClick={() => handlePlay({ ...h })} className="group shrink-0 w-44 text-left">
                      <div className="relative aspect-video rounded-lg overflow-hidden bg-black">
                        {h.thumb ? (
                          <img src={h.thumb} alt={h.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-tr from-red-900/40 to-[#181920]">
                            <Play size={18} className="text-slate-600" />
                          </div>
                        )}
                      </div>
                      <p className="text-[11px] font-semibold text-slate-100 line-clamp-2 leading-snug mt-1.5">{h.title}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <ChannelAvatar channelId={h.channel_id} videoId={h.id} author={h.author} size={20} ring={false} />
                        <p className="text-[10px] text-slate-400 truncate">{h.author}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Video Grid — kiểu YouTube: card không viền, avatar kênh tròn */}
            {loading && videos.length === 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-3 gap-y-6 max-w-[1600px] mx-auto mt-5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="animate-pulse">
                    <div className="aspect-video rounded-xl bg-white/10" />
                    <div className="flex gap-2.5 mt-2.5">
                      <div className="w-9 h-9 rounded-full bg-white/10 shrink-0" />
                      <div className="flex-1 space-y-2 pt-0.5">
                        <div className="h-3 rounded bg-white/10 w-11/12" />
                        <div className="h-3 rounded bg-white/10 w-2/3" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {videos.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-3 gap-y-6 max-w-[1600px] mx-auto mt-5">
                {videos.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => handlePlay(v)}
                    className="group text-left"
                  >
                    <div className="relative aspect-video bg-black rounded-xl overflow-hidden">
                      {v.thumb ? (
                        <img src={v.thumb} alt={v.title} className="w-full h-full object-cover group-hover:scale-105 group-hover:rounded-none transition-all duration-300" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-tr from-red-900/40 to-[#181920]">
                          <Play size={28} className="text-slate-600" />
                        </div>
                      )}
                      <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[11px] font-medium text-white">
                        {fmtDuration(v.duration)}
                      </span>
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                        <span className="w-11 h-11 rounded-full bg-black/70 flex items-center justify-center">
                          <Play size={18} className="text-white ml-0.5" fill="currentColor" />
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2.5 mt-2.5">
                      <ChannelAvatar channelId={v.channel_id} videoId={v.id} author={v.author} size={36} />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-slate-100 line-clamp-2 leading-snug">{v.title}</p>
                        <p className="text-xs text-slate-400 mt-1 truncate">{v.author}</p>
                        <p className="text-xs text-slate-400">
                          {v.views > 0 ? fmtViews(v.views) : ''}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {!loading && videos.length === 0 && !error && (
              <div className="max-w-2xl mx-auto mt-10 text-center">
                <MonitorPlay size={44} className="mx-auto text-slate-700" />
                <p className="text-sm text-slate-500 mt-3 font-medium">{t(lang, 'ytFreeBanner')}</p>
                <p className="text-[11px] text-slate-600 mt-1">{t(getLang(), 'Gõ từ khóa ở trên để bắt đầu. Dùng chính backend yt-dlp — không ads, không tracking.')}</p>
              </div>
            )}
          </>
        ) : (
          /* Player View — kiểu trang xem YouTube: cột chính + Up tiếp theo */
          <div className="max-w-[1700px] mx-auto flex flex-col lg:flex-row gap-5">
          <div className="flex-1 min-w-0">
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-3 transition-colors"
            >
              <ArrowLeft size={14} /> {t(getLang(), 'Quay lại kết quả')}
            </button>

            <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-white/10 shadow-2xl">
              {streamLoading ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                  <Loader2 size={28} className="text-red-400 animate-spin" />
                  <p className="text-xs text-slate-400">{t(getLang(), 'Đang lấy luồng video...')}</p>
                </div>
              ) : proxyUrl ? (
                <>
                  <video
                    key={selected?.id || 'yt-single'}
                    ref={videoRef}
                    src={isHlsStream ? undefined : proxyUrl}
                    controls
                    autoPlay
                    playsInline
                    className="w-full h-full bg-black"
                    onCanPlay={() => { tryPlay(false); }}
                    onPlay={() => setPlayBlocked(false)}
                    onError={() => { if (!isHlsStream) setError(t(getLang(), 'Không phát được video qua proxy. Thử video khác.')); }}
                  />
                  {playBlocked && (
                    <button
                      onClick={() => tryPlay(true)}
                      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 hover:bg-black/50 transition-colors"
                      title={t(lang, 'tipClickPlay')}
                    >
                      <span className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-2xl transition-all">
                        <Play size={26} className="text-white ml-1" fill="currentColor" />
                      </span>
                      <span className="text-xs text-slate-200 font-semibold">{t(getLang(), 'Bấm để phát video')}</span>
                    </button>
                  )}
                </>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <p className="text-xs text-slate-500">{t(getLang(), 'Đang chuẩn bị phát...')}</p>
                </div>
              )}
            </div>

            {error && selected && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                {error}
              </div>
            )}

            <h2 className="text-base font-bold text-white mt-3 leading-snug">{selected.title}</h2>
            {/* Info line kiểu YouTube: views • thời lượng ngay dưới title (fmtViews đã kèm "lượt xem") */}
            <p className="text-xs text-slate-400 mt-1">
              {selected.views > 0 ? fmtViews(selected.views) : ''}
              {selected.duration ? `${selected.views > 0 ? ' • ' : ''}${fmtDuration(selected.duration)}` : ''}
            </p>
            {/* Hàng kênh + hành động kiểu YouTube */}
            <div className="flex flex-wrap items-center gap-3 mt-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <ChannelAvatar channelId={selected.channel_id} videoId={selected.id} author={selected.author} size={40} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{selected.author}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={handleSummarize}
                  disabled={summarizing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-xs font-bold shadow transition-all"
                >
                  {summarizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {summarizing ? t(getLang(), 'Đang tóm tắt...') : t(getLang(), 'Tóm tắt AI')}
                </button>
                {/* Like/dislike ghép 1 pill kiểu YouTube */}
                <div className="flex items-center rounded-full bg-white/10 overflow-hidden">
                  <button
                    onClick={() => setLiked(!liked)}
                    className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold transition-all border-r border-white/10 ${liked ? 'text-black bg-white' : 'text-white hover:bg-white/10'}`}
                  >
                    <ThumbsUp size={13} fill={liked ? 'currentColor' : 'none'} /> {t(getLang(), 'Thích')}
                  </button>
                  <button className="px-3.5 py-2 text-white hover:bg-white/10 transition-all" title={t(lang, 'tipDislike')}>
                    <ThumbsDown size={13} />
                  </button>
                </div>
                <button
                  onClick={shareVideo}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all"
                >
                  <Share2 size={13} /> {t(getLang(), 'Chia sẻ')}
                </button>
                {proxyUrl && (
                  <button
                    onClick={enterPip}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all"
                    title={t(lang, 'tipPopout')}
                  >
                    <PictureInPicture2 size={13} /> {pipActive ? t(getLang(), 'Đang phát nền') : t(getLang(), 'Phát nền')}
                  </button>
                )}
                {proxyUrl && (
                  <button
                    onClick={downloadVideo}
                    disabled={downloading}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all disabled:opacity-50"
                    title={t(lang, 'tipDownloadVid')}
                  >
                    {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {downloading ? t(getLang(), 'Đang tải...') : t(getLang(), 'Tải xuống')}
                  </button>
                )}
              </div>
            </div>
            {summarizing && summaryStep && (
              <p className="text-[11px] text-slate-400 animate-pulse mt-2">{summaryStep}</p>
            )}
            {/* Hộp mô tả kiểu YouTube — bấm để mở rộng */}
            {selected.description && (
              <div
                className="mt-3 p-3 rounded-xl bg-white/5 hover:bg-white/[0.08] cursor-pointer transition-colors"
                onClick={() => setDescOpen(!descOpen)}
              >
                <p className={`text-xs text-slate-300 leading-relaxed whitespace-pre-wrap ${descOpen ? '' : 'line-clamp-2'}`}>
                  {selected.description}
                </p>
                <p className="text-[11px] text-slate-500 mt-1 font-semibold">{descOpen ? t(getLang(), 'Ẩn bớt') : t(getLang(), '...xem thêm')}</p>
              </div>
            )}

            {/* Bình luận kiểu YouTube — bấm để tải (chậm 10-30s, cache 24h server) */}
            <div className="mt-4 rounded-2xl bg-white/5 border border-white/5 overflow-hidden">
              <button onClick={loadComments} className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/[0.06] transition-colors text-left">
                <MessageSquare size={14} className="text-slate-400 shrink-0" />
                <span className="text-xs font-bold text-white flex-1">
                  {t(getLang(), 'Bình luận')}{comments?.count ? ` — ${comments.count.toLocaleString('vi-VN')} ${t(getLang(), 'bình luận')}` : ''}
                </span>
                {commentsLoading ? (
                  <span className="text-[10px] text-slate-400 animate-pulse flex items-center gap-1 shrink-0">
                    <Loader2 size={10} className="animate-spin" /> {commentsSlow ? t(getLang(), 'Vẫn đang tải (worker bận, chờ thêm)...') : t(getLang(), 'Đang tải (10-30 giây)...')}
                  </span>
                ) : (
                  <ChevronDown size={14} className={`text-slate-400 transition-transform shrink-0 ${comments ? 'rotate-180' : ''}`} />
                )}
              </button>
              {comments && comments.comments && comments.comments.length > 0 && (
                <div className="px-4 pb-3 space-y-3.5">
                  {/* Ô gửi bình luận local của app (không cần Google OAuth) */}
                  <div className="flex gap-2.5 items-start pb-1">
                    <span className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                      B
                    </span>
                    <div className="flex-1 min-w-0">
                      <textarea
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } }}
                        placeholder={t(lang, 'phYtComment')}
                        rows={commentRows}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-400/60 resize-none"
                      />
                      <div className="flex items-center gap-2 mt-1.5">
                        <button
                          onClick={sendComment}
                          disabled={sendingComment || !commentText.trim()}
                          className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-semibold transition-all"
                        >
                          {sendingComment ? t(getLang(), 'Đang gửi...') : t(getLang(), 'Gửi bình luận')}
                        </button>
                        <span className="text-[10px] text-slate-500">{t(getLang(), 'Hiển thị trong app ngay, ghim lên đầu')}</span>
                      </div>
                    </div>
                  </div>
                  {comments.comments.map((c, i) => (
                    <div key={c.id || i} className="flex gap-2.5">
                      {c.avatar ? (
                        <img src={c.avatar} alt={c.author} loading="lazy" className="w-8 h-8 rounded-full object-cover shrink-0" />
                      ) : (
                        <span className="w-8 h-8 rounded-full bg-gradient-to-tr from-slate-600 to-slate-800 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                          {String(c.author || (getLang() === 'en' ? 'A' : 'Ẩ')).trim().charAt(0).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-[11px] text-slate-400">
                          <span className="font-semibold text-slate-300">{c.author}</span>
                          {c.local && <span className="ml-1.5 px-1.5 py-px rounded bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[9px] font-bold">trong app</span>}
                          {c.time ? ` · ${c.time}` : ''}
                        </p>
                        <p className="text-xs text-slate-200 leading-relaxed mt-0.5 whitespace-pre-wrap break-words">{c.text}</p>
                        {c.likes > 0 && (
                          <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                            <ThumbsUp size={10} /> {c.likes.toLocaleString('vi-VN')}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {comments && (!comments.comments || comments.comments.length === 0) && (
                <div className="px-4 pb-3">
                  {/* Ô gửi ngay cả khi chưa có bình luận nào */}
                  <div className="flex gap-2.5 items-start mb-2">
                    <span className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                      B
                    </span>
                    <div className="flex-1 min-w-0">
                      <textarea
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } }}
                        placeholder={t(lang, 'phYtCommentFirst')}
                        rows={commentRows}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-400/60 resize-none"
                      />
                      <button
                        onClick={sendComment}
                        disabled={sendingComment || !commentText.trim()}
                        className="mt-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-semibold transition-all"
                      >
                        {sendingComment ? t(getLang(), 'Đang gửi...') : t(getLang(), 'Gửi bình luận')}
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">{t(getLang(), 'Video này chưa có bình luận hoặc không lấy được bình luận.')}</p>
                </div>
              )}
            </div>

              {/* Kết quả tóm tắt */}
              {summary && summary.summary && (
                <div className="mt-4 rounded-2xl bg-[#181920] border border-red-500/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-red-600/15 to-rose-600/10 border-b border-white/5">
                    <Sparkles size={14} className="text-red-400" />
                    <span className="text-[11px] font-bold text-white flex-1">{t(getLang(), 'Tóm tắt AI')} — {summary.title}</span>
                    {summary.transcript && (
                      <button
                        onClick={() => setShowTranscript(!showTranscript)}
                        className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white transition-colors"
                      >
                        <FileText size={11} />
                        {showTranscript ? t(lang, 'Ẩn transcript') : t(lang, 'Xem transcript')}
                        {showTranscript ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      </button>
                    )}
                    {summary.srt && (
                      <>
                        <button
                          onClick={() => setShowSrt(!showSrt)}
                          className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white transition-colors"
                        >
                          <Subtitles size={11} />
                          {showSrt ? t(getLang(), 'Ẩn phụ đề') : t(getLang(), 'Xem phụ đề')}
                          {showSrt ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        </button>
                        <button
                          onClick={downloadSrt}
                          className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white transition-colors"
                          title={t(lang, 'tipDownloadSrt')}
                        >
                          <Download size={11} /> SRT
                        </button>
                      </>
                    )}
                  </div>
                  <div className="px-4 py-3 max-h-80 overflow-y-auto">
                    {renderMarkdown(summary.summary)}
                    {showTranscript && summary.transcript && (
                      <div className="mt-3 pt-3 border-t border-white/5">
                        <p className="text-[10px] font-bold text-slate-500 mb-2 uppercase tracking-wider">Transcript</p>
                        <p className="text-[11px] text-slate-400 leading-relaxed">{summary.transcript}</p>
                      </div>
                    )}
                    {showSrt && summary.srt && (
                      <div className="mt-3 pt-3 border-t border-white/5">
                        <p className="text-[10px] font-bold text-slate-500 mb-2 uppercase tracking-wider">{t(getLang(), 'Phụ đề SRT (timestamp)')}</p>
                        <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">{summary.srt}</pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {/* Cột Up tiếp theo kiểu YouTube */}
            <aside className="w-full lg:w-[360px] shrink-0">
              <p className="text-sm font-bold text-white mb-2.5">{t(getLang(), 'Up tiếp theo')}</p>
              <div className="flex flex-col gap-2.5">
                {videos.filter((v) => v.id !== selected?.id).map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setLiked(false);
                      setDescOpen(false);
                      handlePlay(v);
                      document.getElementById('yt-scroll')?.scrollTo({ top: 0 });
                    }}
                    className="group flex gap-2 text-left"
                  >
                    <div className="relative w-40 shrink-0 aspect-video rounded-lg overflow-hidden bg-black">
                      {v.thumb ? (
                        <img src={v.thumb} alt={v.title} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-tr from-red-900/40 to-[#181920]">
                          <Play size={20} className="text-slate-600" />
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 px-1 py-px rounded bg-black/80 text-[10px] font-medium text-white">
                        {fmtDuration(v.duration)}
                      </span>
                    </div>
                    <div className="min-w-0 py-0.5">
                      <p className="text-xs font-semibold text-slate-100 line-clamp-2 leading-snug">{v.title}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <ChannelAvatar channelId={v.channel_id} videoId={v.id} author={v.author} size={22} ring={false} />
                        <p className="text-[11px] text-slate-400 truncate">{v.author}</p>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">{v.views > 0 ? fmtViews(v.views) : ''}</p>
                    </div>
                  </button>
                ))}
              </div>
            </aside>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
