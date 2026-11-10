import { apiFetch, API_BASE } from '../config';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, X, RefreshCw, Search, Loader2, Zap, Bot } from 'lucide-react';

// Đuôi header multipart: "Content-Type: image/jpeg\r\n\r\n"
const HEAD_END = new TextEncoder().encode('\r\n\r\n');

// Tìm chuỗi byte needle trong Uint8Array, từ vị trí `from`.
function findBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}


export default function BrowserView({ onClose }) {
  const lang = getLang();
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const framesAbortRef = useRef(null);
  const intentionalCloseRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('https://www.google.com');
  const [status, setStatus] = useState('disconnected');
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(Date.now());
  const [fps, setFps] = useState(0);
  const [steps, setSteps] = useState([]);
  const [taskGoal, setTaskGoal] = useState('');
  const [taskRunning, setTaskRunning] = useState(false);
  const [taskInfo, setTaskInfo] = useState(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [streamRes, setStreamRes] = useState({ w: 640, h: 360 });
  // Viewport thật của trang (CSS px) — server có thể đổi để giảm tải raster.
  const [viewport, setViewport] = useState({ w: 640, h: 360 });
  const stepsEndRef = useRef(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - lastFrameTimeRef.current) / 1000;
      setFps(Math.round(frameCountRef.current / elapsed));
      frameCountRef.current = 0;
      lastFrameTimeRef.current = now;
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Kênh frame BINARY (multipart/x-mixed-replace) — nhanh hơn SSE base64 ~4×.
  // Đọc chunk, tách theo boundary, decode JPEG → draw vào canvas.
  const connectFrames = () => {
    const token = localStorage.getItem('rexi_token') || '';
    if (framesAbortRef.current) { try { framesAbortRef.current.abort(); } catch (e) {} }
    const ac = new AbortController();
    framesAbortRef.current = ac;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/services/browser/stream-frames?token=${encodeURIComponent(token)}`, {
          signal: ac.signal, headers: { Accept: 'multipart/x-mixed-replace' },
        });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        const reader = resp.body.getReader();
        let buf = new Uint8Array(0);
        const MARK = new TextEncoder().encode('--frame');
        const SOI = new Uint8Array([0xff, 0xd8]); // JPEG start-of-image
        const EOI = new Uint8Array([0xff, 0xd9]); // JPEG end-of-image
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf, 0); merged.set(value, buf.length);
          buf = merged;
          for (;;) {
            // Tìm JPEG trong chunk: SOI ... EOI (đáng tin cậy hơn đoán độ dài).
            const s = findBytes(buf, SOI);
            if (s < 0) break;
            const e = findBytes(buf, EOI, s + 2);
            if (e < 0) break; // chưa đủ frame — chờ chunk sau
            const jpeg = buf.slice(s, e + 2);
            // Cắt phần đã xử lý (nhưng giữ lại boundary "--frame" nếu có ngay trước)
            const nextMark = findBytes(buf, MARK, e + 2);
            buf = nextMark >= 0 ? buf.slice(nextMark) : buf.slice(e + 2);
            if (jpeg.length > 100) {
              const blob = new Blob([jpeg], { type: 'image/jpeg' });
              const bmp = await createImageBitmap(blob);
              const cv = canvasRef.current;
              if (cv) {
                if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
                cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
                bmp.close?.();
                frameCountRef.current++;
              }
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[frames] stream ended:', e.message);
      }
    })();
  };

  const connectWS = () => {
    // 4/10: ĐỔI WS → SSE — Render proxy chèn WS compression (RSV1/fragmentation) làm
    // connection chết 1006 ngầm (server clients 0, không frame). SSE là HTTP thường,
    // qua Render + Cloudflare OK; EventSource tự reconnect.
    // P0-03: yêu cầu JWT — EventSource không gửi được header → token qua query.
    const token = localStorage.getItem('rexi_token') || '';
    intentionalCloseRef.current = false;
    if (wsRef.current) { try { wsRef.current.close(); } catch (e) { console.warn('[rexi] sse close failed', e); } }
    const es = new EventSource(`${API_BASE}/services/browser/stream-sse?token=${encodeURIComponent(token)}`);
    wsRef.current = es;

    es.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setStatus('connected');
      // Kênh frame binary có thể đã chết (mất mạng) → mở lại.
      if (!framesAbortRef.current) connectFrames();
    };

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Frame ảnh đi qua kênh BINARY (stream-frames) — SSE chỉ mang event.
        if (msg.type === 'hello' && msg.opts) {
          // Server có thể đổi kích thước stream → cập nhật nhãn cho đúng.
          setStreamRes({ w: Number(msg.opts.maxWidth) || 640, h: Number(msg.opts.maxHeight) || 360 });
          // Viewport thật của trang (CSS px) — dùng để ánh xạ toạ độ click.
          setViewport({
            w: Number(msg.opts.viewportWidth) || 640,
            h: Number(msg.opts.viewportHeight) || 360,
          });
        }
        if (msg.type === 'auth_failed') {
          setStatus('error');
          console.error('[SSE] auth_failed:', msg.msg);
        }
        // ---- Task runner: theo dõi từng bước ----
        if (msg.type === 'task_start') {
          setSteps([]);
          setTaskRunning(true);
          setTaskInfo({ goal: msg.goal, status: 'running', steps: 0 });
        }
        if (msg.type === 'step') {
          setSteps((prev) => [...prev.slice(-199), {
            n: msg.n, thought: msg.thought, action: msg.action,
            ok: msg.ok !== false, message: msg.message, error: msg.error, ts: msg.ts,
          }]);
          setTaskInfo((prev) => (prev ? { ...prev, steps: (prev.steps || 0) + 1 } : prev));
          setTimeout(() => stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        }
        if (msg.type === 'task_done') {
          setTaskRunning(false);
          setTaskInfo((prev) => ({ ...(prev || {}), status: 'done', ok: msg.ok, summary: msg.summary, steps: msg.steps }));
        }
        if (msg.type === 'task_stopped' || msg.type === 'task_error') {
          setTaskRunning(false);
          setTaskInfo((prev) => ({ ...(prev || {}), status: msg.type === 'task_error' ? 'error' : 'stopped', error: msg.error || msg.reason }));
        }
      } catch {
      }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource tự reconnect; hiển thị trạng thái cho người dùng
      if (!intentionalCloseRef.current && reconnectAttemptsRef.current < 5) {
        reconnectAttemptsRef.current += 1;
        setStatus('connecting');
      } else {
        setStatus('disconnected');
        try { es.close(); } catch (e) { console.warn('[rexi] sse close failed', e); }
      }
    };
  };

  const disconnectWS = () => {
    intentionalCloseRef.current = true;
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) { console.warn('[rexi] ws close failed', e); }
      wsRef.current = null;
    }
    if (framesAbortRef.current) {
      try { framesAbortRef.current.abort(); } catch (e) {}
      framesAbortRef.current = null;
    }
    setConnected(false);
    setStatus('disconnected');
  };

  const launchBrowser = async (initialUrl) => {
    setLoading(true);
    setStatus('launching');
    try {
      await apiFetch('/services/browser/launch', {
        method: 'POST',
        body: JSON.stringify({ url: initialUrl }),
      });
      connectWS();
      connectFrames();
      setStatus('connected');
    } catch (e) {
      setStatus('error');
      console.error('Launch error:', e);
    } finally {
      setLoading(false);
    }
  };

  const navigate = async () => {
    if (!url.trim()) return;
    if (!connected) {
      await launchBrowser(url.trim());
      return;
    }
    setStatus('navigating');
    try {
      await apiFetch('/services/browser/navigate', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      });
      setStatus('connected');
    } catch (e) {
      setStatus('error');
      console.error('Navigate error:', e);
    }
  };

  const closeBrowser = async () => {
    try {
      await apiFetch('/services/browser/close', { method: 'POST' });
    } catch (e) {
      console.error('Close error:', e);
    }
    disconnectWS();
    setStatus('disconnected');
  };

  // Canvas dùng objectFit:'contain' → nội dung 16:9 có thể bị letterbox trong khung.
  // Phải ánh xạ toạ độ chuột theo vùng nội dung THẬT, không theo cả khung.
  // Bitmap canvas = kích thước ảnh stream (maxWidth×maxHeight, cùng tỉ lệ với viewport CSS).
  const canvasToPage = (e) => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const rect = cv.getBoundingClientRect();
    const imgW = cv.width || 1280, imgH = cv.height || 720;
    const VW = viewport.w, VH = viewport.h;
    // 1) scale bitmap -> khung chứa (objectFit: contain)
    const scale = Math.min(rect.width / imgW, rect.height / imgH);
    const drawW = imgW * scale, drawH = imgH * scale;
    const offX = (rect.width - drawW) / 2;
    const offY = (rect.height - drawH) / 2;
    // 2) toạ độ trong bitmap
    const bx = (e.clientX - rect.left - offX) / scale;
    const by = (e.clientY - rect.top - offY) / scale;
    if (bx < 0 || by < 0 || bx > imgW || by > imgH) return null; // bấm ra vùng đen
    // 3) bitmap -> toạ độ trang (CSS px của viewport)
    return {
      x: Math.round((bx / imgW) * VW),
      y: Math.round((by / imgH) * VH),
    };
  };

  const handleCanvasClick = (e) => {
    if (!connected) return;
    const p = canvasToPage(e);
    if (!p) return;
    apiFetch('/services/browser/click', {
      method: 'POST',
      body: JSON.stringify({ x: p.x, y: p.y }),
    }).catch(console.error);
  };

  const handleCanvasDoubleClick = (e) => {
    if (!connected) return;
    const p = canvasToPage(e);
    if (!p) return;
    apiFetch('/services/browser/click', {
      method: 'POST',
      body: JSON.stringify({ x: p.x, y: p.y }),
    }).catch(console.error);
  };

  const handleKeyDown = (e) => {
    if (!connected) return;
    if (['Tab', 'F5', 'F11', 'F12'].includes(e.key)) {
      e.preventDefault();
    }
    apiFetch('/services/browser/key', {
      method: 'POST',
      body: JSON.stringify({ key: e.key }),
    }).catch(console.error);
  };

  const handleScroll = (e) => {
    if (!connected) return;
    e.preventDefault();
    apiFetch('/services/browser/scroll', {
      method: 'POST',
      body: JSON.stringify({ deltaX: e.deltaX, deltaY: e.deltaY }),
    }).catch(console.error);
  };

  const runAIAction = async () => {
    if (!aiInstruction.trim()) return;
    setAiLoading(true);
    try {
      await apiFetch('/services/browser/act', {
        method: 'POST',
        body: JSON.stringify({ instruction: aiInstruction }),
      });
      setAiInstruction('');
    } catch (e) {
      console.error('AI action error:', e);
      alert('AI action failed: ' + e.message);
    } finally {
      setAiLoading(false);
    }
  };

  // ---- Tác vụ tự động nhiều bước (task runner) ----
  const startTask = async () => {
    if (!taskGoal.trim()) return;
    setTaskRunning(true);
    setSteps([]);
    setTaskInfo({ goal: taskGoal, status: 'running', steps: 0 });
    try {
      const r = await apiFetch('/services/browser/task', {
        method: 'POST',
        body: JSON.stringify({ goal: taskGoal }),
      });
      if (r && r.success === false) {
        setTaskRunning(false);
        setTaskInfo({ goal: taskGoal, status: 'error', error: r.error });
      }
    } catch (e) {
      setTaskRunning(false);
      setTaskInfo({ goal: taskGoal, status: 'error', error: e.message });
    }
  };

  const stopTask = async () => {
    try {
      await apiFetch('/services/browser/task/stop', { method: 'POST', body: JSON.stringify({}) });
    } catch (e) {
      console.error('stop task:', e);
    }
    setTaskRunning(false);
  };

  // ---- Đọc màn hình (vision) ----
  const readScreen = async () => {
    setVisionLoading(true);
    try {
      const r = await apiFetch('/services/browser/vision', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'Mô tả nội dung đang hiển thị trên màn hình và các nút đáng chú ý.' }),
      });
      if (r && r.success) {
        setSteps((prev) => [...prev.slice(-199), { n: '👁', thought: r.text, action: 'vision', ok: true, message: r.model }]);
      } else {
        setSteps((prev) => [...prev.slice(-199), { n: '👁', thought: r?.error || 'Không đọc được màn hình', action: 'vision', ok: false }]);
      }
    } catch (e) {
      setSteps((prev) => [...prev.slice(-199), { n: '👁', thought: e.message, action: 'vision', ok: false }]);
    } finally {
      setVisionLoading(false);
    }
  };

  // ---- Cuộn liên tục (TikTok/shorts) ----
  const scrollContinuous = async (durationMs = 10000) => {
    try {
      await apiFetch('/services/browser/scroll-continuous', {
        method: 'POST',
        body: JSON.stringify({ deltaY: 260, durationMs, intervalMs: 25 }),
      });
    } catch (e) {
      console.error('scroll continuous:', e);
    }
  };

  useEffect(() => {
    // Không tự launch khi mở tab (đỡ tốn RAM Chromium) — user bấm Go/Khởi động thì navigate() sẽ launch
    return () => {
      disconnectWS();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusColors = {
    disconnected: 'text-slate-500',
    launching: 'text-amber-400',
    connecting: 'text-cyan-400',
    connected: 'text-emerald-400',
    navigating: 'text-cyan-400',
    error: 'text-rose-400',
  };

  const statusLabels = {
    disconnected: tx(lang, 'Đã ngắt kết nối'),
    launching: tx(lang, 'Đang khởi động Chrome...'),
    connecting: tx(lang, 'Đang kết nối stream...'),
    connected: tx(lang, 'Đang chạy'),
    navigating: tx(lang, 'Đang tải trang...'),
    error: tx(lang, 'Lỗi'),
  };

  return (
    <div className="flex h-full bg-[#0f1014] text-white font-sans">
      <div className="w-72 flex flex-col border-r border-white/5 bg-[#131417] overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot size={20} className="text-cyan-400" />
            <span className="font-bold text-sm">Browser Agent</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="p-3 border-b border-white/5">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && navigate()}
                placeholder={t(lang, 'phUrl')}
                className="w-full pl-8 pr-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500/50"
              />
            </div>
            <button
              onClick={navigate}
              disabled={loading || !url.trim()}
              className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors"
            >
              {loading ? '...' : connected ? 'Go' : tx(lang, 'Khởi động')}
            </button>
          </div>
        </div>

        <div className="px-3 py-2 border-b border-white/5">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${
              status === 'connected' ? 'bg-emerald-400 animate-pulse' :
              status === 'launching' || status === 'navigating' ? 'bg-amber-400 animate-pulse' :
              status === 'error' ? 'bg-rose-400' : 'bg-slate-500'
            }`} />
            <span className={statusColors[status]}>{statusLabels[status]}</span>
          </div>
          {connected && (
            <div className="mt-1 text-[10px] text-slate-500 flex justify-between">
              <span>FPS: {fps}</span>
              <span>{streamRes.w}×{streamRes.h}</span>
            </div>
          )}
        </div>

        <div className="p-3 border-b border-white/5">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-300 mb-2">
            <Zap size={14} className="text-amber-400" />
            AI Action (Stagehand)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runAIAction()}
              placeholder={t(lang, 'phTask')}
              className="flex-1 px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-amber-500/50"
            />
            <button
              onClick={runAIAction}
              disabled={aiLoading || !connected}
              className="px-3 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1"
            >
              {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">{tx(lang, 'Dùng ngôn ngữ tự nhiên. AI sẽ điều khiển browser.')}</p>
        </div>

        {/* ===== Tác vụ tự động (nhiều bước) + theo dõi bước ===== */}
        <div className="p-3 border-b border-white/5">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-300 mb-2">
            <Bot size={14} className="text-violet-400" />
            {tx(lang, 'Tác vụ tự động')}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={taskGoal}
              onChange={(e) => setTaskGoal(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !taskRunning && startTask()}
              placeholder={tx(lang, 'VD: tìm và mở bài viết về AI, đọc tiêu đề')}
              className="flex-1 px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-violet-500/50"
            />
            {taskRunning ? (
              <button
                onClick={stopTask}
                className="px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                {tx(lang, 'Dừng')}
              </button>
            ) : (
              <button
                onClick={startTask}
                disabled={!taskGoal.trim() || !connected}
                className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1"
              >
                <Zap size={12} />
              </button>
            )}
          </div>
          {taskInfo && (
            <div className="mt-1 text-[10px] text-slate-400 flex items-center gap-2 flex-wrap">
              <span className={taskInfo.status === 'running' ? 'text-amber-400' : taskInfo.status === 'done' ? 'text-emerald-400' : 'text-rose-400'}>
                {taskInfo.status === 'running' ? tx(lang, 'Đang chạy') : taskInfo.status === 'done' ? tx(lang, 'Xong') : taskInfo.status === 'stopped' ? tx(lang, 'Đã dừng') : tx(lang, 'Lỗi')}
              </span>
              {taskInfo.steps ? <span>{tx(lang, 'Bước')}: {taskInfo.steps}</span> : null}
              {taskInfo.summary ? <span className="text-emerald-300/90">{taskInfo.summary}</span> : null}
              {taskInfo.error ? <span className="text-rose-300/90">{taskInfo.error}</span> : null}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <button
              onClick={() => scrollContinuous(10000)}
              disabled={!connected}
              className="px-2 py-1.5 bg-[#1b1d23] hover:bg-[#232630] disabled:opacity-50 text-[11px] text-slate-300 rounded-lg border border-white/5 transition-colors"
            >
              {tx(lang, 'Cuộn liên tục 10s')}
            </button>
            <button
              onClick={readScreen}
              disabled={!connected || visionLoading}
              className="px-2 py-1.5 bg-[#1b1d23] hover:bg-[#232630] disabled:opacity-50 text-[11px] text-slate-300 rounded-lg border border-white/5 transition-colors flex items-center justify-center gap-1"
            >
              {visionLoading ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
              {tx(lang, 'Đọc màn hình')}
            </button>
          </div>
        </div>

        {steps.length > 0 && (
          <div className="flex-1 min-h-0 flex flex-col border-b border-white/5">
            <p className="px-3 pt-3 pb-1 text-[10px] text-slate-500 uppercase tracking-wider">
              {tx(lang, 'Các bước đã thực hiện')}
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1.5">
              {steps.map((s, i) => (
                <div
                  key={`${s.n}-${i}`}
                  className={`text-[11px] leading-snug rounded-md px-2 py-1.5 border ${
                    s.ok === false
                      ? 'bg-rose-500/5 border-rose-500/20 text-rose-200'
                      : 'bg-white/[0.03] border-white/5 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-slate-500">{s.n}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 font-mono">{s.action}</span>
                  </div>
                  {s.thought && <div className="mt-0.5 text-slate-200">{s.thought}</div>}
                  {s.error && <div className="mt-0.5 text-rose-300">{s.error}</div>}
                </div>
              ))}
              <div ref={stepsEndRef} />
            </div>
          </div>
        )}

        <div className="p-3 border-b border-white/5">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">{tx(lang, 'Thao tác nhanh')}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: 'Google', url: 'https://google.com' },
              { label: 'YouTube', url: 'https://youtube.com' },
              { label: 'Facebook', url: 'https://facebook.com' },
              { label: 'GitHub', url: 'https://github.com' },
            ].map(site => (
              <button
                key={site.label}
                onClick={() => { setUrl(site.url); navigate(); }}
                disabled={loading || !connected}
                className="py-1.5 text-xs rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
              >
                {site.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-3 flex-1 overflow-y-auto text-[10px] text-slate-500">
          <p className="uppercase tracking-wider mb-2">{tx(lang, 'Phím tắt')}</p>
          <div className="space-y-1 font-mono">
            <div className="flex justify-between"><span>Click</span><span>{tx(lang, 'Chuột trái')}</span></div>
            <div className="flex justify-between"><span>Double-click</span><span>{tx(lang, 'Click trái ×2')}</span></div>
            <div className="flex justify-between"><span>Scroll</span><span>{tx(lang, 'Cuộn chuột')}</span></div>
            <div className="flex justify-between"><span>Type</span><span>{tx(lang, 'Gõ trực tiếp')}</span></div>
            <div className="flex justify-between"><span>Enter</span><span>Submit/Go</span></div>
            <div className="flex justify-between"><span>Backspace</span><span>{tx(lang, 'Xóa')}</span></div>
            <div className="flex justify-between"><span>Tab</span><span>{tx(lang, 'Chuyển focus')}</span></div>
            <div className="flex justify-between"><span>Escape</span><span>{tx(lang, 'Hủy')}</span></div>
          </div>
        </div>

        <div className="p-3 border-t border-white/5 space-y-2">
          <button
            onClick={() => { setUrl('about:blank'); navigate(); }}
            disabled={loading || !connected}
            className="w-full py-2 text-xs rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className="inline-block mr-1" /> {tx(lang, 'Làm mới trang')}
          </button>
          <button
            onClick={closeBrowser}
            disabled={loading}
            className="w-full py-2 text-xs rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 disabled:opacity-50 transition-colors"
          >
            <X size={12} className="inline-block mr-1" /> {tx(lang, 'Đóng Chrome')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative">
        <div className="h-10 px-4 flex items-center justify-between border-b border-white/5 bg-[#131417]">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              {connected ? 'Live Stream' : tx(lang, 'Chưa kết nối')}
            </span>
            {connected && <span className="text-[10px] text-slate-500 px-2 py-0.5 rounded bg-white/5">{streamRes.w} × {streamRes.h}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => canvasRef.current?.requestFullscreen()}
              className="p-1.5 rounded hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
              title={t(lang, 'tipFullscreen')}
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 relative overflow-hidden bg-black">
          <canvas
            ref={canvasRef}
            width={viewport.w}
            height={viewport.h}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
              margin: '0 auto',
              cursor: connected ? 'default' : 'not-allowed',
            }}
            onClick={handleCanvasClick}
            onDoubleClick={handleCanvasDoubleClick}
            onWheel={handleScroll}
            onKeyDown={handleKeyDown}
            tabIndex={0}
          />
          
          {!connected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-white">
              <Loader2 size={48} className="animate-spin text-cyan-400 mb-4" />
              <p className="text-slate-400">{tx(lang, 'Nhấn "Go" để khởi động Chrome')}</p>
              <p className="text-xs text-slate-500 mt-2">{tx(lang, 'Chrome sẽ mở trong background và stream về đây')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}