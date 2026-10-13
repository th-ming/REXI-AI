import { API_BASE } from '../config';
import { t, getLang } from '../i18n';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Tv, Globe, Play, Radio, Search } from 'lucide-react';
import { ALL_IPTV_COUNTRIES } from '../data/iptvCountries.js';

const IPTV_CATEGORIES = [
  { id: 'news', name: '📰 Tin Tức 24/7' },
  { id: 'animation', name: '🦄 Hoạt Hình / Anime' },
  { id: 'movies', name: '🍿 Phim Điện Ảnh' },
  { id: 'sports', name: '⚽ Thể Thao Live' },
  { id: 'entertainment', name: '🎭 Giải Trí' },
  { id: 'music', name: '🎵 Âm Nhạc' },
  { id: 'documentary', name: '🎬 Tài Liệu' },
  { id: 'kids', name: '🧸 Thiếu Nhi' },
  { id: 'general', name: '📡 Tổng Hợp' },
  { id: 'education', name: '📚 Giáo Dục' },
  { id: 'religion', name: '🕌 Tôn Giáo' },
  { id: 'science', name: '🔬 Khoa Học' },
  { id: 'business', name: '💼 Kinh Doanh' },
  { id: 'shop', name: '🛒 Mua Sắm' },
];

const POPULAR_COUNTRIES = ['VN', 'US', 'GB', 'KR', 'JP', 'CN', 'TH', 'FR', 'DE', 'IN', 'RU', 'BR', 'AU', 'CA', 'HK', 'TW'];

// Trích YouTube video ID từ mọi dạng URL: watch?v=, youtu.be/, /shorts/, /live/, /embed/, /v/
function extractYouTubeId(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  let m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = u.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:shorts|live|embed|v)\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return '';
}

function isYouTubeUrl(rawUrl) {
  const u = String(rawUrl || '').toLowerCase();
  return u.includes('youtube.com') || u.includes('youtu.be') || u.includes('youtube-nocookie.com');
}


const codeToTwemojiUrl = (code) => {
  if (!code || code.length !== 2) return null;
  const c = code.toUpperCase();
  const cp1 = (0x1F1E6 + c.charCodeAt(0) - 65).toString(16);
  const cp2 = (0x1F1E6 + c.charCodeAt(1) - 65).toString(16);
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/${cp1}-${cp2}.svg`;
};

const FlagImg = ({ code, size = 18, className = '' }) => {
  const url = codeToTwemojiUrl(code);
  if (!url) return <span className={`inline-block shrink-0 ${className}`} style={{ fontSize: size }}>🌍</span>;
  return (
    <img
      src={url}
      alt={code}
      className={`inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      onError={e => { e.target.style.display = 'none'; }}
    />
  );
};

