// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Rexi AI OS - Master Web Suite (Auto-Synced & Reloaded)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  PanelLeftOpen,
  X,
  Settings,
  Layers,
  Bot, Code,
  Trash2,
  Database,
  Search,
  Check,
  AlertTriangle,
  Folder,
  Mic,
  Download,
  Cpu,
  FileCode,
  ChevronDown,
  Zap,
  MessageSquare,
  RefreshCw,
  Monitor,
  Tv,
  Eye,
  ChevronUp,
  Terminal,
  Shield,
  Sparkles,
  Lock,
  GitBranch,
  EyeOff,
  Video,
  BookOpen,
  Clapperboard,
  MonitorPlay,
  Gamepad2,
  FileText,
  Languages,
  ChevronLeft,
  MoreVertical,
  Plus,
  Share2,
  CheckCircle2,
  XCircle,
  Info,
  User,
  Play,
  GraduationCap,
  Scissors,
  Wand2,
  Music2
} from 'lucide-react';
import { getLang, setLang, t } from './i18n';
import { tx } from './i18n-sweep';
let _hlsPromise = null;
const loadHls = () => (_hlsPromise ||= import('hls.js').then((m) => m.default));

// Components
import { API_BASE, apiFetch } from './config';
import Sidebar from './components/Sidebar';
import ChatTab from './components/ChatTab';
const CodeEditorTab = lazy(() => import('./components/CodeEditorTab'));
const IPTVTab = lazy(() => import('./components/IPTVTab'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const SkillsModal = lazy(() => import('./components/SkillsModal'));
const AdminPanel = lazy(() => import('./AdminPanel'));
const StudioTab = lazy(() => import('./components/StudioTab'));
const VideoCreatorTab = lazy(() => import('./components/VideoCreatorTab'));
const OpenCutTab = lazy(() => import('./components/OpenCutTab'));
const VideoEditTab = lazy(() => import('./components/VideoEditTab'));
const OpenShortsTab = lazy(() => import('./components/OpenShortsTab'));
const TikTokFeedTab = lazy(() => import('./components/TikTokFeedTab'));
const ImageGenTab = lazy(() => import('./components/ImageGenTab'));
const DocumentsTab = lazy(() => import('./components/DocumentsTab'));
const YouTubeTab = lazy(() => import('./components/YouTubeTab'));
const GameTab = lazy(() => import('./components/GameTab'));
const ClassroomTab = lazy(() => import('./components/ClassroomTab'));
const BrowserView = lazy(() => import('./components/BrowserView'));
const HelpModal = lazy(() => import('./components/HelpModal'));
const ScrapePanel = lazy(() => import('./components/ScrapePanel'));


// (marked/highlight render markdown náº±m trong Frontend/src/utils/sanitize.js â€” ChatTab dÃ¹ng sanitizeMarkdown)

// Popover UI Cháº©n Tráº­n & Chá»n Model Äáº³ng Cáº¥p ChuyÃªn Nghiá»‡p (Glassmorphism & Grouped)
const ModelSelectorPopover = ({ availableModels, modelName, setModelName, setProvider, executionMode }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const activeModelObj = useMemo(() => {
    // ðŸ¤– Auto: hiá»ƒn thá»‹ cháº¿ Ä‘á»™ tá»± chá»n model thÃ´ng minh
    if (modelName === 'auto') return { id: 'auto', name: tx(getLang(), 'Auto (tá»± chá»n thÃ´ng minh)'), provider: 'xkiro', type: 'free' };
    // ðŸ”„ Æ¯u tiÃªn model tháº­t Ä‘ang Ä‘Æ°á»£c chá»n; náº¿u model cÅ© Ä‘Ã£ bá»‹ xÃ³a (khÃ´ng cÃ²n trong danh sÃ¡ch má»›i)
    // â†’ KHÃ”NG hiá»ƒn thá»‹ model giáº£/cÅ© â€” tá»± chá»n model tháº­t Ä‘áº§u tiÃªn (hoáº·c tráº¡ng thÃ¡i 'Ä‘ang táº£i')
    const found = availableModels.find(m => m.id === modelName);
    if (found) return found;
    if (availableModels.length > 0) return availableModels[0];
    return { id: modelName || '', name: modelName || tx(getLang(), 'Äang táº£i model...'), provider: '', type: 'free' };
  }, [availableModels, modelName]);

  const groupedModels = useMemo(() => {
    const map = {};
    const isAgent = executionMode === 'agent';
    const filtered = availableModels.filter(m => {
      // Agent Mode: tu an model chua verify chay duoc agent (co agent_ok tu scanner probe)
      if (isAgent && !m.agent) return false;
      const query = search.toLowerCase().trim();
      if (!query) return true;
      return (m.name || '').toLowerCase().includes(query) ||
             (m.id || '').toLowerCase().includes(query) ||
             (m.provider || '').toLowerCase().includes(query);
    });

    filtered.forEach(m => {
      const pKey = (m.providerName || m.provider || 'AI Provider').toUpperCase();
      if (!map[pKey]) map[pKey] = [];
      map[pKey].push(m);
    });
    return map;
  }, [availableModels, search, executionMode]);

  const selectModel = (m) => {
    setModelName(m.id);
    localStorage.setItem('rexi_model', m.id);
    if (m.provider) {
      setProvider(m.provider);
      localStorage.setItem('rexi_provider', m.provider);
    }
    setOpen(false);
  };

  const getProviderBadge = (providerName) => {
    const p = (providerName || '').toLowerCase();
    if (p.includes('gemini') || p.includes('google')) return { bg: 'bg-blue-500/10 border-blue-500/30 text-blue-400', IconComp: Bot };
    if (p.includes('groq')) return { bg: 'bg-amber-500/10 border-amber-500/30 text-amber-400', IconComp: Zap };
    if (p.includes('deepseek')) return { bg: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400', IconComp: Cpu };
    if (p.includes('kira')) return { bg: 'bg-rose-500/10 border-rose-500/30 text-rose-400', IconComp: Shield };
    if (p.includes('opencode')) return { bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', IconComp: Settings };
    if (p.includes('openai') || p.includes('gpt')) return { bg: 'bg-purple-500/10 border-purple-500/30 text-purple-400', IconComp: Sparkles };
    return { bg: 'bg-slate-500/10 border-slate-500/30 text-slate-300', IconComp: Sparkles };
  };

  const msLang = getLang();

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rexi-ms-trigger flex items-center gap-2 px-3 py-1.5 rounded-xl border border-blue-500/40 shadow-lg text-xs font-medium transition-all cursor-pointer group hover:scale-[1.02] active:scale-[0.98]"
      >
        <span className="flex items-center gap-1.5 truncate max-w-[170px] sm:max-w-[240px]">
          <Zap size={14} className="text-cyan-400" />
          <span className="font-bold text-cyan-100 truncate">{activeModelObj.name || activeModelObj.id}</span>
          {(activeModelObj.status === 'needs_balance' || activeModelObj.type === 'paid') && (
            <span className="text-[9px] font-extrabold rounded-md bg-amber-500/20 text-amber-300 uppercase border border-amber-500/30 shrink-0" title={t(msLang, 'msBalanceTip')}><Lock size={10} /></span>
          )}
          <span className="px-1.5 py-0.5 text-[9px] font-extrabold rounded-md bg-cyan-500/20 text-cyan-300 uppercase border border-cyan-500/30 shrink-0">
            {(activeModelObj.provider || 'AI').toUpperCase()}
          </span>
        </span>
        <ChevronDown size={14} className={`text-slate-400 group-hover:text-cyan-300 transition-transform duration-200 ${open ? 'rotate-180 text-cyan-400' : ''}`} />
      </button>

      {open && (
        <div className="rexi-ms-pop absolute top-full left-0 mt-2 w-[340px] sm:w-[380px] max-h-[460px] border border-cyan-500/50 rounded-2xl shadow-[0_25px_60px_-15px_rgba(0,0,0,0.95)] z-[9999999] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
          <div className="rexi-ms-head p-3 border-b border-white/10 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold flex items-center gap-1.5">
                <Cpu size={14} className="text-cyan-400 animate-pulse" /> {t(msLang, 'msTitle')}
              </span>
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/20">
                {executionMode === 'agent' ? Object.values(groupedModels).reduce((a, g) => a + g.length, 0) : availableModels.length} Models
              </span>
            </div>
            {executionMode === 'agent' && (
              <div className="text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded-lg px-2 py-1">
                {tx(msLang, 'Agent Mode â€” chá»‰ hiá»‡n model cháº¡y Ä‘Æ°á»£c agent')}
              </div>
            )}

            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder={t(msLang, 'msSearch')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="rexi-ms-input w-full text-xs pl-8 pr-3 py-1.5 rounded-xl border border-white/10 focus:border-cyan-400 outline-none placeholder:text-slate-500 transition-all"
                autoFocus
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-3 custom-scrollbar">
            {/* ðŸ¤– AUTO â€” tá»± chá»n model thÃ´ng minh theo Ä‘á»™ khÃ³ cÃ¢u há»i */}
            <button
              type="button"
              onClick={() => selectModel({ id: 'auto', provider: 'xkiro' })}
              className={`w-full flex items-center justify-between p-2 rounded-xl text-left transition-colors mb-1 ${
                modelName === 'auto'
                  ? 'bg-[var(--accent)]/15 border border-[var(--accent)]/50 text-[var(--c-accent-soft)] font-semibold'
                  : 'bg-white/[0.03] border border-white/10 text-slate-300 hover:text-white hover:border-white/20'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-indigo-300"><Bot size={16} /></span>
                <span>{t(msLang, 'msAuto')}</span>
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 uppercase shrink-0">VIP</span>
            </button>
            {Object.keys(groupedModels).length > 0 ? (
              Object.entries(groupedModels).map(([providerGroup, models]) => {
                const badge = getProviderBadge(providerGroup);
                return (
                  <div key={providerGroup} className="space-y-1">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      <badge.IconComp size={12} />
                      <span className="text-slate-300">{providerGroup}</span>
                      <span className="ml-auto text-[9px] opacity-60">({models.length})</span>
                    </div>

                    <div className="space-y-1">
                      {models.map(m => {
                        const isSelected = m.id === modelName;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => selectModel(m)}
                            className={`w-full flex items-center justify-between p-2 rounded-xl text-left transition-all ${
                              isSelected
                                ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-200 font-semibold shadow-inner'
                                : 'hover:bg-white/5 border border-transparent text-slate-300 hover:text-white'
                            }`}
                          >
                            <div className="flex flex-col min-w-0 pr-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs truncate">{m.name || m.id}</span>
                                {(m.status === 'needs_balance' || m.type === 'paid') && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold shrink-0" title={t(msLang, 'msPaidTip')}>ðŸ”’ {t(msLang, 'msPaidShort')}</span>
                                )}
                              </div>
                              <span className="text-[10px] text-slate-500 font-mono truncate">{m.id}</span>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {isSelected && (
                                <Check size={14} className="text-cyan-400 font-bold ml-1" />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-6 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
                <AlertTriangle size={20} className="text-amber-400" />
                <span>{t(msLang, 'msNoFoundPre')}"{search}"</span>
              </div>
            )}
          </div>

          <div className="rexi-ms-foot p-2 border-t border-white/10 text-[10px] text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1"><Zap size={11} className="text-cyan-400" /> {t(msLang, 'autoProvider')}</span>
            <span className="text-cyan-400 font-mono">Rexi AI OS</span>
          </div>
        </div>
      )}
    </div>
  );
};



// FAB menu item (icon + label + description)
const FabItem = ({ item, activeTab, onPick }) => (
  <button
    onClick={onPick}
    title={item.desc ? `${item.label} â€” ${item.desc}` : item.label}
    className={`flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all border ${
      activeTab === item.tab
        ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30 font-bold'
        : 'text-[var(--text-sub)] hover:text-[var(--text-main)] hover:bg-white/5 border-transparent'
    }`}
  >
    <span className={item.color}>{item.icon}</span>
    <span className="whitespace-nowrap">{item.label}</span>
  </button>
);

const TabLoading = () => (
  <div className="flex items-center justify-center h-full w-full gap-2 text-slate-500 text-xs">
    <span className="w-4 h-4 rounded-full border-2 border-slate-600 border-t-cyan-400 animate-spin" />
  </div>
);

const KEEPALIVE_TABS = new Set(['iptv', 'youtube', 'tiktokfeed']);

const AI_SPECIALTIES = [
  { id: 'general', key: 'spGeneral' },
  { id: 'business', key: 'spBusiness' },
  { id: 'marketing', key: 'spMarketing' },
  { id: 'education', key: 'spEducation' },
  { id: 'health', key: 'spHealth' },
  { id: 'coder', key: 'spCoder' }
];





export default function App() {
  const [lang, setLangState] = useState(getLang());
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  // FIX DUP: khi handleSendMessage tá»± táº¡o conv má»›i vÃ  setActiveConvId, useEffect[activeConvId]
  // sáº½ fetchMessages (replace state) giá»¯a lÃºc optimistic tempUserMsg Ä‘ang hiá»ƒn thá»‹ â†’
  // line "push temp trá»Ÿ láº¡i" táº¡o báº£n sao â†’ tin user hiá»‡n 2 láº§n. Flag nÃ y cháº·n fetch Ä‘Ã³.
  const skipConvFetchRef = useRef(false);
  const [inputText, setInputText] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [superToolsOpen, setSuperToolsOpen] = useState(false);
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [showPassword, setShowPassword] = useState(false);
  const [forgotOtp, setForgotOtp] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotStep, setForgotStep] = useState('login');
  const [showForgotNewPassword, setShowForgotNewPassword] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [activeTab, setActiveTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || localStorage.getItem('rexi_activeTab') || 'chat'); // 'chat' | 'code' | 'files' | 'iptv' | 'desktop'
  const handleSetActiveTab = (tab) => { setActiveTab(tab); localStorage.setItem('rexi_activeTab', tab); };
  const [openedTabs, setOpenedTabs] = useState(() => new Set(KEEPALIVE_TABS.has(activeTab) ? [activeTab] : []));
  useEffect(() => {
    if (!KEEPALIVE_TABS.has(activeTab)) return;
    setOpenedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIds, setSearchIds] = useState(null); // Set id há»™i thoáº¡i khá»›p Ná»˜I DUNG tin nháº¯n (full-text)

  // TÃ¬m full-text theo ná»™i dung tin nháº¯n (debounce 300ms, gá»i backend)
  useEffect(() => {
    const q = (searchQuery || '').trim();
    if (q.length < 2) { setSearchIds(null); return undefined; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/chat/conversations/search?q=${encodeURIComponent(q)}`);
        if (alive) setSearchIds(new Set(data.ids || []));
      } catch {
        if (alive) setSearchIds(new Set());
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [searchQuery]);
  const [fabOpen, setFabOpen] = useState(false);
  const fabMenuRef = useRef(null);
  useEffect(() => {
    if (fabOpen && fabMenuRef.current) fabMenuRef.current.scrollTop = 0;
  }, [fabOpen]);
  useEffect(() => {
    const els = fabMenuRef.current ? [...fabMenuRef.current.children] : [];
    els.forEach((el, i) => {
      if (fabOpen) {
        el.style.animation = 'rexi-fab-item-in .45s cubic-bezier(0.32,0.72,0,1) both';
        el.style.animationDelay = `${Math.min(60 + i * 26, 640)}ms`;
      } else {
        el.style.animation = '';
        el.style.animationDelay = '';
      }
    });
  }, [fabOpen]);
  useEffect(() => {
    if (!fabOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFabOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fabOpen]);

  // AI Configuration State
  const [provider, setProvider] = useState(() => localStorage.getItem('rexi_provider') || 'xkiro');
  const [modelName, setModelName] = useState(() => localStorage.getItem('rexi_model') || 'mistralai/mistral-small-2603');
  const lastAutoSwapRef = useRef(''); // chá»‘ng toast Ä‘Ãºp khi nhiá»u nguá»“n refresh model cÃ¹ng lÃºc
  const [apiKey, setApiKey] = useState(() => {
    // P2-23: key KHÃ”NG náº±m localStorage (plaintext + XSS Ä‘á»c Ä‘Æ°á»£c) â€” chá»‰ sessionStorage (Ä‘Ã³ng tab lÃ  máº¥t)
    const saved = sessionStorage.getItem('rexi_api_key') || '';
    const token = localStorage.getItem('rexi_token') || '';
    // Tá»± Ä‘á»™ng dá»n dáº¹p key há»ng/key nháº§m JWT token Ä‘á»ƒ luÃ´n luÃ´n tá»± cáº­p nháº­t theo Key chuáº©n cá»§a Admin tá»« CSDL
    if (saved && (saved.startsWith('AQ..') || saved === token || saved.length > 200)) {
      sessionStorage.removeItem('rexi_api_key');
      localStorage.removeItem('rexi_api_key'); // dá»n sÃ³t tá»« báº£n cÅ© (trÆ°á»›c P2-23)
      return '';
    }
    return saved;
  });
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('rexi_base_url') || '');
  const [availableModels, setAvailableModels] = useState([]); // load Ä‘á»™ng tá»« /api/models â€” chá»‰ model chat
  const [allModels, setAllModels] = useState([]); // má»i modality (chat/image/tts/stt/embed)
  const [aiSpecialty, setAiSpecialty] = useState('general');
  const [executionMode, setExecutionMode] = useState('chat'); // 'chat' | 'agent'
  const [agentEngine, setAgentEngine] = useState('auto'); // 'auto' | 'opencode' | 'dsh'
  // Bat Agent Mode ma model dang chon khong chay duoc agent -> tu chuyen sang con agent dau tien
  useEffect(() => {
    if (executionMode !== 'agent' || modelName === 'auto') return;
    const cur = availableModels.find(m => m.id === modelName);
    if (cur && !cur.agent) {
      const first = availableModels.find(m => m.agent);
      if (first) {
        setModelName(first.id);
        if (first.provider) setProvider(first.provider);
        localStorage.setItem('rexi_model', first.id);
        if (first.provider) localStorage.setItem('rexi_provider', first.provider);
      }
    }
  }, [executionMode]);
  const [chatModeOpen, setChatModeOpen] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('standard'); // 'standard' | 'deep'
  const [currentTheme, setCurrentTheme] = useState(() => localStorage.getItem('rexi_theme_v2') || 'light');

  // Workspace Files State
  const [fileTree, setFileTree] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [savingFile, setSavingFile] = useState(false);

  // Attachment & Voice State
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [speakingMsgId, setSpeakingMsgId] = useState(null);

  // TTS Settings
  const [ttsVoice, setTtsVoice] = useState(() => localStorage.getItem('rexi_tts_voice') || 'vi-VN-HoaiMyNeural');
  const [ttsRate] = useState(() => localStorage.getItem('rexi_tts_rate') || '+0%');
  const [ttsPitch] = useState(() => localStorage.getItem('rexi_tts_pitch') || '+0%');
  const [ttsVoices, setTtsVoices] = useState([]);
  const [, setTtsVoicesLoading] = useState(true);
  const [ttsUsingServer, setTtsUsingServer] = useState(() => {
    const saved = localStorage.getItem('rexi_tts_mode');
    return saved === 'server' && !!localStorage.getItem('rexi_token');
  });
  const ttsServerBrokenRef = useRef(false); // P3: server TTS lá»—i táº¡m thá»i â†’ fallback browser cho phiÃªn, KHÃ”NG ghi Ä‘Ã¨ setting user

  // Skills List from Database
  const [dbSkills, setDbSkills] = useState([]);

  // IPTV State
  const [iptvChannels, setIptvChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [iptvCategory, setIptvCategory] = useState('news');
  const [iptvSearch, setIptvSearch] = useState('');
  const [iptvTab, setIptvTab] = useState('category'); // 'category' | 'country'
  const [iptvCountry, setIptvCountry] = useState('VN');
  const [iptvSubtitleOn, setIptvSubtitleOn] = useState(false);
  const [iptvEmbeddedSubs, setIptvEmbeddedSubs] = useState([]); // track phá»¥ Ä‘á» nhÃºng cá»§a kÃªnh (Ä‘á»“ng bá»™ 100%)
  const [iptvError, setIptvError] = useState(''); // lá»—i phÃ¡t kÃªnh (hiá»‡n overlay thay vÃ¬ mÃ n Ä‘en im láº·ng)
  const iptvVideoRef = useRef(null);
  const hlsRef = useRef(null);

  // Desktop Remote State
  const [desktopScreenshot, setDesktopScreenshot] = useState(null);
  const [desktopLoading, setDesktopLoading] = useState(false);
  const [desktopError, setDesktopError] = useState(null);

  // Guest Limits State
  const [guestLimits, setGuestLimits] = useState({ messages: { used: 0, limit: 10, remaining: 10 }, agentTasks: { used: 0, limit: 3, remaining: 3 } });

  // Live Canvas state
  const [liveHtml, setLiveHtml] = useState('');

  // Super Tools State (Exec, Git, Memory)
  const [execCommand, setExecCommand] = useState('');
  const [execOutput, setExecOutput] = useState('');
  const [gitStatus, setGitStatus] = useState(null);
  const [gitDiff, setGitDiff] = useState('');
  const [memories, setMemories] = useState([]);
  const [newMemory, setNewMemory] = useState('');

  // Rate Limit Toast
  const [, setRateLimitToast] = useState('');
  const rateLimitTimerRef = useRef(null);

  // General Toast
  const [toastMsg, setToastMsg] = useState('');
  const [toastType, setToastType] = useState('success');
  const toastTimerRef = useRef(null);
  const showToast = (msg, type = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    setToastType(type);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 3000);
  };


  // Auth Token
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('rexi_token') || null);

  // User Profile
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rexi_user'));
      if (saved && saved.ma_nguoi_dung) return saved;
      return null;
    } catch { return null; }
  });
  const authHeaders = () => {
    const h = { 'Content-Type': 'application/json' };
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    return h;
  };


  // Fetch danh sÃ¡ch toÃ n bá»™ model Ä‘á»™ng Ä‘ang hoáº¡t Ä‘á»™ng tá»« backend tá»« Táº¤T Cáº¢ nhÃ  cung cáº¥p
  const fetchAvailableModels = async () => {
    try {
      const data = await apiFetch('/models');
      if (data.success && data.models) {
        let allArr = [];
        Object.entries(data.models).forEach(([pKey, list]) => {
          if (Array.isArray(list)) {
            list.forEach(m => {
              allArr.push({ ...m, provider: m.provider || pKey });
            });
          }
        });
        setAllModels(allArr);
        const chatArr = allArr.filter(m => (m.modality || 'chat') === 'chat');
        setAvailableModels(chatArr);
        if (chatArr.length > 0) {
          const currentExist = chatArr.find(m => m.id === modelName);
          if (!currentExist) {
            // ðŸ”„ THUáº¬T TOÃN Báº¢O TOÃ€N PHIÃŠN (Safe Swap): model Ä‘ang chá»n vá»«a bá»‹ lÆ°á»£t quÃ©t má»›i
            // xÃ³a/thay tháº¿ â†’ KHÃ”NG Ä‘á»•i model Ã¢m tháº§m. Chá»n model thay tháº¿ gáº§n nháº¥t:
            // 1) Æ¯u tiÃªn model CÃ™NG nhÃ  cung cáº¥p (giá»¯ Ä‘Ãºng Ã½ Ä‘á»‹nh ngÆ°á»i dÃ¹ng)
            // 2) Náº¿u nhÃ  cung cáº¥p cÅ©ng biáº¿n máº¥t â†’ model Ä‘áº§u tiÃªn cÃ²n sá»‘ng
            // Rá»“i bÃ¡o rÃµ cho ngÆ°á»i dÃ¹ng báº±ng toast (bá» qua náº¿u chÆ°a tá»«ng chá»n model = láº§n Ä‘áº§u má»Ÿ).
            const oldSelected = availableModels.find(m => m.id === modelName);
            const oldProviderName = (oldSelected ? oldSelected.provider : '') || (modelName.split('/')[0] || '');
            const sameProvider = chatArr.find(m => String(m.provider || '').toLowerCase() === String(oldProviderName).toLowerCase());
            const replacement = sameProvider || chatArr[0];
            setModelName(replacement.id);
            if (replacement.provider) setProvider(replacement.provider);
            localStorage.setItem('rexi_model', replacement.id);
            // Toast Ä‘Ãºng 1 láº§n cho má»—i model bá»‹ thay (chá»‘ng Ä‘Ãºp khi SSE + interval + event cháº¡y cÃ¹ng lÃºc)
            if (modelName && lastAutoSwapRef.current !== modelName) {
              lastAutoSwapRef.current = modelName;
              showToast(`âš ï¸ ${modelName} ${t(lang, 'khÃ´ng cÃ²n kháº£ dá»¥ng sau lÆ°á»£t quÃ©t â€” tá»± chuyá»ƒn sang')} ${replacement.id}`, 'info');
            }
          }
        }
      } else {
        setAvailableModels([]);
      }
    } catch {
      setAvailableModels([]);
    }
  };

  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authFullName, setAuthFullName] = useState('');

  // Handle Google/GitHub OAuth redirect (runs in popup OR main window)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let googleToken = params.get('google_token');
    let googleUser = params.get('user');
    const googleError = params.get('error');
    let githubToken = params.get('github_token');
    let githubUser = params.get('user');

    if (!googleToken && window.location.hash.includes('google_token=')) {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      googleToken = hashParams.get('google_token');
      googleUser = hashParams.get('user');
    }
    if (!githubToken && window.location.hash.includes('github_token=')) {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      githubToken = hashParams.get('github_token');
      githubUser = hashParams.get('user');
    }

    const oauthToken = googleToken || githubToken;
    const oauthUser = googleToken ? googleUser : githubUser;
    const provider = googleToken ? 'Google' : (githubToken ? 'GitHub' : null);

    if (oauthToken && oauthUser) {
      try {
        const user = JSON.parse(decodeURIComponent(oauthUser));
        setAuthToken(oauthToken);
        localStorage.setItem('rexi_token', oauthToken);
        setCurrentUser(user);
        localStorage.setItem('rexi_user', JSON.stringify(user));
        window.history.replaceState({}, document.title, window.location.pathname);
        // Náº¿u Ä‘ang á»Ÿ popup â†’ bÃ¡o cho parent qua postMessage (dá»± phÃ²ng khi
        // storage event khÃ´ng tá»›i) rá»“i Ä‘Ã³ng popup; parent detect qua cáº£ 2 kÃªnh.
        if (window.opener) {
          try { window.opener.postMessage('rexi_oauth_success', window.location.origin); } catch (_) {}
          window.close();
        } else {
          showToast(`${t(lang, 'ÄÄƒng nháº­p')} ${provider} ${t(lang, 'thÃ nh cÃ´ng!')}`);
        }
      } catch (e) {
        console.error('[Auth] Failed to parse OAuth user:', e);
        if (window.opener) window.close();
      }
    } else if (googleError) {
      if (!window.opener) alert(t(lang, 'ÄÄƒng nháº­p tháº¥t báº¡i: ') + googleError);
      window.history.replaceState({}, document.title, '/');
      if (window.opener) window.close();
    }
  }, []);

  // Handle social connectors redirect (?social_connected=<p> / ?social_error=<...>)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const connected = params.get('social_connected');
      const socialError = params.get('social_error');
      if (!connected && !socialError) return;
      const names = { x: 'X (Twitter)', tiktok: 'TikTok', instagram: 'Instagram' };
      if (connected) {
        showToast(`${t(lang, 'ÄÃ£ káº¿t ná»‘i')} ${names[connected] || connected}!`, 'success');
      } else {
        showToast(`${t(lang, 'Káº¿t ná»‘i máº¡ng xÃ£ há»™i tháº¥t báº¡i: ')}${socialError}`, 'error');
      }
      params.delete('social_connected');
      params.delete('social_error');
      const qs = params.toString();
      window.history.replaceState({}, document.title, window.location.pathname + (qs ? `?${qs}` : ''));
    } catch (e) {
      console.warn('[Social] query param handling failed', e);
    }
  }, []);

  const chatScrollRef = useRef(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // TÃ­nh hiá»‡n/áº©n nÃºt cuá»™n tá»« vá»‹ trÃ­ thá»±c táº¿ â€” gá»i sau má»i thay Ä‘á»•i ná»™i dung/
  // chuyá»ƒn Ä‘oáº¡n chat (fix bug cá» káº¹t true khi chat má»›i ngáº¯n khÃ´ng cuá»™n Ä‘Æ°á»£c).
  // á»ž sÃ¡t Ä‘Ã¡y (cÃ¡ch Ä‘Ã¡y <= 60px) thÃ¬ áº©n Háº¾T â€” Ä‘ang Ä‘á»c tin má»›i nháº¥t, pill
  // ná»•i che chá»¯ ráº¥t khÃ³ chá»‹u.
  const updateScrollFlags = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distFromTop = el.scrollTop;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distFromBottom <= 80;
    setShowScrollTop(distFromTop > 220 && !nearBottom);
    setShowScrollBottom(distFromBottom > 220);
  };

  // Hiá»‡n/áº©n 2 nÃºt cuá»™n lÃªn-xuá»‘ng theo vá»‹ trÃ­ cuá»™n
  const handleChatScroll = () => { updateScrollFlags(); };

  const scrollToTopSmooth = () => {
    chatScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottomSmooth = () => {
    const el = chatScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  const fileInputRef = useRef(null);

   useEffect(() => {
    const fetchTtsVoices = async () => {
      try {
        const res = await fetch(`${API_BASE}/services/tts/voices`, {
          headers: authHeaders(),
          credentials: 'include'
        });
        const data = await res.json();
        if (data.success && data.voices) {
          setTtsVoices(data.voices);
        }
      } catch {
        console.log('[TTS] Could not fetch voices, using defaults');
      } finally {
        setTtsVoicesLoading(false);
      }
    };
    fetchTtsVoices();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Token háº¿t háº¡n â†’ xÃ³a token cÅ©, má»Ÿ mÃ n hÃ¬nh Ä‘Äƒng nháº­p Ä‘á»ƒ user Ä‘Äƒng nháº­p láº¡i
  useEffect(() => {
    const onSessionExpired = () => {
      localStorage.removeItem('rexi_token');
      localStorage.removeItem('rexi_user');
      setAuthToken('');
      setCurrentUser(null);
      setAuthModalOpen(true);
      showToast(t(lang, 'PhiÃªn Ä‘Äƒng nháº­p Ä‘Ã£ háº¿t háº¡n. Vui lÃ²ng Ä‘Äƒng nháº­p láº¡i.'), 'error');
    };
    window.addEventListener('rexi_session_expired', onSessionExpired);
    return () => window.removeEventListener('rexi_session_expired', onSessionExpired);
  }, []);

  // Äá»•i identity (login/logout/chuyá»ƒn tÃ i khoáº£n) â†’ bá» conv Ä‘ang má»Ÿ + xÃ³a list cÅ©.
  // Conv cÅ© thuá»™c identity cÅ© (guest conv gáº¯n session cÅ©, user conv cá»§a tÃ i khoáº£n cÅ©)
  // â†’ giá»¯ láº¡i sáº½ gá»­i tin vÃ o conv khÃ´ng cÃ²n quyá»n (403) hoáº·c hiá»‡n nháº§m lá»‹ch sá»­ ngÆ°á»i khÃ¡c.
  const authIdRef = useRef(undefined);
  useEffect(() => {
    const id = currentUser
      ? (currentUser.ma_nguoi_dung || currentUser.id || currentUser.email || 'user')
      : null;
    if (authIdRef.current === undefined) { authIdRef.current = id; return; }
    if (authIdRef.current !== id) {
      authIdRef.current = id;
      setActiveConvId(null);
      setConversations([]);
    }
  }, [currentUser]);

  // Listen for token changes from OAuth popup (storage event + postMessage dá»± phÃ²ng)
  useEffect(() => {
    const pullFromStorage = () => {
      const tok = localStorage.getItem('rexi_token');
      if (!tok) return false;
      setAuthToken(tok);
      const savedUser = localStorage.getItem('rexi_user');
      if (savedUser) {
        try { setCurrentUser(JSON.parse(savedUser)); } catch (e) { console.warn('[rexi] corrupt rexi_user in storage', e); }
      }
      return true;
    };
    const onStorage = (e) => {
      if (e.key === 'rexi_token' && e.newValue) {
        pullFromStorage();
        showToast(t(lang, 'ÄÄƒng nháº­p thÃ nh cÃ´ng!'));
      }
    };
    const onMessage = (e) => {
      if (e.data === 'rexi_oauth_success') {
        if (pullFromStorage()) showToast(t(lang, 'ÄÄƒng nháº­p thÃ nh cÃ´ng!'));
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('rexi_theme_v2', currentTheme);
    // Cross-fade khi Ä‘á»•i theme: báº­t transition mÃ u 400ms rá»“i gá»¡ (trÃ¡nh áº£nh hÆ°á»Ÿng animation khÃ¡c)
    try {
      document.documentElement.classList.add('theme-anim');
      const t = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
      return () => { clearTimeout(t); document.documentElement.classList.remove('theme-anim'); };
    } catch (e) { /* ignore */ }
  }, [currentTheme]);

  // ÄÃ³ng FAB menu overlay khi Ä‘á»•i tab
  useEffect(() => {
    setFabOpen(false);
  }, [activeTab]);

  useEffect(() => {
    fetchConversations();
    fetchFileTree();
    fetchDbSkills();
    fetchGitStatus();
    fetchMemories();
    fetchAvailableModels();
    if (!currentUser) fetchGuestLimits();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Login (form/Google) lÃ  SPA transition, khÃ´ng reload trang: cÃ¡c fetch á»Ÿ trÃªn Ä‘Ã£ cháº¡y
  // khi CHÆ¯A cÃ³ token (401 â†’ dá»¯ liá»‡u rá»—ng cáº£ session). Khi user Ä‘Æ°á»£c set sau mount â†’ táº£i láº¡i.
  const authRefetchInitRef = useRef(false);
  useEffect(() => {
    if (!authRefetchInitRef.current) { authRefetchInitRef.current = true; return; }
    if (!currentUser) return;
    fetchConversations();
    fetchFileTree();
    fetchDbSkills();
    fetchGitStatus();
    fetchMemories();
    fetchAvailableModels();
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Khi cÃ³ model má»›i Ä‘Æ°á»£c Ä‘Äƒng táº£i hoáº·c quÃ©t xong tá»« Admin Panel â†’ load láº¡i danh sÃ¡ch model á»Ÿ Menu Header Trang Chá»§
  useEffect(() => {
    fetchAvailableModels();

    const handleModelsPublished = () => {
      fetchAvailableModels();
    };
    window.addEventListener('rexi_models_published', handleModelsPublished);
    return () => window.removeEventListener('rexi_models_published', handleModelsPublished);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE: tá»± Ä‘á»™ng cáº­p nháº­t danh sÃ¡ch model khi backend scan xong hoáº·c Admin cáº­p nháº­t
  useEffect(() => {
    const evtSource = new EventSource(`${API_BASE.replace('/api', '')}/api/models/stream`);
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('[SSE] Model scan/update complete:', data);
        fetchAvailableModels();
      } catch (err) { console.warn('[rexi] bad SSE model payload', err); }
    };
    evtSource.onerror = () => {};
    return () => evtSource.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ðŸ”„ Auto-refresh danh sÃ¡ch model má»—i 60s â€” Ä‘áº£m báº£o tab Ä‘ang má»Ÿ váº«n tá»± cáº­p nháº­t model má»›i
  // khi Admin quÃ©t xong (khÃ´ng cáº§n F5, khÃ´ng phá»¥ thuá»™c duy nháº¥t vÃ o SSE)
  useEffect(() => {
    fetchAvailableModels();
    const timer = setInterval(fetchAvailableModels, 60000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchGuestLimits = async () => {
    try {
      const data = await apiFetch('/chat/guest-limits');
      if (data.success && data.limits && data.limits.messages) {
        setGuestLimits(data.limits);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    // Äá»•i Ä‘oáº¡n chat â†’ reset cá» cuá»™n ngay (chat má»›i chÆ°a cÃ³ sá»± kiá»‡n cuá»™n Ä‘á»ƒ tá»± cáº­p nháº­t)
    setShowScrollTop(false);
    setShowScrollBottom(false);
    if (activeConvId) {
      // Conv do handleSendMessage vá»«a táº¡o â†’ state Ä‘Ã£ cÃ³ tin optimistic, khÃ´ng refetch (chá»‘ng dup)
      if (skipConvFetchRef.current) { skipConvFetchRef.current = false; return; }
      fetchMessages(activeConvId);
    } else {
      setMessages([]);
    }
  }, [activeConvId]); // eslint-disable-line react-hooks/exhaustive-deps

useEffect(() => {
     if (chatScrollRef.current) {
       const el = chatScrollRef.current;
       const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
       if (nearBottom) {
         el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
       }
     }
     // Äo láº¡i sau khi layout xong (tin nháº¯n má»›i cÃ³ thá»ƒ lÃ m cá» cÅ© sai)
     const t = setTimeout(updateScrollFlags, 120);
     return () => clearTimeout(t);
   }, [messages, loading]);

  const fetchConversations = async () => {
    try {
      const data = await apiFetch('/chat/conversations', { headers: authHeaders() });
      setConversations(data);
      if (data.length > 0 && !activeConvId) {
        setActiveConvId(data[0].ma_hoi_thoai);
      }
    } catch (e) { console.log(e); }
  };

  const fetchMessages = async (convId) => {
    try {
      const data = await apiFetch(`/chat/conversations/${convId}/messages`, { headers: authHeaders() });
      setMessages(data);
    } catch (e) { console.log(e); }
  };

  const fetchFileTree = async () => {
    try {
      const data = await apiFetch('/workspace/files', { headers: authHeaders() });
      setFileTree(data);
    } catch (e) { console.log(e); }
  };

  const fetchDbSkills = async () => {
    try {
      const data = await apiFetch('/services/skills', { headers: authHeaders() });
      setDbSkills(data);
    } catch (e) { console.log(e); }
  };

  const fetchGitStatus = async () => {
    try {
      const data = await apiFetch('/chat/git/status', { headers: authHeaders() });
      setGitStatus(data);
    } catch (e) { console.log(e); }
  };

  const fetchMemories = async () => {
    try {
      const data = await apiFetch('/chat/memory', { headers: authHeaders() });
      setMemories(data);
    } catch (e) { console.log(e); }
  };

  const fetchIPTV = async (cat, country, search) => {
    try {
      let url = '/services/iptv/channels?';
      if (country) url += `country=${country}&`;
      else if (cat) url += `category=${cat}&`;
      if (search) url += `search=${encodeURIComponent(search)}`;
      const data = await apiFetch(url, { headers: authHeaders() });
      if (data.channels) {
        setIptvChannels(data.channels);
        if (data.channels.length > 0) setSelectedChannel(data.channels[0]);
      }
    } catch (e) { console.log(e); }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (iptvTab === 'category') fetchIPTV(iptvCategory, null, iptvSearch);
      else if (iptvCountry) fetchIPTV(null, iptvCountry, iptvSearch);
      else fetchIPTV(iptvCategory || 'news', null, iptvSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [iptvSearch, iptvCategory, iptvCountry, iptvTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // HLS.js player for IPTV
  // PhÃ¡t cÃ³ tiáº¿ng; náº¿u trÃ¬nh duyá»‡t cháº·n autoplay cÃ³ tiáº¿ng â†’ tá»± mute rá»“i phÃ¡t (user báº¥m loa Ä‘á»ƒ báº­t tiáº¿ng)
  const tryPlay = useCallback((video) => {
    video.muted = false;
    video.play().catch(() => {
      try {
        video.muted = true;
        video.play().catch(() => {});
      } catch { /* ignore */ }
    });
  }, []);
  const playHlsStream = useCallback(async (url) => {
    const video = iptvVideoRef.current;
    if (!video) return;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    setIptvEmbeddedSubs([]);
    setIptvError('');
    // HÃ m Ä‘á»c track phá»¥ Ä‘á» vá»›i delay (hls.js populate subtitleTracks cháº­m hÆ¡n MANIFEST_PARSED)
    const readEmbeddedSubs = (hls) => {
      setTimeout(() => {
        try {
          // Chá»‰ Ã¡p dá»¥ng náº¿u hls nÃ y váº«n lÃ  instance Ä‘ang phÃ¡t (trÃ¡nh race khi Ä‘á»•i kÃªnh nhanh)
          if (hlsRef.current !== hls) return;
          const subs = (hls.subtitleTracks || []).map(s => ({ id: s.id, name: s.name || s.lang || t(lang, 'Phá»¥ Ä‘á»') }));
          if (subs.length) setIptvEmbeddedSubs(subs);
        } catch { /* ignore */ }
      }, 1200);
    };
    if (url.includes('youtube') || url.includes('youtu.be')) {
      // youtube: fallback handled in JSX
      return;
    }
    // ChÆ¡i qua proxy same-origin (Ä‘Ã£ cÃ³ sáºµn /api/services/iptv/proxy) Ä‘á»ƒ
    // video.captureStream() láº¥y Ä‘Æ°á»£c audio track â†’ Phá»¥ Äá» AI hoáº¡t Ä‘á»™ng Ä‘Æ°á»£c
    // P2-19d: proxy giá» yÃªu cáº§u auth â€” <video>/hls.js khÃ´ng gá»­i Ä‘Æ°á»£c Authorization
    // header nÃªn kÃ¨m token qua ?token= (backend bridge sang header).
    const _proxyToken = localStorage.getItem('rexi_token') || '';
    const streamUrl = `${API_BASE}/services/iptv/proxy?url=${encodeURIComponent(url)}${_proxyToken ? `&token=${encodeURIComponent(_proxyToken)}` : ''}`;
    let fallbackTried = false;
    const failChannel = () => setIptvError(t(lang, 'KÃªnh nÃ y hiá»‡n khÃ´ng phÃ¡t Ä‘Æ°á»£c â€” thá»­ kÃªnh khÃ¡c.'));
    let Hls;
    try { Hls = await loadHls(); } catch { failChannel(); return; }
    const attachFallback = () => {
      // Fallback: proxy lá»—i â†’ thá»­ phÃ¡t trá»±c tiáº¿p URL gá»‘c (giá»¯ kÃªnh cháº¡y nhÆ° trÆ°á»›c)
      fallbackTried = true;
      try { hlsRef.current?.destroy(); } catch { /* ignore */ }
      hlsRef.current = null;
      if (Hls.isSupported()) {
        const fb = new Hls({ enableWorker: false });
        fb.loadSource(url);
        fb.attachMedia(video);
        fb.on(Hls.Events.MANIFEST_PARSED, () => {
          setIptvError('');
          tryPlay(video);
          readEmbeddedSubs(fb);
        });
        fb.on(Hls.Events.SUBTITLE_TRACKS_LOADED, () => readEmbeddedSubs(fb));
        fb.on(Hls.Events.ERROR, (evt, data) => {
          if (data.fatal) failChannel();
        });
        hlsRef.current = fb;
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        setIptvError('');
        tryPlay(video);
      } else {
        failChannel();
      }
    };
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIptvError('');
        tryPlay(video);
        readEmbeddedSubs(hls);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_LOADED, () => readEmbeddedSubs(hls));
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (data.fatal && !fallbackTried) attachFallback();
        else if (data.fatal) failChannel();
      });
      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      setIptvError('');
      tryPlay(video);
      video.onerror = () => {
        if (!fallbackTried) attachFallback();
        else failChannel();
      };
    } else {
      failChannel();
    }
  }, [iptvVideoRef, hlsRef, tryPlay, lang]);

  useEffect(() => {
    if (selectedChannel) playHlsStream(selectedChannel.url);
  }, [selectedChannel, playHlsStream]);

  const fetchDesktopScreenshot = async () => {
    setDesktopLoading(true);
    setDesktopError(null);
    try {
      // DÃ¹ng fetch trá»±c tiáº¿p vÃ¬ response lÃ  áº£nh blob (apiFetch parse JSON nÃªn khÃ´ng dÃ¹ng Ä‘Æ°á»£c)
      const res = await fetch(`${API_BASE}/services/desktop/screenshot?t=${Date.now()}`, {
        headers: authHeaders(),
        credentials: 'include'
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setDesktopScreenshot(url);
      } else {
        let msg = `${t(lang, 'Lá»—i chá»¥p mÃ n hÃ¬nh (')}${res.status}). ${t(lang, 'Thá»­ láº¡i sau.')}`;
        try { const d = await res.json(); if (d?.error) msg = d.error; } catch (e) {}
        setDesktopScreenshot(null);
        setDesktopError(res.status === 401
          ? t(lang, 'Cáº§n Ä‘Äƒng nháº­p Ä‘á»ƒ dÃ¹ng Remote Desktop.')
          : msg);
      }
    } catch (e) {
      setDesktopScreenshot(null);
      setDesktopError(e.message || t(lang, 'KhÃ´ng thá»ƒ káº¿t ná»‘i'));
    } finally { setDesktopLoading(false); }
  };

  const fetchGitDiff = async () => {
    try {
      const d = await apiFetch('/chat/git/diff', { headers: authHeaders() });
      setGitDiff(d.diff || '');
    } catch (e) { console.warn('[rexi] git diff fetch failed', e); }
  };

  useEffect(() => {
    if (activeTab === 'iptv' && iptvChannels.length === 0) fetchIPTV('news');
    if (activeTab === 'desktop') fetchDesktopScreenshot();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const creatingConvRef = useRef(false); // cháº·n click-spam: POST conv chÆ°a xong mÃ  báº¥m tiáº¿p
  const handleNewConversation = async () => {
    if (creatingConvRef.current) return; // Ä‘ang táº¡o dá»Ÿ (await POST) â†’ bá» qua click thá»«a
    // Náº¿u cuá»™c trÃ² chuyá»‡n hiá»‡n táº¡i chÆ°a cÃ³ tin nháº¯n nÃ o â†’ khÃ´ng cho táº¡o thÃªm
    if (activeConvId && messages.length === 0) {
      return; // ÄÃ£ cÃ³ cuá»™c trÃ² chuyá»‡n trá»‘ng, khÃ´ng táº¡o thÃªm
    }
    creatingConvRef.current = true;
    try {
      const data = await apiFetch('/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ tieu_de: t(lang, 'TrÃ² chuyá»‡n má»›i'), ten_mo_hinh_ai: modelName })
      });
      setConversations(prev => [data, ...prev]);
      setActiveConvId(data.ma_hoi_thoai);
      setMessages([]);
    } catch (e) { console.error(e); }
    finally { creatingConvRef.current = false; }
  };

  const handleDeleteConversation = async (id, e) => {
    e.stopPropagation();
    try {
      await apiFetch(`/chat/conversations/${id}`, { method: 'DELETE', headers: authHeaders() });
      setConversations(prev => prev.filter(c => c.ma_hoi_thoai !== id));
      if (activeConvId === id) setActiveConvId(null);
    } catch (err) {
      if (err.status === 401) {
        showToast(t(lang, 'ÄÄƒng nháº­p Ä‘á»ƒ xÃ³a há»™i thoáº¡i.'), 'error');
      } else if (err.status === 403) {
        showToast(t(lang, 'Báº¡n chá»‰ cÃ³ thá»ƒ xÃ³a há»™i thoáº¡i cá»§a mÃ¬nh.'), 'error');
      } else {
        showToast(err.message || t(lang, 'XÃ³a há»™i thoáº¡i tháº¥t báº¡i.'), 'error');
      }
    }
  };

  const handleTogglePin = async (conv, e) => {
    if (e) e.stopPropagation();
    const next = conv.da_ghim ? 0 : 1;
    setConversations(prev => prev.map(c => c.ma_hoi_thoai === conv.ma_hoi_thoai ? { ...c, da_ghim: next } : c));
    try {
      await apiFetch(`/chat/conversations/${conv.ma_hoi_thoai}/pin`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ da_ghim: next })
      });
    } catch (err) {
      setConversations(prev => prev.map(c => c.ma_hoi_thoai === conv.ma_hoi_thoai ? { ...c, da_ghim: conv.da_ghim || 0 } : c));
      showToast(err.message || (next ? t(lang, 'Ghim há»™i thoáº¡i tháº¥t báº¡i.') : t(lang, 'Bá» ghim tháº¥t báº¡i.')), 'error');
    }
  };

  // ÄÃ­nh kÃ¨m file: áº£nh â†’ downscale (giá»¯ vision, cháº·n base64 khá»•ng lá»“ phÃ¬nh prompt/DB);
  // file text â†’ Ä‘á»c text cáº¯t 15k kÃ½ tá»±; binary khÃ¡c â†’ tá»« chá»‘i (PDF dÃ¹ng nÃºt PDF riÃªng).
  const MAX_IMAGE_DIM = 1568;
  const MAX_IMAGE_OUT = 4 * 1024 * 1024; // base64 áº£nh sau xá»­ lÃ½
  const MAX_TEXT_IN = 100 * 1024; // text Ä‘áº§u vÃ o
  const MAX_TEXT_SEND = 15000; // text gá»­i vÃ o prompt

  const downscaleImage = (dataUrl) => new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          let q = 0.85, out = cv.toDataURL('image/jpeg', q);
          while (out.length > MAX_IMAGE_OUT && q > 0.4) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
          resolve(out.length <= MAX_IMAGE_OUT ? out : null);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });

  const handleFileSelect = (e) => {
    Array.from(e.target.files || []).forEach((file) => {
      const reader = new FileReader();
      const isImage = (file.type || '').startsWith('image/');
      const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/.test(file.type || '')
        || /\.(txt|md|csv|json|js|ts|py|java|html?|css|xml|log|ini|cfg)$/i.test(file.name || '');
      if (isImage) {
        if (file.size > 15 * 1024 * 1024) { showToast?.(`${t(lang, 'áº¢nh')} ${file.name} ${t(lang, 'quÃ¡ lá»›n (>15MB), bá» qua.')}`, 'error'); return; }
        reader.readAsDataURL(file);
        reader.onload = async () => {
          const small = await downscaleImage(String(reader.result || ''));
          if (!small) { showToast?.(`${t(lang, 'KhÃ´ng xá»­ lÃ½ Ä‘Æ°á»£c áº£nh')} ${file.name}.`, 'error'); return; }
          const item = { name: file.name, isImage: true, dataUrl: small };
          setAttachedFiles(p => [...p, item]);
          // QuÃ©t QR/barcode trong áº£nh (náº¿u cÃ³) â€” hiá»‡n ná»™i dung + cáº£nh bÃ¡o link
          try {
            const b64 = String(small).split(',')[1] || '';
            const r = await fetch(`${API_BASE}/services/qr`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ name: file.name, base64: b64 }),
            });
            const d = await r.json();
            if (d && d.values && d.values.length) {
              setAttachedFiles(p => p.map(x => (x === item ? { ...x, qr: d.values } : x)));
            }
          } catch (e) { console.warn('[qr] scan lá»—i:', e.message); }
        };
      } else if (isText) {
        if (file.size > MAX_TEXT_IN) { showToast?.(`File ${file.name} ${t(lang, 'quÃ¡ lá»›n (>100KB), bá» qua.')}`, 'error'); return; }
        reader.readAsText(file);
        reader.onload = () => {
          const t = String(reader.result || '');
          const cut = t.length > MAX_TEXT_SEND ? t.slice(0, MAX_TEXT_SEND) + (getLang() === 'en' ? `\n...[trimmed, file is ${t.length} chars]` : `\n...[Ä‘Ã£ cáº¯t, file dÃ i ${t.length} kÃ½ tá»±]`) : t;
          setAttachedFiles(p => [...p, { name: file.name, isImage: false, isBinary: false, textContent: cut }]);
        };
      } else {
        showToast?.(`${t(lang, 'KhÃ´ng há»— trá»£ file')} ${file.name} ${t(lang, 'á»Ÿ Ä‘Ã¢y (PDF dÃ¹ng nÃºt ðŸ“„, áº£nh/text má»›i Ä‘Ã­nh kÃ¨m Ä‘Æ°á»£c).')}`, 'error');
      }
    });
    e.target.value = '';
  };

  const handleRemoveFile = (idx) => setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));

  // Chia sáº» há»™i thoáº¡i Ä‘ang má»Ÿ -> tráº£ link cÃ´ng khai (backend Ä‘Ã£ cÃ³ POST /services/conversations/:id/share)
  const handleShareConversation = async () => {
    if (!activeConvId) throw new Error(t(lang, 'ChÆ°a cÃ³ há»™i thoáº¡i Ä‘á»ƒ chia sáº»'));
    const data = await apiFetch(`/services/conversations/${activeConvId}/share`, { method: 'POST' });
    if (!data || !data.success) throw new Error((data && data.error) || t(lang, 'KhÃ´ng táº¡o Ä‘Æ°á»£c link chia sáº»'));
    const path = data.share_url || `/api/services/share/${data.share_token}`;
    return new URL(path, window.location.origin).href;
  };

  const handleSendMessage = async (textToSend) => {
    let text = textToSend || inputText;
    if (!text.trim() && attachedFiles.length === 0) return;
    if (loading) return;

    // â”€â”€â”€ INTENT ROUTER: nháº­n diá»‡n Ã½ Ä‘á»‹nh cÃ¢u chat â†’ tá»± má»Ÿ tab phÃ¹ há»£p â”€â”€â”€
    // Chá»‰ auto-chuyá»ƒn tab khi chÆ°a báº­t Agent Mode vÃ  cÃ¢u cÃ³ Ã½ Ä‘á»‹nh rÃµ rÃ ng (high confidence)
    if (executionMode !== 'agent' && attachedFiles.length === 0) {
      try {
        const intentRes = await apiFetch('/chat/intent', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ noi_dung: text })
        });
        if (intentRes && intentRes.success && intentRes.confidence === 'high' && intentRes.tab && intentRes.tab !== 'chat') {
          handleSetActiveTab(intentRes.tab);
          showToast(`${t(lang, 'ÄÃ£ chuyá»ƒn sang: ')}${intentRes.label}`, 'info');
          return;
        }
      } catch (e) { /* intent lá»—i khÃ´ng cháº·n chat */ }
    }

    if (attachedFiles.length > 0) {
      attachedFiles.forEach(f => {
        text += f.isImage ? `\n\n![${f.name}](${f.dataUrl})` :
          f.isBinary ? `\n\n[File: ${f.name}](${f.dataUrl})` :
          `\n\n\`\`\`${f.name}\n${f.textContent}\n\`\`\``;
      });
    }

    let convId = activeConvId;
    if (!convId) {
      try {
        const data = await apiFetch('/chat/conversations', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ tieu_de: text.replace(/!\[.*?\]\(.*?\)/g, '').substring(0, 30), ten_mo_hinh_ai: modelName })
        });
        convId = data.ma_hoi_thoai;
        skipConvFetchRef.current = true; // cháº·n useEffect refetch â€” state Ä‘Ã£ cÃ³ tin optimistic
        setActiveConvId(convId);
        setConversations(prev => [data, ...prev]);
      } catch (e) {
        console.error('[Chat] KhÃ´ng táº¡o Ä‘Æ°á»£c há»™i thoáº¡i:', e);
        convId = null;
      }
    }

    // Double-check: náº¿u váº«n chÆ°a cÃ³ convId (cÃ³ thá»ƒ do race condition), bÃ¡o lá»—i thay vÃ¬ gá»­i vÃ o path rá»—ng
    if (!convId) {
      setMessages(prev => [...prev, {
        ma_tin_nhan: Date.now().toString(),
        vai_tro: 'assistant',
        noi_dung: t(lang, 'âš ï¸ KhÃ´ng thá»ƒ táº¡o cuá»™c trÃ² chuyá»‡n. Vui lÃ²ng thá»­ láº¡i.')
      }]);
      setLoading(false);
      return;
    }

    const tempUserMsg = { ma_tin_nhan: Date.now().toString(), vai_tro: 'user', noi_dung: text };
    setMessages(prev => [...prev, tempUserMsg]);
    setInputText('');
    setAttachedFiles([]);
    setLoading(true);
    let streamStarted = false;
    const streamMsgId = 'stream_' + Date.now();

    try {
      // DÃ¹ng fetch trá»±c tiáº¿p (khÃ´ng qua apiFetch) vÃ¬ cáº§n Ä‘á»c SSE stream tá»« Response
      const res = await fetch(`${API_BASE}/chat/conversations/${convId}/messages/stream`, {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          vai_tro: 'user',
          noi_dung: text,
          provider: provider,
          client_api_key: apiKey,
          model_name: modelName,
          base_url: baseUrl,
          mode: aiSpecialty,
          execution_mode: executionMode,
          agent_engine: agentEngine,
          thinking_level: thinkingLevel === 'deep' ? 'deep' : 'normal'
        })
      });

      // Rate Limit (429) â€” middleware tráº£ JSON trÆ°á»›c khi vÃ o SSE handler
      if (res.status === 429) {
        setRateLimitToast(t(lang, 'QuÃ¡ nhiá»u yÃªu cáº§u trong thá»i gian ngáº¯n (Rate Limit Exceeded). Vui lÃ²ng Ä‘á»£i 1 phÃºt.'));
        if (rateLimitTimerRef.current) clearTimeout(rateLimitTimerRef.current);
        rateLimitTimerRef.current = setTimeout(() => setRateLimitToast(''), 5000);
        return;
      }

      // Guest limit / yÃªu cáº§u Ä‘Äƒng nháº­p (401) â€” middleware tráº£ JSON
      if (res.status === 401) {
        const errorData = await res.json().catch(() => ({}));
        // Token khÃ´ng há»£p lá»‡ / háº¿t háº¡n â†’ xÃ³a token cÅ© + má»Ÿ láº¡i mÃ n hÃ¬nh Ä‘Äƒng nháº­p
        if (errorData.code === 'INVALID_TOKEN') {
          window.dispatchEvent(new CustomEvent('rexi_session_expired', { detail: errorData.error }));
          return;
        }
        if (errorData.code === 'LOGIN_REQUIRED' || errorData.code === 'AGENT_LIMIT_REACHED') {
          const isAgentLimit = errorData.code === 'AGENT_LIMIT_REACHED';
          setMessages(prev => [...prev.filter(m => m.ma_tin_nhan !== tempUserMsg.ma_tin_nhan), tempUserMsg, {
            ma_tin_nhan: Date.now().toString(),
            vai_tro: 'assistant',
            noi_dung: isAgentLimit
                ? t(lang, 'ðŸ”’ **ÄÃ£ háº¿t lÆ°á»£t Agent Mode.**\n\nBáº¡n Ä‘Ã£ dÃ¹ng háº¿t **3 lÆ°á»£t** Agent cho tÃ i khoáº£n khÃ¡ch.\n\nÄÄƒng nháº­p Ä‘á»ƒ:\nâœ… Agent Mode khÃ´ng giá»›i háº¡n\nâœ… Chat khÃ´ng giá»›i háº¡n\nâœ… LÆ°u lá»‹ch sá»­ & Memory')
                : t(lang, 'ðŸ”’ **ÄÃ£ háº¿t lÆ°á»£t chat.**\n\nBáº¡n Ä‘Ã£ dÃ¹ng háº¿t **10 tin nháº¯n** cho tÃ i khoáº£n khÃ¡ch.\n\nÄÄƒng nháº­p Ä‘á»ƒ:\nâœ… Chat khÃ´ng giá»›i háº¡n\nâœ… Agent Mode khÃ´ng giá»›i háº¡n\nâœ… LÆ°u lá»‹ch sá»­ & Memory')
          }]);
          fetchGuestLimits();
          setTimeout(() => setAuthModalOpen(true), 500);
        }
        return;
      }

      // Fallback: response khÃ´ng pháº£i SSE (backend tráº£ JSON lá»—i khÃ¡c) â†’ xá»­ lÃ½ JSON
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        if (res.ok) {
          const aiMsg = await res.json();
          setMessages(prev => [...prev.filter(m => m.ma_tin_nhan !== tempUserMsg.ma_tin_nhan), tempUserMsg, aiMsg]);
          fetchConversations();
          if (!currentUser) fetchGuestLimits();
        } else {
          setMessages(prev => [...prev.filter(m => m.ma_tin_nhan !== tempUserMsg.ma_tin_nhan), tempUserMsg, {
            ma_tin_nhan: Date.now().toString(), vai_tro: 'assistant',
            noi_dung: `âš ï¸ ${t(lang, 'Lá»—i Server (')}${res.status}). ${t(lang, 'HÃ£y kiá»ƒm tra Backend Ä‘Ã£ cháº¡y chÆ°a vÃ  API Key trong má»¥c CÃ i Äáº·t!')}`
          }]);
        }
        return;
      }

      // ---- Äá»c SSE stream: hiá»ƒn thá»‹ token theo thá»i gian thá»±c ----
      streamStarted = true;
      let aiText = '';
      let finalMaTinNhan = streamMsgId;
      setMessages(prev => [...prev.filter(m => m.ma_tin_nhan !== tempUserMsg.ma_tin_nhan), tempUserMsg, { ma_tin_nhan: streamMsgId, vai_tro: 'assistant', noi_dung: '' }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      const updateAI = (t) => setMessages(prev => prev.map(m => m.ma_tin_nhan === streamMsgId ? { ...m, noi_dung: t } : m));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop();
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith('data: ')) continue;
          let payload;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload.type === 'route') {
            // Äá»‹nh tuyáº¿n: hiá»ƒn thá»‹ provider/model há»‡ thá»‘ng tá»± chá»n
            const cat = payload.category || 'auto';
            const routeBadge = `ðŸ“¡ **${t(lang, 'Äá»‹nh tuyáº¿n (Auto):')}** ${(payload.provider || '').toUpperCase()} â†’ \`${payload.model || ''}\` (${t(lang, 'loáº¡i:')} ${cat})`;
            aiText += '\n\n<small>' + routeBadge + '</small>\n\n';
            updateAI(aiText);
          }
          else if (payload.type === 'token') { aiText += payload.text; updateAI(aiText); }
          else if (payload.type === 'status') { if (!aiText) updateAI(payload.message); }
          else if (payload.type === 'error') { aiText = aiText ? aiText + '\n\nâš ï¸ ' + payload.message : payload.message; updateAI(aiText); }
          else if (payload.type === 'done') { finalMaTinNhan = payload.ma_tin_nhan || finalMaTinNhan; if (payload.noi_dung) { aiText = payload.noi_dung; updateAI(aiText); } }
        }
      }

      // Cáº­p nháº­t ma_tin_nhan cuá»‘i (khá»›p DB) + lÃ m sáº¡ch thÃ´ng bÃ¡o lá»—i há»‡ thá»‘ng & suy luáº­n nhÃ¡p
      setMessages(prev => prev.map(m => {
        if (m.ma_tin_nhan !== streamMsgId) return m;
        let finalText = aiText;
        if (finalText && /Here'?s a thinking process:/i.test(finalText)) {
          const finalMatch = finalText.match(/(?:Output matches draft|Final Output|Output):\s*([âœ…\s\S]+)$/i);
          if (finalMatch && finalMatch[1]) finalText = finalMatch[1].replace(/^[âœ…\s]+/, '').trim();
          else {
            const draftMatch = finalText.match(/Draft:\s*"([^"]+)"/i);
            if (draftMatch && draftMatch[1]) finalText = draftMatch[1].trim();
          }
        }
        if (finalText && (finalText.includes('The filename, directory name') || finalText.includes('syntax is incorrect'))) {
          finalText = `${t(lang, 'Xin chÃ o')} **${currentUser?.ten_day_du || 'USER'}**! ${t(lang, 'TÃ´i lÃ ')} **Rexi AI Assistant**.\n\n${t(lang, 'Há»‡ thá»‘ng Ä‘Ã£ sáºµn sÃ ng 100% vá»›i bá»™')} **35+ Skills Agent**, ${t(lang, 'Quáº£n LÃ½ Files Workspace, Live IPTV & Remote Desktop Control.')} ${t(lang, 'Báº¡n muá»‘n tÃ´i lÃ m gÃ¬ giÃºp báº¡n?')}`;
        }
        return { ...m, ma_tin_nhan: finalMaTinNhan, noi_dung: finalText };
      }));
      fetchConversations();
      if (!currentUser) fetchGuestLimits();
    } catch {
      if (streamStarted) {
        setMessages(prev => prev.map(m => m.ma_tin_nhan === streamMsgId ? { ...m, noi_dung: (m.noi_dung || '') + '\n\n' + t(lang, 'âš ï¸ Káº¿t ná»‘i stream bá»‹ ngáº¯t.') } : m));
      } else {
        setMessages(prev => [...prev, {
          ma_tin_nhan: Date.now().toString(),
          vai_tro: 'assistant',
          noi_dung: t(lang, 'âš ï¸ KhÃ´ng thá»ƒ káº¿t ná»‘i tá»›i Server Backend. HÃ£y kiá»ƒm tra Backend Ä‘Ã£ cháº¡y chÆ°a vÃ  API Key trong má»¥c CÃ i Äáº·t!')
        }]);
      }
    } finally {
      setLoading(false);
    }
  };

  const recognitionRef = useRef(null);
  const [voiceTranscript, setVoiceTranscript] = useState('');

  const startVoice = async () => {
    // Náº¿u Ä‘ang nghe â†’ báº¥m láº¡i Ä‘á»ƒ Dá»ªNG
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      showToast(t(lang, 'ÄÃ£ dá»«ng ghi Ã¢m â€” chá»¯ Ä‘Ã£ vÃ o Ã´ chat, báº¥m gá»­i nhÃ©!'), 'info');
      return;
    }
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      alert(t(lang, 'TrÃ¬nh duyá»‡t khÃ´ng há»— trá»£ Web Speech API.'));
      return;
    }
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const r = new SR();
      recognitionRef.current = r;
      r.lang = 'vi-VN';
      r.interimResults = true;
      r.continuous = true;
      // DÃ¹ng biáº¿n local Ä‘á»ƒ trÃ¡nh stale-closure khi Ä‘á»c transcript trong onend
      let recognizedText = '';
      r.onstart = () => { setListening(true); setVoiceTranscript(''); };
      r.onend = () => {
        setListening(false);
        recognitionRef.current = null;
        if (recognizedText && recognizedText.trim()) {
          showToast(t(lang, 'ðŸŽ™ï¸ ÄÃ£ chuyá»ƒn giá»ng nÃ³i thÃ nh chá»¯ â€” báº¥m gá»­i nhÃ©!'), 'info');
        }
        setVoiceTranscript('');
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed') alert(t(lang, 'Cáº¥p quyá»n Micro cho trÃ¬nh duyá»‡t Ä‘á»ƒ sá»­ dá»¥ng.'));
        setListening(false);
        recognitionRef.current = null;
        setVoiceTranscript('');
      };
      r.onresult = (e) => {
        let text = '';
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
        }
        recognizedText = text;
        setVoiceTranscript(text);
        setInputText(text);
      };
      r.start();
    } catch { alert(t(lang, 'Cáº¥p quyá»n Micro cho trÃ¬nh duyá»‡t Ä‘á»ƒ sá»­ dá»¥ng.')); }
  };

  const speakText = (text, id) => {
    const cleanText = text.replace(/<[^>]*>/g, '').replace(/[*#`_]/g, '').trim();
    if (!cleanText) return;

    // Náº¿u Ä‘ang Ä‘á»c tin nháº¯n nÃ y thÃ¬ dá»«ng
    if (speakingMsgId === id) {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      setSpeakingMsgId(null);
      return;
    }

    // Dá»«ng báº¥t ká»³ Ä‘á»c nÃ o Ä‘ang cháº¡y
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    const useServerTTS = ttsUsingServer && !ttsServerBrokenRef.current && cleanText.length <= 2000;

    if (useServerTTS) {
      // DÃ¹ng Backend TTS (edge-tts, cháº¥t lÆ°á»£ng cao)
      setSpeakingMsgId(id);
      setTtsUsingServer(true);
      fetch(`${API_BASE}/services/tts`, {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          text: cleanText,
          voice: ttsVoice,
          rate: ttsRate,
          pitch: ttsPitch
        })
      })
        .then(r => r.json())
        .then(data => {
          if (data.success && data.audio) {
            const audio = new Audio('data:audio/mp3;base64,' + data.audio);
            audio.play().catch(e => {
              console.warn('[Audio Play Error]:', e.message);
              setSpeakingMsgId(null);
            });
            audio.onended = () => setSpeakingMsgId(null);
            audio.onerror = () => setSpeakingMsgId(null);
          } else {
            throw new Error(data.error || 'TTS server failed');
          }
        })
        .catch(err => {
          console.warn('[TTS] Server failed, falling back to browser (setting user giá»¯ nguyÃªn):', err.message);
          ttsServerBrokenRef.current = true; // táº¡m táº¯t server TTS cho phiÃªn nÃ y, khÃ´ng ghi Ä‘Ã¨ localStorage
          speakBrowser(cleanText, id);
        });
    } else {
      speakBrowser(cleanText, id);
    }
  };

  const speakBrowser = (text, id) => {
    if ('speechSynthesis' in window) {
      setSpeakingMsgId(id);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'vi-VN';
      utterance.rate = 1.0;
      utterance.onend = () => setSpeakingMsgId(null);
      window.speechSynthesis.speak(utterance);
    }
  };

  const copyToClipboard = (text, id) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      }).catch(() => {
        fallbackCopy(text, id);
      });
    } else {
      fallbackCopy(text, id);
    }
  };
  const fallbackCopy = (text, id) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      console.warn('Copy failed');
    }
  };

  const exportMd = () => {
    const title = conversations.find(c => c.ma_hoi_thoai === activeConvId)?.tieu_de || 'rexi_chat';
    const md = messages.map(m => `### ${m.vai_tro === 'user' ? t(lang, 'ðŸ‘¤ Báº¡n') : 'ðŸ¤– Rexi'}\n${m.noi_dung}`).join('\n\n---\n\n');
    // Giá»¯ chá»¯ Unicode (ká»ƒ cáº£ tiáº¿ng Viá»‡t) trong tÃªn file, chá»‰ bá» kÃ½ tá»± cáº¥m cá»§a Windows
    const safeName = (title.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_') || 'rexi_chat').slice(0, 80);
    const blobUrl = URL.createObjectURL(new Blob([`# ${title}\n\n${md}`], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), {
      href: blobUrl,
      download: safeName + '.md'
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  };

  const handleOpenFile = async (fileRelPath) => {
    try {
      const data = await apiFetch(`/workspace/file-content?path=${encodeURIComponent(fileRelPath)}`, { headers: authHeaders() });
      setSelectedFile(fileRelPath);
      setFileContent(data.content);
      handleSetActiveTab('code');
    } catch (e) { console.error(e); }
  };

  const handleSaveFile = async () => {
    if (!selectedFile) return;
    setSavingFile(true);
    try {
      await apiFetch('/workspace/file-content', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: fileContent })
      });
      alert(t(lang, 'ÄÃ£ lÆ°u tá»‡p tin thÃ nh cÃ´ng!'));
    } catch (e) { alert(t(lang, 'Lá»—i lÆ°u file: ') + e.message); }
    finally { setSavingFile(false); }
  };

  const handleExecCommand = async () => {
    if (!execCommand.trim()) return;
    try {
      const data = await apiFetch('/chat/exec', {
        method: 'POST',
        headers: { ...authHeaders(), 'X-Exec-Confirm': 'yes' },
        body: JSON.stringify({ command: execCommand })
      });
      setExecOutput(data.stdout || data.stderr || data.error || t(lang, 'Thá»±c thi thÃ nh cÃ´ng.'));
    } catch (e) { setExecOutput(t(lang, 'Lá»—i thá»±c thi: ') + e.message); }
  };

  const handleAddMemory = async () => {
    if (!newMemory.trim()) return;
    try {
      await apiFetch('/chat/memory', {
        method: 'POST',
        body: JSON.stringify({ loai: 'thong_tin_user', noi_dung: newMemory })
      });
      setNewMemory('');
      fetchMemories();
    } catch (e) { console.error(e); }
  };



  const handleAuthSubmit = async () => {
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
      const body = authMode === 'login'
        ? { email: authEmail, password: authPassword }
        : { email: authEmail, password: authPassword, ten_day_du: authFullName };

      const data = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (data.success && data.token) {
        setAuthToken(data.token);
        localStorage.setItem('rexi_token', data.token);
        if (data.user) {
          setCurrentUser(data.user);
          localStorage.setItem('rexi_user', JSON.stringify(data.user));
        }
        setAuthModalOpen(false);
      } else if (authMode === 'register' && data.success) {
        setAuthMode('login');
        alert(t(lang, 'ÄÄƒng kÃ½ thÃ nh cÃ´ng! Vui lÃ²ng Ä‘Äƒng nháº­p.'));
      } else {
        alert(data.error || t(lang, 'ÄÄƒng nháº­p tháº¥t báº¡i'));
      }
    } catch (e) {
      console.error('[Auth] Login failed:', e);
      // Náº¿u server tráº£ lá»—i cá»¥ thá»ƒ (vd sai máº­t kháº©u) thÃ¬ hiá»‡n lá»—i Ä‘Ã³ thay vÃ¬ thÃ´ng bÃ¡o chung
      alert(e.message && !e.message.includes('HTTP')
        ? e.message
        : t(lang, 'KhÃ´ng thá»ƒ káº¿t ná»‘i Ä‘áº¿n mÃ¡y chá»§. Vui lÃ²ng kiá»ƒm tra máº¡ng hoáº·c khá»Ÿi Ä‘á»™ng láº¡i server Rexi AI.'));
    }
  };


  // Google Sign-In Handler



  // Open Google OAuth popup â†’ backend callback redirects popup to localhost:5173?google_token=...
  // Parent window detects token via storage event listener (useEffect above)
  const [youtubeScopeOn, setYoutubeScopeOn] = useState(false);
  // withYouTube=true: xin them scope YouTube (NHáº Y Cáº¢M) -> Google se hien canh bao
  // "chua xac minh" (bat buoc phai vay voi app chua verify). VI VAY khong bao gio
  // truyen true cho nut DANG NHAP â€” chi dung cho nut "Ket noi YouTube" rieng.
  const openGoogleOAuth = (withYouTube = false) => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) {
      alert(t(lang, 'Google Client ID chÆ°a cáº¥u hÃ¬nh. Vui lÃ²ng thÃªm VITE_GOOGLE_CLIENT_ID vÃ o file .env'));
      return;
    }
    const redirectUri = `${window.location.origin}/api/auth/google/callback`;
    const wantYouTube = !!withYouTube;
    const scope = wantYouTube
      ? 'email profile https://www.googleapis.com/auth/youtube.force-ssl'
      : 'email profile';

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      prompt: 'select_account',
      access_type: 'offline',
      ...(wantYouTube ? { include_granted_scopes: 'true' } : {})
    });
    
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    // ÄÄƒng nháº­p NGAY TRÃŠN Cá»¬A Sá»” CHÃNH (khÃ´ng má»Ÿ popup nhá») â€” callback quay vá» app
    // vÃ  tá»± Ä‘Äƒng nháº­p luÃ´n; khÃ´ng cÃ²n "Ã´ nhá»" pháº£i tá»± Ä‘Ã³ng.
    window.location.assign(googleAuthUrl);
  };



  const renderTree = (nodes) => nodes.map(node => (
    <div key={node.path}>
      {node.type === 'folder' ? (
        <div className="mt-1">
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-slate-400 font-medium">
            <Folder size={13} className="text-amber-400" /><span>{node.name}</span>
          </div>
          {node.children && <div className="ml-3 border-l border-white/5 pl-2">{renderTree(node.children)}</div>}
        </div>
      ) : (
        <button
          onClick={() => handleOpenFile(node.path)}
          className={`w-full flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-left transition-colors ${selectedFile === node.path ? 'bg-cyan-500/20 text-cyan-300 font-medium' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
        >
          <FileCode size={12} className="text-cyan-400 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      )}
    </div>
  ));

  const filteredConvs = conversations.filter(c =>
    (c.tieu_de || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (searchIds && searchIds.has(c.ma_hoi_thoai))
  ).sort((a, b) => (b.da_ghim ? 1 : 0) - (a.da_ghim ? 1 : 0));

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-main)] text-[var(--text-main)] font-sans antialiased">
      

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SIDEBAR NAVIGATION â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <Sidebar
        sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        activeTab={activeTab} setActiveTab={handleSetActiveTab}
        conversations={conversations} filteredConvs={filteredConvs}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        activeConvId={activeConvId} setActiveConvId={setActiveConvId}
        handleNewConversation={handleNewConversation}
        handleDeleteConversation={handleDeleteConversation}
        handleTogglePin={handleTogglePin}
        filesDrawerOpen={filesDrawerOpen} setFilesDrawerOpen={setFilesDrawerOpen}
        renderTree={renderTree} fileTree={fileTree}
         setSkillsOpen={setSkillsOpen} setSuperToolsOpen={setSuperToolsOpen} setHelpOpen={setHelpOpen}
        currentUser={currentUser} setCurrentUser={setCurrentUser} setAuthToken={setAuthToken}
        setAuthModalOpen={setAuthModalOpen} setSettingsOpen={setSettingsOpen}
        apiFetch={apiFetch} API_BASE={API_BASE} showToast={showToast} setConversations={setConversations}
        currentTheme={currentTheme} setCurrentTheme={setCurrentTheme}
        lang={lang}
      />

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• MAIN WORKSPACE AREA â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg-main)]">
        
        {/* Top Header Bar (Hiá»ƒn thá»‹ á»Ÿ má»i tab, trá»« Browser) */}
        {activeTab !== 'browser' && (
        <header className="relative z-50 min-h-14 py-2 px-3 border-b border-white/5 flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-sidebar)] backdrop-blur-md">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="group inline-flex items-center justify-center w-9 h-9 translate-y-[3px] text-slate-400 hover:bg-white/10 hover:text-[var(--c-accent-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50 rounded-lg transition-colors duration-200 shrink-0"
                title={t(lang, 'openMenu')}
                aria-label={t(lang, 'openMenu')}
              >
                <PanelLeftOpen size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </button>
            )}

            {/* Model & Specialty Selectors */}
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <ModelSelectorPopover
                availableModels={availableModels}
                modelName={modelName}
                setModelName={setModelName}
                setProvider={setProvider}
                executionMode={executionMode}
              />

              <select
                value={aiSpecialty}
                onChange={e => setAiSpecialty(e.target.value)}
                className="bg-[#131417] text-xs font-medium text-slate-300 border border-white/10 rounded-xl px-3 py-1.5 outline-none cursor-pointer hover:border-white/20 transition-colors shrink-0 min-w-[170px]"
              >
                {AI_SPECIALTIES.map(s => (
                  <option key={s.id} value={s.id} className="bg-[#1e1f20] text-slate-200">
                    {t(lang, s.key)}
                  </option>
                ))}
              </select>



              <select
                value={thinkingLevel}
                onChange={e => setThinkingLevel(e.target.value)}
                className="bg-[#131417] text-xs text-slate-300 border border-white/10 rounded-xl px-2.5 py-1.5 outline-none cursor-pointer"
              >
                <option value="standard">{t(lang, 'thFast')}</option>
                <option value="deep">{t(lang, 'thDeep')}</option>
              </select>
            </div>
          </div>

          {/* Action Tools */}
          <div className="flex items-center gap-2">
            <button
              onClick={exportMd}
              className="px-2.5 py-1.5 rounded-xl bg-[#131417] border border-white/10 text-xs text-slate-300 hover:text-white flex items-center gap-1"
              title={t(lang, 'exportMd')}
            >
              <Download size={13} /> {lang === 'vi' ? 'Markdown' : 'Markdown'}
            </button>

            {/* Language Toggle â€” Äá»•i ngÃ´n ngá»¯ Viá»‡t/English */}
            <button
              onClick={() => { const next = lang === 'vi' ? 'en' : 'vi'; setLang(next); setLangState(next); }}
              title={lang === 'vi' ? 'Switch to English' : 'Chuyá»ƒn sang tiáº¿ng Viá»‡t'}
              className="px-2.5 py-1.5 rounded-xl bg-[#131417] border border-white/10 text-xs text-slate-300 hover:text-[var(--c-accent-soft)] hover:border-white/20 flex items-center gap-1 transition-colors"
            >
              <Languages size={13} /> {lang === 'vi' ? 'EN' : 'VI'}
            </button>

            {/* TTS Voice Selector */}
            <div className="flex items-center gap-1.5">
              <select
                title={lang === 'vi' ? 'Chuyá»ƒn Ä‘á»•i giá»ng nÃ³i thÃ nh server (edge-tts)' : 'Switch voice output to server (edge-tts)'}
                value={ttsUsingServer ? 'server' : 'browser'}
                onChange={e => {
                  const useServer = e.target.value === 'server';
                  setTtsUsingServer(useServer);
                  localStorage.setItem('rexi_tts_mode', useServer ? 'server' : 'browser');
                }}
                className="bg-[#131417] text-[10px] font-medium text-slate-300 border border-white/10 rounded-xl px-2 py-1 outline-none cursor-pointer hover:border-white/20 transition-colors shrink-0"
              >
                <option value="browser" className="bg-[#1e1f20] text-slate-200">{t(lang, 'ttsBrowser')}</option>
                <option value="server" className="bg-[#1e1f20] text-slate-200">{t(lang, 'ttsServer')}</option>
              </select>

              {ttsUsingServer && ttsVoices.length > 0 && (
                <select
                  title={t(lang, 'tipVoice')}
                  value={ttsVoice}
                  onChange={e => {
                    setTtsVoice(e.target.value);
                    localStorage.setItem('rexi_tts_voice', e.target.value);
                  }}
                  className="bg-[#131417] text-[10px] font-medium text-cyan-300 border border-cyan-500/30 rounded-xl px-2 py-1 outline-none cursor-pointer hover:border-cyan-400 transition-all shrink-0 max-w-[180px] truncate"
                >
                  {ttsVoices.map(v => (
                    <option key={v.id} value={v.id} className="bg-[#1e1f20] text-slate-200">
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* â‹¯ Menu thÃªm */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreMenuOpen(v => !v)}
                title={t(lang, 'tipAdd')}
                className="inline-flex items-center justify-center w-8 h-8 rounded-xl border border-white/10 bg-[#131417] text-slate-300 hover:text-white hover:border-white/20 transition-all"
              >
                <MoreVertical size={16} />
              </button>
              {moreMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-56 bg-[#141522] border border-white/10 rounded-xl shadow-2xl p-1 z-50">
                    <button onClick={() => { handleNewConversation(); setMoreMenuOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                      <Plus size={14} /> {t(lang, 'newConversation')}
                    </button>
                    <button onClick={async () => { setMoreMenuOpen(false); try { const u = await handleShareConversation(); try { await navigator.clipboard?.writeText(u); showToast?.(lang === 'vi' ? 'ÄÃ£ copy link chia sáº»' : 'Share link copied', 'success'); } catch (e) { console.warn(e); } if (navigator.share) navigator.share({ title: 'Rexi AI', url: u }).catch(() => {}); } catch (e) { showToast?.(e.message, 'error'); } }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                      <Share2 size={14} /> {t(lang, 'shareConv')}
                    </button>
                    <button onClick={() => { try { exportMd(); } catch (e) { console.warn(e); } setMoreMenuOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                      <Download size={14} /> {t(lang, 'exportMd')}
                    </button>
                    <button onClick={() => { setSettingsOpen(true); setMoreMenuOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                      <Settings size={14} /> {t(lang, 'menuSettings')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        )}

        {/* Guest Mode Banner â€” Ä‘áº·t DÆ¯á»šI header Ä‘á»ƒ header luÃ´n á»Ÿ Ä‘á»‰nh (nÃºt thu/má»Ÿ menu háº¿t bá»‹ lá»‡ch lÃªn xuá»‘ng) */}
        {!currentUser && (
          <div className="bg-blue-500/10 border-b border-blue-500/25 px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-xs text-blue-200/90">
                <span className="text-blue-400 flex items-center"><User size={14} /></span>
                <span className="font-semibold text-blue-300">{t(lang, 'guestMode')}</span>
              </span>
              <span className="flex items-center gap-1.5 text-[11px]">
                <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">{guestLimits.messages.remaining}</span>
                <span className="text-blue-200/60">/ {guestLimits.messages.limit} {t(lang, 'guestMsgUnit')}</span>
              </span>
              <span className="flex items-center gap-1.5 text-[11px]">
                <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">{guestLimits.agentTasks.remaining}</span>
                <span className="text-blue-200/60">/ {guestLimits.agentTasks.limit} {t(lang, 'guestTaskUnit')}</span>
              </span>
            </div>
            <button
              onClick={() => setAuthModalOpen(true)}
              className="text-[11px] font-semibold px-3 py-1 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 transition-all"
            >
              {t(lang, 'login')}
            </button>
          </div>
        )}

        {/* Tab Router Content */}
        <div className="flex-1 overflow-hidden relative">
          
          <Suspense fallback={<TabLoading />}>
          {/* TAB 1: AI CHAT WORKSPACE */}
          {activeTab === 'chat' && (
            <ChatTab
              messages={messages} inputText={inputText} setInputText={setInputText}
              loading={loading} attachedFiles={attachedFiles}
              executionMode={executionMode} setExecutionMode={setExecutionMode}
              agentEngine={agentEngine} setAgentEngine={setAgentEngine}
              chatModeOpen={chatModeOpen} setChatModeOpen={setChatModeOpen}
              listening={listening} voiceTranscript={voiceTranscript} copiedId={copiedId} speakingMsgId={speakingMsgId}
               handleSendMessage={handleSendMessage} startVoice={startVoice}
               speakText={speakText} copyToClipboard={copyToClipboard} lang={lang}
               ttsUsingServer={ttsUsingServer}
              fileInputRef={fileInputRef} handleFileSelect={handleFileSelect}
              chatScrollRef={chatScrollRef} handleChatScroll={handleChatScroll}
              showScrollTop={showScrollTop} showScrollBottom={showScrollBottom}
              scrollToTopSmooth={scrollToTopSmooth} scrollToBottomSmooth={scrollToBottomSmooth}
              currentUser={currentUser}
              onOpenFeature={handleSetActiveTab}
              activeConvId={activeConvId}
              onShare={handleShareConversation}
              onRemoveFile={handleRemoveFile}
            />
          )}

          {/* TAB 2 & 3: CODE EDITOR & WORKSPACE FILES */}
          {(activeTab === 'code' || activeTab === 'files') && (
            <CodeEditorTab
              selectedFile={selectedFile} fileContent={fileContent}
              setFileContent={setFileContent} savingFile={savingFile}
              handleSaveFile={handleSaveFile} liveHtml={liveHtml}
              setLiveHtml={setLiveHtml}
            />
          )}

          {/* TAB 4: IPTV LIVE TV â€” giá»¯ mount (display:none khi áº©n) Ä‘á»ƒ phÃ¡t ná»n khi chuyá»ƒn tab */}
          {(activeTab === 'iptv' || openedTabs.has('iptv')) && (
          <div className={activeTab === 'iptv' ? 'contents' : 'hidden'}>
            <IPTVTab
              iptvTab={iptvTab} setIptvTab={setIptvTab}
              iptvCategory={iptvCategory} setIptvCategory={setIptvCategory}
              iptvCountry={iptvCountry} setIptvCountry={setIptvCountry}
              iptvSearch={iptvSearch} setIptvSearch={setIptvSearch}
              iptvChannels={iptvChannels} selectedChannel={selectedChannel}
              setSelectedChannel={setSelectedChannel} fetchIPTV={fetchIPTV}
              iptvVideoRef={iptvVideoRef}
              iptvSubtitleOn={iptvSubtitleOn} setIptvSubtitleOn={setIptvSubtitleOn}
              iptvEmbeddedSubs={iptvEmbeddedSubs}
              iptvError={iptvError}
              hlsRef={hlsRef}
            />
          </div>
          )}

          {/* TAB 5a: TTS STUDIO */}
          {activeTab === 'tts' && (
            <StudioTab
              API_BASE={API_BASE}
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB 5b: VIDEO CREATOR */}
          {activeTab === 'video' && (
            <VideoCreatorTab
              API_BASE={API_BASE}
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB 5d: Táº O áº¢NH AI (Gemini Image) */}
          {activeTab === 'image' && (
            <ImageGenTab
              API_BASE={API_BASE}
              authToken={authToken}
              showToast={showToast}
              imageModels={allModels.filter(m => m.modality === 'image')}
            />
          )}

          {/* TAB: Äá»ŒC & HIá»‚U FILE (RAG) */}
          {activeTab === 'documents' && (
            <DocumentsTab
              API_BASE={API_BASE}
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB 5c: OPENCUT EDITOR */}
          {activeTab === 'opencut' && (
            <OpenCutTab
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB: Dá»°NG VIDEO (server-side, khÃ´ng cáº§n cÃ i) */}
          {activeTab === 'videoedit' && (
            <VideoEditTab
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB: OPENSHORTS â€” video dÃ i â†’ shorts 9:16 */}
          {activeTab === 'openshorts' && (
            <OpenShortsTab
              authToken={authToken}
              showToast={showToast}
            />
          )}

          {/* TAB 5d: YOUTUBE FREE (khÃ´ng quáº£ng cÃ¡o) â€” giá»¯ mount Ä‘á»ƒ phÃ¡t ná»n khi chuyá»ƒn tab */}
          {(activeTab === 'youtube' || openedTabs.has('youtube')) && (
          <div className={activeTab === 'youtube' ? 'contents' : 'hidden'}>
            <YouTubeTab
              authToken={authToken}
              showToast={showToast}
              active={activeTab === 'youtube'}
            />
          </div>
          )}

          {/* TAB 5d-2: TIKTOK FEED (xem dá»c + lá»c chá»§ Ä‘á» AI tá»± lÆ°á»›t) */}
          {(activeTab === 'tiktokfeed' || openedTabs.has('tiktokfeed')) && (
          <div className={activeTab === 'tiktokfeed' ? 'contents' : 'hidden'}>
            <TikTokFeedTab
              authToken={authToken}
              showToast={showToast}
              active={activeTab === 'tiktokfeed'}
            />
          </div>
          )}

          {/* TAB 5e: GAME ZONE (HTML5 games) */}
          {activeTab === 'games' && (
            <GameTab showToast={showToast} />
          )}

          {/* TAB 5f: Lá»šP Há»ŒC AI (OpenMAIC â€” multi-agent classroom) */}
          {activeTab === 'classroom' && (
            <ClassroomTab showToast={showToast} />
          )}

          {/* TAB 6: REMOTE DESKTOP CONTROL */}
          {activeTab === 'desktop' && (
            <div className="flex flex-col h-full w-full p-4 bg-[#0d0e11] space-y-3">
              <div className="flex items-center justify-between bg-[#181920] p-3 rounded-2xl border border-white/5">
                <div className="flex items-center gap-2">
                  <Monitor className="text-cyan-400" size={18} />
                  <span className="text-xs font-bold text-white">{t(lang, 'Chá»¥p & Äiá»u Khiá»ƒn MÃ n HÃ¬nh (Remote Desktop)')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">{t(lang, 'Chá»¥p mÃ n hÃ¬nh qua PowerShell')}</span>
                  <button
                    onClick={fetchDesktopScreenshot}
                    disabled={desktopLoading}
                    className="px-3 py-1.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-medium flex items-center gap-1 hover:bg-cyan-500/30 disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={desktopLoading ? 'animate-spin' : ''} />
                    {desktopLoading ? t(lang, 'Äang chá»¥p...') : t(lang, 'Cáº­p Nháº­t MÃ n HÃ¬nh')}
                  </button>
                </div>
              </div>

              <div
                className="flex-1 border border-white/10 rounded-2xl bg-black overflow-hidden flex items-center justify-center cursor-crosshair"
                onClick={async (e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const xPct = ((e.clientX - rect.left) / rect.width).toFixed(4);
                  const yPct = ((e.clientY - rect.top) / rect.height).toFixed(4);
                  await apiFetch('/services/desktop/click', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify({ x_percent: parseFloat(xPct), y_percent: parseFloat(yPct) })
                  });
                  setTimeout(fetchDesktopScreenshot, 600);
                }}
                title={t(lang, 'tipDesktopMouse')}
              >
                {desktopScreenshot ? (
                  <img src={desktopScreenshot} alt="Desktop" className="max-h-full max-w-full object-contain" />
                ) : desktopError ? (
                  <div className="text-center space-y-2">
                    <Monitor size={40} className="mx-auto text-red-500" />
                    <p className="text-xs text-red-400">{desktopError}</p>
                    <p className="text-[11px] text-slate-600">{t(lang, 'Nháº¥n "Cáº­p Nháº­t MÃ n HÃ¬nh" Ä‘á»ƒ thá»­ láº¡i')}</p>
                  </div>
                ) : (
                  <div className="text-center space-y-2">
                    <Monitor size={40} className="mx-auto text-slate-600" />
                    <p className="text-xs text-slate-500">{t(lang, 'Báº¥m nÃºt "Cáº­p Nháº­t MÃ n HÃ¬nh" Ä‘á»ƒ chá»¥p desktop')}</p>
                    <p className="text-[11px] text-slate-600">{t(lang, 'âš ï¸ Cáº§n cháº¡y backend trong cÃ¹ng phiÃªn Windows (khÃ´ng headless)')}</p>
                  </div>
                )}
              </div>
            </div>
          )}

           {/* TAB 6: BROWSER AGENT (Playwright + Stagehand) */}
          {activeTab === 'browser' && (
            <BrowserView token={authToken} currentUser={currentUser} onClose={() => setActiveTab('chat')} />
          )}

           {/* TAB 7: ADMIN PANEL */}
          {activeTab === 'admin' && currentUser?.phan_quyen === 'admin' && (
            <AdminPanel token={authToken} currentUser={currentUser} onClose={() => setActiveTab('chat')} />
          )}

          </Suspense>
        </div>
      </main>

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SKILLS MODAL (DATABASE SKILLS) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <Suspense fallback={null}><SkillsModal skillsOpen={skillsOpen} setSkillsOpen={setSkillsOpen} dbSkills={dbSkills} /></Suspense>

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SCRAPE PANEL (DATA SCRAPER KIT) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <Suspense fallback={null}><ScrapePanel open={scrapeOpen} onClose={() => setScrapeOpen(false)} token={authToken} /></Suspense>

      {/* Super Tools Modal (Exec, Git, Memory) */}
      {superToolsOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={() => setSuperToolsOpen(false)}>
          <div className="bg-[#181920] border border-white/10 rounded-2xl w-full max-w-2xl p-6 space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/5 pb-3">
              <div className="flex items-center gap-2">
                <Zap className="text-amber-400" size={20} />
                <h3 className="text-sm font-bold text-white">Super Tools (Terminal Exec, Git & Memory)</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSuperToolsOpen(false); setScrapeOpen(true); }}
                  title={t(lang, 'tipScrape')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-cyan-300 hover:text-white bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 transition-all"
                >
                  <Download size={14} /> {lang === 'vi' ? 'CÃ o dá»¯ liá»‡u' : 'Scrape data'}
                </button>
                <button onClick={() => setSuperToolsOpen(false)} className="text-slate-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1 text-xs">
              {/* Terminal Exec */}
              <div className="space-y-2 bg-[#131417] p-3 rounded-xl border border-white/5">
                <h4 className="font-bold text-slate-200 flex items-center gap-1.5"><Terminal size={14} className="text-cyan-400" /> Terminal Exec</h4>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={execCommand}
                    onChange={e => setExecCommand(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleExecCommand()}
                    placeholder={t(lang, 'phCli')}
                    className="flex-1 bg-[#181920] border border-white/10 rounded-xl px-3 py-1.5 text-slate-200 outline-none font-mono"
                  />
                  <button onClick={handleExecCommand} className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-white rounded-xl font-medium inline-flex items-center gap-1"><Play size={13} /> {t(lang, 'Cháº¡y')}</button>
                </div>
                {execOutput && (
                  <pre className="p-3 bg-black rounded-lg font-mono text-[11px] text-emerald-400 overflow-x-auto max-h-40 whitespace-pre-wrap">{execOutput}</pre>
                )}
              </div>

              {/* Git Manager */}
              <div className="space-y-2 bg-[#131417] p-3 rounded-xl border border-white/5">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-200 flex items-center gap-1.5"><GitBranch size={14} className="text-emerald-400" /> ðŸŒ¿ Git Repository Manager</h4>
                  <button onClick={() => { fetchGitStatus(); fetchGitDiff(); }} className="text-[10px] text-slate-400 hover:text-white flex items-center gap-1"><RefreshCw size={10} /> Refresh</button>
                </div>
                {gitStatus ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 bg-[#181920] rounded-lg">
                      <GitBranch size={12} className="text-emerald-400" />
                      <span className="text-emerald-300 font-mono font-bold">{gitStatus.branch}</span>
                      <span className="text-slate-400">| {gitStatus.changes?.length || 0} {t(lang, 'thay Ä‘á»•i')}</span>
                    </div>
                    {gitStatus.changes && gitStatus.changes.length > 0 && (
                      <div className="space-y-1 max-h-24 overflow-y-auto">
                        {gitStatus.changes.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 px-2 py-0.5 rounded font-mono text-[10px]">
                            <span className={c.startsWith('M') ? 'text-amber-400' : c.startsWith('?') ? 'text-slate-500' : 'text-emerald-400'}>{c.substring(0,2)}</span>
                            <span className="text-slate-300">{c.substring(3)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {gitDiff && (
                      <pre className="p-2 bg-black rounded-lg font-mono text-[10px] text-slate-300 overflow-x-auto max-h-32 whitespace-pre-wrap">{gitDiff.substring(0, 1500)}{gitDiff.length > 1500 ? '\n...[truncated]' : ''}</pre>
                    )}
                  </div>
                ) : (
                  <p className="text-slate-500">{t(lang, 'Báº¥m Refresh Ä‘á»ƒ táº£i tráº¡ng thÃ¡i Git...')}</p>
                )}
              </div>

              {/* Long-term Memory */}
              <div className="space-y-2 bg-[#131417] p-3 rounded-xl border border-white/5">
                <h4 className="font-bold text-slate-200 flex items-center gap-1.5"><Database size={14} className="text-purple-400" /> {t(lang, 'Bá»™ Nhá»› DÃ i Háº¡n AI')}</h4>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMemory}
                    onChange={e => setNewMemory(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddMemory()}
                    placeholder={t(lang, 'phMemory')}
                    className="flex-1 bg-[#181920] border border-white/10 rounded-xl px-3 py-1.5 text-slate-200 outline-none"
                  />
                  <button onClick={handleAddMemory} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-medium inline-flex items-center gap-1"><Plus size={13} /> {t(lang, 'LÆ°u')}</button>
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {memories.length === 0 ? (
                    <p className="text-slate-500 text-center py-2">{t(lang, 'ChÆ°a cÃ³ bá»™ nhá»› nÃ o. ThÃªm quy táº¯c Ä‘á»ƒ AI ghi nhá»› vÄ©nh viá»…n!')}</p>
                  ) : memories.map(m => (
                    <div key={m.ma_bo_nho} className="flex items-start gap-2 p-2 bg-[#181920] rounded-lg border border-white/5 group">
                      <span className="text-purple-400 shrink-0">â€¢</span>
                      <span className="flex-1 text-slate-300">{m.noi_dung}</span>
                      <button
                        onClick={async () => {
                          await apiFetch(`/chat/memory/${m.ma_bo_nho}`, { method: 'DELETE', headers: authHeaders() });
                          fetchMemories();
                        }}
                        className="opacity-0 group-hover:opacity-100 text-rose-400 hover:text-rose-300 shrink-0"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-white/5 flex justify-end">
              <button onClick={() => setSuperToolsOpen(false)} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-medium">{t(lang, 'ÄÃ³ng')}</button>
            </div>
          </div>
        </div>
      )}

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• USER AUTH MODAL â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={() => { setAuthModalOpen(false); setForgotStep('login'); setShowPassword(false); setShowForgotNewPassword(false); setForgotMessage(''); }}>
          <div className="bg-[#181920] border border-white/10 rounded-2xl w-full max-w-sm p-6 shadow-2xl relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => { setAuthModalOpen(false); setForgotStep('login'); setShowPassword(false); setShowForgotNewPassword(false); setForgotMessage(''); }} className="absolute top-4 right-4 text-slate-400 hover:text-white">
              <X size={18} />
            </button>

            {forgotStep === 'request' ? (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-white text-center">{t(lang, 'QuÃªn Máº­t Kháº©u')}</h3>
                <p className="text-xs text-slate-400 text-center">{t(lang, 'Nháº­p tÃ i khoáº£n Ä‘á»ƒ nháº­n mÃ£ OTP Ä‘áº·t láº¡i máº­t kháº©u.')}</p>
                <input type="text" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                  placeholder={t(lang, 'phUser')} className="w-full px-3 py-2.5 bg-[#131417] border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500/50" />
                {forgotMessage && <p className="text-xs text-cyan-300 text-center">{forgotMessage}</p>}
                <button type="button" onClick={async () => {
                  try {
                    const data = await apiFetch('/auth/forgot-password', {
                      method: 'POST', headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ account: authEmail })
                    });
                    if (data.success) {
                      // KhÃ´ng bao giá» hiá»‡n OTP ra UI (ká»ƒ cáº£ otp_debug dev) â€” trÃ¡nh lá»™ + táº­p thÃ³i quen xáº¥u
                      setForgotMessage(data.message || t(lang, 'ÄÃ£ gá»­i mÃ£ OTP. Kiá»ƒm tra email/tin nháº¯n cá»§a báº¡n.'));
                      setForgotStep('reset');
                    } else {
                      setForgotMessage(data.error || t(lang, 'KhÃ´ng thá»ƒ táº¡o mÃ£ OTP.'));
                    }
                  } catch { setForgotMessage(t(lang, 'Lá»—i káº¿t ná»‘i server.')); }
                }} className="w-full py-2.5 bg-[var(--accent)] hover:brightness-110 text-white font-medium text-sm rounded-xl transition-colors">{t(lang, 'Gá»­i OTP')}</button>
                <button type="button" onClick={() => { setForgotStep('login'); setForgotMessage(''); }} className="w-full text-xs text-slate-500 hover:text-white transition-colors">{t(lang, 'Quay láº¡i ÄÄƒng Nháº­p')}</button>
              </div>
            ) : forgotStep === 'reset' ? (
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-white text-center">{t(lang, 'Äáº·t Láº¡i Máº­t Kháº©u')}</h3>
                {forgotMessage && <p className="text-xs text-cyan-300 text-center">{forgotMessage}</p>}
                <input type="text" inputMode="numeric" value={forgotOtp} onChange={e => setForgotOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={t(lang, 'phOtp')} className="w-full px-3 py-2.5 bg-[#131417] border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500/50" />
                <div className="relative">
                  <input type={showForgotNewPassword ? 'text' : 'password'} value={forgotNewPassword} onChange={e => setForgotNewPassword(e.target.value)}
                    placeholder={t(lang, 'phNewPass')} className="w-full px-3 py-2.5 pr-10 bg-[#131417] border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 outline-none focus:border-cyan-500/50" />
                  <button type="button" onClick={() => setShowForgotNewPassword(!showForgotNewPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white" aria-label={showForgotNewPassword ? (lang === 'vi' ? 'áº¨n máº­t kháº©u' : 'Hide password') : (lang === 'vi' ? 'Hiá»‡n máº­t kháº©u' : 'Show password')}>
                    {showForgotNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <button type="button" onClick={async () => {
                  try {
                    const data = await apiFetch('/auth/reset-password', {
                      method: 'POST', headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ account: authEmail, otp_code: forgotOtp, new_password: forgotNewPassword })
                    });
                    if (data.success) {
                      setForgotMessage(t(lang, 'Äáº·t láº¡i máº­t kháº©u thÃ nh cÃ´ng. Báº¡n cÃ³ thá»ƒ Ä‘Äƒng nháº­p.'));
                      setAuthPassword('');
                      setForgotOtp('');
                      setForgotNewPassword('');
                      setTimeout(() => { setForgotStep('login'); setForgotMessage(''); setAuthMode('login'); }, 1200);
                    } else {
                      setForgotMessage(data.error || t(lang, 'OTP khÃ´ng Ä‘Ãºng.'));
                    }
                  } catch { setForgotMessage(t(lang, 'Lá»—i káº¿t ná»‘i server.')); }
                }} className="w-full py-2.5 bg-[var(--accent)] hover:brightness-110 text-white font-medium text-sm rounded-xl transition-colors">{t(lang, 'Äáº·t láº¡i máº­t kháº©u')}</button>
                <button type="button" onClick={() => { setForgotStep('request'); setForgotMessage(''); }} className="w-full text-xs text-slate-500 hover:text-white transition-colors">{t(lang, 'Gá»­i láº¡i OTP')}</button>
              </div>
            ) : (
              <div className="auth-login-wrapper">
                <div className="flex flex-col items-center pt-2 pb-2">
                  <img src="/rexi_cat_icon.png" alt="Logo" className="rexi-logo w-12 h-12 object-contain" />
                  <span className="text-xs text-white/50 font-semibold tracking-widest mt-1">Rexi AI</span>
                </div>

<div className="flex bg-[#131417] border border-white/10 rounded-xl p-1 mb-5">
                   <button
                     onClick={() => setAuthMode('login')}
                     className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                        authMode === 'login' ? 'bg-[#4a7dff] hover:bg-[#3d6ae6] text-white' : 'text-slate-200 hover:text-white hover:bg-white/5'
                     }`}
                   >
                     {t(lang, 'loginTab')}
                   </button>
                   <button
                     onClick={() => setAuthMode('register')}
                     className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                        authMode === 'register' ? 'bg-[#4a7dff] hover:bg-[#3d6ae6] text-white' : 'text-slate-200 hover:text-white hover:bg-white/5'
                     }`}
                   >
                     {t(lang, 'registerTab')}
                   </button>
                 </div>

                <form onSubmit={(e) => { e.preventDefault(); handleAuthSubmit(); }} className="space-y-3 text-xs">
                  {authMode === 'register' && (
                    <div>
                      <label className="block text-slate-400 font-medium mb-1">{t(lang, 'fullName')}</label>
                      <input type="text" value={authFullName} onChange={e => setAuthFullName(e.target.value)} placeholder={t(lang, 'phName')} className="w-full bg-[#131417] border border-white/10 rounded-xl p-2.5 text-slate-200 outline-none" />
                    </div>
                  )}
                  <div>
<label className="block text-slate-500 font-medium mb-1">{t(lang, 'account')}</label>
                     <input type="text" required value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder={t(lang, 'phUser')} className="w-full bg-[#131417] border border-white/10 rounded-xl p-2.5 text-slate-200 outline-none" />
                  </div>
                  <div>
<label className="block text-slate-500 font-medium mb-1">{t(lang, 'password')}</label>
                     <div className="relative">
                       <input type={showPassword ? 'text' : 'password'} required value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" className="w-full bg-[#131417] border border-white/10 rounded-xl p-2.5 text-slate-200 outline-none pr-10" />
                       <button type="button" onClick={() => setShowPassword(!showPassword)}
                         className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                         {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                       </button>
                     </div>
                  </div>

<div className="flex justify-end mt-1">
                     <button type="button" onClick={() => { setForgotStep('request'); setForgotMessage(''); }} className="text-[10px] text-slate-500 hover:text-slate-600 transition-colors">
                       {t(lang, 'forgotPassword')}
                     </button>
                   </div>

<button type="submit" className="w-full py-3 mt-4 rounded-xl bg-[#4a7dff] hover:bg-[#3d6ae6] text-white font-bold text-xs shadow-lg shadow-[#4a7dff]/20 transition-all">
                     {authMode === 'login' ? t(lang, 'loginTab') : t(lang, 'registerTab')}
                   </button>
                </form>

<div className="relative flex items-center my-4">
                   <div className="flex-1 h-px bg-white/10"></div>
                   <span className="px-3 text-[10px] text-slate-500 font-medium">{t(lang, 'orDivider')}</span>
                   <div className="flex-1 h-px bg-white/10"></div>
                 </div>

                  <button type="button" onClick={() => openGoogleOAuth(false)} className="w-full py-2.5 rounded-xl bg-[#131417] hover:bg-white/5 text-slate-200 text-xs font-medium flex items-center justify-center gap-2 border border-white/10 transition-all">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    {t(lang, 'continueGoogle')}
                  </button>
                  <button
                    type="button"
                    onClick={() => openGoogleOAuth(true)}
                    title={t(lang, 'tipYtAuth')}
                    className="mt-2 w-full text-[11px] text-slate-500 hover:text-rose-300 transition-colors flex items-center justify-center gap-1.5"
                  >
                    {t(lang, 'â–¶ Káº¿t ná»‘i YouTube Ä‘á»ƒ bÃ¬nh luáº­n (tÃ¹y chá»n)')}
                  </button>

               </div>
            )}
          </div>
        </div>
      )}


      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SETTINGS MODAL â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <Suspense fallback={null}><SettingsModal
        settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
        provider={provider} setProvider={setProvider}
        modelName={modelName} setModelName={setModelName}
        apiKey={apiKey} setApiKey={setApiKey}
        baseUrl={baseUrl} setBaseUrl={setBaseUrl}
        showToast={showToast}
      /></Suspense>

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• FLOATING SPEED DIAL MENU (Hiá»ƒn thá»‹ á»Ÿ má»i tab, ká»ƒ cáº£ Admin) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
          {(
            <>
              <div
                className={
                  'fixed inset-0 z-40 bg-black/40 transition-opacity duration-500 ease-out ' +
                  (fabOpen ? 'opacity-100' : 'opacity-0 pointer-events-none')
                }
                onClick={() => setFabOpen(false)}
              />

          {/* Panel cÃ´ng cá»¥ â€” smoked glass, TRÆ¯á»¢T SÃT MÃ‰P PHáº¢I (right-0, bo trÃ¡i), Ä‘Ã³ng thÃ¬ trÆ°á»£t háº³n vÃ o mÃ©p
              bottom-[9.5rem]: luÃ´n náº±m TRÃŠN tab mÃ©p pháº£i (tab bottom-24 â†’ chiáº¿m 96-152px) */}
          <div ref={fabMenuRef} className={
            'fixed right-0 bottom-[9.5rem] z-[45] flex flex-col gap-1 p-2 rounded-l-2xl rounded-r-none origin-right will-change-transform ' +
            'rexi-fab-panel border border-r-0 ' +
            'transition-all duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)] ' +
            'max-h-[calc(100dvh-216px)] max-w-[calc(100vw-24px)] overflow-y-auto pr-1.5 scrollbar-thin ' +
            (fabOpen
              ? 'opacity-100 translate-x-0 scale-100 pointer-events-auto'
              : 'opacity-0 translate-x-full scale-[0.98] pointer-events-none')
          }>
              {/* NhÃ³m AI */}
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-1 pb-1">{t(lang, 'fabAi')}</p>
              {[
                { tab: 'chat', icon: <MessageSquare size={17} />, label: 'Chat AI', color: 'text-cyan-400', desc: t(lang, 'fabChatDesc') },
                { tab: 'code', icon: <Code size={17} />, label: t(lang, 'fabEditor'), color: 'text-blue-400', desc: t(lang, 'fabEditorDesc') },
                { tab: 'browser', icon: <Bot size={17} />, label: t(lang, 'fabBrowser'), color: 'text-purple-400', desc: t(lang, 'fabBrowserDesc') },
              ].map(item => (
                <FabItem key={item.tab} item={item} activeTab={activeTab} onPick={() => { handleSetActiveTab(item.tab); setFabOpen(false); }} />
              ))}

              {/* NhÃ³m SÃ¡ng Táº¡o */}
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-2 pb-1">{t(lang, 'fabCreate')}</p>
              {[
                { tab: 'tts', icon: <Mic size={17} />, label: t(lang, 'fabTts'), color: 'text-cyan-400', desc: t(lang, 'fabTtsDesc') },
                { tab: 'documents', icon: <FileText size={17} />, label: t(lang, 'fabDocs'), color: 'text-emerald-400', desc: t(lang, 'fabDocsDesc') },
                { tab: 'video', icon: <Video size={17} />, label: 'Video Creator', color: 'text-purple-400', desc: t(lang, 'fabVideoDesc') },
                { tab: 'videoedit', icon: <Wand2 size={17} />, label: t(lang, 'fabVideoedit'), color: 'text-cyan-400', desc: t(lang, 'fabVideoeditDesc') },
                { tab: 'opencut', icon: <Clapperboard size={17} />, label: t(lang, 'fabOpenCut'), color: 'text-sky-400', desc: t(lang, 'fabOpenCutDesc') },
                { tab: 'openshorts', icon: <Scissors size={17} />, label: t(lang, 'fabOpenShorts'), color: 'text-orange-400', desc: t(lang, 'fabOpenShortsDesc') },
                { tab: 'youtube', icon: <MonitorPlay size={17} />, label: t(lang, 'youtube'), color: 'text-red-400', desc: t(lang, 'fabYoutubeDesc') },
                { tab: 'tiktokfeed', icon: <Music2 size={17} />, label: 'TikTok Feed', color: 'text-pink-400', desc: 'Xem TikTok lá»c theo chá»§ Ä‘á» â€” AI tá»± lÆ°á»›t' },
                { tab: 'games', icon: <Gamepad2 size={17} />, label: t(lang, 'fabGames'), color: 'text-fuchsia-400', desc: t(lang, 'fabGamesDesc') },
                { tab: 'classroom', icon: <GraduationCap size={17} />, label: t(lang, 'fabClassroom'), color: 'text-teal-400', desc: t(lang, 'fabClassroomDesc') },
              ].map(item => (
                <FabItem key={item.tab} item={item} activeTab={activeTab} onPick={() => { handleSetActiveTab(item.tab); setFabOpen(false); }} />
              ))}

              {/* NhÃ³m Giáº£i TrÃ­ & Há»‡ Thá»‘ng */}
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-2 pb-1">{t(lang, 'fabEnt')}</p>
              {[
                { tab: 'iptv', icon: <Tv size={17} />, label: t(lang, 'fabIptv'), color: 'text-rose-400', desc: t(lang, 'fabIptvDesc') },
                { tab: 'files', icon: <Folder size={17} />, label: t(lang, 'fabFiles'), color: 'text-amber-400', desc: t(lang, 'fabFilesDesc') },
                { tab: 'desktop', icon: <Monitor size={17} />, label: t(lang, 'fabDesktop'), color: 'text-emerald-400', desc: t(lang, 'fabDesktopDesc') },
                ...(currentUser?.phan_quyen === 'admin' ? [{ tab: 'admin', icon: <Shield size={17} />, label: t(lang, 'fabAdmin'), color: 'text-amber-400', desc: t(lang, 'fabAdminDesc') }] : []),
              ].map(item => (
                <FabItem key={item.tab} item={item} activeTab={activeTab} onPick={() => { handleSetActiveTab(item.tab); setFabOpen(false); }} />
              ))}

              {/* Trá»£ giÃºp */}
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-2 pb-1">{t(lang, 'fabHelp')}</p>
              <button
                onClick={() => { setHelpOpen(true); setFabOpen(false); }}
                title={t(lang, 'tipHelp')}
                className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all text-slate-300 hover:text-white hover:bg-white/10"
              >
                <span className="text-sky-400"><BookOpen size={17} /></span>
                <div className="flex flex-col items-start whitespace-nowrap">
                  <span>{t(lang, 'fabGuide')}</span>
                  <span className="text-[11px] text-slate-500 font-normal line-clamp-1">{t(lang, 'fabGuideDesc')}</span>
                </div>
              </button>

              {/* ÄÆ°á»ng phÃ¢n cÃ¡ch */}
              <div className="h-px bg-white/10 my-0.5 mx-2" />

              {/* NhÃ³m Quick Tools (Modals) */}
              <button
                onClick={() => { setSkillsOpen(true); setFabOpen(false); }}
                title={t(lang, 'tipSkillsBtn')}
                className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium text-purple-300 hover:text-white hover:bg-purple-500/20 transition-all"
              >
                <Layers size={17} className="text-purple-400" />
                <span className="whitespace-nowrap">{t(lang, 'fabSkills')}</span>
              </button>

              <button
                onClick={() => { setSuperToolsOpen(true); setFabOpen(false); }}
                title="Super Tools (CLI/Git) â€” Terminal, Git, Memory"
                className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium text-amber-300 hover:text-white hover:bg-amber-500/20 transition-all"
              >
                <Zap size={17} className="text-amber-400" />
                <span className="whitespace-nowrap">{t(lang, 'fabSuper')}</span>
              </button>

              <button
                onClick={() => { setScrapeOpen(true); setFabOpen(false); }}
                title={t(lang, 'tipScrape')}
                className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium text-cyan-300 hover:text-white hover:bg-cyan-500/20 transition-all"
              >
                <Download size={17} className="text-cyan-400" />
                <span className="whitespace-nowrap">{t(lang, 'fabScrape')}</span>
              </button>

              <button
                onClick={() => { setSettingsOpen(true); setFabOpen(false); }}
                title={t(lang, 'tipSettings')}
                className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 transition-all"
              >
                <Settings size={17} className="text-slate-400" />
                <span className="whitespace-nowrap">{t(lang, 'settingsTitle')}</span>
              </button>
            </div>

            {/* Tab mÃ©p pháº£i kiá»ƒu Drive â€” smoked glass, LED accent, chevron island
                bottom-24 (96px): cao hÆ¡n Ã´ chat, khÃ´ng Ä‘Ã¨ nÃºt Gá»­i má»i viewport */}
            <button
              onClick={() => setFabOpen(!fabOpen)}
              className={
                'group fixed bottom-24 right-0 z-[45] h-14 pl-3 pr-2.5 flex items-center rounded-l-full ' +
                'rexi-fab-tab border border-r-0 ' +
                (activeTab === 'chat' ? '' : 'rexi-fab-tab-ghost ') +
                'transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform ' +
                (fabOpen
                  ? 'translate-x-0 rexi-fab-tab-open'
                  : 'hover:translate-x-0 active:translate-x-0')
              }
              title={fabOpen ? t(lang, 'ariaCollapse') : t(lang, 'openMenu')}
            >
              {/* LED light â€” nguon sang xanh nhe, khong to mau */}
              <span className={`rexi-fab-led absolute left-[7px] top-3 bottom-3 w-px transition-opacity duration-500 ${fabOpen ? 'opacity-100' : 'opacity-55 group-hover:opacity-100'}`} />
              {/* island: chevron trong vong kinh */}
              <span className="rexi-fab-island w-8 h-8 flex items-center justify-center rounded-full transition-all duration-500 group-hover:-translate-x-px">
                <ChevronLeft size={16} strokeWidth={1.5} className={`rexi-fab-chevron transition-transform duration-500 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${fabOpen ? 'rotate-180' : ''}`} />
              </span>
            </button>
        </>
      )}

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• HELP MODAL (HÆ¯á»šNG DáºªN Sá»¬ Dá»¤NG) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
      <Suspense fallback={null}><HelpModal helpOpen={helpOpen} setHelpOpen={setHelpOpen} /></Suspense>

      {/* Toast Notification */}
      {toastMsg && (
        <div className={"fixed bottom-24 right-6 z-[9999] px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border flex items-center gap-3 text-sm font-medium transition-all duration-300 animate-slide-up " + (toastType === 'success' ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-200' : toastType === 'error' ? 'bg-rose-500/20 border-rose-500/30 text-rose-200' : 'bg-cyan-500/20 border-cyan-500/30 text-cyan-200')}>
          <span className="inline-flex items-center">
            {toastType === 'success' ? <CheckCircle2 size={16} /> : toastType === 'error' ? <XCircle size={16} /> : <Info size={16} />}
          </span>
          <span className="max-w-[440px] overflow-hidden text-ellipsis whitespace-nowrap">{toastMsg}</span>
          <button onClick={() => setToastMsg('')} className="ml-2 opacity-60 hover:opacity-100 transition-opacity inline-flex items-center" aria-label={t(lang, 'ariaClose')}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
