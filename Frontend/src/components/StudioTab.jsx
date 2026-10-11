import React, { useState, useRef, useEffect } from 'react';
import { t, getLang } from '../i18n';
import { stripVi } from '../strip-vi';
import { Play, Pause, Download, Volume2, Mic, RotateCw, Loader2, Clock, Type, Hash, User, MapPin, Upload, Sparkles } from 'lucide-react';

// Giọng THẬT của engine Microsoft Edge TTS (lấy đúng từ voices/list — không bịa).
// Backend /services/tts/voices cũng trả động danh sách này; đây chỉ là fallback khi offline.
const FALLBACK_VOICES = [
  { id: 'vi-VN-HoaiMyNeural', label: 'HoaiMy (Nữ) · vi-VN', gender: 'Nữ', locale: 'vi-VN', color: 'rose' },
  { id: 'vi-VN-NamMinhNeural', label: 'NamMinh (Nam) · vi-VN', gender: 'Nam', locale: 'vi-VN', color: 'blue' },
];

const QUICK_SAMPLES = [
  { label: 'Chào mừng', text: 'Xin chào, tôi là Rexi AI, trợ lý ảo thông minh của bạn.' },
  { label: 'Bản tin', text: 'Hôm nay thời tiết Hà Nội ổn định, nền kinh tế tăng trưởng 6.5% so với quý trước.' },
  { label: 'Giới thiệu', text: 'Dự án Rexi AI đang phát triển rất tốt với hơn 10 tính năng AI tích hợp.' },
  { label: 'Quảng cáo', text: 'Giảm giá sốc 50% tất cả sản phẩm! Chỉ còn 3 ngày, nhanh tay đặt hàng ngay!' },
];

const VOICE_COLORS = {
  rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-300', ring: 'ring-rose-500/40' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-300', ring: 'ring-blue-500/40' },
  cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-300', ring: 'ring-cyan-500/40' },
  violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', text: 'text-violet-300', ring: 'ring-violet-500/40' },
  pink: { bg: 'bg-pink-500/10', border: 'border-pink-500/30', text: 'text-pink-300', ring: 'ring-pink-500/40' },
  teal: { bg: 'bg-teal-500/10', border: 'border-teal-500/30', text: 'text-teal-300', ring: 'ring-teal-500/40' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-300', ring: 'ring-amber-500/40' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300', ring: 'ring-emerald-500/40' },
  indigo: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/30', text: 'text-indigo-300', ring: 'ring-indigo-500/40' },
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-300', ring: 'ring-orange-500/40' },
};

const COLOR_KEYS = Object.keys(VOICE_COLORS);

