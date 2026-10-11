import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminPanel from './AdminPanel.jsx'
import { tx } from './i18n-sweep';
import { getLang } from './i18n';

const isAdmin = window.location.pathname === '/admin';

// STALE-BUNDLE GUARD: so hash asset trong HTML server trả về với bundle đang chạy.
// Khác → tab đang giữ bundle cũ trong RAM → tự reload 1 lần (khi tab ẩn để không
// cắt ngang thao tác của user). Sau khi reload, bundle mới sẽ pass → xóa flag,
// lần deploy sau check lại từ đầu.
(function staleBundleGuard() {
  const KEY = 'rexi_stale_reload_at';
  const myAssets = () => [
    ...[...document.querySelectorAll('script[src]')].map(s => s.src.split('/').pop()),
    ...[...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href.split('/').pop()),
  ].filter(a => /^index-[\w-]+\.(js|css)$/.test(a));
  const check = () => {
    fetch('/', { cache: 'no-store' })
      .then(r => r.text())
      .then(html => {
        if (!html.includes('id="root"')) return; // trang lỗi/cold-start → bỏ qua
        const mine = myAssets();
        const stale = mine.length > 0 && !mine.every(a => html.includes(a));
        if (stale) {
          const last = Number(sessionStorage.getItem(KEY) || 0);
          if (!last || Date.now() - last > 60000) {
            sessionStorage.setItem(KEY, String(Date.now()));
            window.location.reload();
          }
        } else {
          try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
        }
      })
      .catch(() => { /* offline/cold start → bỏ qua */ });
  };
  check();
  setInterval(() => {
    if (document.visibilityState === 'hidden') check();
  }, 10 * 60 * 1000);
  // cap nhat ngay khi user quay lai tab — khong phai cho user reload
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
})();

// CLIENT DIAG BEACON: báo cáo build + theme + màu browser đang VẼ thật (computed)
// + probe phát hiện force-dark/darkreader về backend — để biết chính xác user
// đang thấy gì mà không cần screenshot. Gửi 1 lần sau load, lỗi thì im lặng.
(function clientDiag() {
  const send = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = 1; cv.height = 1;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1, 1);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      const paintDark = px[0] < 160; // trắng bị vẽ thành tối → browser ép nền tối
      const darkReader = !!document.querySelector(
        '[data-darkreader-inline-bgcolor],[data-darkreader-inline-border],[data-darkreader-inline-color],style[data-darkreader-mode]'
      );
      const root = document.documentElement;
      const aside = document.querySelector('aside');
      const tile = document.querySelector('[class*="1e1f20"]');
      const body = {
        build: (typeof __BUILD__ !== 'undefined') ? __BUILD__ : '?',
        theme: root.getAttribute('data-theme') || '(none)',
        storedTheme: localStorage.getItem('rexi_theme_v2') || '(none)',
        rootBg: getComputedStyle(root).backgroundColor,
        rootColor: getComputedStyle(document.body).color,
        asideBg: aside ? getComputedStyle(aside).backgroundColor : '',
        tileBg: tile ? getComputedStyle(tile).backgroundColor : '',
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        paintDark, darkReader,
        url: location.href.slice(0, 200),
        ua: navigator.userAgent.slice(0, 300),
        vw: window.innerWidth, vh: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
      };
      fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* không bao giờ làm vỡ app */ }
  };
  if (document.readyState === 'complete') setTimeout(send, 1200);
  else window.addEventListener('load', () => setTimeout(send, 1200));
})();

// Lỗi render không được bắt → thay vì trang trắng, hiện màn hình lỗi thân thiện
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    // TỰ LÀNH: nếu crash do bundle cũ treo trong cache (vd asset hash thay đổi
    // nhưng tab cũ vẫn chạy JS cũ) → reload 1 lần duy nhất để lấy bundle mới.
    try {
      const KEY = 'rexi_crash_reload_once';
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (!last || Date.now() - last > 60000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (e) { /* sessionStorage bị chặn → giữ nút reload thủ công */ }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: '#0b0d12', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif',
          padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 42 }}>⚠️</div>
          <h1 style={{ fontSize: 20, margin: 0 }}>{tx(getLang(), 'Đã xảy ra lỗi hiển thị')}</h1>
          <p style={{ fontSize: 13, color: '#94a3b8', maxWidth: 480, margin: 0 }}>
            {tx(getLang(), 'Giao diện gặp lỗi không mong muốn. Thử tải lại trang — nếu vẫn lỗi, hãy xóa dữ liệu trình duyệt (localStorage) cho trang này rồi thử lại.')}
          </p>
          <pre style={{
            fontSize: 11, color: '#f87171', background: '#16181d',
            padding: 12, borderRadius: 8, maxWidth: 640,
            overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0,
          }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 22px', borderRadius: 12, border: '1px solid #22d3ee66',
              background: '#164e63', color: '#a5f3fc', fontSize: 14,
              fontWeight: 600, cursor: 'pointer',
            }}
          >
            {tx(getLang(), '🔄 Tải lại trang')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      {isAdmin ? <AdminPanel /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
