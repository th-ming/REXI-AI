import React, { useState, useEffect, useCallback } from 'react';
import { t, getLang } from '../i18n';
import { Share2, RefreshCw, CheckCircle2, Link2, Send } from 'lucide-react';
import { API_BASE } from '../config';

const PLATFORM_ORDER = ['x', 'tiktok', 'instagram'];
const PLATFORM_META = {
  x: { label: 'X (Twitter)' },
  tiktok: { label: 'TikTok' },
  instagram: { label: 'Instagram' },
};

/**
 * SocialConnect — khu "Mạng xã hội" (additive).
 * Đọc trạng thái từ /api/social/status, cho kết nối + đăng bài.
 * Guard mọi fetch: lỗi/503 → hiện thông báo, KHÔNG crash tab khác.
 */
export default function SocialConnect({ showToast }) {
  const lang = getLang();
  const [platforms, setPlatforms] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [posting, setPosting] = useState({});

  const authToken = typeof localStorage !== 'undefined' ? localStorage.getItem('rexi_token') : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/social/status`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPlatforms(data.platforms || {});
    } catch (e) {
      setError(e.message || t(lang, 'Không tải được trạng thái mạng xã hội.'));
      setPlatforms(null);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const connect = (p) => {
    const t = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    window.location.href = `${API_BASE}/social/${p}/connect${t}`;
  };

  const post = async (p) => {
    const text = (drafts[p] || '').trim();
    if (!text) { showToast?.(t(lang, 'Nhập nội dung bài đăng trước.'), 'error'); return; }
    setPosting((s) => ({ ...s, [p]: true }));
    try {
      const res = await fetch(`${API_BASE}/social/${p}/post`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.(`${t(lang, 'Đã đăng lên ')}${PLATFORM_META[p].label}!`, 'success');
      setDrafts((s) => ({ ...s, [p]: '' }));
    } catch (e) {
      showToast?.(`${t(lang, 'Đăng lên ')}${PLATFORM_META[p].label} ${t(lang, 'lỗi: ')}${e.message}`, 'error');
    } finally {
      setPosting((s) => ({ ...s, [p]: false }));
    }
  };

  const statusPill = (info) => {
    if (!info || !info.configured) {
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/15 text-slate-400 border border-white/10">{t(lang, 'Chưa cấu hình')}</span>;
    }
    if (info.connected) {
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">{t(lang, 'Đã kết nối')}</span>;
    }
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">{t(lang, 'Chưa kết nối')}</span>;
  };

  // Nếu CHƯA có nền tảng nào sẵn sàng -> ẩn HẲN mục này.
  // Người dùng không phải cấu hình gì — hệ thống (operator) lo.
  if (platforms && !PLATFORM_ORDER.some((p) => platforms[p] && platforms[p].configured)) {
    return null;
  }

  return (
    <div className="border-t border-white/10 pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Share2 size={16} className="text-cyan-500" /> {t(lang, 'Mạng xã hội')}
        </h3>
        <button
          type="button"
          onClick={load}
          title={t(lang, 'tipStatusReload')}
          className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin text-cyan-500' : ''} />
        </button>
      </div>

      {error && (
        <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" /> {error}
        </p>
      )}

      {!platforms && !error && (
        <p className="text-[11px] text-slate-400">{t(lang, 'Đang tải...')}</p>
      )}

      {platforms && PLATFORM_ORDER.filter((p) => platforms[p] && platforms[p].configured).map((p) => {
        const info = platforms[p] || { configured: false, connected: false };
        const meta = PLATFORM_META[p] || { label: p };
        return (
          <div key={p} className="rounded-xl bg-[#0e0f16] border border-white/10 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">{meta.label}</span>
                {statusPill(info)}
              </div>
              {info.configured && !info.connected && (
                <button
                  type="button"
                  onClick={() => connect(p)}
                  className="text-[11px] font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-cyan-500/10 transition-colors"
                >
                  <Link2 size={12} /> {t(lang, 'Kết nối')}
                </button>
              )}
            </div>

            {info.connected && (
              <div className="space-y-2">
                {info.account && (
                  <p className="text-[10px] text-slate-400">{t(lang, 'Tài khoản:')} <span className="text-cyan-300">{info.account}</span></p>
                )}
                <textarea
                  value={drafts[p] || ''}
                  onChange={(e) => setDrafts((s) => ({ ...s, [p]: e.target.value }))}
                  rows={2}
                  placeholder={(lang === 'vi' ? 'Viết nội dung đăng lên ' : 'Write the post content for ') + meta.label + '...'}
                  className="w-full px-3 py-2 bg-[#141522] border border-white/10 rounded-lg text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-400 resize-none"
                />
                <button
                  type="button"
                  onClick={() => post(p)}
                  disabled={posting[p]}
                  className="text-[11px] font-medium text-white bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 rounded-lg px-3 py-1.5 flex items-center gap-1.5 transition-colors"
                >
                  {posting[p] ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />} {t(lang, 'Đăng')}
                </button>
              </div>
            )}

            {info.configured && !info.connected && (
              <p className="text-[10px] text-slate-500">{t(lang, 'Bấm "Kết nối" để cấp quyền đăng bài.')}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