export default function StudioTab({ API_BASE, authToken, showToast }) {
  const lang = getLang();
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('vi-VN-HoaiMyNeural');
  const [voices, setVoices] = useState(FALLBACK_VOICES);
  const [engine, setEngine] = useState(null);
  const [rate, setRate] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [playing, setPlaying] = useState(false);
  const [history, setHistory] = useState([]);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(null);
  // Engine VieNeu có khả dụng không (server báo qua /tts/voices) → mở UI chọn engine + clone giọng
  const [vieneuAvailable, setVieneuAvailable] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [cloneFile, setCloneFile] = useState(null);
  const [cloneText, setCloneText] = useState('');
  const [cloneRefText, setCloneRefText] = useState('');
  const [cloneLoading, setCloneLoading] = useState(false);
  const [cloneAudioUrl, setCloneAudioUrl] = useState(null);
  // Giọng tùy chỉnh của tôi (lưu mẫu clone để tái dùng + gọi như API)
  const [myVoices, setMyVoices] = useState([]);
  const [voiceName, setVoiceName] = useState('');
  const [savingVoice, setSavingVoice] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [showMine, setShowMine] = useState(false);
  const [apiVoiceId, setApiVoiceId] = useState(null);
  const audioRef = useRef(null);
  const previewAudioRef = useRef(null);
  const textareaRef = useRef(null);
  const cloneFileRef = useRef(null);

  const selectedVoice = voices.find(v => v.id === voice);

  const formatRate = (v) => v >= 0 ? `+${v}%` : `${v}%`;
  const formatPitch = (v) => v >= 0 ? `+${v}Hz` : `${v}Hz`;

  const charCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estimatedSeconds = Math.ceil(wordCount * 0.4);

  // Tải danh sách giọng theo engine ('vieneu' | 'edge-tts' | '' = mặc định server)
  const loadVoices = async (eng) => {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const query = eng ? `?engine=${encodeURIComponent(eng)}` : '';
      const res = await fetch(`${API_BASE}/services/tts/voices${query}`, { headers, credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !Array.isArray(data.voices) || !data.voices.length) return;
      const mapped = data.voices.map((v, i) => ({
        id: v.id,
        label: v.label || v.id,
        gender: v.gender,
        region: v.locale || v.region,
        color: v.color || COLOR_KEYS[i % COLOR_KEYS.length],
      }));
      setVoices(mapped);
      const resolvedEngine = data.engine || eng || null;
      setEngine(resolvedEngine);
      if (resolvedEngine === 'vieneu' && data.voice_clone) setVieneuAvailable(true);
      if (data.default && !mapped.some(v => v.id === voice)) {
        setVoice(data.default);
      } else if (!mapped.some(v => v.id === voice)) {
        setVoice(mapped[0].id);
      }
    } catch (err) {
      console.error('[StudioTab] Không tải được danh sách giọng:', err);
    }
  };

  useEffect(() => {
    loadVoices();
    loadMyVoices();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadMyVoices();
  }, [authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Đổi engine: nạp lại danh sách giọng tương ứng, đóng panel clone khi rời VieNeu
  const changeEngine = (eng) => {
    if (!eng || eng === engine) return;
    if (eng !== 'vieneu') setShowClone(false);
    loadVoices(eng);
  };

  const handlePreviewVoice = async (voiceId) => {
    if (previewingVoice === voiceId) {
      if (previewAudioRef.current) { previewAudioRef.current.pause(); }
      setPreviewingVoice(null);
      return;
    }
    setPreviewingVoice(voiceId);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const res = await fetch(`${API_BASE}/services/tts`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ text: t(getLang(), 'Xin chào, đây là giọng nói mẫu.'), voice: voiceId, rate: '+0%', pitch: '+0Hz', engine }),
      });
      if (res.status === 401) {
        setPreviewingVoice(null);
        showToast(t(getLang(), 'Vui lòng đăng nhập để dùng TTS'), 'error');
        return;
      }
      const data = await res.json();
      if (data.success && data.audio) {
        const fmt = data.format === 'wav' ? 'wav' : 'mp3';
        const url = `data:audio/${fmt};base64,` + data.audio;
        if (previewAudioRef.current) { previewAudioRef.current.pause(); }
        previewAudioRef.current = new Audio(url);
        previewAudioRef.current.onended = () => setPreviewingVoice(null);
        previewAudioRef.current.onerror = () => setPreviewingVoice(null);
        previewAudioRef.current.play();
      } else {
        setPreviewingVoice(null);
        if (data.error) showToast(data.error, 'error');
      }
    } catch (err) {
      console.error('[StudioTab] Nghe thử giọng thất bại:', err);
      showToast?.(t(getLang(), 'Không nghe thử được giọng này'), 'error');
      setPreviewingVoice(null);
    }
  };

  const handleGenerate = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setAudioUrl(null);
    setPlaying(false);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const res = await fetch(`${API_BASE}/services/tts`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({
          text: text.trim(),
          voice,
          rate: formatRate(rate),
          pitch: formatPitch(pitch),
          engine,
        }),
      });
      if (res.status === 401) {
        showToast(t(getLang(), 'Vui lòng đăng nhập để dùng TTS'), 'error');
        return;
      }
      const data = await res.json();
      if (data.success && data.audio) {
        const fmt = data.format === 'wav' ? 'wav' : 'mp3';
        setAudioFormat(fmt);
        const url = `data:audio/${fmt};base64,` + data.audio;
        setAudioUrl(url);
        setHistory(prev => [{
          text: text.trim().substring(0, 60),
          voice: data.voice_label || selectedVoice?.label || voice,
          format: fmt,
          time: new Date().toLocaleTimeString('vi-VN'),
          url
        }, ...prev].slice(0, 10));
        showToast(t(getLang(), 'Tạo audio thành công!'), 'success');
      } else {
        showToast(data.error || t(getLang(), 'TTS không khả dụng'), 'error');
      }
    } catch (err) {
      showToast(t(getLang(), 'Lỗi: ') + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Clone giọng: gửi file mẫu + văn bản tới backend (forward sang VieNeu /v1/clone)
  const handleClone = async () => {
    if (!cloneFile || !cloneText.trim()) return;
    setCloneLoading(true);
    setCloneAudioUrl(null);
    try {
      const form = new FormData();
      form.append('audio', cloneFile);
      form.append('text', cloneText.trim());
      if (cloneRefText.trim()) form.append('ref_text', cloneRefText.trim());
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      // KHÔNG set Content-Type để browser tự thêm boundary multipart
      const res = await fetch(`${API_BASE}/services/tts/clone`, {
        method: 'POST', headers, credentials: 'include', body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showToast?.(t(getLang(), 'Vui lòng đăng nhập để dùng TTS'), 'error');
        return;
      }
      if (!res.ok || !data.success || !data.audio) {
        showToast?.(data.error || t(getLang(), 'Clone giọng thất bại'), 'error');
        return;
      }
      const url = 'data:audio/wav;base64,' + data.audio;
      setCloneAudioUrl(url);
      setHistory(prev => [{
        text: '[Clone] ' + cloneText.trim().substring(0, 50),
        voice: data.voice_label || t(getLang(), 'Giọng đã clone'),
        format: 'wav',
        time: new Date().toLocaleTimeString('vi-VN'),
        url
      }, ...prev].slice(0, 10));
      showToast?.(t(getLang(), 'Clone giọng thành công!'), 'success');
    } catch (err) {
      console.error('[StudioTab] Clone lỗi:', err);
      showToast?.(t(getLang(), 'Lỗi clone: ') + err.message, 'error');
    } finally {
      setCloneLoading(false);
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current) return;
    if (playing) { audioRef.current.pause(); } else { audioRef.current.play(); }
  };

  // ─── Giọng của tôi: lưu mẫu / danh sách / đọc lại / tải mẫu / xóa ───
  const authHeaders = () => {
    const h = {};
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    return h;
  };
  const loadMyVoices = async () => {
    if (!authToken) { setMyVoices([]); return; }
    try {
      const res = await fetch(`${API_BASE}/services/tts/custom-voices`, { headers: authHeaders(), credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (data.success && Array.isArray(data.voices)) setMyVoices(data.voices);
    } catch {}
  };
  const saveMyVoice = async () => {
    if (!cloneFile || !voiceName.trim()) { showToast?.(t(getLang(), 'Nhập tên giọng + chọn file mẫu trước'), 'error'); return; }
    setSavingVoice(true);
    try {
      const form = new FormData();
      form.append('audio', cloneFile);
      form.append('ten', voiceName.trim());
      const res = await fetch(`${API_BASE}/services/tts/custom-voices`, {
        method: 'POST', headers: authHeaders(), credentials: 'include', body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        showToast?.(`${t(getLang(), 'Đã lưu giọng ')}"${voiceName.trim()}"!`, 'success');
        setVoiceName('');
        loadMyVoices();
      } else {
        showToast?.(data.error || t(getLang(), 'Lưu giọng thất bại'), 'error');
      }
    } catch (e) {
      showToast?.(t(getLang(), 'Lỗi lưu: ') + e.message, 'error');
    } finally {
      setSavingVoice(false);
    }
  };
  const speakMyVoice = async (id) => {
    if (!cloneText.trim()) { showToast?.(t(getLang(), 'Nhập câu cần đọc ở ô "Câu cần đọc" trước'), 'error'); return; }
    setSpeakingId(id);
    try {
      const res = await fetch(`${API_BASE}/services/tts/custom-voices/${id}/speak`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include', body: JSON.stringify({ text: cloneText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success && data.audio) {
        setCloneAudioUrl('data:audio/wav;base64,' + data.audio);
        showToast?.(`${t(getLang(), 'Đã đọc bằng giọng ')}"${data.voice_label || ''}"!`, 'success');
      } else {
        showToast?.(data.error || t(getLang(), 'Đọc thất bại'), 'error');
      }
    } catch (e) {
      showToast?.(t(getLang(), 'Lỗi đọc: ') + e.message, 'error');
    } finally {
      setSpeakingId(null);
    }
  };
  const downloadSample = async (v) => {
    try {
      const res = await fetch(`${API_BASE}/services/tts/custom-voices/${v.id}/sample`, { headers: authHeaders(), credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `giong-${(v.ten || v.id).replace(/[^\w\-àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]+/gi, '_')}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      showToast?.(t(getLang(), 'Tải mẫu thất bại: ') + e.message, 'error');
    }
  };
  const deleteMyVoice = async (id) => {
    try {
      await fetch(`${API_BASE}/services/tts/custom-voices/${id}`, { method: 'DELETE', headers: authHeaders(), credentials: 'include' });
      loadMyVoices();
    } catch {}
  };
  const apiSnippet = (id) =>
`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://rexiai.bot.cd'}/api/services/tts/custom-voices/${id}/speak \\
  -H "Authorization: Bearer <APP_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d "{\\"text\\":\\"Xin chào\\"}"`;
  const copyApiSnippet = async (id) => {
    try { await navigator.clipboard.writeText(apiSnippet(id)); showToast?.(t(getLang(), 'Đã copy lệnh API!'), 'success'); }
    catch { showToast?.(t(getLang(), 'Copy thất bại'), 'error'); }
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `rexi_tts_${Date.now()}.${audioFormat}`;
    a.click();
  };

  const playHistoryItem = (item) => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setAudioFormat(item.format || 'mp3');
    setAudioUrl(item.url);
    setPlaying(false);
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.onended = () => setPlaying(false);
      audioRef.current.onplay = () => setPlaying(true);
      audioRef.current.onpause = () => setPlaying(false);
    }
  }, [audioUrl]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleGenerate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [text, voice, rate, pitch]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-main)]">
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Volume2 size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-[var(--text-main)]">TTS Studio</h1>
              <p className="text-[10px] text-slate-500">{t(getLang(), 'Chuyển văn bản thành giọng nói tiếng Việt')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--bg-card)] border border-white/10">
              {[
                ...(vieneuAvailable ? [['vieneu', 'VieNeu', t(getLang(), 'VieNeu v3 Turbo (tự host, có clone giọng)')]] : []),
                ['edge-tts', 'Edge', 'Microsoft Edge TTS'],
                ['ahm', 'ahm', t(lang, 'stAhm')],
              ].map(([eng, lab, tip]) => (
                <button
                  key={eng}
                  onClick={() => changeEngine(eng)}
                  title={tip}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${engine === eng
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'}`}
                >
                  {lab}
                </button>
              ))}
            </div>
            {engine === 'ahm' && (
              <span
                className="px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold"
                title={t(lang, 'stAhmTip')}
              >
                Free
              </span>
            )}
            {history.length > 0 && (
              <button
                onClick={() => setShowVoicePanel(!showVoicePanel)}
                className={`md:hidden px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${showVoicePanel ? 'bg-cyan-500/10 text-cyan-300' : 'bg-[var(--bg-card)] text-slate-400 hover:text-slate-300'}`}
              >
                {t(getLang(), 'Lịch sử')} ({history.length})
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                <Type size={12} className="text-cyan-500" />
                {t(getLang(), 'Nội dung văn bản')}
              </label>
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><Hash size={10} />{charCount}/1000</span>
                <span className="flex items-center gap-1"><Type size={10} />{wordCount} {t(getLang(), 'từ')}</span>
                <span className="flex items-center gap-1"><Clock size={10} />~{estimatedSeconds}s</span>
              </div>
            </div>
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={t(lang, 'phTts')}
                className="w-full h-40 p-4 bg-[#12131a] border border-white/10 rounded-2xl text-sm text-slate-200 placeholder-slate-500 outline-none resize-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/10 transition-all font-sans leading-relaxed"
                maxLength={1000}
              />
            </div>

            <div className="flex gap-2 flex-wrap">
              {QUICK_SAMPLES.map((sample, i) => (
                <button
                  key={i}
                  onClick={() => setText(sample.text)}
                  className="px-3 py-1.5 rounded-full bg-[var(--bg-card)] border border-white/10 text-[11px] text-slate-400 hover:text-cyan-300 hover:border-cyan-500/30 hover:bg-cyan-500/10 transition-all"
                >
                  {lang === 'en' ? stripVi(sample.label) : sample.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
              <Mic size={12} className="text-cyan-500" />
              {t(getLang(), 'Chọn giọng đọc')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {voices.map(v => {
                const vc = VOICE_COLORS[v.color] || VOICE_COLORS.cyan;
                const isSelected = voice === v.id;
                const isPreviewing = previewingVoice === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setVoice(v.id)}
                    className={`relative p-3 rounded-xl text-left transition-all border group ${
                      isSelected
                        ? `${vc.bg} ${vc.border} ring-2 ${vc.ring}`
                        : 'bg-[var(--bg-card)] border-white/10 hover:border-white/20 hover:bg-[var(--bg-card-hover)]'
                    }`}
                  >
                    {isSelected && (
                      <span className={`absolute top-1.5 right-1.5 w-4 h-4 rounded-full ${vc.bg} flex items-center justify-center`}>
                        <span className={`text-[8px] ${vc.text}`}>✓</span>
                      </span>
                    )}
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className={`w-7 h-7 rounded-lg ${vc.bg} flex items-center justify-center`}>
                        <User size={12} className={vc.text} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`text-[11px] font-semibold truncate ${isSelected ? vc.text : 'text-slate-300'}`}>
                          {lang === 'en' ? stripVi(v.label) : v.label}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePreviewVoice(v.id); }}
                        className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                          isPreviewing
                            ? 'bg-red-500/20 text-red-400'
                            : `${vc.bg} ${vc.text} opacity-0 group-hover:opacity-100`
                        }`}
                        title={isPreviewing ? (lang === 'vi' ? 'Dừng' : 'Stop') : t(lang, 'tipTryVoice')}
                      >
                        {isPreviewing ? <Pause size={10} /> : <Play size={10} className="ml-0.5" />}
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {v.gender && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-md ${vc.bg} ${vc.text}`}>
                          {t(getLang(), v.gender) && lang !== 'en' ? t(getLang(), v.gender) : (v.gender === 'Nam' ? 'Male' : v.gender === 'Nữ' ? 'Female' : v.gender)}
                        </span>
                      )}
                      {v.region && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-white/5 text-slate-500 flex items-center gap-0.5">
                          <MapPin size={7} />{v.region}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-500">{t(getLang(), 'Tốc độ')}</label>
                <span className="text-[11px] text-cyan-300 font-mono bg-cyan-500/10 px-2 py-0.5 rounded-md">{formatRate(rate)}</span>
              </div>
              <input type="range" min={-50} max={50} value={rate} onChange={e => setRate(parseInt(e.target.value))}
                className="w-full h-2 bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-500" />
              <div className="flex justify-between text-[9px] text-slate-400">
                <span>{t(getLang(), 'Chậm')}</span><span>{t(getLang(), 'Bình thường')}</span><span>{t(getLang(), 'Nhanh')}</span>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-500">{t(getLang(), 'Cao độ')}</label>
                <span className="text-[11px] text-purple-300 font-mono bg-purple-500/10 px-2 py-0.5 rounded-md">{formatPitch(pitch)}</span>
              </div>
              <input type="range" min={-50} max={50} value={pitch} onChange={e => setPitch(parseInt(e.target.value))}
                className="w-full h-2 bg-white/10 rounded-full appearance-none cursor-pointer accent-purple-500" />
              <div className="flex justify-between text-[9px] text-slate-400">
                <span>{t(getLang(), 'Thấp')}</span><span>{t(getLang(), 'Bình thường')}</span><span>{t(getLang(), 'Cao')}</span>
              </div>
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={loading || !text.trim()}
            className="w-full py-4 rounded-2xl bg-[#4a7dff] hover:bg-[#3d6ae6] text-white font-bold text-sm shadow-lg shadow-[#4a7dff]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2.5 active:scale-[0.98]"
          >
            {loading ? (
              <><Loader2 size={18} className="animate-spin" /> {t(getLang(), 'Đang tạo audio...')}</>
            ) : (
              <><Volume2 size={18} /> {t(getLang(), 'Chuyển Thành Giọng Nói')}</>
            )}
          </button>

          {audioUrl && (
            <div className="p-5 bg-[var(--bg-card)] border border-emerald-500/30 rounded-2xl space-y-3">
              <audio ref={audioRef} src={audioUrl} preload="auto" className="hidden" />
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePlayPause}
                  className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 hover:bg-emerald-500/30 transition-all shrink-0"
                >
                  {playing ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-emerald-400">{t(getLang(), 'Audio đã tạo')}</div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {t(getLang(), selectedVoice?.label)} • {formatRate(rate)} • {formatPitch(pitch)} • {audioFormat.toUpperCase()}
                  </div>
                </div>
                <button
                  onClick={handleDownload}
                  className="px-4 py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center gap-1.5 hover:bg-emerald-500/30 transition-all active:scale-95"
                >
                  <Download size={14} /> {t(getLang(), 'Tải')} {audioFormat.toUpperCase()}
                </button>
              </div>
            </div>
          )}

          {vieneuAvailable && (
            <div className="border border-white/10 rounded-2xl overflow-hidden bg-[var(--bg-card)]">
              <button
                onClick={() => setShowClone(!showClone)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-all"
              >
                <span className="flex items-center gap-2 text-xs font-bold text-[var(--text-main)]">
                  <Sparkles size={14} className="text-fuchsia-400" /> {t(getLang(), 'Clone giọng')}
                </span>
                <span className="text-[10px] text-slate-500">{showClone ? t(getLang(), 'Thu gọn') : t(getLang(), 'Mở')}</span>
              </button>
              {showClone && (
                <div className="px-4 pb-4 pt-3 space-y-3 border-t border-white/10">
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    {t(getLang(), 'Tải file ghi âm mẫu')} <b>{t(getLang(), '3–8 giây')}</b> {t(getLang(), '(.wav/.mp3), nhập câu cần đọc — AI sẽ đọc bằng giọng của bạn.')}
                    {t(getLang(), 'Càng rõ, càng ít tạp âm, clone càng giống.')}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      ref={cloneFileRef}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={e => setCloneFile(e.target.files?.[0] || null)}
                    />
                    <button
                      onClick={() => cloneFileRef.current?.click()}
                      className="px-3 py-2 rounded-xl bg-[var(--bg-main)] border border-white/10 text-[11px] text-slate-300 hover:border-fuchsia-500/40 flex items-center gap-1.5 transition-all"
                    >
                      <Upload size={12} /> {cloneFile ? cloneFile.name.slice(0, 28) : t(getLang(), 'Chọn file mẫu')}
                    </button>
                    {cloneFile && (
                      <button
                        onClick={() => { setCloneFile(null); if (cloneFileRef.current) cloneFileRef.current.value = ''; }}
                        className="text-[10px] text-slate-500 hover:text-rose-300 transition-colors"
                      >
                        {t(getLang(), 'Xóa')}
                      </button>
                    )}
                    {cloneFile && (
                      <span className="text-[10px] text-slate-500">{Math.round(cloneFile.size / 1024)} KB</span>
                    )}
                  </div>
                  <textarea
                    value={cloneText}
                    onChange={e => setCloneText(e.target.value)}
                    placeholder={t(lang, 'phClone')}
                    maxLength={1000}
                    className="w-full h-20 p-3 bg-[#12131a] border border-white/10 rounded-xl text-sm text-slate-200 placeholder-slate-500 outline-none resize-none focus:border-fuchsia-500/50 transition-all"
                  />
                  <input
                    value={cloneRefText}
                    onChange={e => setCloneRefText(e.target.value)}
                    placeholder={t(lang, 'phRefText')}
                    maxLength={500}
                    className="w-full px-3 py-2 bg-[#12131a] border border-white/10 rounded-xl text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-fuchsia-500/50 transition-all"
                  />
                  <button
                    onClick={handleClone}
                    disabled={cloneLoading || !cloneFile || !cloneText.trim()}
                    className="w-full py-3 rounded-xl bg-fuchsia-500/20 border border-fuchsia-500/40 text-fuchsia-300 font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-fuchsia-500/30 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
                  >
                    {cloneLoading ? (
                      <><Loader2 size={14} className="animate-spin" /> {t(getLang(), 'Đang clone...')}</>
                    ) : (
                      <><Sparkles size={14} /> {t(getLang(), 'Clone & Đọc thử')}</>
                    )}
                  </button>
                  {cloneAudioUrl && (
                    <div className="p-3 rounded-xl bg-[var(--bg-main)] border border-fuchsia-500/30 flex items-center gap-3">
                      <audio controls src={cloneAudioUrl} className="flex-1 h-9" />
                      <a
                        href={cloneAudioUrl}
                        download={`rexi_clone_${Date.now()}.wav`}
                        className="px-3 py-2 rounded-lg bg-fuchsia-500/20 border border-fuchsia-500/30 text-fuchsia-300 text-[10px] font-bold flex items-center gap-1 hover:bg-fuchsia-500/30 transition-all"
                      >
                        <Download size={12} /> WAV
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Giọng của tôi — lưu mẫu clone để tái dùng + gọi như API */}
          <div className="border border-white/10 rounded-2xl overflow-hidden bg-[var(--bg-card)]">
            <button
              onClick={() => setShowMine(!showMine)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-all"
            >
              <span className="flex items-center gap-2 text-xs font-bold text-[var(--text-main)]">
                <User size={14} className="text-cyan-400" /> {t(getLang(), 'Giọng của tôi')}
                {myVoices.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 text-[10px]">{myVoices.length}</span>
                )}
              </span>
              <span className="text-[10px] text-slate-500">{showMine ? t(getLang(), 'Thu gọn') : t(getLang(), 'Mở')}</span>
            </button>
            {showMine && (
              <div className="px-4 pb-4 pt-3 space-y-3 border-t border-white/10">
                {!authToken ? (
                  <p className="text-[11px] text-slate-500">{t(getLang(), 'Đăng nhập để lưu giọng riêng và tái dùng qua API.')}</p>
                ) : (
                  <>
                    <p className="text-[10px] text-slate-500 leading-relaxed">
                      {t(getLang(), 'Lưu file mẫu đã clone thành giọng riêng có tên — đọc văn bản mới bất cứ lúc nào')}
                      {t(getLang(), 'mà không cần tải mẫu lại. Mỗi giọng còn có')} <b>{t(getLang(), 'API riêng')}</b> {t(getLang(), 'để gọi từ app khác.')}
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={voiceName}
                        onChange={e => setVoiceName(e.target.value)}
                        placeholder={t(lang, 'phVoiceName')}
                        maxLength={60}
                        className="flex-1 px-3 py-2 bg-[#12131a] border border-white/10 rounded-xl text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500/50 transition-all"
                      />
                      <button
                        onClick={saveMyVoice}
                        disabled={savingVoice || !cloneFile || !voiceName.trim()}
                        className="px-3 py-2 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold disabled:opacity-40 hover:bg-cyan-500/30 transition-all whitespace-nowrap"
                      >
                        {savingVoice ? t(getLang(), 'Đang lưu...') : t(getLang(), 'Lưu giọng này')}
                      </button>
                    </div>
                    {!cloneFile && (
                      <p className="text-[10px] text-slate-600">{t(getLang(), 'Chọn file mẫu ở mục Clone giọng phía trên rồi đặt tên để lưu.')}</p>
                    )}
                    {myVoices.length === 0 ? (
                      <p className="text-[10px] text-slate-600">{t(getLang(), 'Chưa lưu giọng nào.')}</p>
                    ) : (
                      <div className="space-y-2">
                        {myVoices.map(v => (
                          <div key={v.id} className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-white/10">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[11px] font-bold text-slate-200 truncate">{v.ten}</p>
                                <p className="text-[9px] text-slate-500">{v.ngay_tao || ''}{v.dung_luong ? ` · ${Math.round(v.dung_luong / 1024)} KB` : ''}</p>
                              </div>
                              <button
                                onClick={() => speakMyVoice(v.id)}
                                disabled={speakingId === v.id}
                                className="px-2.5 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[10px] font-bold disabled:opacity-50 hover:bg-cyan-500/30 transition-all whitespace-nowrap"
                              >
                                {speakingId === v.id ? t(getLang(), 'Đang đọc...') : t(getLang(), 'Đọc câu trên')}
                              </button>
                            </div>
                            <div className="flex items-center gap-3 mt-1.5">
                              <button onClick={() => downloadSample(v)} className="text-[10px] text-slate-400 hover:text-cyan-300 transition-colors">{t(getLang(), 'Tải mẫu')}</button>
                              <button onClick={() => setApiVoiceId(apiVoiceId === v.id ? null : v.id)} className="text-[10px] text-slate-400 hover:text-cyan-300 transition-colors">API</button>
                              <button onClick={() => deleteMyVoice(v.id)} className="text-[10px] text-slate-500 hover:text-rose-300 transition-colors">{t(getLang(), 'Xóa')}</button>
                            </div>
                            {apiVoiceId === v.id && (
                              <div className="mt-2">
                                <pre className="p-2 rounded-lg bg-black/40 border border-white/10 text-[9px] text-slate-400 font-mono whitespace-pre-wrap break-all">{apiSnippet(v.id)}</pre>
                                <button onClick={() => copyApiSnippet(v.id)} className="mt-1 text-[10px] text-cyan-300 hover:text-cyan-200 transition-colors">{t(getLang(), 'Copy lệnh')}</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`w-64 border-l border-white/10 bg-[var(--bg-card)] flex flex-col ${showVoicePanel ? 'max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:w-72 max-md:bg-[var(--bg-card)]' : 'max-md:hidden'}`}>
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{t(getLang(), 'Lịch sử')}</h3>
          {history.length > 0 && (
            <button
              onClick={() => setHistory([])}
              className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors"
            >
              <RotateCw size={10} /> {t(getLang(), 'Xóa')}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {history.length === 0 ? (
            <div className="text-center py-8">
              <Clock size={24} className="text-slate-500 mx-auto mb-2" />
              <p className="text-[10px] text-slate-500">{t(getLang(), 'Chưa có lịch sử')}</p>
              <p className="text-[9px] text-slate-400 mt-1">{t(getLang(), 'Audio đã tạo sẽ xuất hiện ở đây')}</p>
            </div>
          ) : (
            history.map((h, i) => (
              <button
                key={i}
                onClick={() => playHistoryItem(h)}
                className="w-full p-3 rounded-xl bg-[var(--bg-main)] border border-white/10 hover:border-white/20 hover:bg-[var(--bg-card-hover)] text-left transition-all group"
              >
                <div className="text-[11px] text-slate-400 truncate group-hover:text-[var(--text-main)] transition-colors">{h.text}</div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[9px] text-slate-500">{h.voice}{h.format ? ` • ${h.format.toUpperCase()}` : ''}</span>
                  <span className="text-[9px] text-slate-400">{h.time}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
