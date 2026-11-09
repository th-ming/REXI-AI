import { API_BASE } from '../config';
import { t, getLang } from '../i18n';
import React, { useState, useEffect, useRef } from 'react';
import { X, Settings, Eye, EyeOff, RefreshCw, Zap } from 'lucide-react';
import SocialConnect from './SocialConnect';

const FALLBACK_PROVIDERS = {
  gemini: { name: 'Google Gemini', placeholder: 'AIzaSy...', defaultBaseUrl: '' },
  openai: { name: 'OpenAI GPT-4o / O3', placeholder: 'sk-proj-...', defaultBaseUrl: 'https://api.openai.com/v1' },
  claude: { name: 'Anthropic Claude 3.5', placeholder: 'sk-ant-...', defaultBaseUrl: '' },
  deepseek: { name: 'DeepSeek AI (V3/R1)', placeholder: 'sk-...', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  groq: { name: 'Groq Cloud (Fast Llama)', placeholder: 'gsk_...', defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  github: { name: 'GitHub Models (Free)', placeholder: 'ghp_...', defaultBaseUrl: 'https://models.inference.ai.azure.com' },
  opencode: { name: 'OpenCode Agent Engine', placeholder: 'Internal Engine', defaultBaseUrl: '' },
  custom: { name: 'Custom Endpoint / OpenRouter', placeholder: 'sk-or-v1-...', defaultBaseUrl: 'https://openrouter.ai/api/v1' }
};

// Provider KHÔNG cần Base URL — chỉ cần API key là quét được model
const KEY_ONLY_PROVIDERS = ['gemini', 'claude', 'openai', 'deepseek', 'groq', 'github', 'xkiro', 'agentrouter', 'opencode'];

export default function SettingsModal({
  settingsOpen, setSettingsOpen,
  provider, setProvider, modelName, setModelName,
  apiKey, setApiKey, baseUrl, setBaseUrl, showToast
}) {
  const lang = getLang();
  const [showApiKey, setShowApiKey] = useState(false);
  const [dynamicProviders, setDynamicProviders] = useState([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [scanModels, setScanModels] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const scanAbortRef = useRef(null);

  // Fetch danh sách Nhà Cung Cấp động từ API khi mở Modal
  useEffect(() => {
    if (settingsOpen) {
      fetchProviders();
    }
    return () => {
      if (scanAbortRef.current) { try { scanAbortRef.current.abort(); } catch (e) {} }
    };
  }, [settingsOpen]);

  const fetchProviders = async () => {
    setLoadingProviders(true);
    try {
      const res = await fetch(`${API_BASE}/models/providers`);
      const data = await res.json();
      if (data.success && Array.isArray(data.providers)) {
        setDynamicProviders(data.providers);
      }
    } catch (e) {
      console.warn('Load providers failed, fallback static:', e.message);
    } finally {
      setLoadingProviders(false);
    }
  };

  const handleProviderChange = (newProv) => {
    setProvider(newProv);
    localStorage.setItem('rexi_provider', newProv);

    // Auto-fill Base URL theo provider — LUÔN set (kể cả rỗng) để không dính URL cũ của provider trước
    const provInfo = FALLBACK_PROVIDERS[newProv];
    const nextBase = provInfo?.defaultBaseUrl || '';
    setBaseUrl(nextBase);
    localStorage.setItem('rexi_base_url', nextBase);

    // P2-23: khi đổi provider, key cũ (session) thuộc provider khác → xóa để tránh gửi nhầm key sang provider mới
    try { sessionStorage.removeItem('rexi_api_key'); } catch (e) { console.warn('[rexi] storage clear failed', e); }

    // KHÔNG gợi ý model mẫu — để hệ thống tự quét model từ API
  };

  const handleClearKey = () => {
    setApiKey('');
    try { localStorage.removeItem('rexi_api_key'); } catch (e) { console.warn('[rexi] storage clear failed', e); }
    try { sessionStorage.removeItem('rexi_api_key'); } catch (e) { console.warn('[rexi] storage clear failed', e); }
  };

  // TỰ QUÉT MODEL: dán Base URL + API Key là tự lấy danh sách model — không cần gõ tay
  const runScan = async () => {
    if (scanAbortRef.current) { try { scanAbortRef.current.abort(); } catch (e) {} }
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    scanAbortRef.current = ac;
    setScanning(true);
    setScanError('');
    try {
      const res = await fetch(`${API_BASE}/models/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl }),
        signal: ac ? ac.signal : undefined
      });
      const data = await res.json();
      if (ac && ac.signal.aborted) return;
      if (data.success && Array.isArray(data.models) && data.models.length > 0) {
        setScanModels(data.models);
        const next = data.models.includes(modelName) ? modelName : data.models[0];
        setModelName(next);
        localStorage.setItem('rexi_model', next);
      } else {
        setScanModels([]);
        setScanError(data.error || t(lang, 'smScanNone'));
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      setScanError(t(lang, 'smScanErr') + e.message);
    } finally {
      if (!ac || !ac.signal.aborted) setScanning(false);
    }
  };

  // Debounce 700ms sau khi dán/gõ URL hoặc key → tự quét
  useEffect(() => {
    if (!settingsOpen) return;
    const hasBase = (baseUrl || '').trim().length > 0;
    const hasKey = (apiKey || '').trim().length > 0;
    if (!hasBase && !hasKey && provider !== 'opencode') { setScanModels([]); setScanError(''); return; }
    if (!hasBase && !KEY_ONLY_PROVIDERS.includes(provider)) { setScanModels([]); setScanError(''); return; }
    const t = setTimeout(() => { runScan(); }, 700);
    return () => clearTimeout(t);
  }, [settingsOpen, provider, baseUrl, apiKey]);

  if (!settingsOpen) return null;

  const providerList = dynamicProviders.length > 0
    ? dynamicProviders.map(p => ({ key: p.ma_nha_cung_cap, name: p.ten_hien_thi, placeholder: p.placeholder, canKey: p.can_api_key }))
    : Object.entries(FALLBACK_PROVIDERS).map(([k, v]) => ({ key: k, name: v.name, placeholder: v.placeholder, canKey: v.placeholder !== 'Internal Engine' }));

  // Ưu tiên placeholder của provider ĐỘNG từ server, fallback mới tới static
  const dynInfo = dynamicProviders.find(p => p.ma_nha_cung_cap === provider);
  const currentInfo = {
    placeholder: dynInfo?.placeholder || FALLBACK_PROVIDERS[provider]?.placeholder || '',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(0,0,0,.10)', transition:'background-color .2s'}} onClick={() => setSettingsOpen(false)}>
      <div className="bg-[#141522] border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Settings size={18} className="text-cyan-500" /> {t(lang, 'smTitle')}
          </h2>
          <div className="flex items-center gap-2">
            <button onClick={fetchProviders} title={t(lang, 'tipProvReload')} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white">
              <RefreshCw size={14} className={loadingProviders ? 'animate-spin text-cyan-500' : ''} />
            </button>
            <button onClick={() => setSettingsOpen(false)} className="p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white"><X size={16} /></button>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-400">{t(lang, 'smProvider')}</label>
              {loadingProviders && <span className="text-[10px] text-cyan-400 animate-pulse">{t(lang, 'smUpdating')}</span>}
            </div>
            <select
              value={provider}
              onChange={e => handleProviderChange(e.target.value)}
              className="w-full px-3 py-2.5 bg-[#0e0f16] border border-white/10 rounded-xl text-sm text-slate-100 outline-none focus:border-cyan-400 cursor-pointer"
            >
              {providerList.map(p => (
                <option key={p.key} value={p.key} className="bg-[#1e1f20] text-slate-200">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-400">{t(lang, 'smModel')}</label>
              <div className="flex items-center gap-2">
                {scanning && <span className="text-[10px] text-cyan-400 animate-pulse">{t(lang, 'smScanning')}</span>}
                <button type="button" onClick={runScan} title={t(lang, 'tipModelScan')}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                  <RefreshCw size={11} className={scanning ? 'animate-spin' : ''} /> {t(lang, 'smRescan')}
                </button>
              </div>
            </div>
            {scanModels.length > 0 ? (
              <select
                value={scanModels.includes(modelName) ? modelName : scanModels[0]}
                onChange={e => { setModelName(e.target.value); localStorage.setItem('rexi_model', e.target.value); }}
                className="w-full px-3 py-2.5 bg-[#0e0f16] border border-white/10 rounded-xl text-sm text-slate-100 outline-none focus:border-cyan-400 cursor-pointer font-mono"
              >
                {scanModels.map(m => (
                  <option key={m} value={m} className="bg-[#1e1f20] text-slate-200">{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={modelName}
                onChange={e => { setModelName(e.target.value); localStorage.setItem('rexi_model', e.target.value); }}
                placeholder={scanError ? t(lang, 'phScanErr') : t(lang, 'phScan')}
                className="w-full px-3 py-2.5 bg-[#0e0f16] border border-white/10 rounded-xl text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-cyan-400 font-mono"
              />
            )}
            {scanModels.length > 0 && (
              <p className="text-[10px] text-emerald-400 mt-1">{t(lang, 'smScanFoundA')}{scanModels.length}{t(lang, 'smScanFoundB')}</p>
            )}
            {scanModels.length === 0 && scanError && (
              <p className="text-[10px] text-amber-400 mt-1">{scanError}</p>
            )}
          </div>

          {provider !== 'opencode' && (
            <div>
              <label className="text-xs font-medium text-slate-400 mb-1 block">API Key</label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); try { sessionStorage.setItem('rexi_api_key', e.target.value); } catch (err) { console.warn('[rexi] storage save failed', err); } }}
                  placeholder={currentInfo.placeholder || t(lang, 'phApiKey')}
                  className="w-full px-3 py-2.5 bg-[#0e0f16] border border-white/10 rounded-xl text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-cyan-400 pr-10"
                />
                <button type="button" onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {apiKey ? (
                <button type="button" onClick={handleClearKey}
                  className="mt-1 text-[10px] text-rose-500 hover:text-rose-400">
                  {t(lang, 'smClearKey')}
                </button>
              ) : null}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-400 mb-1 block">{t(lang, 'smBaseUrl')}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => { setBaseUrl(e.target.value); localStorage.setItem('rexi_base_url', e.target.value); }}
              placeholder={
                provider === 'gemini' ? t(lang, 'smNoUrlGem')
                : provider === 'claude' ? t(lang, 'smNoUrlClaude')
                : provider === 'opencode' ? t(lang, 'smNoUrlOC')
                : 'https://api.openai.com/v1'
              }
              className="w-full px-3 py-2.5 bg-[#0e0f16] border border-white/10 rounded-xl text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-cyan-400 font-mono"
            />
            {(provider === 'gemini' || provider === 'claude' || provider === 'opencode') && (
              <p className="text-[10px] text-slate-400 mt-1">{t(lang, 'smDirectKey')}</p>
            )}
          </div>

          <button
            onClick={() => setSettingsOpen(false)}
            className="w-full py-2.5 bg-[var(--accent)] hover:brightness-110 text-white font-bold text-sm rounded-xl transition-colors flex items-center justify-center gap-1.5"
          >
            <Zap size={15} /> {t(lang, 'smSave')}
          </button>

          <SocialConnect showToast={showToast} />
        </div>
      </div>
    </div>
  );
}
