import React, { useState } from 'react';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import { Sparkles, Loader2, Download, Copy, Check, Trash2, Shuffle, History, X } from 'lucide-react';

// Gợi ý prompt mẫu — bấm 1 phát điền
const PROMPT_IDEAS = [
  'Phong cảnh núi rừng lúc hoàng hôn, màu cam tím, digital art',
  'Mèo dễ thương đội mũ chef đang nấu ăn trong bếp, anime',
  'Thành phố tương lai về đêm, ánh neon, phong cách cyberpunk',
  'Chú corgi mặc vest CEO ngồi bàn làm việc, pixel art',
  'Bát phở bò bốc khói, ảnh ấm thực chuyên nghiệp',
  'Phi hành gia ngắm bầu trời sao ngoài tàu vũ trụ, concept art',
];

const SIZES = [
  { v: '1024x1024', label: '1:1 Vuông' },
  { v: '512x512', label: '1:1 Nhỏ' },
  { v: '1024x768', label: '4:3 Ngang' },
  { v: '768x1024', label: '3:4 Dọc' },
  { v: '1280x720', label: '16:9 Rộng' },
  { v: '720x1280', label: '9:16 Reels' },
];

export default function ImageGenTab({ API_BASE, authToken, showToast, imageModels = [] }) {
  const lang = getLang();
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState('');
  const [imageMeta, setImageMeta] = useState(null); // {prompt, modelLabel}
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [picked, setPicked] = useState(''); // ''=Gemini builtin, else 'provider||model'
  const [size, setSize] = useState('1024x1024');
  const [history, setHistory] = useState([]); // [{image, prompt, modelLabel}] — phiên này

  const genFetch = async (p) => {
    if (p) {
      const [provider, model] = p.split('||');
      const res = await fetch(`${API_BASE}/media/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ prompt: prompt.trim(), provider, model, size })
      });
      const data = await res.json();
      const first = data.images && data.images[0];
      if (data.success && first) return { image: first.url || first.b64, modelLabel: `${provider.toUpperCase()} · ${model}` };
      throw new Error(data.error || tx(lang, 'Tạo ảnh thất bại — provider này có thể không nhận model đã chọn.'));
    }
    const res = await fetch(`${API_BASE}/services/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ prompt: prompt.trim(), size })
    });
    const data = await res.json();
    if (data.success && data.image) return { image: data.image, modelLabel: 'Gemini (builtin)' };
    throw new Error(data.error || tx(lang, 'Tạo ảnh thất bại.'));
  };

  const generate = async () => {
    if (!prompt.trim()) { setError(tx(lang, 'Vui lòng nhập mô tả ảnh cần tạo.')); return; }
    setLoading(true); setError(''); setImage('');
    try {
      const r = await genFetch(picked);
      setImage(r.image);
      setImageMeta({ prompt: prompt.trim(), modelLabel: r.modelLabel });
      setHistory((h) => [{ image: r.image, prompt: prompt.trim(), modelLabel: r.modelLabel }, ...h].slice(0, 12));
      showToast?.(tx(lang, '✅ Tạo ảnh thành công!'), 'success');
    } catch (e) {
      setError(tx(lang, 'Lỗi tạo ảnh: ') + (e.message || tx(lang, 'kết nối thất bại')));
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = image;
    a.download = 'rexi_image_' + Date.now() + '.png';
    a.click();
  };

  const copyImage = async () => {
    if (!image) return;
    try {
      const blob = await (await fetch(image)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // Fallback: copy base64
      try { await navigator.clipboard.writeText(image); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e2) {}
    }
  };

  const clear = () => { setImage(''); setImageMeta(null); setError(''); setPrompt(''); };

  return (
    <div className="h-full flex flex-col p-4 space-y-4 overflow-y-auto">
      <div className="flex items-center gap-2">
        <Sparkles size={18} className="text-indigo-400" />
        <h2 className="text-lg font-bold text-slate-100">{tx(lang, 'Tạo Ảnh AI')}</h2>
        <span className="text-[10px] text-slate-500">{tx(lang, 'Mặc định Gemini free — hoặc chọn model ảnh từ các router (UnoRouter SD checkpoints, v.v...)')}</span>
      </div>

      <div className="bg-[#1e1f20] border border-white/10 rounded-2xl p-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          placeholder={t(lang, 'phImgPrompt')}
          className="w-full min-h-[90px] bg-[#131416] border border-white/10 rounded-xl p-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 resize-none"
        />
        {/* Chips gợi ý — bấm điền nhanh */}
        <div className="flex flex-wrap gap-1.5">
          {PROMPT_IDEAS.map((idea, i) => (
            <button key={i} type="button" onClick={() => setPrompt(tx(lang, idea))}
              className="px-2.5 py-1 rounded-full bg-[#26282b] hover:bg-[#31343a] border border-white/10 text-[10px] text-slate-300 hover:text-white transition-all text-left max-w-full truncate">
              💡 {(tx(lang, idea).length > 42 ? tx(lang, idea).slice(0, 42) + '…' : tx(lang, idea))}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="bg-[#131416] border border-white/10 rounded-xl px-2.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500/50 max-w-[280px]"
            title={t(lang, 'tipImgModel')}
          >
            <option value="">🖼️ Gemini (builtin — nhanh, free)</option>
            {imageModels.map(m => (
              <option key={`${m.provider}|${m.id}`} value={`${m.provider}||${m.id}`}>
                {m.provider.toUpperCase()} — {m.name || m.id}{m.status === 'needs_balance' || m.type === 'paid' ? ' 🔒' : ''}
              </option>
            ))}
          </select>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className="bg-[#131416] border border-white/10 rounded-xl px-2.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500/50"
          >
            {SIZES.map(s => <option key={s.v} value={s.v}>{tx(lang, s.label)} · {s.v}</option>)}
          </select>
          {imageModels.length === 0 && <span className="text-[10px] text-slate-500">{tx(lang, 'Chưa quét được model ảnh nào — chọn thêm sau lượt quét')}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={generate}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-50 transition-all"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {loading ? tx(lang, 'Đang tạo ảnh...') : tx(lang, 'Tạo ảnh')}
          </button>
          {prompt.trim() && !loading && (
            <button onClick={generate} title={t(lang, 'tipRegen')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#26282b] hover:bg-[#2f3236] text-slate-200 text-xs border border-white/10 transition-all">
              <Shuffle size={14} /> {tx(lang, 'Biến thể')}
            </button>
          )}
          {image && (
            <>
              <button onClick={download} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#26282b] hover:bg-[#2f3236] text-slate-200 text-xs border border-white/10 transition-all">
                <Download size={14} /> {tx(lang, 'Tải ảnh')}
              </button>
              <button onClick={copyImage} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#26282b] hover:bg-[#2f3236] text-slate-200 text-xs border border-white/10 transition-all">
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />} {copied ? tx(lang, 'Đã copy') : 'Copy'}
              </button>
              <button onClick={clear} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#26282b] hover:bg-[#2f3236] text-slate-400 text-xs border border-white/10 transition-all">
                <Trash2 size={14} /> {tx(lang, 'Xóa')}
              </button>
            </>
          )}
        </div>
        <p className="text-[10px] text-slate-500">{tx(lang, '💡 Lưu ý: ảnh tạo từ Gemini free tier, nếu gặp lỗi "hết quota" thì đợi vài phút thử lại. Nút "Biến thể" tạo lại ảnh khác từ cùng mô tả.')}</p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-10 text-slate-400 space-y-3">
          <div className="relative w-40 h-40 rounded-2xl bg-[#131416] border border-white/10 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-pulse" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={28} className="animate-spin text-indigo-400" />
            </div>
          </div>
          <p className="text-xs">{tx(lang, 'Đang vẽ... thường mất 10-20 giây')}</p>
        </div>
      )}

      {image && !loading && (
        <div className="flex flex-col items-center space-y-3">
          <div className="relative flex justify-center">
            <img src={image} alt={tx(lang, 'Kết quả tạo ảnh')} className="max-w-full max-h-[55vh] rounded-2xl border border-white/10 shadow-2xl" />
          </div>
          {imageMeta?.modelLabel && (
            <div className="flex items-center gap-2 text-[10px] text-slate-500">
              <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-indigo-300">{imageMeta.modelLabel}</span>
              {imageMeta.prompt && <span className="max-w-md truncate">{imageMeta.prompt}</span>}
            </div>
          )}
        </div>
      )}

      {/* Lịch sử ảnh phiên này — bấm xem lại, nút xóa khỏi lịch sử */}
      {history.length > 1 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <History size={13} /> {tx(lang, 'Ảnh đã tạo trong phiên')} ({history.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {history.map((h, i) => (
              <div key={i} className="relative group">
                <button onClick={() => { setImage(h.image); setImageMeta({ prompt: h.prompt, modelLabel: h.modelLabel }); setError(''); }}
                  className={`block w-20 h-20 rounded-xl overflow-hidden border transition-all ${image === h.image ? 'border-indigo-400 ring-2 ring-indigo-500/30' : 'border-white/10 hover:border-white/30'}`}>
                  <img src={h.image} alt={h.prompt} className="w-full h-full object-cover" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); setHistory((arr) => arr.filter((_, j) => j !== i)); }}
                  title={t(lang, 'tipDelImg')}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#26282b] border border-white/10 text-slate-400 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!image && !loading && !error && (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-500 space-y-2 py-10">
          <div className="text-5xl mb-2">🖼️</div>
          <p className="text-sm">{tx(lang, 'Mô tả bằng chữ ở trên, bấm')} <b>{tx(lang, 'Tạo ảnh')}</b> {tx(lang, 'là có ảnh AI ngay.')}</p>
          <p className="text-[10px] max-w-md">{tx(lang, 'Bấm chip gợi ý 💡 để điền nhanh, chọn tỉ lệ ảnh ở dropdown, dùng "Biến thể" để tạo thêm ảnh khác từ cùng mô tả.')}</p>
        </div>
      )}
    </div>
  );
}
