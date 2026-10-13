import React, { useRef, useEffect } from 'react';
import { Send, Mic, Paperclip, Volume2, Copy, Check, ArrowUp, ArrowDown, Square, FileText, Loader2, Zap, MessageSquare, Share2, X, Pencil, Clapperboard, Tv, Image as ImageIcon, ChevronDown, Bot, Rocket, MonitorPlay, Scissors, Film, Gamepad2, GraduationCap, Sparkles, Folder, Monitor } from 'lucide-react';
import { sanitizeMarkdown } from '../utils/sanitize';
import { t } from '../i18n';

// ── Welcome quick-actions (redesign) — thêm/bớt card chỉ sửa mảng này ──
const QUICK_ACTIONS = [
  { tab: 'video',      labelKey: 'qaVideo',      descKey: 'qaVideoDesc',      icon: <Clapperboard size={18} />, color: 'text-sky-400',     box: 'bg-sky-500/10 border-sky-500/25' },
  { tab: 'tts',        labelKey: 'qaTts',        descKey: 'qaTtsDesc',        icon: <Mic size={18} />,         color: 'text-cyan-400',    box: 'bg-cyan-500/10 border-cyan-500/25' },
  { tab: 'image',      labelKey: 'qaImage',      descKey: 'qaImageDesc',      icon: <ImageIcon size={18} />,   color: 'text-violet-400',  box: 'bg-violet-500/10 border-violet-500/25' },
  { tab: 'documents',  labelKey: 'qaDocs',       descKey: 'qaDocsDesc',       icon: <FileText size={18} />,    color: 'text-emerald-400', box: 'bg-emerald-500/10 border-emerald-500/25' },
  { tab: 'youtube',    labelKey: 'qaYoutube',    descKey: 'qaYoutubeDesc',    icon: <MonitorPlay size={18} />, color: 'text-red-400',     box: 'bg-red-500/10 border-red-500/25' },
  { tab: 'iptv',       labelKey: 'qaIptv',       descKey: 'qaIptvDesc',       icon: <Tv size={18} />,          color: 'text-amber-400',   box: 'bg-amber-500/10 border-amber-500/25' },
  { tab: 'opencut',    labelKey: 'qaOpenCut',    descKey: 'qaOpenCutDesc',    icon: <Scissors size={18} /> },
  { tab: 'openshorts', labelKey: 'qaOpenShorts', descKey: 'qaOpenShortsDesc', icon: <Film size={18} /> },
  { tab: 'classroom',  labelKey: 'qaClassroom',  descKey: 'qaClassroomDesc',  icon: <GraduationCap size={18} /> },
  { tab: 'games',      labelKey: 'qaGames',      descKey: 'qaGamesDesc',      icon: <Gamepad2 size={18} /> },
];

// 6 ô "đại diện" hiện dạng tile; phần còn lại nằm trong dải pill cuộn ngang.
const FEATURED_ACTIONS = QUICK_ACTIONS.slice(0, 6);
const EXTRA_ACTIONS = [
  { tab: 'opencut',    labelKey: 'qaOpenCut',    icon: <Scissors size={13} />,      color: 'text-sky-400' },
  { tab: 'openshorts', labelKey: 'qaOpenShorts', icon: <Film size={13} />,          color: 'text-fuchsia-400' },
  { tab: 'classroom',  labelKey: 'qaClassroom',  icon: <GraduationCap size={13} />, color: 'text-teal-300' },
  { tab: 'games',      labelKey: 'qaGames',      icon: <Gamepad2 size={13} />,      color: 'text-amber-400' },
  { tab: 'browser',    labelKey: 'qaBrowser',   icon: <Bot size={13} />,            color: 'text-cyan-400' },
  { tab: 'files',      labelKey: 'qaFiles',      icon: <Folder size={13} />,        color: 'text-orange-300' },
  { tab: 'desktop',    labelKey: 'qaDesktop',   icon: <Monitor size={13} />,        color: 'text-slate-400' },
];

