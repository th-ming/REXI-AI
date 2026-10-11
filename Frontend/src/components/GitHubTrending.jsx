import React, { useState, useEffect, useCallback, useRef } from 'react';
import { t, getLang } from '../i18n';
const T = t; // alias tránh bị che bởi biến tab 't'
import { API_BASE, apiFetch } from '../config';
import { mdToHtml, sanitizeHtml } from '../utils/sanitize';
import {
  TrendingUp, Star, GitFork, ExternalLink, RefreshCw,
  Search, Clock, ChevronDown, Users, Flame,
  Volume2, VolumeX, Calendar, Tag, Bell, BellOff, CheckCheck, Sparkles,
  X, Download, FileText, Rocket, Activity
} from 'lucide-react';

function GithubIcon({ size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className}>
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}


const LANGUAGES = [
  '', 'javascript', 'typescript', 'python', 'java', 'go', 'rust',
  'c++', 'c', 'c#', 'ruby', 'php', 'swift', 'kotlin', 'dart',
  'vue', 'svelte', 'shell', 'html', 'css', 'lua', 'zig'
];

const PERIODS = [
  { value: 'daily', label: 'Hôm nay', icon: Flame },
  { value: 'weekly', label: 'Tuần này', icon: Clock },
  { value: 'monthly', label: 'Tháng này', icon: TrendingUp },
];

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n?.toString() || '0';
}

function getLangColor(lang) {
  const colors = {
    JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5',
    Java: '#b07219', Go: '#00ADD8', Rust: '#dea584', 'C++': '#f34b7d',
    C: '#555555', 'C#': '#178600', Ruby: '#701516', PHP: '#4F5D95',
    Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB',
    Vue: '#41b883', Svelte: '#ff3e00', Shell: '#89e051',
    HTML: '#e34c26', CSS: '#563d7c', Lua: '#000080', Zig: '#ec915c',
  };
  return colors[lang] || '#8b8b8b';
}

// ─── TTS Helper ────────────────────────────────────────────
function speakText(text) {
  if (!window.speechSynthesis) return false;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  // Use English voice for repo descriptions (they're in English)
  const voices = window.speechSynthesis.getVoices();
  const enVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'))
    || voices.find(v => v.lang.startsWith('en'));
  if (!enVoice) return false;
  utter.voice = enVoice;
  utter.lang = 'en-US';
  utter.rate = 0.9;
  utter.pitch = 1;
  utter.onend = () => {};
  window.speechSynthesis.speak(utter);
  return true;
}

