import React, { useState } from 'react';
import { t, getLang } from '../i18n';
import { X, BookOpen, ChevronDown, Mic, Video, Tv, Monitor, FolderOpen, Zap, MessageSquare, Sparkles, Clapperboard, MonitorPlay, Scissors } from 'lucide-react';

const SECTIONS = [
  {
    id: 'chat',
    icon: <MessageSquare size={16} className="text-cyan-400" />,
    title: 'Chat AI',
    steps: [
      'Gõ câu hỏi vào ô chat ở giữa màn hình, rồi bấm Enter (hoặc nút gửi ➤) để gửi.',
      'Muốn đổi "bộ não" AI (Gemini, Claude, DeepSeek...): bấm ô chọn model ở góc trên bên trái.',
      'Bấm "Cuộc Trò Chuyện Mới" ở sidebar trái để mở hội thoại khác.',
      'Bấm 📤 Markdown trên header để xuất toàn bộ lịch sử chat thành file .md.'
    ]
  },
  {
    id: 'agent',
    icon: <Zap size={16} className="text-purple-400" />,
    title: 'Agent Mode (AI tự làm việc)',
    steps: [
      'Ở ô nhập chat, bấm nút "💬 Chat AI" → chọn "⚡ Agent Mode".',
      'Agent Mode cho phép AI tự chạy code, đọc file, làm tác vụ thay bạn.',
      'Chế độ khách (chưa đăng nhập) dùng được 3 lượt. Đăng nhập để dùng không giới hạn.'
    ]
  },
  {
    id: 'voice',
    icon: <Mic size={16} className="text-rose-400" />,
    title: '🎙️ Giọng Nói (Voice)',
    steps: [
      '📝 Nói thành chữ: bấm icon 🎤 cạnh ô chat → nói tiếng Việt → chữ tự điền vào ô chat. Bấm lại 🎤 (hoặc "Dừng") để kết thúc.',
      '🔊 Đọc to câu trả lời: dưới mỗi tin nhắn của Rexi có nút "Đọc" — bấm để Rexi đọc to, bấm lại để dừng.',
      '💾 Muốn TẠO FILE MP3: vào tab "TTS Studio" (menu tròn góc phải) → nhập chữ → chọn giọng → bấm "Chuyển Thành Giọng Nói" → bấm nút tải ⬇️ để lưu file về máy.',
      'ℹ️ File audio được tạo ngay trên máy bạn — không lưu trên server. Giọng nói ghi bằng 🎤 chỉ là chuyển chữ, không lưu file âm thanh.'
    ]
  },
  {
    id: 'video',
    icon: <Video size={16} className="text-purple-400" />,
    title: '🎬 Video Creator (tạo video)',
    steps: [
      'Vào tab "Video Creator" trong menu tròn góc phải màn hình.',
      'Dùng chế độ "⚡ Tạo Nhanh" (mặc định): ① Chọn mẫu có sẵn → ② Điền chữ vào các ô → ③ Bấm nút "Render MP4" → ④ Chờ 30-60 giây → ⑤ Bấm "Tải MP4" để lưu về máy.',
      'Muốn chỉnh sâu hơn: chuyển sang "🛠️ HTML Nâng Cao" để tự viết HTML (dành cho người biết code).',
      'Video render cần Backend đang chạy (node server.js).'
    ]
  },
  {
    id: 'opencut',
    icon: <Clapperboard size={16} className="text-sky-400" />,
    title: '🎬 OpenCut Editor (dựng video chuyên sâu)',
    steps: [
      'Vào tab "OpenCut Editor" trong menu tròn góc phải màn hình (nhóm 🎨 Sáng Tạo).',
      'Bấm nút ✚ (FAB) góc phải → chọn "OpenCut Editor" để mở editor dựng video chuyên sâu.',
      'OpenCut chạy như một app riêng (iframe): mặc định trỏ http://localhost:3000 — cần chạy server OpenCut trước (cd D:/repos/OpenCut/apps/web && bun dev).',
      'Có thể đổi URL server trong thanh nhập trên đầu tab, hoặc bấm ⧉ để mở tab mới của trình duyệt.'
    ]
  },
  {
    id: 'openshorts',
    icon: <Scissors size={16} className="text-orange-400" />,
    title: '✂️ OpenShorts (video dài → Shorts)',
    steps: [
      'Vào tab "OpenShorts" trong menu tròn góc phải (nhóm 🎨 Sáng Tạo).',
      'Dán URL video YouTube (podcast, livestream, phỏng vấn — video ≥ 45 giây) rồi bấm "Tạo Shorts".',
      'Chờ ~1-2 phút: OpenShorts tải video, chép lời, tìm khoảnh khắc viral rồi cắt clip dọc 9:16 kèm phụ đề và hook.',
      'Xem preview từng clip ngay trong tab, bấm "Tải MP4" để lưu, hoặc copy caption TikTok bằng icon 📋.',
      'Quota free 20 phút video/tháng (hiển thị ở thanh trên). Server cắt bằng GPU nên ~50 giây/video.'
    ]
  },
  {
    id: 'youtube',
    icon: <MonitorPlay size={16} className="text-red-400" />,
    title: '🎥 YouTube Free (không quảng cáo)',
    steps: [
      'Vào tab "YouTube Free" trong menu tròn góc phải (nhóm 🎨 Sáng Tạo).',
      'Gõ từ khóa (tên bài hát, phim, bài giảng...) rồi bấm "Tìm" hoặc chọn gợi ý có sẵn.',
      'Bấm vào video bất kỳ để xem — không quảng cáo, không cần đăng nhập Google.',
      'Dùng backend yt-dlp lấy luồng trực tiếp từ YouTube. Cần Backend đang chạy.'
    ]
  },
  {
    id: 'iptv',
    icon: <Tv size={16} className="text-rose-400" />,
    title: '📺 IPTV Xem Truyền Hình',
    steps: [
      'Vào tab "IPTV Truyền Hình" → chọn danh mục (Tin tức, Thể thao...) hoặc chuyển qua tab Quốc Gia.',
      'Bấm vào kênh bất kỳ để xem trực tiếp ngay trong app.',
      'Dùng ô tìm kiếm để tìm kênh nhanh. Cần mạng ổn định để xem mượt.'
    ]
  },
  {
    id: 'desktop',
    icon: <Monitor size={16} className="text-emerald-400" />,
    title: '🖥️ Remote Desktop (điều khiển máy)',
    steps: [
      'Vào tab "Remote Desktop" → bấm "Cập Nhật Màn Hình" để chụp màn hình máy tính.',
      'Bấm trực tiếp lên ảnh để điều khiển chuột từ xa.',
      '⚠️ Chỉ hoạt động khi Backend chạy trên chính máy Windows này (không chạy trên server headless).'
    ]
  },
  {
    id: 'files',
    icon: <FolderOpen size={16} className="text-amber-400" />,
    title: '📁 Files Dự Án (Workspace)',
    steps: [
      'Ở sidebar trái, bấm "Files Dự Án" để mở danh sách file.',
      'Bấm vào file bất kỳ để mở và chỉnh sửa ngay trong tab "Editor & Preview".',
      'Bấm 💾 Save để lưu thay đổi vào đĩa.'
    ]
  },
  {
    id: 'tools',
    icon: <Sparkles size={16} className="text-amber-400" />,
    title: '⚙️ Super Tools & Skills',
    steps: [
      'Super Tools: bấm nút vàng "Super Tools" ở sidebar → Terminal Exec (chạy lệnh), Git (trạng thái dự án), Memory (dạy AI nhớ thông tin của bạn).',
      '35+ Skills: bấm nút tím "35+ Skills" ở sidebar để xem kho kỹ năng AI (viết văn bản, tạo slide, phân tích...).',
      'Một số Skills có thể yêu cầu đăng nhập hoặc cấu hình API Key trong ⚙️ Cài Đặt.'
    ]
  }
];

