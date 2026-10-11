import React, { useState, useEffect, useRef } from 'react';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import { Loader2, RefreshCw, Bot, Wifi, WifiOff, Send, ChevronDown, Camera } from 'lucide-react';
import { OPENCUT_URL } from '../config';

export default function OpenCutTab({ authToken, showToast }) {
  const lang = getLang();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [key, setKey] = useState(0);

  const reload = () => { setError(false); setLoading(true); setKey(k => k + 1); };

  return (
    <div className="relative h-full w-full bg-[var(--bg-main)]">
      {loading && !error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <Loader2 size={22} className="text-cyan-500 animate-spin" />
          <p className="text-xs text-slate-500">{tx(getLang(), 'Đang tải OpenCut...')}</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center p-6">
          <p className="text-sm text-slate-300">{tx(getLang(), 'Không tải được OpenCut.')}</p>
          <button
            onClick={reload}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs font-semibold hover:bg-cyan-500/25 transition-all"
          >
            <RefreshCw size={13} /> {tx(getLang(), 'Thử lại')}
          </button>
        </div>
      )}
      <iframe
        key={key}
        src={OPENCUT_URL}
        title="OpenCut"
        className="w-full h-full border-0"
        allow="clipboard-write; fullscreen; camera; microphone; autoplay"
        onLoad={() => setLoading(false)}
        onError={() => { setLoading(false); setError(true); }}
      />
      <AgentBridgePanel token={authToken} showToast={showToast} />
    </div>
  );
}

function AgentBridgePanel({ token, showToast }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [shot, setShot] = useState('');
  const [shotBusy, setShotBusy] = useState(false);
  const taRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!token) return;
      try {
        const r = await fetch('/api/services/opencut-bridge/status', { headers: { Authorization: 'Bearer ' + token } });
        if (r.ok && alive) setStatus(await r.json());
      } catch (e) {}
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || busy) return;
    if (!token) { showToast && showToast(tx(getLang(), 'Cần đăng nhập để dùng agent'), 'error'); return; }
    setBusy(true); setLog(tx(getLang(), 'Đang gửi tới agent...'));
    try {
      const r = await fetch('/api/services/opencut-bridge/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ message: msg })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setLog(tx(getLang(), 'Lỗi: ') + (data.error || r.status)); }
      else {
        const out = data.answer || data.result || data.message || JSON.stringify(data);
        setLog(String(out).slice(0, 2000));
      }
    } catch (e) {
      setLog(tx(getLang(), 'Lỗi mạng: ') + e.message);
    }
    setBusy(false);
  };

  const takeShot = async () => {
    if (!token || shotBusy) return;
    setShotBusy(true);
    try {
      const r = await fetch('/api/services/opencut-bridge/shot', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      const d = await r.json().catch(() => ({}));
      if (d && d.screenshot) setShot(d.screenshot);
      else setLog(tx(getLang(), 'Chụp lỗi: ') + (d.error || r.status));
    } catch (e) { setLog(tx(getLang(), 'Chụp lỗi mạng: ') + e.message); }
    setShotBusy(false);
  };

  const connected = status && status.connected;
  const hasTab = status && status.hasTab;

  return (
    <div className="absolute bottom-3 right-3 z-20 w-[340px] max-w-[92vw]">
      <div className="rounded-2xl border border-white/10 bg-[#141519]/95 backdrop-blur shadow-2xl overflow-hidden">
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left hover:bg-white/[0.04] transition-colors"
        >
          <Bot size={15} className="text-cyan-300 shrink-0" />
          <span className="text-[12.5px] font-semibold text-slate-100 flex-1">OpenCut Agent</span>
          {connected ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-300"><Wifi size={12} />{tx(getLang(), 'đã nối')}</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-slate-500"><WifiOff size={12} />{tx(getLang(), 'chưa nối')}</span>
          )}
          <ChevronDown size={14} className={`text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>

        {open && (
          <div className="px-3.5 pb-3.5">
            <p className="text-[10.5px] text-slate-500 mb-2 leading-relaxed">
              {!token ? tx(getLang(), 'Cần đăng nhập.')
                : connected ? (hasTab ? tx(getLang(), 'Extension OK + có tab OpenCut. Nhập việc cần agent làm:') : tx(getLang(), 'Extension OK nhưng chưa thấy tab opencut.app — hãy mở opencut.app.'))
                : tx(getLang(), 'Chưa thấy extension. Cài "Rexi OpenCut Bridge" (Load unpacked) + mở opencut.app.')}
            </p>
            <textarea
              ref={taRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              placeholder={t(getLang(), 'phOpencut')}
              className="w-full resize-none rounded-lg bg-black/30 border border-white/10 text-[12px] text-slate-100 px-2.5 py-2 focus:outline-none focus:border-cyan-400/50 placeholder:text-slate-600"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={send}
                disabled={busy || !input.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-100 text-[11.5px] font-semibold hover:bg-cyan-500/30 disabled:opacity-40 transition-all"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Giao agent
              </button>
              <button
                onClick={takeShot}
                disabled={shotBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/15 text-slate-200 text-[11.5px] font-semibold hover:bg-white/10 disabled:opacity-40 transition-all"
              >
                {shotBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} {tx(getLang(), 'Chụp')}
              </button>
            </div>
            {log && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 border border-white/10 p-2 text-[10.5px] text-slate-300">{log}</pre>
            )}
            {shot && (
              <img src={shot} alt="OpenCut" className="mt-2 w-full rounded-lg border border-white/10" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