export default function IPTVTab({
  iptvTab, setIptvTab,
  iptvCategory, setIptvCategory,
  iptvCountry, setIptvCountry,
  iptvSearch, setIptvSearch,
  iptvChannels, selectedChannel, setSelectedChannel,
  iptvSubtitleOn, setIptvSubtitleOn,
  iptvEmbeddedSubs, iptvError,
  hlsRef,
  fetchIPTV, iptvVideoRef,
}) {
  const lang = getLang();
  const safeChannels = iptvChannels || [];

  // Filter states
  const [countrySearch, setCountrySearch] = useState('');
  // Hộp chọn quốc gia thu gọn (mặc định đóng cho gọn chỗ)
  const [countryListOpen, setCountryListOpen] = useState(false);
  const selectedCountry = ALL_IPTV_COUNTRIES.find(c => c.code === iptvCountry);
  // Hộp chọn thể loại thu gọn (mặc định đóng cho gọn chỗ)
  const [categoryOpen, setCategoryOpen] = useState(false);
  const selectedCategory = IPTV_CATEGORIES.find(c => c.id === iptvCategory);

  // Sidebar width state
  const [sidebarWidth, setSidebarWidth] = useState(210);

  // Subtitle state
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleInterim, setSubtitleInterim] = useState('');
  const [subtitleStatus, setSubtitleStatus] = useState('idle'); // idle | listening | error | unsupported
  const [subtitleError, setSubtitleError] = useState(''); // Lỗi backend (CHƯA_CÓ_KEY/401/500...) hiện rõ cho user
  const [embeddedSubOn, setEmbeddedSubOn] = useState(false); // track phụ đề nhúng của kênh (đồng bộ 100%)
  const mediaRecorderRef = useRef(null);
  const audioStreamRef = useRef(null);
  const sendingRef = useRef(false);

  const iptvSubtitleOnRef = useRef(iptvSubtitleOn);

  // Danh sách quốc gia — gộp 1: các nước phổ biến ghim đầu, còn lại theo sau (khi không tìm kiếm)
  const filteredCountries = useMemo(() => {
    if (countrySearch) {
      const q = countrySearch.toLowerCase().trim();
      return ALL_IPTV_COUNTRIES.filter(c =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || (() => { try { return (new Intl.DisplayNames([lang], { type: 'region' }).of(c.code) || '').toLowerCase().includes(q); } catch { return false; } })()
      );
    }
    const popular = POPULAR_COUNTRIES.map(code => ALL_IPTV_COUNTRIES.find(c => c.code === code)).filter(Boolean);
    const popularCodes = new Set(popular.map(c => c.code));
    const rest = ALL_IPTV_COUNTRIES.filter(c => !popularCodes.has(c.code));
    return [...popular, ...rest];
  }, [countrySearch]);

  // Sync ref with state
  useEffect(() => {
    iptvSubtitleOnRef.current = iptvSubtitleOn;
  }, [iptvSubtitleOn]);

  // ===== LIVE CAPTION: Groq Whisper (backend) + dịch sang tiếng Việt =====
  useEffect(() => {
    if (!iptvSubtitleOn) {
      // Stop capture
      if (mediaRecorderRef.current) {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn('[rexi] recorder stop failed', e); }
        mediaRecorderRef.current = null;
      }
      if (audioStreamRef.current) {
        try { audioStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { console.warn('[rexi] track stop failed', e); }
        audioStreamRef.current = null;
      }
      setSubtitleText('');
      setSubtitleInterim('');
      setSubtitleStatus('idle');
      setSubtitleError('');
      return;
    }

    // Lấy audio trực tiếp từ video element (không cần mic, nghe tiếng đang phát)
    const video = iptvVideoRef?.current;
    if (!video) {
      // Kênh YouTube (dùng iframe) hoặc video chưa mount → không lấy được audio
      setSubtitleStatus('unsupported');
      setSubtitleError(t(lang, 'Kênh YouTube không hỗ trợ phụ đề AI (video không cho lấy audio).'));
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      // HTTP thường / trình duyệt cũ không có MediaRecorder
      setSubtitleStatus('unsupported');
      setSubtitleError(t(lang, 'Trình duyệt này không hỗ trợ ghi âm (cần HTTPS hoặc trình duyệt mới hơn).'));
      return;
    }

    let cancelled = false;
    let stream = null;
    let recorder = null;
    let retryTimer = null;
    let retryAttempts = 0;

    const startRecorder = () => {
      if (cancelled || (recorder && recorder.state !== 'inactive')) return;
      try {
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          if (retryAttempts++ < 30) retryTimer = setTimeout(startRecorder, 1000);
          return;
        }

        const capturedStream = video.captureStream();
        const audioTracks = capturedStream.getAudioTracks();
        if (!audioTracks.length) {
          if (retryAttempts++ < 30) {
            capturedStream.getTracks().forEach(track => track.stop());
            retryTimer = setTimeout(startRecorder, 1000);
          } else {
            setSubtitleStatus('unsupported');
            setSubtitleError(t(lang, 'Kênh này chưa phát audio hoặc trình duyệt không lấy được audio từ stream.'));
          }
          return;
        }
        retryAttempts = 0;
        stream = capturedStream;
        // Whisper chỉ cần audio. Dùng audio-only stream để MediaRecorder không
        // cố mã hoá cả track hình ảnh thành audio/webm.
        const audioStream = new MediaStream(audioTracks);
        audioStreamRef.current = audioStream;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
        recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
        mediaRecorderRef.current = recorder;
        setSubtitleStatus('listening');

        recorder.ondataavailable = (e) => {
          if (cancelled || !e.data || e.data.size < 3000) return;
          if (sendingRef.current) return; // đang gửi chunk trước, bỏ qua để tránh trùng
          sendingRef.current = true;

          const formData = new FormData();
          formData.append('audio', e.data, 'chunk.webm');
          formData.append('lang', 'auto');

          const iptvToken = localStorage.getItem('rexi_token');
          fetch(`${API_BASE}/services/transcribe`, {
            method: 'POST',
            headers: iptvToken ? { 'Authorization': `Bearer ${iptvToken}` } : {},
            body: formData,
            credentials: 'include',
            signal: AbortSignal.timeout(20000), // timeout 20s — tránh sendingRef kẹt true khi request treo
          })
            .then(async r => {
              const data = await r.json().catch(() => null);
              if (!r.ok) {
                // Backend trả lỗi (CHƯA_CÓ_KEY / 401 / 500...) → hiện thông báo rõ ràng thay vì im lặng
                const msg = data?.message || data?.error || `${t(lang, 'Lỗi server (HTTP ')}${r.status})`;
                setSubtitleStatus('error');
                setSubtitleError(msg);
                return;
              }
              if (data?.success) {
                if (data.text) {
                  setSubtitleText(prev => {
                    const newText = (prev + ' ' + data.text).trim();
                    return newText.length > 300 ? data.text.trim() : newText.slice(-300);
                  });
                }
                // Dịch thành công (kể cả chunk im lặng) → báo đang nghe bình thường, xoá lỗi cũ
                setSubtitleStatus('listening');
                setSubtitleError('');
              }
            })
            .catch(err => {
              setSubtitleStatus('error');
              setSubtitleError(err?.name === 'TimeoutError'
                ? t(lang, 'Yêu cầu phụ đề quá hạn (20s). Tự thử lại giây sau.')
                : t(lang, 'Không kết nối được server. Kiểm tra backend đang chạy.'));
              console.warn('[Caption] fetch error:', err);
            })
            .finally(() => { sendingRef.current = false; });
        };

        recorder.onerror = () => {
          setSubtitleStatus('error');
          setSubtitleError(t(lang, 'Lỗi ghi âm từ video. Thử tắt/bật lại phụ đề.'));
        };
        recorder.onstop = () => {
          if (cancelled) return;
          if (iptvSubtitleOnRef.current) {
            try { startRecorder(); } catch (e) { console.error('[Caption] restart recorder error:', e); }
          }
        };
        // Ghi liên tục, cứ ~5s phát chunk
        recorder.start(5000);

      } catch (e) {
        console.error('[Caption] Failed to start:', e);
        setSubtitleStatus('error');
        setSubtitleError(t(lang, 'Không lấy được âm thanh từ video (có thể do CORS/cross-origin).'));
      }
    };

    const retryEvents = ['loadedmetadata', 'canplay', 'playing', 'timeupdate'];
    retryEvents.forEach(eventName => video.addEventListener(eventName, startRecorder));
    startRecorder();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryEvents.forEach(eventName => video.removeEventListener(eventName, startRecorder));
      if (recorder) { try { recorder.stop(); } catch (e) { console.warn('[rexi] recorder stop failed', e); } }
      if (audioStreamRef.current) { try { audioStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { console.warn('[rexi] track stop failed', e); } }
      if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn('[rexi] stream stop failed', e); } }
      mediaRecorderRef.current = null;
      audioStreamRef.current = null;
    };
  }, [iptvSubtitleOn, iptvVideoRef]);

  const handleMouseDown = (e) => {
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (e) => {
      const newWidth = Math.max(150, Math.min(480, startWidth + (e.clientX - startX)));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  useEffect(() => {
    setEmbeddedSubOn(false);
    if (!selectedChannel && iptvVideoRef?.current) {
      iptvVideoRef.current.pause();
      iptvVideoRef.current.removeAttribute('src');
      iptvVideoRef.current.load();
    }
  }, [selectedChannel, iptvVideoRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const videoEl = iptvVideoRef.current;
    return () => {
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
      }
    };
  }, [iptvVideoRef]);

  return (
    <div className="flex h-full w-full select-none">
      {/* Danh sách kênh */}
      <div
        style={{ width: sidebarWidth, minWidth: 150, maxWidth: 480 }}
        className="flex flex-col border-r border-white/5 bg-[#131417] overflow-hidden"
      >
        <div className="p-3 border-b border-white/5">
          <h3 className="text-xs font-bold text-white flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Tv size={14} className="text-rose-400" /> IPTV ({safeChannels.length})
            </span>
          </h3>
          <div className="flex gap-1 bg-[#131417] rounded-lg p-0.5 mt-2">
            <button onClick={() => { setIptvTab?.('category'); setIptvSearch?.(''); fetchIPTV?.(iptvCategory); }} className={`flex-1 py-1 rounded text-[10px] font-medium transition-all ${iptvTab === 'category' ? 'bg-rose-500/20 text-rose-400' : 'text-slate-500 hover:text-white'}`}>
              <Globe size={10} className="inline mr-1" />{t(lang, 'Thể Loại')}
            </button>
            <button onClick={() => { setIptvTab?.('country'); setIptvSearch?.(''); fetchIPTV?.(null, iptvCountry); }} className={`flex-1 py-1 rounded text-[10px] font-medium transition-all ${iptvTab === 'country' ? 'bg-rose-500/20 text-rose-400' : 'text-slate-500 hover:text-white'}`}>
              🌍 {t(lang, 'Quốc Gia')}
            </button>
          </div>

          {/* Category filter buttons — hộp thu gọn, bấm để mở */}
          {iptvTab === 'category' && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setCategoryOpen(v => !v)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-[#1a1b24] border border-white/5 rounded-lg text-[10px] text-white hover:border-rose-500/30 transition-all"
              >
                <span className="truncate flex-1 text-left">{selectedCategory ? t(lang, selectedCategory.name) : t(lang, 'Chọn thể loại')}</span>
                <span className={`text-slate-500 text-[9px] shrink-0 transition-transform ${categoryOpen ? 'rotate-180' : ''}`}>▼</span>
              </button>
              {categoryOpen && (
              <div className="mt-1 max-h-[160px] overflow-y-auto space-y-0.5 scrollbar-thin border border-white/5 rounded-lg bg-[#131417] p-1">
              {IPTV_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => { setIptvCategory?.(cat.id); setCategoryOpen(false); fetchIPTV?.(cat.id); }}
                  className={`w-full text-left px-2 py-1 rounded text-[10px] font-medium transition-all ${
                    iptvCategory === cat.id ? 'bg-rose-500/20 text-rose-300' : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {t(lang, cat.name)}
                </button>
              ))}
              </div>
              )}
            </div>
          )}

          {/* Country filter — hộp thu gọn, bấm để mở danh sách */}
          {iptvTab === 'country' && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setCountryListOpen(v => !v)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-[#1a1b24] border border-white/5 rounded-lg text-[10px] text-white hover:border-rose-500/30 transition-all"
              >
                {selectedCountry ? (
                  <>
                    <FlagImg code={selectedCountry.code} size={14} />
                    <span className="truncate flex-1 text-left">{new Intl.DisplayNames([lang], { type: 'region' }).of(selectedCountry.code) || selectedCountry.name}</span>
                  </>
                ) : (
                  <span className="truncate flex-1 text-left text-slate-300">🌍 {t(lang, 'Tất cả')} ({ALL_IPTV_COUNTRIES.length} {t(lang, 'quốc gia')})</span>
                )}
                <span className={`text-slate-500 text-[9px] shrink-0 transition-transform ${countryListOpen ? 'rotate-180' : ''}`}>▼</span>
              </button>
              {countryListOpen && (
              <div className="mt-1 border border-white/5 rounded-lg bg-[#131417] p-1">
              <div className="relative">
                <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={countrySearch}
                  onChange={e => setCountrySearch(e.target.value)}
                  placeholder={t(lang, 'phCountry')}
                  className="w-full pl-6 pr-2 py-1 bg-[#1a1b24] border border-white/5 rounded text-[10px] text-white placeholder-slate-600 outline-none focus:border-rose-500/30"
                />
              </div>
              {/* Country list — gộp 1 danh sách duy nhất (kèm cờ phổ biến nổi bật ở đầu) */}
              <div className="mt-1 max-h-[260px] overflow-y-auto space-y-0.5 scrollbar-thin">
                {/* Reset / All button */}
                <button
                  onClick={() => { setIptvCountry?.(null); setCountrySearch(''); setCountryListOpen(false); fetchIPTV?.(iptvCategory || 'news'); }}
                  className={`w-full text-left px-2 py-0.5 rounded text-[9px] font-medium transition-all ${
                    !iptvCountry ? 'bg-rose-500/20 text-rose-300' : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  🌍 {t(lang, 'Tất cả')} ({ALL_IPTV_COUNTRIES.length} {t(lang, 'quốc gia')})
                </button>
                <div className="border-t border-white/5 my-0.5" />
                {filteredCountries.map(c => (
                  <button
                    key={c.code}
                    onClick={() => { setIptvCountry?.(c.code); setCountrySearch(''); setCountryListOpen(false); fetchIPTV?.(null, c.code); }}
                    className={`w-full text-left px-2 py-0.5 rounded text-[9px] font-medium transition-all flex items-center gap-1.5 ${
                      iptvCountry === c.code ? 'bg-rose-500/20 text-rose-300' : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <FlagImg code={c.code} size={14} />
                    <span className="truncate">{new Intl.DisplayNames([lang], { type: 'region' }).of(c.code) || c.name}</span>
                    <span className="text-[8px] text-slate-600 ml-auto shrink-0">{c.code}</span>
                  </button>
                ))}
                {filteredCountries.length === 0 && (
                  <div className="text-[9px] text-slate-600 text-center py-2">{t(lang, 'Không tìm thấy quốc gia')}</div>
                )}
              </div>
              </div>
              )}
            </div>
          )}

          <input
            type="text"
            value={iptvSearch || ''}
            onChange={e => setIptvSearch?.(e.target.value)}
            placeholder={t(lang, 'phIptvChannel')}
            className="w-full mt-2 px-2 py-1.5 bg-[#1a1b24] border border-white/5 rounded-lg text-[10px] text-white placeholder-slate-600 outline-none focus:border-rose-500/30"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {safeChannels.length === 0 && (
            <div className="text-[10px] text-slate-600 text-center py-8">
              {t(lang, 'Chọn thể loại hoặc quốc gia để xem kênh')}
            </div>
          )}
          {safeChannels.map((ch, i) => (
            <button
              key={ch.url || i}
              onClick={() => setSelectedChannel?.(ch)}
              className={`w-full text-left px-3 py-2 text-[10px] flex items-center gap-2 hover:bg-white/5 transition-colors ${
                selectedChannel?.url === ch.url ? 'bg-rose-500/10 border-r-2 border-rose-400' : ''
              }`}
            >
              {ch.logo ? (
                <img src={ch.logo} alt="" className="w-4 h-4 rounded object-contain shrink-0" onError={e => { e.target.style.display = 'none' }} />
              ) : (
                <Play size={11} className={`shrink-0 ${selectedChannel?.url === ch.url ? 'text-rose-400 fill-rose-400' : 'text-slate-500'}`} />
              )}
              <span className="truncate flex-1">{ch.name}</span>
              {ch.status && (
                <span className={`text-[8px] px-1 py-0.5 rounded-full shrink-0 ${
                  ch.status === 'online' ? 'bg-emerald-500/20 text-emerald-400' :
                  ch.status === 'offline' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'
                }`}>
                  {ch.status === 'online' ? '●' : ch.status === 'offline' ? '○' : '?'}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Resizer */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1.5 h-full cursor-col-resize hover:bg-rose-500/30 active:bg-rose-500 transition-colors shrink-0 z-10 flex items-center justify-center group"
        title={t(lang, 'tipResize')}
      >
        <div className="w-0.5 h-8 bg-white/10 group-hover:bg-rose-300 rounded-full" />
      </div>

      {/* Video player */}
      <div className="flex-1 h-full bg-black flex flex-col min-w-0">
        {selectedChannel && (
          <div className="px-3 py-2 bg-[#181920] border-b border-white/5 flex items-center gap-2">
            <Radio size={13} className="text-rose-400 animate-pulse shrink-0" />
            <span className="text-xs font-medium text-white truncate">{selectedChannel.name}</span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {/* Phụ đề NHÚNG của kênh — đồng bộ 100%, 0 đồng, 0 trễ */}
              {(iptvEmbeddedSubs?.length > 0) && (
                <button
                  onClick={() => {
                    const next = !embeddedSubOn;
                    setEmbeddedSubOn(next);
                    const hls = hlsRef?.current;
                    if (hls) {
                      hls.subtitleTrack = next ? (iptvEmbeddedSubs[0]?.id ?? 0) : -1;
                    }
                  }}
                  className={`px-2 py-1 rounded-lg text-[10px] font-medium flex items-center gap-1.5 transition-all min-w-[86px] justify-center ${
                    embeddedSubOn ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                  }`}
                  title={embeddedSubOn ? (lang === 'vi' ? 'Tắt phụ đề kênh (đồng bộ)' : 'Turn off channel subs (synced)') : `${t(lang, 'iptvSubOff')}: ${iptvEmbeddedSubs.map(s => s.name).join(', ')} (100% synced)`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${embeddedSubOn ? 'bg-white animate-pulse' : 'bg-white/20'}`}></span>
                  <span className="truncate">{t(lang, 'Phụ Đề Kênh')}</span>
                </button>
              )}
              {/* Phụ đề AI — nghe rồi dịch: TRỄ ~7-10s + tốn quota, chỉ nên dùng cho kênh ngoại ngữ */}
              <button
                onClick={() => {
                  if (!iptvSubtitleOn) {
                    // Cảnh báo trễ trước khi bật lần đầu
                    setIptvSubtitleOn?.(true);
                  } else {
                    setIptvSubtitleOn?.(false);
                  }
                }}
                className={`px-2 py-1 rounded-lg text-[10px] font-medium flex items-center gap-1.5 transition-all min-w-[80px] justify-center ${
                  iptvSubtitleOn ? 'bg-rose-500/80 text-white' : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                }`}
                title={lang === 'vi' ? 'Phụ đề AI (nghe + dịch): TRỄ ~7-10s so với hình, mỗi giờ xem tốn ~720 request Whisper. Chỉ nên bật cho kênh ngoại ngữ cần dịch sang tiếng Việt.' : 'AI subtitles (listen + translate): ~7-10s LAG behind video, ~720 Whisper requests per hour of viewing. Only enable for foreign-language channels you need translated.'}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${iptvSubtitleOn ? 'bg-white animate-pulse' : 'bg-white/20'}`}></span>
                <span className="truncate">{t(lang, 'Phụ Đề AI')}</span>
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 relative bg-black flex items-center justify-center">
          {selectedChannel && !isYouTubeUrl(selectedChannel.url) ? (
            <video
              ref={iptvVideoRef}
              className="w-full h-full object-contain bg-black"
              controls
              autoPlay
              playsInline
            />
          ) : selectedChannel && isYouTubeUrl(selectedChannel.url) && extractYouTubeId(selectedChannel.url) ? (
            <iframe
              src={`https://www.youtube.com/embed/${extractYouTubeId(selectedChannel.url)}?autoplay=1`}
              className="w-full h-full border-none"
              allowFullScreen
              allow="autoplay"
              title="YouTube Stream"
            />
          ) : (
            <div className="flex-1 h-full flex items-center justify-center text-slate-500 text-xs">
              <div className="text-center space-y-2">
                <Tv size={40} className="mx-auto text-slate-600" />
                <p>{t(lang, 'Chọn kênh để phát trực tiếp')}</p>
              </div>
            </div>
          )}

          {/* Overlay báo kênh lỗi thay vì màn đen im lặng */}
          {!!iptvError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 pointer-events-none">
              <div className="text-center space-y-1.5 px-6">
                <Tv size={32} className="mx-auto text-rose-400" />
                <p className="text-xs text-white font-medium">{iptvError}</p>
              </div>
            </div>
          )}

          {/* ===== SUBTITLE TEXT OVERLAY ===== */}
          {iptvSubtitleOn && (subtitleText || subtitleInterim) && (
            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 max-w-[80%] z-20 pointer-events-none">
              <div className="bg-black/70 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/10">
                {subtitleText && (
                  <p className="text-sm text-white font-medium text-center leading-relaxed">
                    {subtitleText}
                  </p>
                )}
                {subtitleInterim && (
                  <p className="text-sm text-white/50 text-center leading-relaxed italic">
                    {subtitleInterim}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Subtitle status indicator */}
          {iptvSubtitleOn && (
            <div className="absolute top-3 left-3 z-20">
              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[9px] font-medium backdrop-blur-sm max-w-[280px] ${
                subtitleStatus === 'listening' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                subtitleStatus === 'error' ? 'bg-red-500/20 text-red-300 border border-red-500/30' :
                subtitleStatus === 'unsupported' ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' :
                'bg-white/10 text-white/50 border border-white/10'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  subtitleStatus === 'listening' ? 'bg-emerald-400 animate-pulse' :
                  subtitleStatus === 'error' ? 'bg-red-400' :
                  subtitleStatus === 'unsupported' ? 'bg-yellow-400' :
                  'bg-white/30'
                }`}></span>
                <span className="truncate" title={subtitleError || undefined}>
                  {subtitleStatus === 'listening' ? t(lang, 'Đang nghe...') :
                   subtitleStatus === 'error' ? (subtitleError || t(lang, 'Lỗi microphone')) :
                   subtitleStatus === 'unsupported' ? (subtitleError || t(lang, 'Trình duyệt không hỗ trợ')) :
                   t(lang, 'Đang khởi động...')}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
