import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminPanel from './AdminPanel.jsx'
import { tx } from './i18n-sweep';
import { getLang } from './i18n';

const isAdmin = window.location.pathname === '/admin';

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