export default function ChatTab({
  messages, inputText, setInputText, loading, attachedFiles,
  executionMode, setExecutionMode, agentEngine, setAgentEngine, chatModeOpen, setChatModeOpen,
  listening, voiceTranscript, copiedId, speakingMsgId,
  handleSendMessage, startVoice, speakText, copyToClipboard,
  fileInputRef, handleFileSelect, chatScrollRef, handleChatScroll,
  showScrollTop, showScrollBottom, scrollToTopSmooth, scrollToBottomSmooth,
  activeConvId: _activeConvId, onShare, onRemoveFile,
  currentUser, onOpenFeature, lang
}) {
  const dropdownRef = useRef(null);
  const taRef = useRef(null);
  const [sharePop, setSharePop] = React.useState({ open: false, loading: false, url: '', err: '' });

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const doShare = async () => {
    setSharePop({ open: true, loading: true, url: '', err: '' });
    try {
      const url = await onShare?.();
      if (!url) throw new Error(t(lang, 'Không tạo được link'));
      setSharePop({ open: true, loading: false, url, err: '' });
    } catch (e) {
      setSharePop({ open: true, loading: false, url: '', err: e.message || t(lang, 'Lỗi tạo link') });
    }
  };

  const shareTargets = (url) => {
    const u = encodeURIComponent(url);
    const tx = encodeURIComponent(t(lang, 'Xem hội thoại này trên Rexi AI'));
    return [
      ['Telegram', `https://t.me/share/url?url=${u}&text=${tx}`],
      ['Messenger', `https://www.facebook.com/dialog/send?link=${u}&app_id=291494419107518&redirect_uri=${u}`],
      ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
      ['Zalo', `https://zalo.me/share?u=${u}`],
      ['X', `https://twitter.com/intent/tweet?url=${u}&text=${tx}`],
      ['WhatsApp', `https://wa.me/?text=${u}`],
    ];
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setChatModeOpen?.(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setChatModeOpen?.(false);
    }
    if (chatModeOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [chatModeOpen, setChatModeOpen]);

  const hasSendText = !!(inputText.trim() || attachedFiles.length);

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto px-4 py-3">
      {/* Chat Messages */}
      <div className="relative flex-1 min-h-0">
        <div ref={chatScrollRef} onScroll={handleChatScroll} className="h-full overflow-y-auto space-y-4 pr-1 mt-2">
          {messages.length === 0 ? (
            <div className="relative h-full flex flex-col items-center justify-center px-4 py-6 overflow-hidden">
              <div className="relative z-10 w-full max-w-3xl flex flex-col items-center">
                <div className="flex flex-col items-center text-center mb-6 rexi-rise">
                  <img src="/rexi_cat_icon.png" alt="Rexi" className="rexi-logo w-12 h-12 object-contain mb-3" />
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-100">
                    {t(lang, 'welcomeGreeting').replace('{name}', currentUser?.ten_day_du || (lang === 'en' ? 'there' : 'bạn'))}
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-400 mt-1.5">{t(lang, 'welcomeSub')}</p>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 w-full">
                  {FEATURED_ACTIONS.map((a, i) => (
                    <button
                      key={a.tab}
                      onClick={() => onOpenFeature?.(a.tab)}
                      style={{ animationDelay: `${80 + i * 55}ms` }}
                      className="rexi-rise group flex items-center gap-3 text-left rounded-xl p-3 bg-[#1e1f20] border border-white/[0.06] hover:border-white/[0.14] hover:bg-[#222325] transition-colors duration-150"
                    >
                      <span className={`inline-flex items-center justify-center w-10 h-10 rounded-lg border shrink-0 ${a.box || 'border-white/[0.08] bg-white/[0.04]'} ${a.color || 'text-slate-300'}`}>
                        {a.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-slate-200">{t(lang, a.labelKey)}</span>
                        <span className="block text-[10.5px] text-slate-500 truncate">{t(lang, a.descKey)}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 w-full px-1 py-1 mt-3.5">
                  {EXTRA_ACTIONS.map((x, i) => (
                    <button
                      key={x.tab}
                      onClick={() => onOpenFeature?.(x.tab)}
                      style={{ animationDelay: `${410 + i * 45}ms` }}
                      className="rexi-rise rexi-pill inline-flex items-center justify-center gap-1.5 min-w-0 w-full px-1 py-1.5 rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-[11px] whitespace-nowrap overflow-hidden text-slate-300 hover:text-white"
                    >
                      <span className={x.color || 'text-slate-400'}>{x.icon}</span>{t(lang, x.labelKey)}
                    </button>
                  ))}
                </div>

                <p className="text-[11px] text-slate-500 mt-4">{t(lang, 'welcomeHint')}</p>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={msg.ma_tin_nhan || idx}
                className={`flex gap-3 text-sm group ${msg.vai_tro === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.vai_tro !== 'user' && (
                  <img src="/rexi_cat_icon.png" alt="Rexi" className="rexi-logo rexi-logo-no-glow w-7 h-7 shrink-0 mt-0.5 object-contain" />
                )}
                <div className={`relative max-w-[85%] rounded-2xl p-4 shadow-sm ${
                  msg.vai_tro === 'user'
                    ? 'bg-cyan-600 text-white rounded-tr-none'
                    : 'bg-[#1e1f20] border border-white/5 text-slate-200 rounded-tl-none prose-rexi'
                }`}>
                  {msg.vai_tro === 'user' ? (
                    <p className="whitespace-pre-wrap">{msg.noi_dung}</p>
                  ) : msg.vai_tro === 'admin' ? (
                    <div className="bg-gradient-to-r from-amber-900/30 to-orange-900/30 border border-amber-500/30 rounded-xl p-4">
                      <div className="flex items-center gap-1.5 mb-2 text-[11px] text-amber-400 font-semibold">
                        <span className="inline-block w-2 h-2 rounded-full bg-amber-400"></span>
                        {t(lang, 'Phản hồi từ Admin')}
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(msg.noi_dung || '') }} />
                    </div>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(msg.noi_dung || '') }} />
                  )}
                  {msg.vai_tro !== 'user' && (
                    <div className="flex items-center justify-end gap-3 mt-3 pt-2 border-t border-white/5 text-xs text-slate-400">
                      <button onClick={() => speakText(msg.noi_dung, msg.ma_tin_nhan)}
                        className={`flex items-center gap-1 transition-colors ${speakingMsgId === msg.ma_tin_nhan ? "text-amber-400 animate-pulse" : "hover:text-cyan-400"}`}>
                        <Volume2 size={13} />
                        <span>{speakingMsgId === msg.ma_tin_nhan ? t(lang, 'stop') : t(lang, 'speak')}</span>
                      </button>
                      <button onClick={() => copyToClipboard(msg.noi_dung, msg.ma_tin_nhan)}
                        className="flex items-center gap-1 hover:text-cyan-400 transition-colors">
                        {copiedId === msg.ma_tin_nhan ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                        <span>{copiedId === msg.ma_tin_nhan ? t(lang, 'copied') : t(lang, 'copy')}</span>
                      </button>
                      <div className="relative">
                        <button onClick={doShare} className="flex items-center gap-1 hover:text-cyan-400 transition-colors" title={t(lang, 'tipShare')}>
                          <Share2 size={13} />
                          <span>{t(lang, 'Chia sẻ')}</span>
                        </button>
                        {sharePop.open && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setSharePop(s => ({ ...s, open: false }))} />
                            <div className="absolute right-0 bottom-full mb-2 w-72 bg-[#141522] border border-white/10 rounded-xl shadow-2xl p-3 z-50 text-left">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{t(lang, 'Chia sẻ hội thoại')}</span>
                                <button onClick={() => setSharePop(s => ({ ...s, open: false }))} className="text-slate-500 hover:text-white"><X size={13} /></button>
                              </div>
                              {sharePop.loading ? (
                                <div className="text-[11px] text-slate-400 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> {t(lang, 'đang tạo link…')}</div>
                              ) : sharePop.err ? (
                                <div className="text-[11px] text-rose-400">{sharePop.err}</div>
                              ) : (
                                <>
                                  <div className="flex gap-1.5">
                                    <input readOnly value={sharePop.url} className="flex-1 min-w-0 bg-[#0e0f16] border border-white/10 rounded-md px-2 py-1.5 text-[10px] text-slate-300 outline-none" />
                                    <button onClick={() => copyToClipboard(sharePop.url, 'share')} className="px-2.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px] font-semibold hover:bg-cyan-500/30">{copiedId === 'share' ? t(lang, 'Đã chép') : t(lang, 'Chép')}</button>
                                  </div>
                                  <div className="grid grid-cols-2 gap-1.5 mt-2">
                                    {shareTargets(sharePop.url).map(([n, href]) => (
                                      <a key={n} href={href} target="_blank" rel="noopener noreferrer" className="text-center text-[10.5px] py-1.5 rounded-md border border-white/10 text-slate-300 hover:text-cyan-300 hover:border-cyan-500/40">{n}</a>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {msg.vai_tro === 'user' && (
                    <div className="flex items-center justify-end gap-3 mt-2 text-[11px] text-white/70 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => copyToClipboard(msg.noi_dung, msg.ma_tin_nhan)} className="flex items-center gap-1 hover:text-white transition-colors" title={t(lang, 'tipCopy')}>
                        {copiedId === msg.ma_tin_nhan ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedId === msg.ma_tin_nhan ? t(lang, 'Đã chép') : t(lang, 'Chép')}</span>
                      </button>
                      <button onClick={() => { setInputText?.(msg.noi_dung || ''); taRef.current?.focus(); }} className="flex items-center gap-1 hover:text-white transition-colors" title={t(lang, 'tipEditResend')}>
                        <Pencil size={12} />
                        <span>{t(lang, 'Sửa')}</span>
                      </button>
                    </div>
                  )}
                </div>
                {msg.vai_tro === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-white shrink-0 mt-0.5">
                    {(currentUser?.ten_day_du || 'U')[0].toUpperCase()}
                  </div>
                )}
              </div>
            ))
          )}

          {loading && (
            <div className="flex gap-3 items-center text-slate-400 text-xs">
              <img src="/rexi_cat_icon.png" alt="Rexi" className="rexi-logo rexi-logo-no-glow w-7 h-7 object-contain" />
              <div className="flex items-center gap-1.5 bg-[#1e1f20] px-4 py-2.5 rounded-full border border-white/5">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce"></span>
                <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0.2s]"></span>
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce [animation-delay:0.4s]"></span>
                <span className="ml-2 font-medium">{t(lang, 'Rexi đang phân tích...')}</span>
              </div>
            </div>
          )}

          {/* Scroll buttons — 1 pill nổi giữa, theo theme (không còn 2 cục tròn lạc lõng) */}
          {(showScrollTop || showScrollBottom) && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-30 flex items-center gap-1 p-1 rounded-full bg-[var(--bg-card)]/95 backdrop-blur border border-[var(--border-color)] shadow-lg">
              {showScrollTop && (
                <button onClick={scrollToTopSmooth} title={t(lang, 'tipToTop')} className="w-8 h-8 rounded-full text-[var(--text-sub)] hover:text-cyan-500 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-all">
                  <ArrowUp size={15} />
                </button>
              )}
              {showScrollBottom && (
                <button onClick={scrollToBottomSmooth} title={t(lang, 'tipToLatest')} className="w-8 h-8 rounded-full text-[var(--text-sub)] hover:text-cyan-500 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition-all">
                  <ArrowDown size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Attachment Preview */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-2 bg-[#181920] border border-white/10 rounded-xl mb-2">
          {attachedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-2 bg-white/10 text-cyan-200 px-2 py-1 rounded-md text-xs max-w-[280px]">
              {f.isImage && f.dataUrl
                ? <img src={f.dataUrl} alt="" className="w-8 h-8 rounded object-cover border border-white/10 shrink-0" />
                : <Paperclip size={12} className="shrink-0" />}
              <div className="min-w-0">
                <div className="truncate max-w-[150px] font-medium">{f.name}</div>
                <div className="text-[10px] text-slate-400">
                  {f.isImage ? t(lang, 'ảnh') : f.textContent ? `${Math.round((f.textContent.length || 0) / 1000)}k ${t(lang, 'ký tự')}` : t(lang, 'tệp')}
                  {f.qr && f.qr.length ? t(lang, ' · có QR') : ''}
                </div>
                {f.qr && f.qr.length > 0 && (
                  <div className="text-[10px] text-amber-300 break-all max-w-[210px]">
                    QR: {f.qr.join('  |  ')}
                    {/^(https?:\/\/|www\.)/i.test(f.qr[0] || '') && <span className="text-rose-400">{t(lang, '⚠ link — kiểm tra kỹ')}</span>}
                  </div>
                )}
              </div>
              <button onClick={() => onRemoveFile?.(i)} className="shrink-0 text-slate-400 hover:text-rose-400 transition-colors" title={t(lang, 'tipRemoveFile')}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Voice Recording Indicator */}
      {listening && (
        <div className="mt-2 mb-2 flex items-center gap-3 px-4 py-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 animate-slide-up">
          <span className="relative flex w-3 h-3 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75 animate-ping"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span>
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold text-rose-300 flex items-center gap-1.5"><Mic size={12} /> {t(lang, 'Đang nghe... Hãy nói tiếng Việt')}</p>
            <p className="text-[11px] text-rose-200/70 truncate">
              {voiceTranscript || t(lang, 'Lời nói của bạn sẽ hiện ra ở đây...')}
            </p>
          </div>
          <button
            onClick={startVoice}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[11px] font-semibold hover:bg-rose-500/30 transition-all shrink-0"
          >
            <Square size={11} /> {t(lang, 'stop')}
          </button>
        </div>
      )}

      {/* Input Area */}
      <div className="mt-3 relative z-10">
        <input type="file" ref={fileInputRef} onChange={handleFileSelect} multiple className="hidden" />
        <div className="flex items-center bg-[#181920] border border-white/10 focus-within:border-cyan-500/50 rounded-2xl px-4 py-2.5 shadow-xl transition-colors">
          
          {/* Mode Selector — pill tự giãn chữ, màu theo mode (cyan=Chat / purple=Agent) */}
          <div className="relative mr-2 shrink-0" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setChatModeOpen(!chatModeOpen)}
              aria-haspopup="menu"
              aria-expanded={chatModeOpen}
              className={`flex items-center justify-center gap-1 rounded-xl border px-2 py-1.5 w-[118px] text-[10px] font-bold cursor-pointer select-none transition-all shadow-sm ${
                executionMode === 'agent'
                  ? 'bg-orange-500/10 border-orange-500/30 text-orange-300 hover:border-orange-400/60 hover:bg-orange-500/15'
                  : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-200 hover:border-cyan-400/60 hover:bg-cyan-500/15'
              }`}
            >
              {executionMode === 'agent'
                ? <Zap size={11} className="shrink-0" />
                : <MessageSquare size={11} className="shrink-0" />}
              <span className="whitespace-nowrap">{executionMode === 'agent' ? 'Agent Mode' : 'Chat AI'}</span>
              <ChevronDown size={10} className={`shrink-0 transition-transform duration-200 ${chatModeOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown - absolute, không đẩy elements khác */}
            {chatModeOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setChatModeOpen(false)} />
                <div className="absolute bottom-full left-0 mb-2 w-64 bg-[#141522] border border-white/10 rounded-2xl shadow-2xl p-1.5 z-50">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 px-2.5 pt-1 pb-1.5">{t(lang, 'Chế độ trò chuyện')}</div>

                  <button
                    type="button"
                    onClick={() => { setExecutionMode('chat'); setChatModeOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left cursor-pointer transition-all border ${
                      executionMode !== 'agent' ? 'bg-cyan-500/10 border-cyan-500/30' : 'border-transparent hover:bg-white/5'
                    }`}
                  >
                    <span className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 shrink-0">
                      <MessageSquare size={13} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-bold text-slate-100">Chat AI</span>
                      <span className="block text-[10px] text-slate-400 mt-0.5 leading-tight">{t(lang, 'Trò chuyện AI thông thường')}</span>
                    </span>
                    {executionMode !== 'agent' && <Check size={14} className="text-cyan-300 shrink-0" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => { setExecutionMode('agent'); setChatModeOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-2 py-2 mt-1 rounded-xl text-left cursor-pointer transition-all border ${
                      executionMode === 'agent' ? 'bg-orange-500/10 border-orange-500/30' : 'border-transparent hover:bg-white/5'
                    }`}
                  >
                    <span className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/25 text-orange-300 shrink-0">
                      <Zap size={13} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-bold text-slate-100">Agent Mode</span>
                      <span className="block text-[10px] text-slate-400 mt-0.5 leading-tight">{t(lang, 'Tự động thực thi code & tác vụ')}</span>
                    </span>
                    {executionMode === 'agent' && <Check size={14} className="text-orange-300 shrink-0" />}
                  </button>

                  {executionMode === 'agent' && (
                    <div className="mt-2 pt-1.5 border-t border-white/10">
                      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 px-2.5 pb-1">{t(lang, 'Engine xử lý')}</div>

                      <button
                        type="button"
                        onClick={() => { setAgentEngine('auto'); setChatModeOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl text-left cursor-pointer transition-all border ${
                          agentEngine === 'auto' ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5'
                        }`}
                      >
                        <span className="p-1 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 shrink-0">
                          <Bot size={12} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] font-bold text-slate-200">{t(lang, 'Auto (tự chọn engine)')}</span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight">{t(lang, 'Task ngắn → DSH nhanh, task dài → OpenCode')}</span>
                        </span>
                        {agentEngine === 'auto' && <Check size={13} className="text-emerald-400 shrink-0" />}
                      </button>

                      <button
                        type="button"
                        onClick={() => { setAgentEngine('opencode'); setChatModeOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-2 py-1.5 mt-0.5 rounded-xl text-left cursor-pointer transition-all border ${
                          agentEngine === 'opencode' ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5'
                        }`}
                      >
                        <span className="p-1 rounded-lg bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 shrink-0">
                          <Rocket size={12} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] font-bold text-slate-200">OpenCode</span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight">{t(lang, 'Nhiều model, ổn định (mặc định)')}</span>
                        </span>
                        {agentEngine === 'opencode' && <Check size={13} className="text-cyan-400 shrink-0" />}
                      </button>

                      <button
                        type="button"
                        onClick={() => { setAgentEngine('dsh'); setChatModeOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-2 py-1.5 mt-0.5 rounded-xl text-left cursor-pointer transition-all border ${
                          agentEngine === 'dsh' ? 'bg-white/5 border-white/10' : 'border-transparent hover:bg-white/5'
                        }`}
                      >
                        <span className="p-1 rounded-lg bg-orange-500/10 border border-orange-500/25 text-orange-300 shrink-0">
                          <Zap size={12} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] font-bold text-slate-200">DeepSeek Harness</span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight">{t(lang, 'Nhanh hơn ~30% (thử nghiệm — server cloud tự chạy Agent nội bộ)')}</span>
                        </span>
                        {agentEngine === 'dsh' && <Check size={13} className="text-orange-400 shrink-0" />}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <textarea
            ref={taRef}
            value={inputText}
            onChange={e => { setInputText(e.target.value); autoGrow(); }}
            onPaste={e => {
              const dt = e.clipboardData;
              if (!dt) return;
              const raw = [];
              if (dt.files && dt.files.length) { for (const f of dt.files) raw.push(f); }
              else if (dt.items) { for (const it of dt.items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) raw.push(f); } } }
              if (!raw.length) return;
              e.preventDefault();
              const stamp = Date.now();
              const named = raw.map((f, i) => f.name ? f : new File([f], 'pasted-' + stamp + (i ? '-' + i : '') + '.' + ((f.type || 'image/png').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, ''), { type: f.type || 'image/png' }));
              handleFileSelect && handleFileSelect({ target: { files: named } });
            }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); setTimeout(autoGrow, 0); } }}
            placeholder={lang === 'en' ? "Type your question here and press Enter — e.g. 'Write me a video script...'" : "Gõ câu hỏi ở đây rồi bấm Enter — VD: 'Soạn giúp tôi kịch bản video...'"}
            rows={1}
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none resize-none max-h-32 px-2 py-1.5 leading-6"
          />

          <button onClick={() => fileInputRef.current?.click()} className="p-2 rounded-lg text-slate-400 hover:text-cyan-400 hover:bg-white/5 transition-all" title={t(lang, 'tipAttach')}>
            <Paperclip size={16} />
          </button>

          <button
            onClick={hasSendText ? () => handleSendMessage() : startVoice}
            disabled={hasSendText && loading}
            title={hasSendText ? (lang === 'vi' ? 'Gửi tin nhắn' : 'Send message') : t(lang, 'voiceInput')}
            className={`ml-1.5 p-2.5 rounded-xl transition-all shrink-0 ${
              hasSendText
                ? 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 text-white shadow-md'
                : listening
                  ? 'text-rose-400 bg-rose-500/15 animate-pulse'
                  : 'text-slate-400 hover:text-cyan-400 hover:bg-white/5'
            }`}
          >
            {hasSendText ? <Send size={16} /> : <Mic size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

