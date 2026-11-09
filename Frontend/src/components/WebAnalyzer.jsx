import { apiFetch } from "../config";
import React, { useState } from 'react';
import { Globe, Search, Loader2, CheckCircle, AlertTriangle, Clock, Image, Link, FileText, BarChart3 } from 'lucide-react';
import { tx } from "../i18n-sweep";
import { getLang } from "../i18n";


export default function WebAnalyzer({ apiFetch: apiFetchProp, showToast }) {
  const [url, setUrl] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);

  const handleAnalyze = async () => {
    if (!url.trim()) return showToast(tx(getLang(), 'Nhập URL cần phân tích!'), 'error');
    let finalUrl = url.trim();
    if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;
    setAnalyzing(true);
    setResult(null);
    try {
      const fetchFn = apiFetchProp || apiFetch;
      const data = await fetchFn('/agent/web-analyze', {
        method: 'POST',
        body: JSON.stringify({ url: finalUrl })
      });
      if (data.success && data.result) {
        setResult(data.result);
        if (data.result.error) showToast(data.result.error, 'error');
        else showToast(tx(getLang(), 'Phân tích xong!'), 'success');
      } else {
        showToast(data.error || tx(getLang(), 'Lỗi phân tích'), 'error');
      }
    } catch (e) {
      showToast(tx(getLang(), 'Lỗi kết nối: ') + e.message, 'error');
    } finally { setAnalyzing(false); }
  };

  const ScoreBadge = ({ label, value, color }) => (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${
      color === 'green' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
      color === 'yellow' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' :
      'bg-rose-500/10 border-rose-500/30 text-rose-300'
    }`}>
      {color === 'green' ? <CheckCircle size={14} /> : color === 'yellow' ? <Clock size={14} /> : <AlertTriangle size={14} />}
      <span className="text-xs font-medium">{label}: <b>{value}</b></span>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-white/5 bg-[var(--bg-sidebar)]">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Globe size={18} className="text-cyan-400" /> {tx(getLang(), 'Agent Phân Tích Web')}
        </h2>
        <p className="text-[11px] text-slate-400 mt-1">{tx(getLang(), 'Nhập URL, agent tự vào đọc, chụp screenshot, đánh giá SEO & design')}</p>
      </div>

      {/* Input */}
      <div className="p-4 border-b border-white/5">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text" value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
              placeholder="https://example.com"
              className="w-full pl-9 pr-3 py-2.5 bg-[#0d0e11] border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500/50 font-mono"
            />
          </div>
          <button onClick={handleAnalyze} disabled={analyzing}
            className="px-5 py-2.5 bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors">
            {analyzing ? <><Loader2 size={16} className="animate-spin" /> {tx(getLang(), 'Đang phân tích...')}</> : <><Search size={16} /> {tx(getLang(), 'Phân Tích')}</>}
          </button>
        </div>
      </div>

      {/* Results */}
      {result && !result.error && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Screenshot */}
          {result.screenshot && (
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <img src={result.screenshot} alt="Screenshot" className="w-full object-cover max-h-64" />
            </div>
          )}

          {/* Title & Meta */}
          <div className="bg-[#181920] rounded-xl border border-white/5 p-4 space-y-2">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <FileText size={14} className="text-cyan-400" /> {result.title || tx(getLang(), '(Không có title)')}
            </h3>
            <p className="text-xs text-slate-400 line-clamp-2">{result.metaDesc}</p>
            {result.metaKeywords !== '(không có)' && (
              <p className="text-[11px] text-slate-500">Keywords: {result.metaKeywords}</p>
            )}
          </div>

          {/* Scores */}
          <div className="grid grid-cols-3 gap-2">
            <ScoreBadge label="SEO" value={result.score?.seo ? tx(getLang(), result.score.seo) : ''} color={result.score?.seo === 'Tốt' ? 'green' : 'yellow'} />
            <ScoreBadge label={tx(getLang(), 'Tốc độ')} value={result.score?.speed ? tx(getLang(), result.score.speed) : ''} color={result.score?.speed === 'Nhanh' ? 'green' : result.score?.speed === 'Trung bình' ? 'yellow' : 'red'} />
            <ScoreBadge label="Accessibility" value={result.score?.accessibility ? tx(getLang(), result.score.accessibility) : ''} color={result.score?.accessibility === 'Tốt' ? 'green' : 'red'} />
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1"><Clock size={12} /> Load Time</div>
              <div className="text-lg font-bold text-white">{result.loadTime}ms</div>
            </div>
            <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1"><BarChart3 size={12} /> HTML Size</div>
              <div className="text-lg font-bold text-white">{(result.htmlSize / 1024).toFixed(1)}KB</div>
            </div>
            <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1"><Link size={12} /> Links</div>
              <div className="text-lg font-bold text-white">{result.links}</div>
            </div>
            <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1"><Image size={12} /> Images</div>
              <div className="text-lg font-bold text-white">{result.totalImages} {result.imgNoAlt > 0 && <span className="text-xs text-rose-400">({result.imgNoAlt} {tx(getLang(), 'thiếu alt')})</span>}</div>
            </div>
          </div>

          {/* Headings */}
          <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
            <div className="text-xs text-slate-400 mb-1">Headings</div>
            <div className="flex gap-3 text-sm">
              <span className="text-white">H1: <b>{result.h1Count}</b></span>
              <span className="text-white">H2: <b>{result.h2Count}</b></span>
            </div>
          </div>

          {/* Body Text Preview */}
          {result.bodyText && (
            <div className="bg-[#181920] rounded-xl border border-white/5 p-3">
              <div className="text-xs text-slate-400 mb-2">{tx(getLang(), 'Nội dung trang (preview)')}</div>
              <p className="text-xs text-slate-300 line-clamp-6 whitespace-pre-wrap">{result.bodyText}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
