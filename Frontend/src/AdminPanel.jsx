// ═══════════════════════════════════════════════════════════
// ADMIN PANEL - Rexi AI OS (Auto-Reloaded & Synced)
// ═══════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { t, getLang } from './i18n';
import { tx } from './i18n-sweep';
import {
  Shield, Users, MessageSquare, Key, Layers, Settings, Home,
  Activity, Trash2, Search, RefreshCw, ChevronLeft, ChevronRight,
  Crown, User as UserIcon, Lock, CheckCircle, XCircle,
  AlertTriangle, Database, Send, Wifi,
  GitBranch, Terminal, X, Clock, Tv, Globe, Radar, PlayCircle, CalendarClock,
  Plus, Pencil, Download, Loader2, Save, Bell, Code
} from 'lucide-react';
import { API_BASE, apiFetch } from './config';
import GitHubTrending from './components/GitHubTrending';
function codeToTwemojiUrl(code) {
  if (!code || code.length !== 2) return null;
  const c = code.toUpperCase();
  const cp1 = (0x1F1E6 + c.charCodeAt(0) - 65).toString(16);
  const cp2 = (0x1F1E6 + c.charCodeAt(1) - 65).toString(16);
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/${cp1}-${cp2}.svg`;
}

function FlagImg({ code, size = 16 }) {
  const url = codeToTwemojiUrl(code);
  if (!url) return <span style={{ fontSize: size }}>🌍</span>;
  return <img src={url} alt={code} style={{ width: size, height: size, verticalAlign: 'middle' }} onError={e => { e.target.style.display = 'none'; }} />;
}

function GithubIcon({ size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className}>
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}



// ─── Sidebar Menu Items ────────────────────────────────────
const MENU_ITEMS = [
  { id: 'users', icon: Users, label: t(getLang(), 'Người Dùng'), color: 'text-indigo-400' },
  { id: 'conversations', icon: MessageSquare, label: t(getLang(), 'Hội Thoại'), color: 'text-emerald-400' },
  { id: 'apikeys', icon: Key, label: 'API Keys', color: 'text-amber-400' },
  { id: 'skills', icon: Layers, label: t(getLang(), 'Kỹ Năng'), color: 'text-purple-400' },
  { id: 'chat', icon: Send, label: t(getLang(), 'Chat với Users'), color: 'text-rose-400' },
  { id: 'iptv', icon: Tv, label: 'IPTV Monitor', color: 'text-sky-400' },
  { id: 'github', icon: GithubIcon, label: 'GitHub Trending', color: 'text-purple-400' },
  { id: 'routing', icon: GitBranch, label: t(getLang(), 'Định Tuyến'), color: 'text-cyan-400' },
  { id: 'settings', icon: Settings, label: t(getLang(), 'Hệ Thống'), color: 'text-slate-400' },
];

// ─── Badge Components ──────────────────────────────────────
function RoleBadge({ role }) {
  return role === 'admin'
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30"><Crown size={9} /> Admin</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"><UserIcon size={9} /> User</span>;
}

function StatusBadge({ status }) {
  return status === 'banned'
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30"><XCircle size={9} /> {t(getLang(), 'Bị khoá')}</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"><CheckCircle size={9} /> Active</span>;
}

function Toast({ message, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  const c = type === 'success' ? 'bg-emerald-900/90 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/90 border-rose-500/40 text-rose-200';
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border shadow-2xl text-sm font-medium backdrop-blur ${c}`}>
      {type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
      {message}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: DASHBOARD
// ═══════════════════════════════════════════════════════════

// TAB: USER MANAGEMENT
// ═══════════════════════════════════════════════════════════
const UsersTab = memo(function UsersTab({ token, currentUser, showToast, stats, statsLoading, fetchStats }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(() => {
    const saved = localStorage.getItem('rexi_admin_user_page');
    return saved ? parseInt(saved, 10) : 1;
  });
  const [totalPages, setTotalPages] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [actionLoading, setActionLoading] = useState({});

  const handlePageChange = (newPage) => {
    setPage(newPage);
    localStorage.setItem('rexi_admin_user_page', newPage.toString());
  };

  const fetchUsers = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 10 });
      if (search) params.append('search', search);
      const data = await apiFetch(`/auth/users?${params}`, token);
      setUsers(Array.isArray(data.users) ? data.users : []);
      setTotalPages(data.totalPages || 1);
      setTotalUsers(data.totalUsers || 0);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, token, showToast]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const changeRole = async (userId, newRole) => {
    setActionLoading(prev => ({ ...prev, [`role_${userId}`]: true }));
    // Cập nhật lạc quan (Optimistic Update) ngay trên giao diện để tránh giật cuộn chuột
    setUsers(prev => prev.map(u => u.ma_nguoi_dung === userId ? { ...u, phan_quyen: newRole } : u));
    try {
      await apiFetch(`/auth/users/${userId}/role`, token, { method: 'PUT', body: JSON.stringify({ phan_quyen: newRole }) });
      showToast(t(getLang(), 'Đã cập nhật quyền thành công'));
      fetchUsers(true); // Tải ngầm không unmount bảng -> Vị trí cuộn chuột đứng yên 100%
      if (fetchStats) fetchStats();
    } catch (e) {
      showToast(e.message, 'error');
      fetchUsers(true);
    } finally {
      setActionLoading(prev => ({ ...prev, [`role_${userId}`]: false }));
    }
  };

  const changeStatus = async (userId, newStatus) => {
    setActionLoading(prev => ({ ...prev, [`status_${userId}`]: true }));
    // Cập nhật lạc quan (Optimistic Update)
    setUsers(prev => prev.map(u => u.ma_nguoi_dung === userId ? { ...u, trang_thai: newStatus } : u));
    try {
      await apiFetch(`/auth/users/${userId}/status`, token, { method: 'PUT', body: JSON.stringify({ trang_thai: newStatus }) });
      showToast(t(getLang(), 'Đã cập nhật trạng thái thành công'));
      fetchUsers(true); // Tải ngầm không unmount bảng -> Vị trí cuộn chuột đứng yên 100%
      if (fetchStats) fetchStats();
    } catch (e) {
      showToast(e.message, 'error');
      fetchUsers(true);
    } finally {
      setActionLoading(prev => ({ ...prev, [`status_${userId}`]: false }));
    }
  };

  const statCards = [
    { icon: Users, label: t(getLang(), 'Tổng User'), value: stats?.tong_user, bg: 'bg-indigo-500/15', text: 'text-indigo-300', border: 'border-indigo-500/25', glow: 'shadow-indigo-500/5' },
    { icon: Crown, label: 'Admin', value: stats?.tong_admin, bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-amber-500/25', glow: 'shadow-amber-500/5' },
    { icon: Lock, label: t(getLang(), 'Bị Khoá'), value: stats?.tong_bi_khoa, bg: 'bg-rose-500/15', text: 'text-rose-300', border: 'border-rose-500/25', glow: 'shadow-rose-500/5' },
    { icon: MessageSquare, label: t(getLang(), 'Hội Thoại'), value: stats?.tong_hoi_thoai, bg: 'bg-cyan-500/15', text: 'text-cyan-300', border: 'border-cyan-500/25', glow: 'shadow-cyan-500/5' },
    { icon: Activity, label: t(getLang(), 'Tin Nhắn'), value: stats?.tong_tin_nhan, bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/25', glow: 'shadow-emerald-500/5' },
    { icon: Trash2, label: t(getLang(), 'Thùng Rác'), value: stats?.tong_xoa_mem, bg: 'bg-slate-500/15', text: 'text-slate-300', border: 'border-slate-500/25', glow: 'shadow-slate-500/5' },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((c, i) => (
          <div
            key={i}
            className={`p-4 bg-[#141622]/80 backdrop-blur-xl rounded-2xl border border-white/8 shadow-lg ${c.glow} flex items-center gap-3.5 hover:-translate-y-0.5 hover:border-white/20 transition-all duration-300 group`}
          >
            <div className={`p-2.5 rounded-xl ${c.bg} ${c.text} border ${c.border} group-hover:scale-105 transition-transform duration-300 shrink-0`}>
              <c.icon size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider truncate">{c.label}</p>
              <p className={`text-xl font-bold ${c.text} tracking-tight truncate`}>{statsLoading ? '...' : (c.value ?? 0).toLocaleString('vi-VN')}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Users Table Header & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#141622]/60 backdrop-blur-md p-4 rounded-2xl border border-white/8">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
            <Users size={18} />
          </div>
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              {t(getLang(), 'Quản Lý Người Dùng')}
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono">{totalUsers}</span>
            </h2>
            <p className="text-[11px] text-slate-400">{t(getLang(), 'Danh sách tài khoản và phân quyền truy cập hệ thống')}</p>
          </div>
        </div>

        <form onSubmit={e => { e.preventDefault(); setSearch(searchInput); setPage(1); }} className="flex items-center gap-2">
          <div className="relative flex-1 sm:flex-none">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={t(getLang(), 'phAdminSearch')}
              className="pl-9 pr-3 py-2 bg-[#0d0e14] border border-white/10 rounded-xl text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 w-full sm:w-64 transition-all"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white text-xs rounded-xl font-bold transition-all shadow-md active:scale-95 shrink-0"
          >
            {t(getLang(), 'Tìm kiếm')}
          </button>
        </form>
      </div>

      {/* Users Table */}
      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm bg-[#141622]/40 rounded-2xl border border-white/8">
          <RefreshCw size={22} className="animate-spin mx-auto mb-2 text-cyan-400" />
          <span>{t(getLang(), 'Đang tải danh sách người dùng...')}</span>
        </div>
      ) : (
        <div className="bg-[#141622]/90 backdrop-blur-xl rounded-2xl border border-white/8 overflow-hidden shadow-2xl">
          <table className="w-full text-sm">
            <thead className="bg-[#0e0f17]/90 border-b border-white/10">
              <tr>
                <th className="px-5 py-3.5 text-left text-[10px] text-slate-400 uppercase font-bold tracking-wider">{t(getLang(), 'Tài khoản')}</th>
                <th className="px-5 py-3.5 text-left text-[10px] text-slate-400 uppercase font-bold tracking-wider">{t(getLang(), 'Phân Quyền')}</th>
                <th className="px-5 py-3.5 text-left text-[10px] text-slate-400 uppercase font-bold tracking-wider">{t(getLang(), 'Trạng Thái')}</th>
                <th className="px-5 py-3.5 text-left text-[10px] text-slate-400 uppercase font-bold tracking-wider">{t(getLang(), 'Ngày Khởi Tạo')}</th>
                <th className="px-5 py-3.5 text-center text-[10px] text-slate-400 uppercase font-bold tracking-wider">{t(getLang(), 'Thao Tác')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map(user => {
                const isSelf = user.ma_nguoi_dung === currentUser?.ma_nguoi_dung || (user.email && user.email === currentUser?.email);
                const isBanned = user.trang_thai === 'banned';
                const isAdmin = user.phan_quyen === 'admin';
                return (
                  <tr key={user.ma_nguoi_dung} className={`hover:bg-white/[0.03] transition-colors ${isBanned ? 'opacity-55' : ''}`}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 via-indigo-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-xs font-bold text-cyan-300 shadow-sm shrink-0">
                          {(user.ten_day_du || user.email || '?')[0].toUpperCase()}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-200 flex items-center gap-2">
                            {user.ten_day_du || t(getLang(), 'Chưa đặt tên')}
                            {isSelf && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold">{t(getLang(), 'Bạn')}</span>}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5"><RoleBadge role={user.phan_quyen} /></td>
                    <td className="px-5 py-3.5"><StatusBadge status={user.trang_thai || 'active'} /></td>
                    <td className="px-5 py-3.5 text-[11px] text-slate-400 font-mono">{new Date(user.ngay_tao).toLocaleDateString('vi-VN')}</td>
                    <td className="px-5 py-3.5">
                      {!isSelf && (
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => changeRole(user.ma_nguoi_dung, isAdmin ? 'user' : 'admin')}
                            disabled={actionLoading[`role_${user.ma_nguoi_dung}`]}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all active:scale-95 ${
                              isAdmin
                                ? 'bg-slate-500/15 border border-slate-500/30 text-slate-300 hover:bg-slate-500/30'
                                : 'bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 shadow-sm shadow-amber-500/10'
                            }`}
                          >
                            {actionLoading[`role_${user.ma_nguoi_dung}`] ? <Loader2 size={11} className="animate-spin" /> : isAdmin ? t(getLang(), 'Hạ quyền') : t(getLang(), 'Nâng quyền')}
                          </button>
                          <button
                            onClick={() => changeStatus(user.ma_nguoi_dung, isBanned ? 'active' : 'banned')}
                            disabled={actionLoading[`status_${user.ma_nguoi_dung}`]}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all active:scale-95 ${
                              isBanned
                                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 shadow-sm shadow-emerald-500/10'
                                : 'bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/30'
                            }`}
                          >
                            {actionLoading[`status_${user.ma_nguoi_dung}`] ? <Loader2 size={11} className="animate-spin" /> : isBanned ? t(getLang(), 'Mở khoá') : t(getLang(), 'Khoá')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-400 bg-[#0e0f17]/50">
              <span>{t(getLang(), 'Hiển thị trang')} {page}/{totalPages}</span>
              <div className="flex items-center gap-1.5">
                <button
                  disabled={page <= 1}
                  onClick={() => handlePageChange(page - 1)}
                  className="px-3 py-1 bg-white/5 hover:bg-white/10 disabled:opacity-40 rounded-lg text-xs"
                >
                  {t(getLang(), 'Trước')}
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => handlePageChange(page + 1)}
                  className="px-3 py-1 bg-white/5 hover:bg-white/10 disabled:opacity-40 rounded-lg text-xs"
                >
                  Sau
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// TAB: CONVERSATIONS
// ═══════════════════════════════════════════════════════════
const ConversationsTab = memo(function ConversationsTab({ token, showToast }) {
  const [convs, setConvs] = useState([]);
  const [trashConvs, setTrashConvs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [convTab, setConvTab] = useState('all'); // 'all' | 'trash'

  const fetchConvs = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/chat/conversations/all', token);
      setConvs(Array.isArray(data) ? data : []);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  const fetchTrash = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/chat/admin/conversations/trash', token);
      setTrashConvs(Array.isArray(data) ? data : []);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchConvs(); fetchTrash(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const viewMessages = async (convId) => {
    try {
      const data = await apiFetch(`/chat/conversations/${convId}/messages`, token);
      setMessages(Array.isArray(data) ? data : []);
      setSelectedConv(convId);
    } catch (e) { showToast(e.message, 'error'); }
  };

  const deleteConv = async (convId) => {
    if (!window.confirm(t(getLang(), 'Bạn có chắc muốn xoá mềm cuộc hội thoại này?'))) return;
    try {
      await apiFetch(`/chat/admin/conversations/${convId}`, token, { method: 'DELETE' });
      showToast(t(getLang(), 'Đã xoá mềm cuộc hội thoại'));
      if (selectedConv === convId) {
        setSelectedConv(null);
        setMessages([]);
      }
      fetchConvs(); fetchTrash();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const restoreConv = async (convId) => {
    try {
      await apiFetch(`/chat/admin/conversations/${convId}/restore`, token, { method: 'POST' });
      showToast(t(getLang(), 'Đã khôi phục cuộc hội thoại'));
      if (selectedConv === convId) {
        setSelectedConv(null);
        setMessages([]);
      }
      fetchConvs(); fetchTrash();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const permanentDelete = async (convId) => {
    if (!window.confirm(t(getLang(), '⚠️ XÓA VĨNH VIỄN! Cuộc hội thoại sẽ không thể khôi phục. Tiếp tục?'))) return;
    try {
      await apiFetch(`/chat/admin/conversations/${convId}/permanent`, token, { method: 'DELETE' });
      showToast(t(getLang(), 'Đã xoá vĩnh viễn'));
      if (selectedConv === convId) {
        setSelectedConv(null);
        setMessages([]);
      }
      fetchTrash();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const displayConvs = convTab === 'all' ? convs : trashConvs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><MessageSquare size={20} className="text-emerald-400" /> {t(getLang(), 'Quản Lý Hội Thoại')}</h2>
        <div className="flex gap-1 bg-[#1e1f20] rounded-xl p-1">
          <button onClick={() => setConvTab('all')} className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${convTab === 'all' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-white'}`}>
            {t(getLang(), 'Tất cả')} ({convs.length})
          </button>
          <button onClick={() => setConvTab('trash')} className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${convTab === 'trash' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'text-slate-400 hover:text-white'}`}>
            {t(getLang(), '🗑️ Thùng rác')} ({trashConvs.length})
          </button>
        </div>
      </div>
      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm"><RefreshCw size={20} className="animate-spin mx-auto mb-2 text-emerald-400" /> {t(getLang(), 'Đang tải...')}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#181920] rounded-2xl border border-white/8 overflow-hidden max-h-[60vh] overflow-y-auto">
            {displayConvs.map(c => (
              <div key={c.ma_hoi_thoai} onClick={() => viewMessages(c.ma_hoi_thoai)}
                className={`px-4 py-3 border-b border-white/5 cursor-pointer hover:bg-white/3 transition-colors ${selectedConv === c.ma_hoi_thoai ? 'bg-emerald-500/10' : ''}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-slate-200 truncate max-w-[250px]">{c.tieu_de || t(getLang(), 'Trò chuyện mới')}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{c.email || 'guest'} · {c.ten_mo_hinh_ai || 'N/A'}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {convTab === 'all' ? (
                      <button onClick={(e) => { e.stopPropagation(); deleteConv(c.ma_hoi_thoai); }} className="text-slate-500 hover:text-rose-400 p-1" title={t(getLang(), 'tipSoftDel')}><Trash2 size={12} /></button>
                    ) : (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); restoreConv(c.ma_hoi_thoai); }} className="text-slate-500 hover:text-emerald-400 p-1" title={t(getLang(), 'tipRestore')}><RefreshCw size={12} /></button>
                        <button onClick={(e) => { e.stopPropagation(); permanentDelete(c.ma_hoi_thoai); }} className="text-slate-500 hover:text-rose-400 p-1" title={t(getLang(), 'tipHardDel')}><Trash2 size={12} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {displayConvs.length === 0 && <p className="text-center text-slate-500 text-xs py-8">{convTab === 'all' ? t(getLang(), 'Không có cuộc hội thoại nào') : t(getLang(), 'Thùng rác trống')}</p>}
          </div>
          <div className="bg-[#181920] rounded-2xl border border-white/8 p-5 max-h-[60vh] overflow-y-auto space-y-4">
            {selectedConv ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <h3 className="text-xs font-bold text-emerald-400">{t(getLang(), 'Chi Tiết Tin Nhắn')}</h3>
                  <span className="text-[10px] text-slate-500 font-mono">{t(getLang(), 'Tổng: ')}{messages.length}</span>
                </div>
                <div className="space-y-3">
                  {messages.map(m => {
                    const isUser = m.vai_tro === 'user';
                    const isAdmin = m.vai_tro === 'admin';
                    return (
                      <div key={m.ma_tin_nhan} className={`flex flex-col p-3 rounded-xl border transition-all ${
                        isUser
                          ? 'bg-cyan-500/5 border-cyan-500/10 text-cyan-200'
                          : isAdmin
                            ? 'bg-amber-500/5 border-amber-500/10 text-amber-200'
                            : 'bg-[#131417]/40 border-white/5 text-slate-300'
                      }`}>
                        <div className="flex items-center justify-between mb-1.5 text-[10px] font-bold text-slate-400">
                          <span>{isUser ? tx(getLang(), '👤 KHÁCH HÀNG') : isAdmin ? tx(getLang(), '🛡️ ADMIN PHẢN HỒI') : tx(getLang(), '🤖 TRỢ LÝ AI')}</span>
                        </div>
                        <p className="text-xs leading-relaxed whitespace-pre-wrap font-sans">{m.noi_dung}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-xs">
                <MessageSquare size={24} className="mb-2 text-slate-600" />
                {t(getLang(), 'Chọn một cuộc hội thoại bên trái để xem nội dung chi tiết')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// TAB: API KEYS — v2 với Auto-Scan 24h & Collapsible Providers
// ═══════════════════════════════════════════════════════════

const PROVIDER_LABELS = {
  gemini: { name: 'Google Gemini', icon: '🔑', color: 'text-blue-300' },
  openrouter: { name: 'OpenRouter', icon: '🔑', color: 'text-purple-300' },
  groq: { name: 'Groq Cloud', icon: '🔑', color: 'text-orange-300' },
  nvidia: { name: 'Nvidia NIM', icon: '🔑', color: 'text-green-300' },
  mistral: { name: 'Mistral AI', icon: '🔑', color: 'text-cyan-300' },
  cerebras: { name: 'Cerebras', icon: '🔑', color: 'text-pink-300' },
  cohere: { name: 'Cohere AI', icon: '🔑', color: 'text-sky-300' },
  openai: { name: 'OpenAI', icon: '🔑', color: 'text-emerald-300' },
  deepseek: { name: 'DeepSeek', icon: '🔑', color: 'text-indigo-300' },
  opencode: { name: 'OpenCode', icon: '🔑', color: 'text-amber-300' },
  github: { name: 'GitHub Models', icon: '🔑', color: 'text-slate-300' },
  claude: { name: 'Anthropic', icon: '🔑', color: 'text-violet-300' },
  grok: { name: 'xAI Grok', icon: '🔑', color: 'text-blue-400' },
};

const ApiKeysTab = memo(function ApiKeysTab({ token, showToast }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newProvider, setNewProvider] = useState('gemini');
  const [newKey, setNewKey] = useState('');
  const [scanningAll, setScanningAll] = useState(false);
  const [scanningProvider, setScanningProvider] = useState(null); // which provider is being scanned
  const [expandedProviders, setExpandedProviders] = useState({});
  const [scanCache, setScanCache] = useState({}); // { provider: { working: [], failed: [] } }
  const [providerScanLog, setProviderScanLog] = useState({}); // { provider: lastScanTime }
  const [lastFullScan, setLastFullScan] = useState(null);
  const [weeklySchedule, setWeeklySchedule] = useState({ day: 1, time: '00:00', label: 'CN → T2 00:00' });
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [editDay, setEditDay] = useState(1);
  const [editTime, setEditTime] = useState('00:00');

  const fetchKeys = async () => {
    setLoading(true);
    // FIX: /chat/keys thay vì /models/keys (route nằm trong chat.routes.js)
    try { const data = await apiFetch('/chat/keys', token); setKeys(Array.isArray(data) ? data : []); }
    catch (e) { showToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  const fetchScanCache = async () => {
    try {
      const data = await apiFetch('/models/admin/models/scan-cache', token);
      if (data.success) {
        setScanCache(data.grouped || {});
        // Build scan log map
        const logMap = {};
        for (const p of (data.providers || [])) logMap[p.ma_nha_cung_cap] = p.lan_quet_cuoi;
        setProviderScanLog(logMap);
        if (data.providers?.length > 0) {
          const latest = data.providers.sort((a, b) => b.lan_quet_cuoi?.localeCompare(a.lan_quet_cuoi))[0];
          setLastFullScan(latest?.lan_quet_cuoi || null);
        }
      }
    } catch { /* no scan data yet */ }
  };

  const fetchWeeklySchedule = async () => {
    try {
      const data = await apiFetch('/models/admin/models/weekly-schedule', token);
      if (data.success) {
        setWeeklySchedule({ day: data.day, time: data.time, label: data.label });
        setEditDay(data.day);
        setEditTime(data.time);
      }
    } catch { /* mặc định CN→T2 00:00 */ }
  };

  const saveWeeklySchedule = async () => {
    try {
      const res = await apiFetch('/models/admin/models/weekly-schedule', token, {
        method: 'POST', body: JSON.stringify({ day: editDay, time: editTime })
      });
      if (res.success) {
        setWeeklySchedule({ day: editDay, time: editTime, label: res.label });
        setEditingSchedule(false);
        showToast(res.message || t(getLang(), 'Đã lưu lịch quét ✅'));
      } else showToast(res.message || t(getLang(), 'Lỗi lưu'), 'error');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const resetWeeklySchedule = async () => {
    try {
      const res = await apiFetch('/models/admin/models/weekly-schedule/reset', token, { method: 'POST' });
      if (res.success) {
        setWeeklySchedule({ day: 1, time: '00:00', label: 'CN → T2 00:00' });
        setEditDay(1); setEditTime('00:00');
        setEditingSchedule(false);
        showToast(res.message || t(getLang(), 'Đã reset lịch quét ✅'));
      }
    } catch (e) { showToast(e.message, 'error'); }
  };

  useEffect(() => { fetchKeys(); fetchScanCache(); fetchWeeklySchedule(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async () => {
    if (!newKey.trim()) return;
    try {
      // FIX: /chat/keys thay vì /models/keys
      await apiFetch('/chat/keys', token, { method: 'POST', body: JSON.stringify({ provider: newProvider, api_key: newKey }) });
      showToast(t(getLang(), 'Đã lưu API Key ✅ — đang tự động quét model...'));
      setNewKey(''); fetchKeys();
      // 🔄 Tự động quét ngay provider vừa lưu key để model working mới cập nhật vào DB + trang chủ
      setScanningProvider(newProvider);
      try {
        await apiFetch('/models/admin/models/scan-provider', token, {
          method: 'POST',
          body: JSON.stringify({ provider: newProvider })
        });
        await fetchScanCache();
        showToast(t(getLang(), '✅ Quét xong ') + newProvider + t(getLang(), ' — đã cập nhật model hoạt động lên trang chủ!'));
        window.dispatchEvent(new CustomEvent('rexi_models_published'));
      } catch (scanErr) {
        showToast(t(getLang(), 'Đã lưu key nhưng quét model lỗi: ') + scanErr.message, 'error');
      } finally {
        setScanningProvider(null);
      }
    } catch (e) { showToast(e.message, 'error'); }
  };

  // Quét TẤT CẢ providers — đồng bộ, chờ kết quả rồi mới hiển thị
  const scanAll = async () => {
    setScanningAll(true);
    showToast(t(getLang(), '🔄 Đang quét tất cả providers...'));
    try {
      const data = await apiFetch('/models/admin/models/scan-all', token, { method: 'POST' });
      await fetchScanCache();
      const keptProviders = (data.summary || []).filter(s => s.keptOld);
      const keptNames = keptProviders.map(s => s.providerId);
      const keptLabel = keptNames.slice(0, 3).join(', ') + (keptNames.length > 3 ? ` +${keptNames.length - 3} ${t(getLang(), 'khác')}` : '');
      if (data.message) {
        showToast(keptProviders.length > 0
          ? `${data.message} ⚠️ ${keptLabel}: 0 working — ${t(getLang(), 'giữ model cũ')}`
          : data.message);
      } else {
        showToast(keptProviders.length > 0
          ? `${t(getLang(), '⚠️ Quét xong — ')}${keptLabel} ${t(getLang(), 'giữ model cũ')} (0 working)`
          : t(getLang(), '✅ Quét hoàn tất!'));
      }
    } catch(e) { showToast(t(getLang(), 'Lỗi quét: ') + e.message, 'error'); }
    finally { setScanningAll(false); }
  };

  // Quét một provider đơn lẻ
  // Quét một provider đơn lẻ — báo toast & log rõ ràng
  const scanSingleProvider = async (providerId) => {
    console.log('[AdminPanel] Triggering scan for provider:', providerId);
    const provName = PROVIDER_LABELS[providerId]?.name || providerId;
    setScanningProvider(providerId);
    showToast(`${t(getLang(), '🔄 Đang quét ')}${provName}...`);
    try {
      const data = await apiFetch('/models/admin/models/scan-provider', token, {
        method: 'POST',
        body: JSON.stringify({ provider: providerId })
      });
      console.log('[AdminPanel] Scan response:', data);
      if (data.success) {
        if (data.keptOld) {
          showToast(`${t(getLang(), '⚠️ ')}${provName}: 0/${data.total} ${t(getLang(), 'model hoạt động — GIỮ NGUYÊN model cũ. Lý do: ')}${data.keptOldReason || t(getLang(), 'lỗi tạm thời')}`, 'error');
        } else {
          showToast(`✅ ${provName}: ${data.working}/${data.total} ${t(getLang(), 'model hoạt động')}`);
        }
        await fetchScanCache();
        window.dispatchEvent(new CustomEvent('rexi_models_published', { detail: { provider: providerId } }));
      } else if (data.skipped) {
        showToast(`${t(getLang(), '⚠️ ')}${provName}: ${t(getLang(), 'Chưa có API Key')}`, 'error');
      } else {
        showToast(data.error || t(getLang(), 'Lỗi quét'), 'error');
      }
    } catch(e) {
      console.error('[AdminPanel] Scan error:', e);
      showToast(t(getLang(), 'Lỗi quét: ') + e.message, 'error');
    } finally {
      setScanningProvider(null);
    }
  };

  const toggleProvider = (providerId) => {
    setExpandedProviders(prev => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const formatTime = (isoStr) => {
    if (!isoStr) return t(getLang(), 'Chưa quét');
    const d = new Date(isoStr);
    return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // All providers that have keys
  const providerIdsWithKeys = [...new Set(keys.map(k => k.ten_nha_cung_cap))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <Key size={16} className="text-amber-400" />
            </span>
            API Keys & Model Scanner
          </h2>
          {lastFullScan && (
            <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {t(getLang(), 'Quét lần cuối: ')}{formatTime(lastFullScan)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Weekly Schedule — editable */}
          <div className="flex items-center gap-1.5 bg-[#13141a]/80 border border-violet-500/20 rounded-xl px-3 py-1.5">
            <CalendarClock size={12} className="text-violet-400" />
            <span className="text-[11px] font-medium text-violet-300">{t(getLang(), 'Tự động quét')}</span>
            {editingSchedule ? (
              <>
                <select value={editDay} onChange={e => setEditDay(Number(e.target.value))}
                  className="bg-[#0d0e14] border border-violet-500/30 rounded-md px-1.5 py-0.5 text-[11px] text-violet-200 font-semibold outline-none cursor-pointer">
                  <option value={0}>CN</option><option value={1}>T2</option><option value={2}>T3</option>
                  <option value={3}>T4</option><option value={4}>T5</option><option value={5}>T6</option><option value={6}>T7</option>
                </select>
                <select value={editTime} onChange={e => setEditTime(e.target.value)}
                  className="bg-[#0d0e14] border border-violet-500/30 rounded-md px-1.5 py-0.5 text-[11px] text-violet-200 font-mono font-semibold outline-none cursor-pointer">
                  {['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00',
                    '12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00',
                    '00:30','03:30','12:30','18:30'].map(t => (
                    <option key={t} value={t} className="bg-[#0d0e14]">{t}</option>
                  ))}
                </select>
                <button onClick={saveWeeklySchedule}
                  className="px-2 py-0.5 bg-violet-500/25 hover:bg-violet-500/40 text-violet-200 rounded-md text-[10px] font-bold transition-colors">{t(getLang(), 'Lưu')}</button>
                <button onClick={() => { setEditingSchedule(false); setEditDay(weeklySchedule.day); setEditTime(weeklySchedule.time); }}
                  className="px-1.5 py-0.5 text-slate-500 hover:text-slate-300 text-[10px] transition-colors">{t(getLang(), 'Hủy')}</button>
              </>
            ) : (
              <>
                <button onClick={() => setEditingSchedule(true)}
                  className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-200 text-[10px] font-bold border border-violet-500/20 hover:bg-violet-500/25 transition-colors cursor-pointer">
                  {weeklySchedule.label}
                </button>
                <button onClick={resetWeeklySchedule}
                  className="text-[9px] text-slate-500 hover:text-violet-300 transition-colors" title={t(getLang(), 'tipResetDef')}>↺</button>
              </>
            )}
          </div>

          <button
            onClick={async () => {
              if (window.confirm(t(getLang(), "Reset cache models? (Tự động hàng tuần CN→T2 00:00, nút này dùng khi cần ngay)"))) {
                try {
                  const res = await apiFetch('/models/admin/models/clear-and-reset', token, { method: 'POST' });
                  showToast(res.message || t(getLang(), "Đã reset!"));
                  fetchScanCache();
                  window.dispatchEvent(new CustomEvent('rexi_models_published'));
                } catch(e) { showToast(e.message, 'error'); }
              }
            }}
            className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors border border-rose-500/20 hover:border-rose-500/40"
            title={t(getLang(), 'tipResetNow')}
          >
            <Trash2 size={12} />
            Reset Cache
          </button>
          <button
            type="button"
            onClick={() => !scanningAll && scanAll()}
            className={`px-3.5 py-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-cyan-500/10 transition-all ${scanningAll ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {scanningAll ? <RefreshCw size={12} className="animate-spin" /> : <Radar size={12} />}
            {scanningAll ? t(getLang(), 'Đang quét...') : t(getLang(), 'Quét Tất Cả')}
          </button>
        </div>
      </div>

      {/* Box Thêm / Lưu Key */}
      <div className="bg-[#141622]/80 backdrop-blur-xl rounded-2xl border border-white/8 p-4 shadow-xl">
        <h3 className="text-xs font-bold text-amber-400 mb-3 flex items-center gap-2">
          <Plus size={14} className="text-amber-400" /> {t(getLang(), 'Thêm / Cập Nhật API Key Mới')}
        </h3>
        <div className="flex flex-wrap gap-2.5">
          <select
            value={newProvider}
            onChange={e => setNewProvider(e.target.value)}
            className="px-3.5 py-2 bg-[#0d0e14] border border-white/10 rounded-xl text-xs text-slate-200 outline-none focus:border-cyan-500/50 transition-all font-medium"
          >
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="claude">Anthropic Claude</option>
            <option value="deepseek">DeepSeek AI</option>
            <option value="groq">Groq Cloud</option>
            <option value="grok">xAI Grok</option>
            <option value="github">GitHub Models</option>
            <option value="opencode">OpenCode Agent</option>
            <option value="openrouter">OpenRouter Gateway</option>
            <option value="nvidia">Nvidia NIM</option>
            <option value="cerebras">Cerebras</option>
            <option value="cohere">Cohere AI</option>
            <option value="mistral">Mistral AI</option>
            <option value="xkiro">xKiro</option>
            <option value="agentrouter">AgentRouter</option>
            <option value="bai">B.AI</option>
            <option value="kiosapi">KiosAPI</option>
            <option value="unorouter">UnoRouter</option>
            <option value="custom">Custom / {t(getLang(), 'Khác')}</option>
          </select>

          <input
            type="password"
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveKey()}
            placeholder={t(getLang(), 'phAdminKey')}
            className="flex-1 min-w-[220px] px-3.5 py-2 bg-[#0d0e14] border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500/50 font-mono transition-all"
          />

          <button
            onClick={saveKey}
            className="px-4 py-2 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 shrink-0"
          >
            {t(getLang(), 'Lưu Key')}
          </button>
        </div>
      </div>

      {/* Danh sách Providers — Collapsible 60fps */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-300 flex items-center gap-2">
            <Activity size={14} className="text-emerald-400" /> {t(getLang(), 'Nhà Cung Cấp & Trạng Thái Model')}
            <span className="text-slate-500 font-normal text-[11px]">{t(getLang(), '(Bấm vào dòng để xem danh sách chi tiết)')}</span>
          </h3>
        </div>

        {loading ? (
          <div className="text-center py-12 text-slate-400 text-xs bg-[#141622]/40 rounded-2xl border border-white/8">
            <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-cyan-400" />
            <span>{t(getLang(), 'Đang tải danh sách nhà cung cấp...')}</span>
          </div>
        ) : (
          <div className="space-y-2">
            {providerIdsWithKeys.map(providerId => {
              const label = PROVIDER_LABELS[providerId] || { name: providerId.toUpperCase(), icon: '🔑', color: 'text-slate-300' };
              const cache = scanCache[providerId] || { working: [], failed: [], skipped: [], needs_balance: [] };
              const isExpanded = expandedProviders[providerId];
              const isScanning = scanningProvider === providerId;
              const lastScan = providerScanLog[providerId];
              const totalModels = cache.working.length + cache.failed.length + (cache.skipped?.length || 0) + (cache.needs_balance?.length || 0);
              const key = keys.find(k => k.ten_nha_cung_cap === providerId);

              return (
                <div key={providerId} className="bg-[#141622]/80 backdrop-blur-xl rounded-2xl border border-white/8 overflow-hidden shadow-lg hover:border-white/15 transition-all duration-300">
                  {/* Provider Header Row */}
                  <div className="flex items-center justify-between px-4 py-3 bg-[#10111a]/80">
                    <div
                      className="flex items-center gap-3 flex-1 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => toggleProvider(providerId)}
                    >
                      <span className="text-base">{label.icon}</span>
                      <div>
                        <span className={`text-xs font-bold ${label.color}`}>{label.name}</span>
                        <div className="text-[10px] text-slate-500 mt-0.5 font-mono flex items-center gap-2">
                          <span>{key?.gia_tri_khoa ? key.gia_tri_khoa.substring(0, 6) + '...' + key.gia_tri_khoa.slice(-4) : t(getLang(), 'Chưa có key')}</span>
                          {lastScan && <span className="text-slate-600">· {t(getLang(), 'Quét: ')}{formatTime(lastScan)}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      {totalModels > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/20">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]"></span>
                            {cache.working.length} OK
                          </span>
                          {cache.failed.length > 0 && (
                            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-400 font-semibold border border-rose-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                              {cache.failed.length} {t(getLang(), 'Lỗi')}
                            </span>
                          )}
                          {(cache.needs_balance?.length || 0) > 0 && (
                            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-semibold border border-amber-500/20" title={t(getLang(), 'tipPaidAdmin')}>
                              {cache.needs_balance.length} {t(getLang(), 'Trả phí')}
                            </span>
                          )}
                          {(cache.skipped?.length || 0) > 0 && (
                            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-500/15 text-slate-400 font-semibold border border-slate-500/20" title={t(getLang(), 'tipNonChat')}>
                              {cache.skipped.length} {t(getLang(), 'Khác loại')}
                            </span>
                          )}
                        </div>
                      )}
                      {totalModels === 0 && <span className="text-[10px] text-slate-500">{t(getLang(), 'Chưa quét')}</span>}

                      <button
                        type="button"
                        onClick={() => !isScanning && scanSingleProvider(providerId)}
                        className={`px-3 py-1 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 rounded-xl text-[10px] font-bold flex items-center gap-1.5 transition-all active:scale-95 shadow-sm ${isScanning ? 'opacity-50' : ''}`}
                      >
                        {isScanning ? <RefreshCw size={10} className="animate-spin text-cyan-300" /> : <Search size={10} className="text-cyan-300" />}
                        {isScanning ? t(getLang(), 'Đang quét...') : t(getLang(), 'Quét')}
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleProvider(providerId)}
                        className="p-1 text-slate-400 hover:text-white transition-colors"
                      >
                        <ChevronRight size={16} className={`transition-transform duration-300 ${isExpanded ? 'rotate-90 text-cyan-400' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {/* Smooth CSS Grid Accordion 60fps */}
                  <div
                    className={`grid transition-all duration-300 ease-in-out ${
                      isExpanded ? 'grid-rows-[1fr] opacity-100 border-t border-white/5' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="px-4 py-3 space-y-1.5 max-h-72 overflow-y-auto scrollbar-thin">
                        {totalModels === 0 ? (
                          <div className="text-center py-4 text-slate-500 text-xs">
                            {t(getLang(), 'Chưa có dữ liệu quét. Bấm nút ')}<b className="text-cyan-400">{t(getLang(), 'Quét')}</b> {t(getLang(), 'để kiểm tra.')}
                          </div>
                        ) : (
                          <>
                            {cache.working.map(m => (
                              <div key={m.ma_model} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-emerald-500/5 hover:bg-emerald-500/10 border border-emerald-500/10 text-xs transition-colors">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399] shrink-0"></span>
                                  <span className="font-mono text-slate-200 truncate">{m.ma_model}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {m.do_tre_ms > 0 && <span className="text-[10px] text-emerald-400 font-mono">⚡ {m.do_tre_ms}ms</span>}
                                  <span className="text-[10px] text-emerald-400 font-semibold">{t(getLang(), '✅ Hoạt động')}</span>
                                </div>
                              </div>
                            ))}
                            {cache.failed.map(m => (
                              <div key={m.ma_model} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-rose-500/5 border border-rose-500/10 text-xs opacity-70">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>
                                  <span className="font-mono text-slate-400 truncate">{m.ma_model}</span>
                                </div>
                                <span className="text-[10px] text-rose-400 truncate max-w-[220px]" title={m.loi_chi_tiet}>❌ {m.loi_chi_tiet || (getLang() === 'vi' ? 'Lỗi kết nối' : 'Connection error')}</span>
                              </div>
                            ))}
                            {(cache.needs_balance || []).map(m => (
                              <div key={m.ma_model} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-amber-500/5 border border-amber-500/10 text-xs opacity-75">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
                                  <span className="font-mono text-slate-400 truncate">{m.ma_model}</span>
                                </div>
                                <span className="text-[10px] text-amber-400 truncate max-w-[220px]" title={m.loi_chi_tiet}>💰 {m.loi_chi_tiet || (getLang() === 'vi' ? 'Trả phí' : 'Paid')}</span>
                              </div>
                            ))}
                            {(cache.skipped || []).map(m => (
                              <div key={m.ma_model} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-500/5 border border-slate-500/10 text-xs opacity-60">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0"></span>
                                  <span className="font-mono text-slate-400 truncate">{m.ma_model}</span>
                                </div>
                                <span className="text-[10px] text-slate-400 shrink-0">⊘ {m.loi_chi_tiet || t(getLang(), 'không dùng cho chat')}</span>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {providerIdsWithKeys.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-xs bg-[#141622]/80 backdrop-blur-xl rounded-2xl border border-white/8">
                {t(getLang(), 'Chưa có API Key nào được cấu hình. Thêm key ở phía trên.')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// TAB: SKILLS
// ═══════════════════════════════════════════════════════════
const SkillsTab = memo(function SkillsTab({ token, showToast }) {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(null);

  const fetchSkills = async () => {
    setLoading(true);
    try {
      // Lấy TẤT CẢ skills (kể cả bị tắt) để admin có thể bật/tắt
      const data = await apiFetch('/services/skills/all', token);
      setSkills(Array.isArray(data) ? data : []);
    } catch {
      // Fallback: lấy chỉ skills đang kích hoạt
      try { const data = await apiFetch('/services/skills', token); setSkills(Array.isArray(data) ? data : []); }
      catch (e2) { showToast(e2.message, 'error'); }
    } finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchSkills(); }, []);

  const toggleSkill = async (skill) => {
    setToggling(skill.ma_ky_nang);
    const newStatus = skill.trang_thai === 'kich_hoat' ? 'vo_hieu' : 'kich_hoat';
    try {
      await apiFetch(`/services/skills/${skill.ma_ky_nang}/toggle`, token, {
        method: 'PUT',
        body: JSON.stringify({ trang_thai: newStatus })
      });
      showToast(`${newStatus === 'kich_hoat' ? t(getLang(), '✅ Đã bật') : t(getLang(), '⛔ Đã tắt')}: ${skill.tieu_de || skill.ten_ky_nang}`);
      await fetchSkills();
    } catch (e) { showToast(t(getLang(), 'Lỗi toggle skill: ') + e.message, 'error'); }
    finally { setToggling(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><Layers size={20} className="text-purple-400" /> {t(getLang(), 'Kỹ Năng Agent')}
          <span className="text-xs text-slate-400 font-normal">({skills.filter(s=>s.trang_thai==='kich_hoat').length}/{skills.length} {t(getLang(), 'đang bật')})</span>
        </h2>
        <button onClick={fetchSkills} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors">
          <RefreshCw size={13} />
        </button>
      </div>
      {loading ? <div className="text-center py-8 text-slate-400 text-xs"><RefreshCw size={16} className="animate-spin mx-auto mb-1" /> {t(getLang(), 'Đang tải...')}</div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {skills.map(s => {
            const isActive = s.trang_thai === 'kich_hoat';
            return (
              <div key={s.ma_ky_nang} className={`p-3 bg-[#181920] rounded-xl border transition-all ${
                isActive ? 'border-purple-500/30 hover:border-purple-400/50' : 'border-white/5 opacity-50 hover:opacity-75'
              }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">{s.ten_ky_nang}</span>
                    <p className="text-xs font-semibold text-slate-200 mt-1.5">{s.tieu_de}</p>
                    <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{s.mo_ta}</p>
                  </div>
                  <button
                    onClick={() => toggleSkill(s)}
                    disabled={toggling === s.ma_ky_nang}
                    title={isActive ? (getLang() === 'vi' ? 'Tắt kỹ năng này' : 'Disable this skill') : (getLang() === 'vi' ? 'Bật kỹ năng này' : 'Enable this skill')}
                    className={`shrink-0 w-10 h-5 rounded-full transition-all relative ${
                      toggling === s.ma_ky_nang ? 'opacity-50' : ''
                    } ${isActive ? 'bg-purple-500' : 'bg-white/10'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                      isActive ? 'left-5' : 'left-0.5'
                    }`} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// TAB: ADMIN CHAT
// ═══════════════════════════════════════════════════════════
const AdminChatTab = memo(function AdminChatTab({ token, showToast }) {
  const [convs, setConvs] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [, setLoading] = useState(true);
  const [convSearch, setConvSearch] = useState('');
  const [msgLimit, setMsgLimit] = useState(20);
  const knownConvsRef = useRef(null);


  const fetchConvs = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiFetch('/chat/conversations/all', token);
      const list = Array.isArray(data) ? data : [];
      setConvs(list);
      const ids = new Set(list.map(c => c.ma_hoi_thoai));
      if (silent && knownConvsRef.current) {
        const added = list.filter(c => !knownConvsRef.current.has(c.ma_hoi_thoai)).length;
        const removed = [...knownConvsRef.current].filter(id => !ids.has(id)).length;
        if (added > 0) showToast(`${t(getLang(), '🔔 Có ')}${added} ${t(getLang(), 'hội thoại mới!')}`);
        if (removed > 0) showToast(`${t(getLang(), 'Đã có ')}${removed} ${t(getLang(), 'hội thoại bị xóa.')}`, 'error');
      }
      knownConvsRef.current = ids;
    } catch (e) { if (!silent) showToast(e.message, 'error'); }
    finally { if (!silent) setLoading(false); }
  };

  // Auto-refresh danh sách hội thoại mỗi 60s

  useEffect(() => {
    fetchConvs();
    const interval = setInterval(() => fetchConvs(true), 60000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectConv = async (convId) => {
    setSelectedConv(convId);
    setMsgLimit(20);
    try { const data = await apiFetch(`/chat/conversations/${convId}/messages`, token); setMessages(Array.isArray(data) ? data : []); }
    catch (e) { showToast(e.message, 'error'); }
  };

  const sendReply = async () => {
    if (!reply.trim() || !selectedConv) return;
    try {
      await apiFetch(`/chat/admin/conversations/${selectedConv}/reply`, token, {
        method: 'POST',
        body: JSON.stringify({ noi_dung: reply })
      });
      setReply('');
      selectConv(selectedConv);
      showToast(t(getLang(), 'Đã gửi phản hồi'));
    } catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Send size={20} className="text-rose-400" /> {t(getLang(), 'Chat với Users')}</h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-[#181920] rounded-2xl border border-white/8 overflow-hidden max-h-[60vh] overflow-y-auto">
          <div className="px-3 py-2 border-b border-white/5 text-[10px] text-slate-400 uppercase font-semibold">{t(getLang(), 'Danh sách hội thoại')}</div>
          <div className="px-3 py-2 border-b border-white/5">
            <input type="text" value={convSearch} onChange={e => setConvSearch(e.target.value)}
              placeholder={t(getLang(), 'phAdminFilter')} className="w-full px-2.5 py-1.5 bg-[#0d0e11] border border-white/10 rounded-lg text-[11px] text-white placeholder-slate-500 outline-none" />
          </div>
          {convs.filter(c => {
            const q = convSearch.trim().toLowerCase();
            if (!q) return true;
            return (c.email || 'guest').toLowerCase().includes(q) || (c.tieu_de || '').toLowerCase().includes(q);
          }).map(c => (
            <div key={c.ma_hoi_thoai} onClick={() => selectConv(c.ma_hoi_thoai)}
              className={`px-3 py-2.5 border-b border-white/5 cursor-pointer hover:bg-white/3 transition-colors ${selectedConv === c.ma_hoi_thoai ? 'bg-rose-500/10' : ''}`}>
              <p className="text-xs font-medium text-slate-200 truncate">{c.tieu_de || t(getLang(), 'Trò chuyện mới')}</p>
              <p className="text-[10px] text-slate-500">{c.email || 'guest'}</p>
            </div>
          ))}
        </div>
        <div className="lg:col-span-2 bg-[#181920] rounded-2xl border border-white/8 flex flex-col max-h-[60vh]">
          {selectedConv ? (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length > msgLimit && (
                  <div className="text-center">
                    <button onClick={() => setMsgLimit(l => l + 30)} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[10px] text-slate-300 transition-colors">{t(getLang(), 'Tải tin nhắn cũ hơn')} ({messages.length - msgLimit})</button>
                  </div>
                )}
                {messages.slice(-msgLimit).map(m => (
                  <div key={m.ma_tin_nhan} className={`flex ${m.vai_tro === 'user' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[80%] p-3 rounded-xl text-xs ${m.vai_tro === 'user' ? 'bg-cyan-500/10 text-cyan-200' : 'bg-rose-500/10 text-rose-200'}`}>
                      <span className="text-[10px] font-bold opacity-60">{m.vai_tro === 'user' ? '👤 User' : '🤖 Admin'}</span>
                      <p className="mt-1 whitespace-pre-wrap">{m.noi_dung}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-3 border-t border-white/5 flex gap-2">
                <input type="text" value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendReply()}
                  placeholder={t(getLang(), 'phFeedback')} className="flex-1 px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 outline-none" />
                <button onClick={sendReply} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1"><Send size={12} /> {t(getLang(), 'Gửi')}</button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500 text-xs">{t(getLang(), 'Chọn hội thoại để phản hồi')}</div>
          )}
        </div>
      </div>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// TAB: SYSTEM SETTINGS
// ═══════════════════════════════════════════════════════════
const SettingsTab = memo(function SettingsTab({ token, showToast }) {
  const [gitStatus, setGitStatus] = useState(null);
  const [gitDiff, setGitDiff] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [execCmd, setExecCmd] = useState('');
  const [execOutput, setExecOutput] = useState('');
  const [cacheMsg, setCacheMsg] = useState('');

  const fetchGit = async () => {
    try { const data = await apiFetch('/chat/git/status', token); setGitStatus(data); }
    catch (e) { showToast(e.message, 'error'); }
  };

  const fetchGitDiff = async () => {
    setDiffLoading(true);
    try {
      const data = await apiFetch('/chat/git/diff', token);
      setGitDiff(data.diff || t(getLang(), 'Không có thay đổi chưa commit.'));
      setShowDiff(true);
    } catch (e) { showToast(t(getLang(), 'Lỗi git diff: ') + e.message, 'error'); }
    finally { setDiffLoading(false); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchGit(); }, []);

  const runExec = async () => {
    if (!execCmd.trim()) return;
    try {
      const data = await apiFetch('/chat/exec', token, { method: 'POST', body: JSON.stringify({ command: execCmd }), headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Exec-Confirm': 'yes' } });
      setExecOutput(data.stdout || data.stderr || data.error || 'Done');
    } catch (e) { setExecOutput('Error: ' + e.message); }
  };

  const clearModelCache = async () => {
    try {
      const data = await apiFetch('/chat/admin/cache/clear-models', token, { method: 'POST' });
      setCacheMsg(data.message || t(getLang(), 'Đã xóa cache'));
      showToast(t(getLang(), 'Đã xóa cache models'));
      setTimeout(() => setCacheMsg(''), 3000);
    } catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Settings size={20} className="text-slate-400" /> {t(getLang(), 'Hệ Thống')}</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#181920] rounded-2xl border border-white/8 p-4">
          <h3 className="text-xs font-bold text-cyan-400 mb-3 flex items-center gap-1.5"><GitBranch size={14} /> Git Status</h3>
          {gitStatus?.isGit ? (
            <div className="space-y-2 text-xs text-slate-300">
              <p>Branch: <span className="text-cyan-300 font-mono">{gitStatus.branch}</span></p>
              {gitStatus.changes?.length > 0 && (
                <div>
                  <p className="text-amber-300 mb-1">{gitStatus.changes.length} files changed:</p>
                  <div className="space-y-0.5 max-h-24 overflow-y-auto">
                    {gitStatus.changes.map((f, i) => (
                      <p key={i} className="font-mono text-[10px] text-slate-400 truncate">{f}</p>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={fetchGitDiff} disabled={diffLoading}
                className="mt-2 px-3 py-1.5 bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-500/30 text-cyan-300 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 transition-colors">
                {diffLoading ? <RefreshCw size={11} className="animate-spin" /> : <Code size={11} />}
                Xem Git Diff
              </button>
            </div>
          ) : <p className="text-xs text-slate-500">{t(getLang(), 'Không có Git repo')}</p>}
        </div>
        <div className="bg-[#181920] rounded-2xl border border-white/8 p-4">
          <h3 className="text-xs font-bold text-amber-400 mb-3 flex items-center gap-1.5"><Database size={14} /> Cache Management</h3>
          <p className="text-xs text-slate-400 mb-3">{t(getLang(), 'Xóa cache models đã lưu để fetch lại danh sách mới.')}</p>
          <button onClick={clearModelCache} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5">
            <Trash2 size={13} /> {t(getLang(), 'Xóa Cache Models')}
          </button>
          {cacheMsg && <p className="mt-2 text-[11px] text-emerald-400">✅ {cacheMsg}</p>}
        </div>
        <div className="bg-[#181920] rounded-2xl border border-white/8 p-4">
          <h3 className="text-xs font-bold text-emerald-400 mb-3 flex items-center gap-1.5"><Terminal size={14} /> Terminal Exec</h3>
          <div className="flex gap-2">
            <input type="text" value={execCmd} onChange={e => setExecCmd(e.target.value)} onKeyDown={e => e.key === 'Enter' && runExec()}
              placeholder={t(getLang(), 'phAdminCmd')} className="flex-1 px-3 py-2 bg-[#0d0e11] border border-white/5 rounded-lg text-xs text-slate-200 placeholder-slate-500 outline-none font-mono" />
            <button onClick={runExec} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold">{t(getLang(), 'Chạy')}</button>
          </div>
          {execOutput && <pre className="mt-2 p-2 bg-black/40 rounded-lg text-[11px] text-slate-300 font-mono max-h-32 overflow-auto">{execOutput}</pre>}
        </div>
      </div>
      {/* Git Diff Modal */}
      {showDiff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowDiff(false)}>
          <div className="bg-[#16171f] border border-white/10 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2"><GitBranch size={14} /> Git Diff — {gitStatus?.branch}</h3>
              <button onClick={() => setShowDiff(false)} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"><X size={14} /></button>
            </div>
            <pre className="p-4 overflow-auto flex-1 text-[11px] font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">{gitDiff}</pre>
          </div>
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// TAB: IPTV MONITOR
// ═══════════════════════════════════════════════════════════
const IptvTab = memo(function IptvTab({ token, showToast }) {
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [countries, setCountries] = useState([]);
  const [history, setHistory] = useState([]);
  const [channels, setChannels] = useState([]);
  const [chanTotal, setChanTotal] = useState(0);
  const [filters, setFilters] = useState({ status: '', country: '', search: '', page: 1 });
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(50);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ channel_name: '', url: '', logo: '', group_name: '', country: '', status: 'unknown' });
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);

  const load = useCallback(async (all = false) => {
    try {
      if (all) {
        const [st, sa, co, hi] = await Promise.all([
          apiFetch('/admin/status', token),
          apiFetch('/admin/stats', token),
          apiFetch('/admin/countries', token),
          apiFetch('/admin/scan-history', token),
        ]);
        setStatus(st); setStats(sa); setCountries(co.countries || []); setHistory(hi.history || []);
      }
    } catch (e) { showToast(e.message, 'error'); }
  }, [token, showToast]);

  useEffect(() => { load(true); }, [load]);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: filters.page, limit });
      if (filters.status) q.set('status', filters.status);
      if (filters.country) q.set('country', filters.country);
      if (filters.search) q.set('search', filters.search);
      const data = await apiFetch(`/admin/channels?${q}`, token);
      setChannels(data.channels || []);
      setChanTotal(data.total || 0);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setLoading(false); }
  }, [token, filters, limit, showToast]);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  const runScan = async () => {
    setScanning(true);
    try {
      const data = await apiFetch('/admin/scan-now', token, { method: 'POST' });
      showToast(data.message || t(getLang(), 'Đã kích hoạt scan'));
      setTimeout(() => { load(true); setScanning(false); }, 15000);
    } catch (e) { showToast(e.message, 'error'); setScanning(false); }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ channel_name: '', url: '', logo: '', group_name: '', country: '', status: 'unknown' });
    setShowForm(true);
  };

  const openEdit = (ch) => {
    setEditing(ch);
    setForm({ channel_name: ch.channel_name, url: ch.url, logo: ch.logo || '', group_name: ch.group_name || '', country: ch.country || '', status: ch.status });
    setShowForm(true);
  };

  const saveChannel = async () => {
    if (!form.channel_name.trim() || !form.url.trim()) return showToast(t(getLang(), 'Cần nhập tên và URL'), 'error');
    setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/admin/channels/${editing.id}`, token, { method: 'PUT', body: JSON.stringify(form) });
        showToast(t(getLang(), 'Đã cập nhật kênh'));
      } else {
        await apiFetch('/admin/channels', token, { method: 'POST', body: JSON.stringify(form) });
        showToast(t(getLang(), 'Đã thêm kênh mới'));
      }
      setShowForm(false);
      loadChannels();
    } catch (e) { showToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const deleteChannel = async (ch) => {
    if (!window.confirm(`${t(getLang(), 'Xóa kênh ')}"${ch.channel_name}"?`)) return;
    try {
      await apiFetch(`/admin/channels/${ch.id}`, token, { method: 'DELETE' });
      showToast(t(getLang(), 'Đã xóa kênh'));
      loadChannels();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const downloadExport = async (fmt) => {
    setExporting(fmt);
    try {
      const q = new URLSearchParams();
      if (filters.country) q.set('country', filters.country);
      if (filters.status) q.set('status', filters.status);
      if (filters.search) q.set('search', filters.search);
      const url = `${API_BASE}/admin/channels/export/${fmt}?${q}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const ext = fmt === 'm3u' ? 'm3u' : fmt;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `iptv-channels.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast(`${t(getLang(), 'Đã tải ')}${fmt.toUpperCase()} ${t(getLang(), 'thành công')}`);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setExporting(null); }
  };

  const loadNotifications = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/notifications?limit=30', token);
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread || 0);
    } catch (e) { showToast(e.message || t(getLang(), 'Lỗi tải thông báo'), 'error'); }
  }, [token]);

  useEffect(() => { loadNotifications(); }, [loadNotifications]);

  const markAllRead = async () => {
    try {
      await apiFetch('/admin/notifications/read-all', token, { method: 'PUT' });
      setNotifications(n => n.map(x => ({ ...x, is_read: 1 })));
      setUnreadCount(0);
    } catch (e) { showToast(e.message || t(getLang(), 'Lỗi đánh dấu đã đọc'), 'error'); }
  };

  const markRead = async (id) => {
    try {
      await apiFetch(`/admin/notifications/${id}/read`, token, { method: 'PUT' });
      setNotifications(n => n.map(x => x.id === id ? { ...x, is_read: 1 } : x));
      setUnreadCount(c => Math.max(0, c - 1));
    } catch (e) { showToast(e.message || t(getLang(), 'Lỗi đánh dấu đã đọc'), 'error'); }
  };

  const deleteNotif = async (id) => {
    try {
      await apiFetch(`/admin/notifications/${id}`, token, { method: 'DELETE' });
      setNotifications(n => n.filter(x => x.id !== id));
      const was = notifications.find(x => x.id === id);
      if (was && !was.is_read) setUnreadCount(c => Math.max(0, c - 1));
    } catch (e) { showToast(e.message || t(getLang(), 'Lỗi xóa thông báo'), 'error'); }
  };

  const total = status?.total_channels || stats?.summary?.total_all || 0;
  const online = status?.total_online || stats?.summary?.total_online || 0;
  const onlinePct = stats?.summary?.online_pct || (total ? ((online / total) * 100).toFixed(1) : '0');

  const cards = [
    { label: t(getLang(), 'Tổng kênh'), value: total, color: 'text-white', icon: Tv },
    { label: t(getLang(), 'Đang hoạt động'), value: online, color: 'text-emerald-400', icon: Wifi },
    { label: t(getLang(), 'Kênh lỗi'), value: total - online, color: 'text-rose-400', icon: XCircle },
    { label: 'Online (%)', value: `${onlinePct}%`, color: 'text-cyan-400', icon: Activity },
    { label: t(getLang(), 'Quốc gia'), value: stats?.summary?.countries_scanned ?? countries.length, color: 'text-amber-400', icon: Globe },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><Tv size={20} className="text-sky-400" /> IPTV Monitor</h2>
        <div className="flex items-center gap-2">
          {status?.is_running && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              <Radar size={12} className="animate-pulse" /> {tx(getLang(), 'Đang scan...')}
            </span>
          )}
          <button onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold">
            <Plus size={13} /> {t(getLang(), 'Thêm kênh')}
          </button>
          <div className="relative group">
            <button className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-semibold">
              <Download size={13} /> Export {exporting && <Loader2 size={11} className="animate-spin" />}
            </button>
            <div className="absolute right-0 top-full mt-1 bg-[#1a1b23] border border-white/10 rounded-xl shadow-xl py-1 hidden group-hover:block z-10 min-w-[120px]">
              <button onClick={() => downloadExport('m3u')} className="w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-white/10">M3U Playlist</button>
              <button onClick={() => downloadExport('csv')} className="w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-white/10">CSV Spreadsheet</button>
              <button onClick={() => downloadExport('json')} className="w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-white/10">JSON Data</button>
            </div>
          </div>
          <button onClick={runScan} disabled={scanning}
            className="flex items-center gap-1.5 px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold">
            <PlayCircle size={13} /> {scanning ? t(getLang(), 'Đang quét...') : t(getLang(), 'Quét kênh')}
          </button>
          <button onClick={() => load(true)} className="p-2 rounded-xl hover:bg-white/10 text-slate-400"><RefreshCw size={14} /></button>
          <div className="relative">
            <button onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs) loadNotifications(); }}
              className="p-2 rounded-xl hover:bg-white/10 text-slate-400 relative">
              <Bell size={14} />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-rose-500 text-white text-[9px] font-bold px-1">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            {showNotifs && (
              <div className="absolute right-0 top-full mt-1 bg-[#1a1b23] border border-white/10 rounded-xl shadow-2xl w-80 z-20">
                <div className="px-3 py-2.5 border-b border-white/5 flex items-center justify-between">
                  <span className="text-xs font-bold text-white">{t(getLang(), 'Thông báo')}</span>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="text-[10px] text-sky-400 hover:text-sky-300">{t(getLang(), 'Đọc tất cả')}</button>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {notifications.length === 0 && <div className="p-5 text-center text-xs text-slate-500">{t(getLang(), 'Chưa có thông báo')}</div>}
                  {notifications.map(n => (
                    <div key={n.id} onClick={() => { if (!n.is_read) markRead(n.id); }}
                      className={`px-3 py-2.5 border-b border-white/5 cursor-pointer hover:bg-white/5 ${!n.is_read ? 'bg-sky-500/5' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {!n.is_read && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0"></span>}
                            <span className="text-[11px] font-semibold text-white">{n.title}</span>
                          </div>
                          <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2">{n.message}</p>
                          <span className="text-[9px] text-slate-500 mt-1 block">{new Date(n.created_at).toLocaleString('vi-VN')}</span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); deleteNotif(n.id); }}
                          className="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-rose-400 shrink-0"><X size={11} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        {cards.map(c => (
          <div key={c.label} className="bg-[#181920] rounded-2xl border border-white/8 p-4">
            <div className="flex items-center gap-2 text-[10px] text-slate-400 uppercase font-semibold mb-2"><c.icon size={13} /> {c.label}</div>
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Countries table */}
        <div className="bg-[#181920] rounded-2xl border border-white/8 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-xs font-bold text-sky-400 flex items-center gap-1.5"><Globe size={14} /> {t(getLang(), 'Quốc gia theo số kênh')}</h3>
            <span className="text-[10px] text-slate-500">Top {Math.min(countries.length, 15)} / {countries.length}</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {countries.slice(0, 15).map(c => (
              <div key={c.code} className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 text-xs">
                <div className="flex items-center gap-2 text-slate-300"><FlagImg code={c.code} /> {c.name} <span className="text-slate-500">({c.code})</span></div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">{c.online}✓</span>
                  <span className="text-rose-400">{c.offline}✗</span>
                  <span className="text-slate-400 font-semibold w-10 text-right">{c.total}</span>
                </div>
              </div>
            ))}
            {countries.length === 0 && <div className="p-6 text-center text-xs text-slate-500">{t(getLang(), 'Chưa có dữ liệu quét')}</div>}
          </div>
        </div>

        {/* Channels table */}
        <div className="xl:col-span-2 bg-[#181920] rounded-2xl border border-white/8 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-bold text-sky-400 flex items-center gap-1.5 mr-auto"><Tv size={14} /> {t(getLang(), 'Kênh')} {filters.status === 'online' ? t(getLang(), '(hoạt động)') : filters.status === 'offline' ? t(getLang(), '(lỗi)') : t(getLang(), '(tất cả)')}</h3>
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value, page: 1 }))}
              className="px-2 py-1.5 bg-[#0d0e11] border border-white/10 rounded-lg text-[11px] text-slate-300 outline-none">
              <option value="">{t(getLang(), 'Tất cả trạng thái')}</option>
              <option value="online">{t(getLang(), 'Hoạt động')}</option>
              <option value="offline">{t(getLang(), 'Lỗi')}</option>
            </select>
            <select value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value, page: 1 }))}
              className="px-2 py-1.5 bg-[#0d0e11] border border-white/10 rounded-lg text-[11px] text-slate-300 outline-none">
              <option value="">{t(getLang(), 'Mọi quốc gia')}</option>
              {countries.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
            </select>
            <div className="flex items-center gap-1.5 bg-[#0d0e11] border border-white/10 rounded-lg px-2 py-1">
              <Search size={12} className="text-slate-500" />
              <input value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
                placeholder={t(getLang(), 'phAdminCh')} className="bg-transparent text-[11px] text-slate-200 placeholder-slate-500 outline-none w-28" />
            </div>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#181920]">
                <tr className="text-left text-[10px] text-slate-500 uppercase border-b border-white/5">
                  <th className="px-4 py-2">{t(getLang(), 'Trạng thái')}</th>
                  <th className="px-2 py-2">{t(getLang(), 'Kênh')}</th>
                  <th className="px-2 py-2">{t(getLang(), 'Quốc gia')}</th>
                  <th className="px-2 py-2">{t(getLang(), 'Nhóm')}</th>
                  <th className="px-4 py-2 text-right">Ping</th>
                  <th className="px-2 py-2 text-right">{t(getLang(), 'Hành động')}</th>
                </tr>
              </thead>
              <tbody>
                {channels.map(ch => (
                  <tr key={ch.id} className="border-b border-white/5 hover:bg-white/3">
                    <td className="px-4 py-2">{ch.status === 'online'
                      ? <span className="text-emerald-400"><CheckCircle size={12} /></span>
                      : <span className="text-rose-400"><XCircle size={12} /></span>}</td>
                    <td className="px-2 py-2 text-slate-200 font-medium max-w-[220px] truncate">{ch.channel_name}</td>
                    <td className="px-2 py-2 text-slate-400">{ch.country ? <span className="inline-flex items-center gap-1.5"><FlagImg code={ch.country} /> <span>{ch.country}</span></span> : '—'}</td>
                    <td className="px-2 py-2 text-slate-400 max-w-[120px] truncate">{ch.group_name}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{ch.latency_ms > 0 ? `${ch.latency_ms}ms` : '—'}</td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(ch)} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-sky-400" title={t(getLang(), 'tipEdit')}><Pencil size={12} /></button>
                        <button onClick={() => deleteChannel(ch)} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-rose-400" title={t(getLang(), 'tipDelete')}><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {channels.length === 0 && !loading && <tr><td colSpan={6} className="p-6 text-center text-slate-500">{t(getLang(), 'Không có kênh nào')}</td></tr>}
              </tbody>
            </table>
            {loading && <div className="p-4 text-center text-[11px] text-slate-500">{t(getLang(), 'Đang tải...')}</div>}
          </div>
          <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between text-[11px] text-slate-400">
            <span>{chanTotal} {t(getLang(), 'kênh')} · {t(getLang(), 'trang')} {filters.page}</span>
            <div className="flex items-center gap-1.5">
              <select value={limit} onChange={e => setLimit(parseInt(e.target.value))} className="px-1.5 py-1 bg-[#0d0e11] border border-white/10 rounded-lg text-[11px] outline-none">
                <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
              </select>
              <button disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))} className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30"><ChevronLeft size={13} /></button>
              <button disabled={filters.page * limit >= chanTotal} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))} className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30"><ChevronRight size={13} /></button>
            </div>
          </div>
        </div>
      </div>

      {/* Scan history */}
      <div className="bg-[#181920] rounded-2xl border border-white/8 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5 flex items-center gap-1.5">
          <Clock size={14} className="text-sky-400" />
          <h3 className="text-xs font-bold text-sky-400">{t(getLang(), 'Lịch sử quét')}</h3>
        </div>
        <div className="max-h-56 overflow-y-auto">
          {history.map(h => (
            <div key={h.id} className="flex items-center justify-between px-4 py-2 border-b border-white/5 text-xs">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${h.status === 'done' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'}`}>
                  {h.status === 'done' ? <CheckCircle size={9} /> : <AlertTriangle size={9} />} {t(getLang(), { done: 'Hoàn tất', running: 'Đang quét', interrupted: 'Bị gián đoạn', failed: 'Thất bại' }[h.status]) || h.status}
                </span>
                <span className="text-slate-300">{new Date(h.started_at).toLocaleString('vi-VN')}</span>
              </div>
              <div className="flex items-center gap-3 text-slate-400">
                <span>{h.total_channels} {t(getLang(), 'kênh')}</span>
                <span className="text-emerald-400">{h.online_channels}✓</span>
                <span className="text-rose-400">{h.offline_channels}✗</span>
                {h.new_channels > 0 && <span className="text-sky-400">+{h.new_channels} {t(getLang(), 'mới')}</span>}
                {h.lost_channels > 0 && <span className="text-orange-400">-{h.lost_channels} {t(getLang(), 'mất')}</span>}
              </div>
            </div>
          ))}
          {history.length === 0 && <div className="p-6 text-center text-xs text-slate-500">{t(getLang(), 'Chưa có lịch sử quét')}</div>}
        </div>
      </div>

      {/* Add/Edit Channel Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="bg-[#1a1b23] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                {editing ? <><Pencil size={14} className="text-sky-400" /> {t(getLang(), 'Sửa kênh')}</> : <><Plus size={14} className="text-emerald-400" /> {t(getLang(), 'Thêm kênh mới')}</>}
              </h3>
              <button onClick={() => setShowForm(false)} className="p-1 rounded-lg hover:bg-white/10 text-slate-400"><X size={16} /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">{t(getLang(), 'Tên kênh *')}</label>
                <input value={form.channel_name} onChange={e => setForm(f => ({ ...f, channel_name: e.target.value }))}
                  className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500"
                  placeholder={t(getLang(), 'phAdminVtv')} />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">URL stream *</label>
                <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                  className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500 font-mono text-xs"
                  placeholder="https://example.com/live/stream.m3u8" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Logo URL</label>
                  <input value={form.logo} onChange={e => setForm(f => ({ ...f, logo: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500"
                    placeholder="https://..." />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">{t(getLang(), 'Quốc gia (mã 2 chữ)')}</label>
                  <input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value.toUpperCase() }))}
                    className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500"
                    placeholder="VN" maxLength={2} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">{t(getLang(), 'Nhóm')}</label>
                  <input value={form.group_name} onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500"
                    placeholder="News, Sports..." />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">{t(getLang(), 'Trạng thái')}</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0d0e11] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-sky-500">
                    <option value="unknown">{t(getLang(), 'Chưa rõ')}</option>
                    <option value="online">{t(getLang(), 'Hoạt động')}</option>
                    <option value="offline">{t(getLang(), 'Lỗi')}</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-white/5 flex items-center justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg">{t(getLang(), 'Hủy')}</button>
              <button onClick={saveChannel} disabled={saving || !form.channel_name.trim() || !form.url.trim()}
                className="flex items-center gap-1.5 px-5 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {editing ? t(getLang(), 'Cập nhật') : t(getLang(), 'Thêm mới')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════════════════════════
// MAIN ADMIN PANEL — REXI Harmonized Glassmorphic UI/UX 
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// TAB: ROUTING TELEMETRY — thống kê định tuyến AI
// ═══════════════════════════════════════════════════════════
const RoutingTab = memo(function RoutingTab({ token, showToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/chat/routing-stats', token);
      setData(d);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setLoading(false); }
  }, [token, showToast]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-cyan-400" /></div>;
  }
  if (!data) return <div className="text-slate-400 p-8">{t(getLang(), 'Không có dữ liệu định tuyến.')}</div>;

  const { totals, providers, byCategory, recentEvents, uptimeMs } = data;
  const uptimeMin = Math.round((uptimeMs || 0) / 60000);

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><GitBranch className="w-5 h-5 text-cyan-400" /> {t(getLang(), 'Định Tuyến AI — Telemetry')}</h2>
        <p className="text-xs text-slate-400 mt-1">{t(getLang(), 'Thống kê hệ thống tự chọn model / fallback / provider đang dùng. Uptime: ')}{uptimeMin} {t(getLang(), 'phút')}</p>
      </div>

      {/* Tổng quan */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: t(getLang(), 'Tổng lượt route'), value: totals?.routed ?? 0, color: 'text-cyan-300' },
          { label: 'Fallback', value: totals?.fallbacks ?? 0, color: 'text-amber-300' },
          { label: t(getLang(), 'Lỗi'), value: totals?.errors ?? 0, color: 'text-rose-300' },
          { label: t(getLang(), 'Provider hoạt động'), value: (providers || []).length, color: 'text-emerald-300' },
        ].map((c, i) => (
          <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{c.label}</div>
            <div className={`text-2xl font-bold mt-1 ${c.color}`}>{(c.value ?? 0).toLocaleString('vi-VN')}</div>
          </div>
        ))}
      </div>

      {/* Theo provider */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4">
        <h3 className="text-sm font-bold text-white mb-3">Theo Provider</h3>
        <div className="space-y-2">
          {(providers || []).map(p => (
            <div key={p.provider} className="flex items-center gap-3 text-xs">
              <span className="w-28 font-semibold text-slate-200 uppercase">{p.provider}</span>
              <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full" style={{ width: `${Math.min(100, Math.round((p.count / Math.max(1, Math.max(...providers.map(x => x.count || 0)))) * 100))}%` }} />
              </div>
              <span className="w-10 text-right text-slate-300">{p.count}</span>
              <span className="w-16 text-right text-slate-500">{p.avgMs}ms</span>
              <span className={`w-14 text-right ${p.errorRate > 20 ? 'text-rose-400' : 'text-emerald-400'}`}>{t(getLang(), 'lỗi')} {p.errorRate}%</span>
            </div>
          ))}
          {(providers || []).length === 0 && <div className="text-slate-500 text-xs">{t(getLang(), 'Chưa có lượt route nào — gõ "Auto" trong chat để bắt đầu.')}</div>}
        </div>
      </div>

      {/* Theo loại câu hỏi */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4">
        <h3 className="text-sm font-bold text-white mb-3">{t(getLang(), 'Theo Loại Câu Hỏi')}</h3>
        <div className="flex flex-wrap gap-2">
          {Object.entries(byCategory || {}).map(([cat, cnt]) => (
            <span key={cat} className="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold">
              {cat} × {cnt}
            </span>
          ))}
          {Object.keys(byCategory || {}).length === 0 && <span className="text-slate-500 text-xs">{t(getLang(), 'Chưa có dữ liệu.')}</span>}
        </div>
      </div>

      {/* Sự kiện gần đây */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4">
        <h3 className="text-sm font-bold text-white mb-3">{t(getLang(), 'Sự Kiện Gần Đây')}</h3>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {(recentEvents || []).map((ev, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] text-slate-400 border-b border-white/5 pb-1">
              <span className="text-slate-600">{new Date(ev.ts).toLocaleTimeString('vi-VN')}</span>
              {ev.type === 'fallback' ? <span className="text-amber-400 font-semibold">fallback</span>
                : ev.type === 'error' ? <span className="text-rose-400 font-semibold">error</span>
                : <span className="text-cyan-400 font-semibold">route</span>}
              <span className="uppercase text-slate-300">{ev.provider}</span>
              {ev.model && <span className="text-slate-500 truncate">{ev.model}</span>}
              {ev.from && <span className="text-slate-600">← {t(getLang(), 'từ')} {ev.from}</span>}
            </div>
          ))}
          {(recentEvents || []).length === 0 && <div className="text-slate-500 text-xs">{t(getLang(), 'Chưa có sự kiện.')}</div>}
        </div>
      </div>

      <button onClick={load} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold hover:bg-cyan-500/20">
        <RefreshCw className="w-3 h-3" /> {t(getLang(), 'Làm mới')}
      </button>
    </div>
  );
});

export default function AdminPanel(props) {
  const lang = getLang();
  const token = props.token || (() => { try { return localStorage.getItem('rexi_token') || null; } catch { return null; } })();
  const [currentUser, setCurrentUser] = useState(() => {
    if (props.currentUser) return props.currentUser;
    try {
      const raw = localStorage.getItem('rexi_user');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const onClose = props.onClose;
  const [activeTab, setActiveTabState] = useState(() => {
    return localStorage.getItem('rexi_admin_active_tab') || 'users';
  });

  const setActiveTab = useCallback((tab) => {
    setActiveTabState(tab);
    localStorage.setItem('rexi_admin_active_tab', tab);
  }, []);

  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [toast, setToast] = useState(null);


  useEffect(() => {
    if (!token || !currentUser || currentUser.phan_quyen !== 'admin') { 
      if (onClose) onClose(); 
      else window.location.href = '/'; 
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = useCallback((message, type = 'success') => setToast({ message, type }), []);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try { 
      const data = await apiFetch('/auth/stats', token); 
      setStats(data); 
    } catch { 
      setStats(null); 
    } finally { 
      setStatsLoading(false); 
    }
  }, [token]);

  useEffect(() => { fetchStats(); }, [fetchStats]);


  const tabContent = useMemo(() => {
    switch (activeTab) {
      case 'users': return <UsersTab token={token} currentUser={currentUser} showToast={showToast} stats={stats} statsLoading={statsLoading} fetchStats={fetchStats} />;
      case 'conversations': return <ConversationsTab token={token} showToast={showToast} />;
      case 'apikeys': return <ApiKeysTab token={token} showToast={showToast} />;
      case 'skills': return <SkillsTab token={token} showToast={showToast} />;
      case 'chat': return <AdminChatTab token={token} showToast={showToast} />;
      case 'iptv': return <IptvTab token={token} showToast={showToast} />;
      case 'github': return <GitHubTrending token={token} showToast={showToast} />;
      case 'routing': return <RoutingTab token={token} showToast={showToast} />;
      case 'settings': return <SettingsTab token={token} showToast={showToast} />;
      default: return <UsersTab token={token} currentUser={currentUser} showToast={showToast} stats={stats} statsLoading={statsLoading} fetchStats={fetchStats} />;
    }
  }, [activeTab, token, currentUser, showToast, stats, statsLoading, fetchStats]);

  if (!token || !currentUser || currentUser.phan_quyen !== 'admin') return null;
  return (
    <div className="flex h-full w-full bg-[#0b0c10] text-slate-100 font-sans relative z-10 overflow-hidden">
      {/* Sleek Integrated Sub-Nav Sidebar */}
      <aside className="flex flex-col bg-[#0d0e14]/90 backdrop-blur-2xl border-r border-white/8 w-52 shrink-0 transition-all duration-300">
        <div className="p-4 border-b border-white/8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-sm shadow-amber-500/10">
              <Shield size={18} />
            </div>
            <div>
              <h1 className="text-xs font-bold bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 bg-clip-text text-transparent">Admin Hub</h1>
              <p className="text-[9px] text-slate-500 font-medium tracking-wide">Rexi AI OS v2.0</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2.5 space-y-1 overflow-y-auto scrollbar-none">
          {MENU_ITEMS.map(item => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-500/15 via-indigo-500/15 to-purple-500/15 text-cyan-300 border border-cyan-500/30 font-bold shadow-sm shadow-cyan-500/10 translate-x-0.5'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 font-medium'
                }`}
              >
                <item.icon size={16} className={isActive ? 'text-cyan-400' : item.color} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/8 bg-[#0a0b0e]/60">
          <button
            onClick={() => onClose && onClose()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
          >
            <Home size={14} className="text-cyan-400" />
            <span>{t(getLang(), 'Về trang chủ')}</span>
          </button>
        </div>
      </aside>

      {/* Main Glassmorphism Display Area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gradient-to-br from-[#0b0c10] via-[#0e0f17] to-[#0a0b10]">
        <header className="h-14 px-6 border-b border-white/8 flex items-center justify-between bg-[#0d0e14]/70 backdrop-blur-xl shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-bold text-slate-400">{t(getLang(), 'Bảng điều khiển')}</span>
            <span className="text-xs text-slate-600">/</span>
            <span className="text-xs font-bold text-cyan-400">{MENU_ITEMS.find(m => m.id === activeTab)?.label}</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-semibold">
              <Crown size={12} className="text-amber-400" />
              <span>{currentUser.ten_day_du}</span>
            </div>

            <button
              onClick={() => fetchStats()}
              title={t(getLang(), 'tipRefresh')}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-400 hover:text-white transition-all active:scale-95"
            >
              <RefreshCw size={14} className={statsLoading ? 'animate-spin text-cyan-400' : ''} />
            </button>

            {onClose && (
              <button
                onClick={onClose}
                title={t(getLang(), 'tipCloseAdmin')}
                className="p-2 rounded-xl bg-white/5 hover:bg-rose-500/20 border border-white/5 text-slate-400 hover:text-rose-300 transition-all active:scale-95"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-white/10">
          {tabContent}
        </main>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
