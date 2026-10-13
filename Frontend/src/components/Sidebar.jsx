import React, { useState, useRef, useEffect } from 'react';
import {
   PanelLeftClose, Plus, MessageSquare,
   Layers, Zap, Search, Trash2, ChevronDown, FolderOpen,
   User, Settings, LogOut, Headphones, Shield, Pin
  } from 'lucide-react';
import { API_BASE } from '../config';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';

const RexiLogo = ({ className = "w-8 h-8" }) => (
  <img src="/rexi_cat_icon.png" alt="Rexi" className={`rexi-logo object-contain ${className}`} />
);

export default function Sidebar({
  sidebarOpen, setSidebarOpen,
  setActiveTab,
  filteredConvs, searchQuery, setSearchQuery,
  activeConvId, setActiveConvId,
  handleNewConversation, handleDeleteConversation, handleTogglePin,
  filesDrawerOpen, setFilesDrawerOpen, renderTree, fileTree,
   setSkillsOpen, setSuperToolsOpen,
  currentUser, setCurrentUser, setAuthToken, setAuthModalOpen, setSettingsOpen,
  apiFetch, showToast, setConversations,
  lang = 'vi'
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = () => {
    if (!window.confirm(t(lang, 'logoutConfirm'))) return;
    try {
      const token = localStorage.getItem('rexi_token');
      if (token) fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    } catch (e) {
      console.warn('[Sidebar] Logout API lỗi (vẫn xóa phiên cục bộ):', e.message);
    }
    setCurrentUser(null);
    setAuthToken('');
    localStorage.removeItem('rexi_token');
    localStorage.removeItem('rexi_user');
    setUserMenuOpen(false);
  };

  const handleContactAdmin = async () => {
    if (!currentUser) { setAuthModalOpen(true); return; }
    try {
      const data = await apiFetch('/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ tieu_de: tx(getLang(), '[Admin] Hỗ trợ & Phản hồi') })
      });
      if (data.ma_hoi_thoai) {
        setConversations(prev => [data, ...prev]);
        setActiveConvId(data.ma_hoi_thoai);
        setActiveTab('chat');
        setUserMenuOpen(false);
        showToast(t(lang, 'contactAdminCreated'), 'success');
      } else {
        showToast(data.error || t(lang, 'contactAdminFail'), 'error');
      }
    } catch(e) {
      console.error('Contact admin error:', e);
      showToast(t(lang, 'serverError'), 'error');
    }
  };

  const handleAdminPanel = () => {
    if (!currentUser) {
      showToast(t(lang, 'needLoginAdmin'), 'error');
      setAuthModalOpen(true);
      return;
    }
    if (currentUser.phan_quyen !== 'admin') {
      showToast(t(lang, 'adminOnlyAccess'), 'error');
      return;
    }
    setActiveTab('admin');
  };

  return (
    <aside className={`
      fixed inset-y-0 left-0 z-40 flex flex-col bg-[var(--bg-sidebar)] border-r border-white/5 transition-all duration-300
      ${sidebarOpen ? 'w-72' : 'w-0 overflow-hidden'}
      md:relative md:shrink-0
    `}>
      {/* Header Branding */}
      <div className="flex items-center justify-between h-14 px-4 border-b border-white/5">
        <div className="flex items-center gap-3 min-w-0">
          <RexiLogo className="w-8 h-8" />
          <div className="min-w-0">
            <h1 className="font-bold text-base bg-gradient-to-r from-cyan-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent truncate">
              Rexi AI OS
            </h1>
            <span className="text-[10px] text-cyan-400/80 tracking-widest uppercase font-medium truncate block">Master Suite v2.0</span>
          </div>
        </div>
        <button
          onClick={() => setSidebarOpen(false)}
          className="group inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:bg-white/10 hover:text-cyan-300 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 transition-all duration-200 shrink-0"
          title={t(lang, 'collapseSidebar') || 'Thu gọn'}
          aria-label={t(lang, 'ariaCollapse')}
        >
          <PanelLeftClose size={18} className="transition-transform duration-200 group-hover:-translate-x-0.5" />
        </button>
      </div>

      {/* New Conversation Button */}
      <div className="p-3">
        <button
          onClick={handleNewConversation}
          className="btn-new-conv w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-xs transition-all"
        >
          <Plus size={15} />
          <span>{t(lang, 'newConversation')}</span>
        </button>
      </div>



      {/* Skills & Super Tools Buttons — chỉ hiển thị khi đã đăng nhập (backend chặn guest 401) */}
      {currentUser && (
      <div className="grid grid-cols-2 gap-2 px-3 mt-2">
        <button
          onClick={() => setSkillsOpen(true)}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-purple-900/30 border border-purple-500/30 text-purple-300 hover:text-white text-[11px] font-medium transition-all"
        >
          <Layers size={13} /> {t(lang, 'skillsBtn')}
        </button>
        <button
          onClick={() => setSuperToolsOpen(true)}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-amber-900/30 border border-amber-500/30 text-amber-300 hover:text-white text-[11px] font-medium transition-all"
        >
          <Zap size={13} /> {t(lang, 'superToolsBtn')}
        </button>
      </div>
      )}

      {/* Search */}
      <div className="px-3 my-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#131417] border border-white/5">
          <Search size={14} className="text-slate-500 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t(lang, 'searchConvs')}
            className="w-full bg-transparent text-xs text-slate-200 placeholder-slate-500 outline-none"
          />
        </div>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {filteredConvs.map(conv => (
          <div
            key={conv.ma_hoi_thoai}
            onClick={() => { setActiveConvId(conv.ma_hoi_thoai); setActiveTab('chat'); }}
            className={`conv-item group flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-all border ${
              activeConvId === conv.ma_hoi_thoai
                ? 'conv-active bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
                : 'border-transparent hover:bg-white/5 text-slate-300'
            }`}
          >
            <div className="flex items-center gap-2.5 truncate">
              <MessageSquare size={14} className={activeConvId === conv.ma_hoi_thoai ? "text-cyan-400" : "text-slate-500"} />
              <span className="text-xs truncate font-medium">{conv.tieu_de || t(lang, 'newChat')}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={(e) => handleTogglePin && handleTogglePin(conv, e)}
                className={`p-1 rounded-md transition-all ${
                  conv.da_ghim
                    ? 'opacity-100 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                    : 'opacity-0 group-hover:opacity-100 text-slate-500 hover:text-amber-400 hover:bg-white/10'
                }`}
                title={conv.da_ghim ? t(lang, 'unpinConv') : t(lang, 'pinConv')}
              >
                <Pin size={13} className={conv.da_ghim ? 'fill-amber-400/30' : ''} />
              </button>
              <button
                onClick={(e) => handleDeleteConversation(conv.ma_hoi_thoai, e)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-rose-400 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Files Drawer — chỉ hiển thị khi đã đăng nhập (trước đây guest thấy nhưng click bị 401) */}
      {currentUser && (
      <div className="px-2 border-t border-white/5 pt-2">
        <button
          onClick={() => setFilesDrawerOpen(!filesDrawerOpen)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <span className="flex items-center gap-2"><FolderOpen size={15} /> {t(lang, 'projectFiles')}</span>
          <ChevronDown size={13} className={`transition-transform ${filesDrawerOpen ? 'rotate-180' : ''}`} />
        </button>
        {filesDrawerOpen && (
          <div className="mt-1 max-h-40 overflow-y-auto px-1 pb-2 font-mono text-xs">
            {renderTree(fileTree)}
          </div>
        )}
      </div>
      )}

      {/* User Profile Bar */}
      <div className="p-3 border-t border-white/5 flex items-center justify-between bg-[#131417] relative">
        {currentUser ? (
          <div className="relative" ref={userMenuRef}>
            <button onClick={() => setUserMenuOpen(!userMenuOpen)} className="flex items-center gap-2.5 cursor-pointer hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shadow-md">
                {currentUser.ten_day_du ? currentUser.ten_day_du[0].toUpperCase() : 'U'}
              </div>
              <div className="truncate max-w-[110px]">
                <p className="text-xs font-semibold text-slate-200 truncate">{currentUser.ten_day_du}</p>
                <p className="text-[10px] text-emerald-400 font-medium flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Connected</p>
              </div>
            </button>
            {userMenuOpen && (
              <div className="absolute bottom-full left-0 mb-2 bg-[#1a1b24] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50 min-w-[180px]">
                <div className="px-3 py-2 border-b border-white/5">
                  <p className="text-xs font-bold text-white truncate">{currentUser.ten_day_du}</p>
                  <p className="text-[10px] text-slate-400 truncate">{currentUser.email}</p>
                </div>
                <button type="button" onClick={handleContactAdmin} className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-amber-400 hover:bg-white/5 transition-colors">
                  <Headphones size={13} /> {t(lang, 'messageAdmin')}
                </button>
                <div className="border-t border-white/5 my-0.5"></div>
                <button type="button" onClick={handleLogout} className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-rose-400 hover:bg-white/5 transition-colors">
                  <LogOut size={13} /> {t(lang, 'logout')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={() => setAuthModalOpen(true)} title={t(lang, 'loginUnlockTitle')} className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full border border-white/20 flex items-center justify-center">
              <User size={14} className="text-white/70" />
            </div>
            <span className="text-xs font-medium text-slate-400">{t(lang, 'loginBtn')}</span>
          </button>
        )}
        <div className="flex items-center gap-1">
          {currentUser?.phan_quyen === 'admin' && (
            <button onClick={handleAdminPanel} className="p-1.5 rounded-lg hover:bg-white/10 text-amber-400/60 hover:text-amber-400 transition-colors" title={t(lang, 'adminOnlyTitle')}>
              <Shield size={16} />
            </button>
          )}
          <button onClick={() => setSettingsOpen(true)} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title={t(lang, 'settingsTitle')}>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
