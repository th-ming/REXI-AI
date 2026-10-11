/**
 * API Configuration — single source of truth
 * 
 * All API calls use the '/api' prefix which works in both:
 * - Development: Vite proxy forwards /api/* → http://localhost:5000
 * - Production: Backend serves frontend from dist/ and handles /api/* directly
 */

export const API_BASE = '/api';

/**
 * Dịch message lỗi từ backend (mặc định tiếng Việt) sang EN khi UI đang chế độ English.
 * Gọi tập trung trong apiFetch/apiFetchPublic nên mọi call site đều được phủ.
 */
const BACKEND_EN = {
  'Yêu cầu đăng nhập.': 'Please sign in.',
  'ID không hợp lệ': 'Invalid ID',
  'Không có quyền truy cập cuộc hội thoại này.': 'You do not have access to this conversation.',
  'URL/ID video không hợp lệ (chỉ hỗ trợ YouTube).': 'Invalid video URL/ID (YouTube only).',
  'URL/ID video không hợp lệ.': 'Invalid video URL/ID.',
  'Cần nhập tên kênh và URL': 'Channel name and URL are required.',
  'Kênh với URL này đã tồn tại': 'A channel with this URL already exists.',
  'Không tìm thấy kênh': 'Channel not found.',
  'Thiếu message': 'Missing message.',
  'Thiếu URL': 'Missing URL.',
  'Thiếu HTML': 'Missing HTML.',
  'Tài khoản hoặc mật khẩu không đúng.': 'Incorrect email or password.',
  'Credential Google không hợp lệ.': 'Invalid Google credentials.',
  'Không tìm thấy cuộc hội thoại.': 'Conversation not found.',
  'Không có quyền ghim cuộc hội thoại này.': 'You cannot pin this conversation.',
  'Không tìm thấy model nào từ link API này.': 'No models found at this API link.',
  'Lỗi quét model: ': 'Model scan error: ',
  'Không tìm thấy mẫu giọng.': 'Voice sample not found.',
  'VieNeu clone trả audio rỗng': 'VieNeu returned empty audio.',
  'Bình luận trống.': 'Comment is empty.',
  'Path không hợp lệ (path traversal detected)': 'Invalid path (path traversal detected).',
  'Lỗi CSDL': 'Database error.',
  'Tài khoản của bạn đã bị khoá.': 'Your account has been locked.',
  'Phiên đã đăng xuất trên thiết bị này.': 'This device has been signed out.',
  'Token không hợp lệ hoặc đã hết hạn.': 'Invalid or expired token.',
  'Bạn không có quyền thực hiện hành động này.': 'You do not have permission for this action.',
  'Hoạt động tốt': 'OK',
  'worker lỗi': 'worker error',
  'lỗi ingest': 'ingest error',
  'lỗi': 'error',
};
const BACKEND_EN_PREFIX = [
  ['Bạn đã dùng hết 10 tin nhắn', 'You have used all 10 guest messages. Please sign in to keep chatting.'],
  ['Bạn đã hết lượt chat', 'You have used all 10 guest messages. Please sign in to keep chatting.'],
  ['Bạn đã dùng hết 3 ', 'You have used all 3 guest Agent turns. Please sign in for unlimited Agent Mode.'],
  ['Bạn đã hết lượt Agent', 'You have used all 3 guest Agent turns. Please sign in for unlimited Agent Mode.'],
  ['Quá nhiều yêu cầu', 'Too many requests in a short time (rate limit). Please wait a minute.'],
  ['Chưa có dữ liệu scan', 'No scan data yet. Press "Scan channels" to start.'],
];

export function backendMsg(msg) {
  if (!msg || typeof window === 'undefined') return msg;
  let lang = 'vi';
  try { lang = localStorage.getItem('rexi_lang') || 'vi'; } catch (e) { /* ignore */ }
  if (lang !== 'en') return msg;
  if (BACKEND_EN[msg]) return BACKEND_EN[msg];
  for (const [p, e] of BACKEND_EN_PREFIX) if (msg.startsWith(p)) return e;
  return msg;
}


/**
 * OpenCut editor URL — mặc định dùng bản cloud chính thức (opencut.app).
 * Override bằng env VITE_OPENCUT_URL (vd trỏ về instance self-host hoặc localhost:3000).
 */
export const OPENCUT_URL = import.meta.env.VITE_OPENCUT_URL || 'https://opencut.app/projects';

/**
 * Centralized fetch wrapper with auth token support.
 * 
 * @param {string} path - API endpoint path (without /api prefix), e.g. '/auth/users'
 * @param {string|null} token - Bearer token for authentication
 * @param {RequestInit} options - Additional fetch options
 * @returns {Promise<any>} Parsed JSON response
 */
export async function apiFetch(path, token, options = {}) {
  // Hỗ trợ cả 2 cách gọi: apiFetch(path, options) và apiFetch(path, token, options)
  if (typeof token === 'object' && token !== null) {
    options = token;
    token = null;
  }
  // Tự động lấy token từ localStorage nếu không truyền (fix: trước đây gọi apiFetch(path, {headers}) sai signature)
  if (!token && typeof localStorage !== 'undefined') {
    token = localStorage.getItem('rexi_token');
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Token hết hạn / không hợp lệ → báo app mở lại màn hình đăng nhập (thay vì chết lặng)
    if (res.status === 401 && token && (data.code === 'INVALID_TOKEN' || data.code === 'LOGIN_REQUIRED')) {
      try {
        window.dispatchEvent(new CustomEvent('rexi_session_expired', { detail: data.error }));
      } catch (e) { console.warn('[rexi] session_expired dispatch failed', e); }
    }
    const err = new Error(backendMsg(data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Lightweight fetch wrapper WITHOUT token (for public endpoints).
 * 
 * @param {string} path - API endpoint path (without /api prefix)
 * @param {RequestInit} options - Additional fetch options
 * @returns {Promise<any>} Parsed JSON response
 */
export async function apiFetchPublic(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(backendMsg(data.error) || `HTTP ${res.status}`);
  return data;
}
// Dịch error/message từ backend cho MỌI raw fetch site (51 chỗ) — patch 1 lần, phủ toàn app.
;(function patchFetchForI18n() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.__rexiI18nFetch) return;
  const orig = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await orig(...args);
    const origJson = res.json.bind(res);
    res.json = async function () {
      const data = await origJson();
      try {
        if (data && typeof data === 'object') {
          if (typeof data.error === 'string') data.error = backendMsg(data.error);
          if (typeof data.message === 'string' && !/^[a-z_]+$/.test(data.message)) data.message = backendMsg(data.message);
        }
      } catch (e) { /* ignore */ }
      return data;
    };
    return res;
  };
  window.__rexiI18nFetch = true;
})();
