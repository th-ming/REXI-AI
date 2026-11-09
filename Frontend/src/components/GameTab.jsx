import React, { useState } from 'react';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import { Gamepad2, RefreshCw, ExternalLink, Monitor } from 'lucide-react';
import GameFrame from './GameFrame';

const GAMES = [
  { id: 'pacman', name: 'Pac-Man', desc: 'Cổ điển nhất mọi thời đại', emoji: '👻', color: 'from-yellow-500 to-amber-600', url: '/games/pacman/index.html' },
  { id: 'snake', name: 'Snake', desc: 'Rắn săn mồi, điểm càng cao càng nghiện', emoji: '🐍', color: 'from-emerald-500 to-green-600', url: '/games/snake/index.html' },
  { id: 'pong', name: 'Pong Wars', desc: 'Ngày vs Đêm — trận chiến bóng bàn', emoji: '🏓', color: 'from-sky-500 to-indigo-600', url: '/games/pong/index.html' },
];

export default function GameTab({ showToast }) {
  const lang = getLang();
  const [activeGame, setActiveGame] = useState('pacman');
  const [reloadKey, setReloadKey] = useState(0);

  const current = GAMES.find(g => g.id === activeGame) || GAMES[0];

  const handlePick = (id) => {
    setActiveGame(id);
    setReloadKey(k => k + 1);
  };

  const handleReload = () => {
    setReloadKey(k => k + 1);
  };

  const handleOpenNewTab = () => {
    window.open(current.url, '_blank', 'noopener');
    showToast?.((getLang() === 'en' ? `Opened ${current.name} in a new tab` : `Đã mở ${current.name} trong tab mới`), 'success');
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0d0e11]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#181920] border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center shrink-0">
            <Gamepad2 size={14} className="text-white" />
          </span>
          <span className="text-xs font-bold text-white whitespace-nowrap">Game Zone</span>
          <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
            {GAMES.map(g => (
              <button
                key={g.id}
                onClick={() => handlePick(g.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all shrink-0 border ${
                  activeGame === g.id
                    ? 'bg-white/15 text-white border-white/20 shadow-lg'
                    : 'bg-transparent text-slate-400 border-transparent hover:bg-white/5 hover:text-white'
                }`}
                title={tx(lang, g.desc)}
              >
                <span>{g.emoji}</span>
                <span>{g.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleReload}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-all"
            title={t(lang, 'tipReload')}
          >
            <RefreshCw size={14} className="transition-transform group-hover:rotate-90" />
          </button>
          <button
            onClick={handleOpenNewTab}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-all"
            title={t(lang, 'tipNewTab')}
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </div>

      {/* Game info strip */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#14151c] border-b border-white/5 shrink-0">
        <span className={`w-5 h-5 rounded-md bg-[var(--accent)] flex items-center justify-center`}>
          <Monitor size={11} className="text-white" />
        </span>
        <span className="text-[11px] font-semibold text-slate-200">{current.name}</span>
        <span className="text-[10px] text-slate-500">{tx(lang, current.desc)}</span>
        <span className="ml-auto text-[10px] text-slate-600">{tx(lang, 'Chơi ngay trong trình duyệt — không cần cài đặt')}</span>
      </div>

      <GameFrame src={current.url} title={current.name} name={current.name} reloadKey={reloadKey} />
    </div>
  );
}