export default function HelpModal({ helpOpen, setHelpOpen }) {
  const [openSection, setOpenSection] = useState('voice');
  const [activeTab, setActiveTab] = useState('guide'); // 'guide' | 'faq'

  if (!helpOpen) return null;

  const FAQS = [
    { q: 'Màn hình trắng khi mở app?', a: 'Bấm F12 → tab Console xem lỗi đỏ. Thường do thiếu icon import (lỗi "X is not defined") hoặc Backend chưa chạy. Thử: chạy lại `npm run dev` ở Frontend và `node server.js` ở Backend.' },
    { q: 'Không gửi được tin nhắn, báo lỗi server?', a: 'Kiểm tra Backend đã chạy chưa (cửa sổ CMD hiện "Rexi AI Backend đang chạy tại http://localhost:5000"). Vào ⚙️ Cài Đặt để kiểm tra API Key.' },
    { q: 'File audio TTS tải về ở đâu?', a: 'Sau khi bấm "Chuyển Thành Giọng Nói" ở TTS Studio, bấm nút tải ⬇️ — file MP3 sẽ lưu vào thư mục "Tải xuống" (Downloads) của máy bạn.' },
    { q: 'Chế độ khách bị giới hạn?', a: 'Chưa đăng nhập: 10 tin nhắn chat + 3 lượt Agent. Đăng nhập (nút "Đăng nhập" góc dưới sidebar) để dùng không giới hạn.' }
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{backgroundColor:'rgba(0,0,0,.10)', transition:'background-color .2s'}} onClick={() => setHelpOpen(false)}>
      <div className="rexi-lightfix bg-white border border-slate-200 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--accent)] flex items-center justify-center">
              <BookOpen size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-800">{t(getLang(), 'Trung Tâm Trợ Giúp')}</h2>
              <p className="text-[10px] text-slate-500">{t(getLang(), 'Hướng dẫn sử dụng Rexi AI từ A đến Z')}</p>
            </div>
          </div>
          <button onClick={() => setHelpOpen(false)} className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3">
          <button
            onClick={() => setActiveTab('guide')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'guide' ? 'bg-cyan-50 text-cyan-600 border border-cyan-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
          >
            📖 {t(getLang(), 'Hướng dẫn tính năng')}
          </button>
          <button
            onClick={() => setActiveTab('faq')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'faq' ? 'bg-cyan-50 text-cyan-600 border border-cyan-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
          >
            ❓ {t(getLang(), 'Câu hỏi thường gặp')}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'guide' ? (
            <div className="space-y-2">
              {SECTIONS.map(section => (
                <div key={section.id} className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                  <button
                    onClick={() => setOpenSection(openSection === section.id ? '' : section.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-100 transition-colors"
                  >
                    <span className="shrink-0">{section.icon}</span>
                    <span className="flex-1 text-xs font-bold text-slate-700">{t(getLang(), section.title)}</span>
                    <ChevronDown size={14} className={`text-slate-400 transition-transform ${openSection === section.id ? 'rotate-180' : ''}`} />
                  </button>
                  {openSection === section.id && (
                    <div className="px-4 pb-4 pt-1 space-y-2">
                      {section.steps.map((step, i) => (
                        <div key={i} className="flex gap-2.5 text-[11px] text-slate-600 leading-relaxed">
                          <span className="shrink-0 w-4 h-4 rounded-full bg-cyan-100 text-cyan-600 text-[9px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                          <span>{t(getLang(), step)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {FAQS.map((faq, i) => (
                <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-bold text-slate-700 mb-1.5">❓ {t(getLang(), faq.q)}</p>
                  <p className="text-[11px] text-slate-600 leading-relaxed">{t(getLang(), faq.a)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between bg-white">
          <p className="text-[10px] text-slate-500">{t(getLang(), 'Vẫn thắc mắc? Gõ câu hỏi vào chat, Rexi AI sẽ hướng dẫn bạn.')}</p>
          <button
            onClick={() => setHelpOpen(false)}
            className="px-4 py-1.5 rounded-lg bg-cyan-50 border border-cyan-200 text-cyan-600 text-xs font-medium hover:bg-cyan-100 transition-colors"
          >
            {t(getLang(), 'Đã hiểu 👍')}
          </button>
        </div>
      </div>
    </div>
  );
}
