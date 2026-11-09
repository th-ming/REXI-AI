import React, { useState, useEffect, useRef } from 'react';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import { Scissors, Loader2, Download, Copy, Sparkles, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { apiFetch } from '../config';

const OPENSHORTS_VIDEO_BASE = 'https://api.openshorts.app';

function fullVideoUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return OPENSHORTS_VIDEO_BASE + (u.startsWith('/') ? u : '/' + u);
}

export default function OpenShortsTab({ authToken, showToast }) {
  const lang = getLang();
  const [url, setUrl] = useState('');
  const [targetClips, setTargetClips] = useState('');
  const [captions, setCaptions] = useState(true);
  const [autoHook, setAutoHook] = useState(true);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState(null);
  const [status, setStatus] = useState('');
  const [logs, setLogs] = useState([]);
  const [clips, setClips] = useState([]);
  const [error, setError] = useState('');
  const [quota, setQuota] = useState(null);
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const timerRef = useRef(null);
  const logsEndRef = useRef(null);

  useEffect(() => {
    loadQuota();
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  async function loadQuota() {
    try {
      const d = await apiFetch('/services/openshorts/quota', authToken);
      if (d.success && d.me && d.me.minutes) setQuota(d.me.minutes);
    } catch { /* quota chỉ là phụ */ }
  }

  function validate(u) {
    if (!u) return tx(lang, 'Dán URL video YouTube trước');
    if (!/^https?:\/\//i.test(u)) return tx(lang, 'URL phải bắt đầu bằng https://');
    return '';
  }

  async function submitJob(body) {
    const d = await apiFetch('/services/openshorts/process', authToken, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    // Video chất lượng thấp → OpenShorts trả về needs_confirmation thay vì job
    if (d.job && d.job.needs_confirmation) {
      setPendingConfirm({ body, qc: d.job.quality_check || {} });
      setLoading(false);
      showToast(tx(lang, 'Video chất lượng thấp — cần xác nhận trước khi cắt'), 'error');
      return;
    }
    if (!d.job || !d.job.job_id) throw new Error(tx(lang, 'Server không trả về job_id'));
    setPendingConfirm(null);
    setJob(d.job);
    setStatus(d.job.status || 'queued');
    showToast(tx(lang, 'Đã gửi job — OpenShorts đang cắt video…'), 'success');
    startPolling(d.job.job_id);
  }

  async function startJob(e) {
    e?.preventDefault();
    const vErr = validate(url.trim());
    if (vErr) { showToast(vErr, 'error'); return; }
    clearInterval(timerRef.current);
    setLoading(true); setError(''); setClips([]); setLogs([]); setStatus('queued'); setJob(null); setPendingConfirm(null);
    try {
      const body = { url: url.trim(), captions: captions ? 'true' : 'false', auto_hook: autoHook ? 'true' : 'false' };
      if (targetClips) body.target_clips = String(targetClips);
      await submitJob(body);
    } catch (e2) {
      setError(e2.message);
      showToast(e2.message, 'error');
      setLoading(false);
    }
  }

  async function confirmLowQuality() {
    if (!pendingConfirm) return;
    setLoading(true); setError('');
    try {
      await submitJob({ ...pendingConfirm.body, force_low_quality: 'true' });
    } catch (e2) {
      setError(e2.message);
      showToast(e2.message, 'error');
      setLoading(false);
    }
  }

  function startPolling(jobId) {
    clearInterval(timerRef.current);
    let ticks = 0;
    timerRef.current = setInterval(async () => {
      ticks += 1;
      if (ticks > 120) {
        clearInterval(timerRef.current);
        setLoading(false);
        setError(tx(lang, 'Hết thời gian chờ (16 phút). Job có thể vẫn chạy — thử lại sau ít phút.'));
        return;
      }
      try {
        const d = await apiFetch('/services/openshorts/status/' + jobId, authToken);
        if (d.error) { throw new Error(d.error); }
        setStatus(d.status || '');
        if (Array.isArray(d.logs)) setLogs(d.logs);
        const terminalDone = ['completed', 'done', 'success'].includes(d.status);
        const terminalFail = ['failed', 'error', 'cancelled'].includes(d.status);
        if (terminalDone) {
          clearInterval(timerRef.current);
          setLoading(false);
          const cs = (d.result && d.result.clips) || [];
          setClips(cs);
          showToast((getLang() === 'en' ? 'Cut ' + cs.length + ' clips!' : 'Cắt xong ' + cs.length + ' clip!'), 'success');
          loadQuota();
        } else if (terminalFail) {
          clearInterval(timerRef.current);
          setLoading(false);
          const last = (d.logs && d.logs[d.logs.length - 1]) || tx(lang, 'Job thất bại');
          setError(last);
        }
      } catch { /* bỏ qua lỗi mạng giữa 2 lần poll */ }
    }, 8000);
  }

  function copyText(text, label) {
    navigator.clipboard.writeText(text).then(
      () => showToast((getLang() === 'en' ? 'Copied ' + (label || 'text') : 'Đã copy ' + (label || 'văn bản')), 'success'),
      () => showToast(tx(lang, 'Copy thất bại'), 'error')
    );
  }

  const statusLabel = {
    queued: tx(lang, '⏸ Đang xếp hàng…'),
    processing: tx(lang, '🎬 Đang xử lý…'),
    completed: tx(lang, '✅ Hoàn tất'),
    failed: tx(lang, '❌ Thất bại'),
    error: tx(lang, '❌ Lỗi'),
    cancelled: tx(lang, '⛔ Đã hủy')
  }[status] || (status ? '• ' + status : '');

  return (
    <div className="flex flex-col h-full w-full bg-[var(--bg-main)] overflow-y-auto">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-card)] border-b border-white/10 shrink-0 sticky top-0 z-10">
        <span className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center shrink-0">
          <Scissors size={14} className="text-white" />
        </span>
        <span className="text-xs font-bold text-[var(--text-main)] whitespace-nowrap">OpenShorts</span>
        <span className="text-[10px] text-slate-500 whitespace-nowrap hidden sm:inline">{tx(lang, 'Video dài → Shorts 9:16 tự động')}</span>
        <div className="flex-1" />
        {quota && (
          <span className="text-[10px] font-semibold px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-slate-300 whitespace-nowrap" title={t(lang, 'tipQuota')}>
            <Clock size={11} className="inline mr-1 -mt-0.5" />
            {quota.remaining}/{quota.plan_allowance} {tx(lang, 'phút')}
          </span>
        )}
      </div>

      <div className="p-3 md:p-4 max-w-4xl w-full mx-auto flex flex-col gap-3">
        {/* Form */}
        <form onSubmit={startJob} className="bg-[var(--bg-card)] border border-white/10 rounded-xl p-3 md:p-4 flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t(lang, 'phShortsUrl')}
              className="flex-1 min-w-0 bg-[var(--bg-main)] border border-white/10 rounded-lg px-3 py-2 text-xs text-[var(--text-main)] placeholder-slate-500 outline-none focus:border-fuchsia-500/40 font-mono"
            />
            <button
              type="submit"
              disabled={loading}
              className="shrink-0 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {loading ? tx(lang, 'Đang cắt…') : tx(lang, 'Tạo Shorts')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-slate-500">{tx(lang, 'Số clip:')}</span>
              <input
                type="number"
                min="1"
                max="15"
                value={targetClips}
                onChange={(e) => setTargetClips(e.target.value)}
                placeholder="auto"
                className="w-16 bg-[var(--bg-main)] border border-white/10 rounded-lg px-2 py-1 text-xs text-[var(--text-main)] placeholder-slate-600 outline-none focus:border-fuchsia-500/40"
              />
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="accent-fuchsia-500" />
              {tx(lang, 'Phụ đề (burn-in)')}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={autoHook} onChange={(e) => setAutoHook(e.target.checked)} className="accent-fuchsia-500" />
              {tx(lang, 'Hook tự động')}
            </label>
          </div>
          <p className="text-[10px] text-slate-500">
            {tx(lang, 'Nguồn: OpenShorts hosted (GPU ~50s/video) · Quota free 20 phút/tháng · 1 job ≓ thời lượng video gốc.')}
          </p>
        </form>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Xác nhận video chất lượng thấp */}
        {pendingConfirm && !loading && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 md:p-4 flex flex-col gap-2">
            <div className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>
                {tx(lang, 'Video này chỉ có chất lượng thấp nhất')} {pendingConfirm.qc.max_height || '?'}p
                {pendingConfirm.qc.min_height ? (getLang() === 'en' ? ' (minimum required ' + pendingConfirm.qc.min_height + 'p)' : ' (yêu cầu tối thiểu ' + pendingConfirm.qc.min_height + 'p)') : ''}.
                {tx(lang, 'Vẫn cắt thì clip đầu ra sẽ mờ — bạn có muốn tiếp tục không?')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={confirmLowQuality}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--accent)] hover:brightness-110 transition-colors"
              >
                {tx(lang, 'Vẫn cắt (chất lượng thấp)')}
              </button>
              <button
                onClick={() => setPendingConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-300 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
              >
                {tx(lang, 'Hủy')}
              </button>
            </div>
          </div>
        )}

        {/* Progress + logs */}
        {job && (
          <div className="bg-[var(--bg-card)] border border-white/10 rounded-xl p-3 md:p-4">
            <div className="flex items-center gap-2 mb-2">
              {loading && <Loader2 size={14} className="text-fuchsia-400 animate-spin shrink-0" />}
              {!loading && status === 'completed' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
              <span className="text-xs font-semibold text-[var(--text-main)]">{statusLabel}</span>
              <span className="text-[10px] text-slate-500 font-mono ml-auto">#{String(job.job_id || '').substring(0, 8)}</span>
            </div>
            {logs.length > 0 && (
              <div className="max-h-40 overflow-y-auto bg-[var(--bg-main)] border border-white/10 rounded-lg p-2 flex flex-col gap-0.5">
                {logs.map((l, i) => (
                  <span key={i} className="text-[11px] text-slate-400 font-mono leading-relaxed">{l}</span>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        )}

        {/* Kết quả */}
        {clips.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-bold text-[var(--text-main)] flex items-center gap-2">
              <Scissors size={13} className="text-fuchsia-400" />
              {clips.length} {tx(lang, 'clip đã cắt')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {clips.map((c, i) => (
                <div key={i} className="bg-[var(--bg-card)] border border-white/10 rounded-xl overflow-hidden flex flex-col">
                  <video
                    src={fullVideoUrl(c.video_url)}
                    controls
                    preload="metadata"
                    className="w-full aspect-[9/16] max-h-72 bg-black object-contain"
                  />
                  <div className="p-2.5 flex flex-col gap-1.5 flex-1">
                    <div className="flex items-start gap-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 shrink-0" title={t(lang, 'tipViral')}>
                        {c.predicted_score ?? '?'}/10
                      </span>
                      <span className="text-xs font-semibold text-[var(--text-main)] leading-snug">{c.video_title_for_youtube_short}</span>
                    </div>
                    {c.viral_hook_text && (
                      <p className="text-[11px] text-slate-400 italic line-clamp-2">"{c.viral_hook_text}"</p>
                    )}
                    <p className="text-[10px] text-slate-500">{(c.start != null && c.end != null) ? Math.max(1, Math.round(c.end - c.start)) + 's · ' : ''}{(c.video_description_for_tiktok || '').substring(0, 80)}…</p>
                    <div className="flex items-center gap-1.5 mt-auto pt-1">
                      <a
                        href={fullVideoUrl(c.video_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-200 hover:bg-white/10 transition-colors"
                      >
                        <Download size={12} /> {tx(lang, 'Tải MP4')}
                      </a>
                      <button
                        onClick={() => copyText(c.video_title_for_youtube_short + '\n\n' + c.video_description_for_tiktok, 'caption TikTok')}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-slate-200 transition-colors"
                        title="Copy caption TikTok"
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Trạng thái rỗng */}
        {!job && !loading && clips.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--accent)] flex items-center justify-center">
              <Scissors size={22} className="text-white" />
            </div>
            <p className="text-xs text-slate-500 max-w-sm">
              {tx(lang, 'Dán URL video YouTube (podcast, livestream, phỏng vấn…) → OpenShorts tự tìm khoảnh khắc viral, cắt clip 9:16, thêm phụ đề và hook.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