// Preload voices
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// ─── Repo Card ──────────────────────────────────────────────
function RepoCard({ repo, index, isStarred, onStarRepo, starringKey, speakingKey, onSpeak, onOpenDetail }) {
  const isSpeaking = speakingKey === repo.full_name;
  return (
    <div className="group p-4 bg-[#131417] rounded-xl border border-white/5 hover:border-white/15 hover:bg-white/[0.03] transition-all duration-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Rank + Name */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-bold text-slate-500 w-5 text-right">#{repo.rank || index + 1}</span>
            <button onClick={() => onOpenDetail(repo)} title={t(getLang(), 'tipDetail')}
              className="text-sm font-semibold text-cyan-400 hover:text-cyan-300 truncate flex items-center gap-1.5 transition-colors text-left">
              <GithubIcon size={13} className="shrink-0" />
              {repo.full_name}
              <ExternalLink size={10} className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          </div>

          {/* Description */}
          {repo.description && (
            <p className="text-xs text-slate-400 line-clamp-2 mb-2 ml-7">{repo.description}</p>
          )}

          {/* AI Summary */}
          {repo.ai_summary && (
            <div className="ml-7 mb-2 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-500/8 to-cyan-500/8 border border-purple-500/15">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles size={11} className="text-purple-400" />
                <span className="text-[10px] font-semibold text-purple-300 uppercase tracking-wider">{T(getLang(), 'AI Tóm Tắt')}</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed line-clamp-3">{repo.ai_summary}</p>
            </div>
          )}

          {/* Topics */}
          {repo.topics && repo.topics.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2 ml-7">
              {repo.topics.slice(0, 5).map(t => (
                <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 text-[9px] font-medium border border-cyan-500/20">
                  <Tag size={8} /> {t}
                </span>
              ))}
              {repo.topics.length > 5 && (
                <span className="text-[9px] text-slate-500">+{repo.topics.length - 5}</span>
              )}
            </div>
          )}

          {/* Stats Row */}
          <div className="flex flex-wrap items-center gap-3 ml-7">
            {/* Stars gained */}
            {repo.stars_gained > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-semibold border border-amber-500/20">
                <TrendingUp size={10} />
                +{formatNumber(repo.stars_gained)} {repo.period || ''}
              </span>
            )}

            {/* Total Stars — icon ★ clickable to star/unstar */}
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <button
                onClick={() => onStarRepo(repo)}
                disabled={starringKey === repo.full_name}
                title={isStarred ? (getLang() === 'vi' ? 'Bỏ star' : 'Unstar') : (getLang() === 'vi' ? 'Star repo này' : 'Star this repo')}
                className={`p-0.5 rounded transition-all ${
                  isStarred
                    ? 'text-yellow-300 hover:text-yellow-200'
                    : 'text-amber-400 hover:text-yellow-300'
                }`}
              >
                {starringKey === repo.full_name ? (
                  <RefreshCw size={11} className="animate-spin" />
                ) : isStarred ? (
                  <Star size={11} className="fill-yellow-400" />
                ) : (
                  <Star size={11} />
                )}
              </button>
              {formatNumber(repo.stars)}
            </span>

            {/* Forks */}
            {repo.forks > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <GitFork size={11} className="text-slate-500" />
                {formatNumber(repo.forks)}
              </span>
            )}

            {/* Language */}
            {repo.language && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getLangColor(repo.language) }}></span>
                {repo.language}
              </span>
            )}

            {/* License */}
            {repo.license && (
              <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded border border-white/5">
                {repo.license}
              </span>
            )}

            {/* Created date */}
            {repo.created_at && (
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                <Calendar size={9} />
                {new Date(repo.created_at).toLocaleDateString('vi-VN')}
              </span>
            )}

            {/* Contributors */}
            {repo.contributors && repo.contributors.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Users size={10} />
                {repo.contributors.length} contributors
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col items-center gap-1.5 shrink-0">
          {/* TTS Button */}
          <button
            onClick={() => onSpeak(repo)}
            title={isSpeaking ? (getLang() === 'vi' ? 'Dừng đọc' : 'Stop reading') : (getLang() === 'vi' ? 'Đọc mô tả repo' : 'Read repo description')}
            className={`p-2 rounded-lg border transition-all flex items-center justify-center ${
              isSpeaking
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 animate-pulse'
                : 'bg-white/5 text-slate-400 border-white/10 hover:text-emerald-300 hover:border-emerald-500/30'
            }`}
          >
            {isSpeaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>

          {/* Star on GitHub button */}
          <button
            onClick={() => onStarRepo(repo)}
            disabled={starringKey === repo.full_name}
            title={isStarred ? (getLang() === 'vi' ? 'Bỏ star trên GitHub' : 'Unstar on GitHub') : (getLang() === 'vi' ? 'Star trên GitHub' : 'Star on GitHub')}
            className={`p-2 rounded-lg border transition-all disabled:opacity-40 flex items-center justify-center ${
              isStarred
                ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30 hover:bg-yellow-500/30'
                : 'bg-white/5 text-slate-400 border-white/10 hover:text-yellow-300 hover:border-yellow-500/30'
            }`}
          >
            {starringKey === repo.full_name ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : isStarred ? (
              <Star size={13} className="fill-yellow-400" />
            ) : (
              <Star size={13} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// mdToHtml + sanitizeHtml: dùng chung từ ../utils/sanitize (P2-15 harden:
// escape `"`, validate URL http/https/relative, DOMPurify trước render).

function StarChart({ points }) {
  const [w, h, pad] = [360, 140, 8];
  const data = (points || []).slice(-30);
  if (!data.length) return <div className="text-[11px] text-slate-500 py-6 text-center">{T(getLang(), 'Chưa có dữ liệu lịch sử. Bấm "Lưu snapshot" để bắt đầu theo dõi.')}</div>;
  const stars = data.map(d => d.stars);
  const min = Math.min(...stars), max = Math.max(...stars);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / Math.max(data.length - 1, 1);
  const yOf = v => h - pad - ((v - min) / range) * (h - pad * 2);
  const pts = data.map((d, i) => `${(pad + i * step).toFixed(1)},${yOf(d.stars).toFixed(1)}`).join(' ');
  const first = data[0], last = data[data.length - 1];
  const gain = last.stars - first.stars;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-slate-400">
          {data.length} {T(getLang(), 'điểm')} · {first.created_at} → {last.created_at}
        </span>
        <span className={`text-[11px] font-bold ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {gain >= 0 ? '+' : ''}{gain.toLocaleString()} ★
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-36" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <polygon points={`${pad},${h - pad} ${pts} ${w - pad},${h - pad}`} fill="url(#grad)" opacity="0.25" />
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </linearGradient>
        </defs>
        <text x={pad} y={h - pad - 4} fill="#64748b" fontSize="8">{min.toLocaleString()}</text>
        <text x={w - pad - 30} y={pad + 8} fill="#64748b" fontSize="8">{max.toLocaleString()}</text>
      </svg>
    </div>
  );
}

function RepoDetailModal({ repo, token, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('readme');
  const [stars, setStars] = useState([]);
  const [starsLoading, setStarsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        const data = await apiFetch(`/admin/github/repo/${repo.owner || repo.full_name.split('/')[0]}/${repo.name || repo.full_name.split('/')[1]}`, token);
        if (!cancelled) setDetail(data.repo);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repo, token]);

  const loadStars = async () => {
    setStarsLoading(true);
    try {
      const data = await apiFetch(`/admin/github/stars/${repo.full_name.split('/')[0]}/${repo.full_name.split('/')[1]}/history`, token);
      setStars(data.points || []);
    } catch { setStars([]); }
    finally { setStarsLoading(false); }
  };

  useEffect(() => {
    if (tab === 'stars') loadStars();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!repo) return null;
  const fullName = repo.full_name;

  let readmeHtml = '';
  if (detail) {
    try {
      const raw = detail.readme_base64
        ? decodeURIComponent(escape(atob(detail.readme)))
        : detail.readme || '';
      readmeHtml = sanitizeHtml(mdToHtml(raw));
    } catch { readmeHtml = ''; }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#16171f] border border-white/10 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10 flex items-start justify-between gap-3 bg-white/5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GithubIcon size={16} className="text-purple-400 shrink-0" />
              <h2 className="text-sm font-bold text-white truncate flex items-center gap-2">
                <a href={`https://github.com/${fullName}`} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                  {fullName}
                </a>
                {detail?.archived && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-600/30 text-slate-300 border border-white/10">archived</span>}
              </h2>
            </div>
            {detail?.description && <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{detail.description}</p>}
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {detail?.language && (
                <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getLangColor(detail.language) }}></span>
                  {detail.language}
                </span>
              )}
              {detail?.license && <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded border border-white/10">{detail.license}</span>}
              {detail && <span className="inline-flex items-center gap-1 text-[10px] text-slate-400"><Star size={9} className="text-amber-400" /> {formatNumber(detail.stars)}</span>}
              {detail && <span className="inline-flex items-center gap-1 text-[10px] text-slate-400"><GitFork size={9} /> {formatNumber(detail.forks)}</span>}
              {detail && <span className="inline-flex items-center gap-1 text-[10px] text-slate-400"><Users size={9} /> {formatNumber(detail.watchers)} watchers</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 border-b border-white/5">
          {[
            { id: 'readme', label: 'README', icon: FileText },
            { id: 'stars', label: 'Tăng star', icon: Activity },
            { id: 'contributors', label: 'Contributors', icon: Users },
            { id: 'release', label: 'Release', icon: Rocket },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-[11px] font-semibold transition-colors ${
                tab === t.id ? 'bg-white/5 text-purple-300 border-b-2 border-purple-500' : 'text-slate-500 hover:text-slate-300'
              }`}>
              <t.icon size={11} /> {T(getLang(), t.label)}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          {loading && <div className="text-center py-10 text-slate-400 text-xs"><RefreshCw size={18} className="animate-spin mx-auto mb-2 text-purple-400" /> {T(getLang(), 'Đang tải...')}</div>}
          {error && <div className="text-center py-10 text-rose-400 text-xs">{error}</div>}
          {!loading && !error && tab === 'readme' && (
            <div>
              {detail?.ai_summary && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-500/10 to-cyan-500/10 border border-purple-500/15">
                  <div className="flex items-center gap-1.5 mb-1"><Sparkles size={11} className="text-purple-400" /><span className="text-[10px] font-semibold text-purple-300 uppercase tracking-wider">{T(getLang(), 'AI Tóm Tắt')}</span></div>
                  <p className="text-[12px] text-slate-200">{detail.ai_summary}</p>
                </div>
              )}
              {readmeHtml
                ? <div className="text-slate-200 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h1]:mt-3 [&_h2]:mt-2.5 [&_h3]:mt-2 [&_h1]:mb-1.5 [&_h2]:mb-1 [&_h3]:mb-1 [&_a]:text-cyan-400 [&_a:hover]:underline" dangerouslySetInnerHTML={{ __html: readmeHtml }} />
                : <div className="text-center py-8 text-slate-500 text-xs">{T(getLang(), 'Repo không có README.')}</div>}
            </div>
          )}
          {!loading && !error && tab === 'stars' && (
            <div>
              {starsLoading
                ? <div className="text-center py-8 text-slate-400 text-xs"><RefreshCw size={16} className="animate-spin mx-auto mb-2 text-purple-400" /> {T(getLang(), 'Đang tải...')}</div>
                : <StarChart points={stars} />}
            </div>
          )}
          {!loading && !error && tab === 'contributors' && (
            <div className="space-y-2">
              {(!detail?.contributors || detail.contributors.length === 0)
                ? <div className="text-center py-8 text-slate-500 text-xs">{T(getLang(), 'Không có dữ liệu contributors.')}</div>
                : detail.contributors.map((c, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5">
                    <div className="flex items-center gap-2.5">
                      {c.avatar_url
                        ? <img src={c.avatar_url} alt={c.login} className="w-7 h-7 rounded-full bg-white/10" />
                        : <div className="w-7 h-7 rounded-full bg-purple-500/20 flex items-center justify-center text-[10px] text-purple-300 font-bold">@</div>}
                      <span className="text-xs text-slate-200 font-medium">@{c.login}</span>
                    </div>
                    <span className="text-[10px] text-slate-500">{c.contributions} commits</span>
                  </div>
                ))}
            </div>
          )}
          {!loading && !error && tab === 'release' && (
            <div>
              {detail?.latest_release
                ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200 flex items-center gap-2"><Rocket size={13} className="text-emerald-400" />{detail.latest_release.tag_name || 'Latest'}</span>
                      {detail.latest_release.published_at && <span className="text-[10px] text-slate-500">{new Date(detail.latest_release.published_at).toLocaleDateString('vi-VN')}</span>}
                    </div>
                    {detail.latest_release.name && <p className="text-xs text-slate-300 font-medium">{detail.latest_release.name}</p>}
                    {detail.latest_release.body
                      ? <div className="text-slate-300 [&_h1]:text-sm [&_h2]:text-sm [&_h1]:font-bold [&_h2]:font-bold [&_h1]:mt-2 [&_h2]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_a]:text-cyan-400 [&_a:hover]:underline" dangerouslySetInnerHTML={{ __html: sanitizeHtml(mdToHtml(detail.latest_release.body)) }} />
                      : <div className="text-center py-6 text-slate-500 text-xs">{T(getLang(), 'Release không có mô tả.')}</div>}
                  </div>
                )
                : <div className="text-center py-8 text-slate-500 text-xs">{T(getLang(), 'Repo chưa có release nào.')}</div>}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 border-t border-white/10 bg-white/5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {tab === 'stars' && (
              <button onClick={loadStars} className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] text-slate-300 transition-colors">
                <RefreshCw size={10} className="inline mr-1" />{T(getLang(), 'Làm mới')}
              </button>
            )}
            {detail?.homepage && (
              <a href={detail.homepage} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-[10px] text-cyan-300 transition-colors">
                Homepage
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a href={`https://github.com/${fullName}`} target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-semibold transition-colors flex items-center gap-1.5">
              <ExternalLink size={11} /> {T(getLang(), 'Mở trên GitHub')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
export default function GitHubTrending({ token, showToast }) {
  const lang = getLang();
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [language, setLanguage] = useState('');
  const [period, setPeriod] = useState('daily');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [isCached, setIsCached] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savedRepos, setSavedRepos] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [view, setView] = useState('trending'); // 'trending' | 'saved'
  const [speakingKey, setSpeakingKey] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [starredRepos, setStarredRepos] = useState(new Set());
  const [starringKey, setStarringKey] = useState(null);
  const [githubStarred, setGithubStarred] = useState([]);
  const [detailRepo, setDetailRepo] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(null);

  const fetchTrending = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (language) params.set('language', language);
      params.set('since', period);
      const data = await apiFetch(`/admin/github/trending?${params}`, token);
      if (data.success) {
        setRepos(data.repos);
        setLastUpdated(new Date());
        setIsCached(data.cached || false);
        setFetchedAt(data.fetched_at || null);
      } else {
        setError(data.error || 'Failed to fetch trending');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, language, period]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await apiFetch(`/admin/github/search?q=${encodeURIComponent(searchQuery)}&per_page=20`, token);
      if (data.success) setSearchResults(data.repos);
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  // Fetch all starred repos from GitHub — phải khai báo TRƯỚC useEffect dùng nó
  const fetchGithubStarred = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/github/starred', token);
      if (data.success) setGithubStarred(data.repos || []);
    } catch { /* ignore */ }
  }, [token]);

  // Check which repos are starred on GitHub (batch check top repos)
  const fetchStarredStatus = useCallback(async (repoList) => {
    if (!repoList || repoList.length === 0) return;
    try {
      // Batch check — 1 API call instead of N
      const repos = repoList.slice(0, 100).map(repo => ({
        owner: repo.owner || repo.full_name.split('/')[0],
        name: repo.name || repo.full_name.split('/')[1],
      }));
      const data = await apiFetch('/admin/github/starred/batch', token, {
        method: 'POST',
        body: JSON.stringify({ repos }),
      });
      if (data.success && data.starred) {
        const starred = new Set(Object.entries(data.starred).filter(([, v]) => v).map(([k]) => k));
        setStarredRepos(starred);
      }
    } catch { /* ignore */ }
  }, [token]);

  // ─── REAL-TIME: Refresh tất cả data ───────────────────────────
  const lastRefreshRef = useRef(0);
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      // Parallel fetch tất cả data sources
      const promises = [];

      // 1. Trending repos
      promises.push(
        (async () => {
          try {
            const params = new URLSearchParams();
            if (language) params.set('language', language);
            params.set('since', period);
            const data = await apiFetch(`/admin/github/trending?${params}`, token);
            if (data.success) {
              setRepos(data.repos);
              setLastUpdated(new Date());
              setIsCached(data.cached || false);
              setFetchedAt(data.fetched_at || null);
              // Sau khi load trending xong, check star status
              setTimeout(() => {
                if (data.repos?.length > 0) fetchStarredStatus(data.repos);
              }, 300);
            }
          } catch { /* ignore */ }
        })()
      );

      // 2. Notifications
      promises.push(
        (async () => {
          try {
            const data = await apiFetch('/admin/github/notifications', token);
            if (data.success) {
              setNotifications(data.notifications || []);
              setUnreadCount(data.unread_count || 0);
            }
          } catch { /* ignore */ }
        })()
      );

      // 3. Saved repos (nếu đang ở tab saved)
      promises.push(
        (async () => {
          try {
            const data = await apiFetch('/admin/github/saved', token);
            if (data.success) setSavedRepos(data.repos);
          } catch { /* ignore */ }
        })()
      );

      // 4. GitHub starred (nếu đang ở tab starred)
      promises.push(
        (async () => {
          try {
            const data = await apiFetch('/admin/github/starred', token);
            if (data.success) setGithubStarred(data.repos || []);
          } catch { /* ignore */ }
        })()
      );

      await Promise.allSettled(promises);
    } catch { /* ignore */ } finally {
      setRefreshing(false);
      lastRefreshRef.current = Date.now();
    }
  }, [token, language, period, fetchStarredStatus]);

  useEffect(() => {
    fetchTrending().then(() => {
      // Sau khi load trending xong, auto-check trạng thái star cho từng repo
      // Dùng timeout nhỏ để repos state đã được set
      setTimeout(() => {
        setRepos(current => {
          if (current.length > 0) fetchStarredStatus(current);
          return current;
        });
      }, 500);
    });
  }, [fetchTrending]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── REAL-TIME: Auto-refresh khi quay lại tab + polling backoff ──
  useEffect(() => {
    let pollInterval = null;

    const isStale = () => {
      if (!lastRefreshRef.current) return true;
      return Date.now() - lastRefreshRef.current > 2 * 60 * 1000;
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isStale()) {
        refreshAll();
      }
    };

    // Khi quay lại tab → chỉ refresh nếu dữ liệu đã cũ (>2 phút)
    document.addEventListener('visibilitychange', handleVisibility);

    // Polling backoff mỗi 5 phút (chỉ khi tab visible + dữ liệu cũ)
    pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible' && isStale()) {
        refreshAll();
      }
    }, 300000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [refreshAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSaved = useCallback(async () => {
    setSavedLoading(true);
    try {
      const data = await apiFetch('/admin/github/saved', token);
      if (data.success) setSavedRepos(data.repos);
    } catch (e) {
      console.error('Failed to load saved repos', e.message);
    } finally {
      setSavedLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchSaved(); }, [fetchSaved]);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/github/notifications', token);
      if (data.success) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unread_count || 0);
      }
    } catch (e) {
      console.warn('[GitHubTrending] Không tải được thông báo:', e.message);
    }
  }, [token]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // Starred tab trigger — fetchGithubStarred đã được khai báo ở trên
  useEffect(() => {
    if (view === 'starred') fetchGithubStarred();
  }, [view, fetchGithubStarred]);

  // Star/Unstar a repo on GitHub — hiện toast lỗi thay vì im lặng
  const handleStarRepo = async (repo) => {
    const fullName = repo.full_name;
    const isStarred = starredRepos.has(fullName);
    const owner = repo.owner || fullName.split('/')[0];
    const name = repo.name || fullName.split('/')[1];
    setStarringKey(fullName);
    try {
      if (isStarred) {
        await apiFetch(`/admin/github/star/${owner}/${name}`, token, { method: 'DELETE' });
        setStarredRepos(prev => { const s = new Set(prev); s.delete(fullName); return s; });
        setError('');
      } else {
        await apiFetch('/admin/github/star', token, {
          method: 'POST',
          body: JSON.stringify({ owner, name }),
        });
        setStarredRepos(prev => new Set([...prev, fullName]));
        setError('');
      }
    } catch (e) {
      // Hiển thị lỗi rõ cho user — thường là thiếu GITHUB_TOKEN
      const msg = e.message || T(getLang(), 'Lỗi star repo');
      if (msg.includes('GitHub Personal Access Token') || msg.includes('GITHUB_TOKEN')) {
        setError(T(getLang(), '⚠️ Cần GitHub Token: Thêm GITHUB_TOKEN vào .env hoặc nhập GitHub API Key trong Admin → API Keys'));
      } else {
        setError(T(getLang(), '❌ Star thất bại: ') + msg);
      }
    } finally {
      setStarringKey(null);
    }
  };

  // Export saved / starred repos
  const handleExport = async (type, format) => {
    setExporting(`${type}-${format}`);
    try {
      const res = await fetch(`${API_BASE}/admin/github/export/${type}?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `github-${type}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast?.(`${T(getLang(), 'Đã export ')}${type} (${format.toUpperCase()}).`, 'success');
    } catch (e) {
      setError(e.message);
      showToast?.(T(getLang(), 'Export thất bại: ') + e.message, 'error');
    } finally {
      setExporting(null);
    }
  };



  // Close notification dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (showNotifications && !e.target.closest('#notificationBell') && !e.target.closest('[class*="absolute right-0 top-full"]')) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNotifications]);

  const markNotificationsRead = async (ids) => {
    try {
      await apiFetch('/admin/github/notifications/read', token, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      fetchNotifications();
    } catch (e) {
      console.error('[GitHubTrending] Đánh dấu đã đọc thất bại:', e.message);
      showToast?.(T(getLang(), 'Không đánh dấu đã đọc được: ') + (e.message || T(getLang(), 'lỗi mạng')), 'error');
    }
  };


  const displayRepos = view === 'saved'
    ? savedRepos.map((r, i) => ({ ...r, rank: i + 1 }))
    : view === 'starred'
    ? githubStarred.map((r, i) => ({ ...r, rank: i + 1 }))
    : (searchResults || repos);

  const handleSpeak = (repo) => {
    if (speakingKey === repo.full_name) {
      window.speechSynthesis?.cancel();
      setSpeakingKey(null);
      return;
    }
    const parts = [];
    if (repo.description) {
      parts.push(repo.description);
    } else {
      parts.push(`Repository ${repo.full_name}. No description available.`);
    }
    if (repo.language) parts.push(`Built with ${repo.language}.`);
    if (repo.stars) parts.push(`Has ${formatNumber(repo.stars)} stars.`);
    if (repo.stars_gained) parts.push(`Gained ${repo.stars_gained} stars ${repo.period || 'today'}.`);
    if (repo.topics?.length) parts.push(`Topics: ${repo.topics.join(', ')}.`);
    if (repo.homepage) parts.push(`Homepage: ${repo.homepage}.`);
    const ok = speakText(parts.join(' '));
    if (!ok) {
      showToast?.(T(getLang(), 'Thiết bị không có giọng đọc tiếng Anh (voice EN).'), 'error');
      return;
    }
    setSpeakingKey(repo.full_name);
  };

  return (
    <div className="bg-[#181920] rounded-2xl border border-white/8 shadow overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 bg-white/5 border-b border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <span className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <GithubIcon size={15} className="text-purple-400" />
          GitHub Trending
          <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 text-xs font-semibold border border-purple-500/30">
            {displayRepos.length}
          </span>
          {lastUpdated && view === 'trending' && (
            <span className="text-[10px] text-slate-500 font-normal flex items-center gap-1.5">
              {isCached ? (
                <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/20">Cache</span>
              ) : (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">Live</span>
              )}
              {fetchedAt && (
                <span title={fetchedAt}>{new Date(fetchedAt).toLocaleString("vi-VN")}</span>
              )}
            </span>
          )}
          </span>
        <div className="flex items-center gap-2">
          <div className="flex bg-[#131417] rounded-lg border border-white/10 p-0.5 mr-1">
            <button onClick={() => setView('trending')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === 'trending'
                  ? 'bg-purple-600 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}>
              <Flame size={12} />
              Trending
            </button>
            <button onClick={() => setView('starred')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === 'starred'
                  ? 'bg-yellow-500 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}>
              <Star size={12} />
              GitHub Star
              {savedRepos.length > 0 && (
                <span className={`px-1.5 rounded-full text-[9px] font-bold ${view === 'saved' ? 'bg-white/25' : 'bg-amber-500/20 text-amber-300'}`}>
                  {savedRepos.length}
                </span>
              )}
            </button>
          </div>
                    {/* Notification Bell */}
          <div className="relative">
            <button
              onClick={() => { setShowNotifications(!showNotifications); if (!showNotifications) fetchNotifications(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-300 hover:text-white transition-colors relative"
              id="notificationBell"
            >
              <Bell size={13} />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center animate-pulse">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notification Dropdown */}
            {showNotifications && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-[#1a1b24] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <span className="text-xs font-bold text-white flex items-center gap-2">
                    <Bell size={13} className="text-purple-400" /> {T(getLang(), 'Thông báo Trending')}
                  </span>
                  {unreadCount > 0 && (
                    <button
                      onClick={() => markNotificationsRead([])}
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                    >
                      <CheckCheck size={11} /> {T(getLang(), 'Đọc tất cả')}
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-8 text-center text-slate-500 text-xs">
                      <BellOff size={20} className="mx-auto mb-2 opacity-50" />
                      {T(getLang(), 'Chưa có thông báo mới')}
                    </div>
                  ) : (
                    notifications.map(n => (
                      <a
                        key={n.id}
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => { if (!n.is_read) markNotificationsRead([n.id]); }}
                        className={`block px-4 py-3 border-b border-white/5 hover:bg-white/5 transition-colors ${!n.is_read ? 'bg-purple-500/5' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          {!n.is_read && <span className="w-2 h-2 rounded-full bg-purple-500 mt-1.5 shrink-0"></span>}
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-cyan-400 truncate">{n.full_name}</p>
                            {n.description && <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-1">{n.description}</p>}
                            <div className="flex items-center gap-2 mt-1">
                              {n.language && <span className="text-[9px] text-slate-500">{n.language}</span>}
                              {n.stars > 0 && <span className="text-[9px] text-amber-400">★ {n.stars}</span>}
                              {n.stars_gained > 0 && <span className="text-[9px] text-emerald-400">+{n.stars_gained}</span>}
                              <span className="text-[9px] text-slate-600">{new Date(n.created_at).toLocaleString('vi-VN')}</span>
                            </div>
                          </div>
                        </div>
                      </a>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          
          <button onClick={() => { setSearchResults(null); refreshAll(); }} disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-xs text-purple-300 hover:text-purple-200 transition-colors disabled:opacity-50" title="Force refresh from GitHub">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh Live</span>
          </button>
          <button onClick={() => { setSearchResults(null); refreshAll(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-300 hover:text-white transition-colors">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">{T(getLang(), 'Làm mới')}</span>
          </button>
          {/* Export dropdown */}
          {(view === 'saved' || view === 'starred') && (
            <div className="relative">
              <button onClick={() => setShowExport(!showExport)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs text-emerald-300 hover:text-emerald-200 transition-colors">
                <Download size={13} /> <span className="hidden sm:inline">Export</span>
              </button>
              {showExport && (
                <div className="absolute right-0 top-full mt-2 w-40 bg-[#1a1b24] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <button onClick={() => { handleExport(view, 'csv'); setShowExport(false); }} disabled={!!exporting}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-white/5 transition-colors disabled:opacity-40">{exporting === `${view}-csv` ? 'Đang export...' : 'CSV'}</button>
                  <button onClick={() => { handleExport(view, 'json'); setShowExport(false); }} disabled={!!exporting}
                    className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-white/5 transition-colors disabled:opacity-40">{exporting === `${view}-json` ? 'Đang export...' : 'JSON'}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* Controls Row */}
        <div className="flex flex-wrap items-end gap-3">
          {view === 'trending' && (
            <>
          {/* Language Filter */}
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10px] text-slate-500 mb-1 font-semibold uppercase">{T(getLang(), 'Ngôn ngữ')}</label>
            <div className="relative">
              <select value={language} onChange={e => setLanguage(e.target.value)}
                className="w-full appearance-none px-3 py-2 bg-[#131417] border border-white/10 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-purple-500/50 pr-8 cursor-pointer">
                <option value="">{T(getLang(), 'Tất cả')}</option>
                {LANGUAGES.filter(Boolean).map(l => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            </div>
          </div>

          {/* Period Tabs */}
          <div className="flex bg-[#131417] rounded-lg border border-white/10 p-0.5">
            {PERIODS.map(p => (
              <button key={p.value} onClick={() => setPeriod(p.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  period === p.value
                    ? 'bg-purple-600 text-white shadow'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}>
                <p.icon size={12} />
                {T(getLang(), p.label)}
              </button>
            ))}
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder={t(lang, 'phRepoSearch')}
                className="pl-8 pr-3 py-2 bg-[#131417] border border-white/10 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500/50 w-40" />
            </div>
            <button type="submit" disabled={searching || !searchQuery.trim()}
              className="px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs rounded-lg font-semibold transition-colors flex items-center gap-1">
              {searching ? <RefreshCw size={11} className="animate-spin" /> : <Search size={11} />}
              {T(getLang(), 'Tìm')}
            </button>
            {searchResults && (
              <button type="button" onClick={() => { setSearchResults(null); setSearchQuery(''); }}
                className="px-2 py-2 bg-white/5 hover:bg-white/10 text-slate-400 text-xs rounded-lg transition-colors">
                ✕
              </button>
            )}
          </form>
            </>
          )}
        </div>

        {/* Loading */}
        {loading && view === 'trending' && (
          <div className="text-center py-12 text-slate-400 text-sm flex flex-col items-center gap-3">
            <RefreshCw size={22} className="animate-spin text-purple-400" />
            {T(getLang(), 'Đang tải trending repos...')}
          </div>
        )}

        {/* Saved loading */}
        {savedLoading && view === 'saved' && (
          <div className="text-center py-12 text-slate-400 text-sm flex flex-col items-center gap-3">
            <RefreshCw size={22} className="animate-spin text-amber-400" />
            {T(getLang(), 'Đang tải repos đã lưu...')}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-center py-12 text-rose-400 text-sm px-6 flex flex-col items-center gap-2">
            <GithubIcon size={22} className="text-rose-500" />
            {error}
          </div>
        )}

        {/* Repo List */}
        {!error && !(loading && view === 'trending') && !(savedLoading && view === 'saved') && (
          <div className="space-y-2">
            {displayRepos.length === 0 ? (
              <div className="text-center py-12 text-slate-500 text-xs">
                {view === 'saved'
                  ? T(getLang(), 'Chưa có repo nào được lưu. Vào tab Trending và bấm nút bookmark để lưu.')
                  : T(getLang(), 'Không có repo nào. Thử lại sau.')}
              </div>
            ) : (
              displayRepos.map((repo, i) => (
                <RepoCard
                  key={repo.full_name || i}
                  repo={repo}
                  index={i}
                  isStarred={starredRepos.has(repo.full_name)}
                  onStarRepo={handleStarRepo}
                  starringKey={starringKey}
                  speakingKey={speakingKey}
                  onSpeak={handleSpeak}
                  onOpenDetail={(r) => setDetailRepo(r)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Repo Detail Modal */}
      {detailRepo && (
        <RepoDetailModal repo={detailRepo} token={token} onClose={() => setDetailRepo(null)} />
      )}
    </div>
  );
}
