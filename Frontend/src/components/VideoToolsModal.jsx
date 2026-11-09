import React, { useState } from 'react';
import { t, getLang } from '../i18n';
import { tx } from '../i18n-sweep';
import { X, Play, Volume2, Wifi, ExternalLink, Copy } from 'lucide-react';

const VIDEO_TOOLS = [
  {
    category: 'TTS - Chuyển Đổi Chữ Thành Giọng Nói',
    icon: <Volume2 size={16} className="text-emerald-400" />,
    tools: [
      { name: 'Web Speech API', desc: 'Chạy trong trình duyệt, không cần server', status: 'ready', badge: 'Miễn phí' },
      { name: 'Server edge-tts', desc: 'Giọng Microsoft thật, lấy động từ engine (2 giọng vi-VN + đa ngôn ngữ)', status: 'ready', badge: 'Microsoft' },
      { name: 'Valtec TTS', desc: '74.8M params, chạy CPU, zero-shot cloning', status: 'setup', badge: '360⭐' },
      { name: 'VietVoice-TTS', desc: 'Voice cloning chuyên nghiệp', status: 'setup', badge: '105⭐' },
      { name: 'VietTTS', desc: '8 giọng nổi tiếng (Quynh, Ngọc Nga, Son Tùng...)', status: 'setup', badge: '8 voices' },
      { name: 'NghiTTS', desc: 'Chạy trong browser, không cần server', status: 'setup', badge: '139⭐' },
      { name: 'OmniVoice', desc: '600+ ngôn ngữ, voice cloning nâng cao', status: 'setup', badge: '8k⭐' }
    ]
  },
  {
    category: 'Video - Tạo & Chỉnh Sửa Video',
    icon: <Play size={16} className="text-purple-400" />,
    tools: [
      { name: 'claude-video', desc: 'Tạo video từ text/image, chỉnh sửa, avatar', status: 'ready', badge: 'Integrated' },
      { name: 'OpenCut', desc: 'Open-source CapCut alternative (Web/Desktop/Mobile)', status: 'repo', badge: '30k⭐' },
      { name: 'OpenCut-AI', desc: 'AI video editor: transcribe, edit by text, clone voices', status: 'repo', badge: '160⭐' },
      { name: 'HyperFrames', desc: 'HTML → MP4 video renderer cho agents', status: 'repo', badge: '37k⭐' },
      { name: 'HyperFrames @tailwind', desc: 'Tailwind CSS integration', status: 'repo', badge: '71K⭐' },
      { name: 'HyperFrames @figma', desc: 'Figma integration', status: 'repo', badge: '51K⭐' },
      { name: 'floomhq/opencut', desc: 'Code-driven video production (React + Remotion)', status: 'repo', badge: 'repo' }
    ]
  },
  {
    category: 'IPTV - Truyền Hình & Stream',
    icon: <Wifi size={16} className="text-cyan-400" />,
    tools: [
      { name: 'iptv-channels', desc: '200+ quốc gia, M3U playlists, EPG', status: 'ready', badge: 'Integrated' },
      { name: 'iptv-global', desc: 'Quản lý IPTV toàn cầu, catch-up TV', status: 'ready', badge: 'Integrated' },
      { name: 'iptv (core)', desc: 'Streaming live TV & on-demand over IP', status: 'repo', badge: 'Core' }
    ]
  }
];

export default function VideoToolsModal({ videoToolsOpen, setVideoToolsOpen, API_BASE, authToken, showToast }) {
  const lang = getLang();
  const [copiedLink, setCopiedLink] = useState(null);

  const handleTTSTest = async () => {
    if (!videoToolsOpen) return;
    const testText = getLang() === 'en' ? 'Hello, this is a test voice from Rexi AI.' : 'Xin chào, đây là giọng nói thử nghiệm từ Rexi AI.';
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    try {
      const res = await fetch(`${API_BASE}/services/tts`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ text: testText, voice: 'vi-VN-HoaiMyNeural' })
      });
      const data = await res.json();
      if (data.success && data.audio) {
        const audio = new Audio('data:audio/mp3;base64,' + data.audio);
        audio.play();
        showToast(tx(lang, 'Đang phát giọng nói thử nghiệm!'), 'success');
      } else {
        showToast(data.error || tx(lang, 'TTS server không khả dụng, dùng browser'), 'error');
      }
    } catch (err) {
      showToast(tx(lang, 'Lỗi TTS: ') + err.message, 'error');
    }
  };

  const handleCopyRepo = (repoUrl, name) => {
    navigator.clipboard.writeText(repoUrl).then(() => {
      setCopiedLink(name);
      setTimeout(() => setCopiedLink(null), 2000);
      showToast(getLang() === 'en' ? `${name} copied!` : `${name} đã được sao chép!`, 'success');
    });
  };

  if (!videoToolsOpen) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) setVideoToolsOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
    >
      <div className="bg-[#1a1b24] border border-white/10 rounded-2xl p-6 w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Play size={16} className="text-purple-400" />
            Video & Audio Tools (TTS / Video / IPTV)
          </h2>
          <button
            onClick={() => setVideoToolsOpen(false)}
            className="p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        {VIDEO_TOOLS.map((group, gi) => (
          <div key={gi} className="mb-5">
            <div className="flex items-center gap-2 mb-3 pb-1 border-b border-white/5">
              {group.icon}
              <h3 className="text-xs font-bold text-slate-300">{tx(lang, group.category)}</h3>
            </div>

            <div className="grid gap-2.5">
              {group.tools.map((tool, ti) => (
                <div
                  key={ti}
                  className="p-3 bg-[#0d0e11] rounded-xl border border-white/5 hover:border-cyan-500/20 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-200 truncate">{tool.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                          tool.status === 'ready'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : tool.status === 'setup'
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-slate-500/20 text-slate-400'
                        }`}>
                          {tx(lang, tool.badge)}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">{tx(lang, tool.desc)}</p>
                    </div>

                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      {tool.status === 'ready' && tool.name === 'Server edge-tts' && (
                        <button
                          onClick={handleTTSTest}
                          className="p-1 rounded-lg bg-cyan-500/20 text-cyan-300 hover:text-cyan-200 hover:bg-cyan-500/30 transition-all"
                          title={t(lang, 'tipTryVoice')}
                        >
                          <Play size={12} />
                        </button>
                      )}
                      {tool.status === 'repo' && (
                        <button
                          onClick={() => handleCopyRepo(`https://github.com/${tool.name.split(' ')[0].toLowerCase()}`, tool.name)}
                          className="p-1 rounded-lg bg-slate-500/20 text-slate-400 hover:text-white hover:bg-slate-500/30 transition-all"
                          title={t(lang, 'tipCopyRepo')}
                        >
                          {copiedLink === tool.name ? <Copy size={11} className="text-emerald-400" /> : <ExternalLink size={11} />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-4 pt-3 border-t border-white/5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>Server TTS: edge-tts | Browser: Web Speech API | Repo: GitHub</span>
          <button
            onClick={handleTTSTest}
            className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/[0.08] transition-colors text-xs font-medium"
          >
            Test Server TTS
          </button>
        </div>
      </div>
    </div>
  );
}
