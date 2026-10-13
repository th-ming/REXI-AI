# Rexi OpenCut Bridge (extension trình duyệt)

Cầu nối để agent Rexi AI điều khiển **tab OpenCut đang mở trên máy bạn**:
extension poll backend mỗi 1.5s (`POST /api/services/opencut-bridge/poll`),
thực thi lệnh (`eval / click / type / text / list / wait / screenshot`) lên tab
`opencut.app` (hoặc `localhost:3000`), rồi trả kết quả (`POST .../result`).
Panel "OpenCut Agent" trong web app hiện **đã nối** khi extension đã poll
trong 8 giây gần nhất.

## Cài (Chrome / Edge / Opera — 1 lần)

1. Mở trang quản lý extension của trình duyệt, bật **Developer mode**:
   - Chrome/Edge: `chrome://extensions` (Edge: `edge://extensions`)
   - Opera: `opera://extensions`
2. Bấm **Load unpacked** → chọn thư mục này (`extension-rexi-opencut-bridge`).
3. Trên web Rexi (VD https://rexiai.bot.cd) **đăng nhập** như bình thường —
   extension tự lấy token từ tab đã đăng nhập, không cần dán tay.
4. Mở tab **https://opencut.app** (giữ tab đó mở).
5. Bấm icon extension → popup hiện `connected: true` và `tab opencut.app: có`.
   Panel "OpenCut Agent" trong app sẽ chuyển sang **đã nối**.

## Cài (Firefox — tạm thời)

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → chọn
`manifest.json` trong thư mục này. (Bản tạm, mất khi restart Firefox.)

## Kiểm tra nhanh

- Popup extension: backend OK + connected true + tab opencut.app: có.
- Trong app: `GET /api/services/opencut-bridge/status` →
  `{"connected":true,"hasTab":true,...}`.
- Panel "OpenCut Agent" → **đã nối**, nút "Giao agent"/"Chụp" chạy được.

## Gỡ lỗi

- `connected: false` → extension chưa poll: kiểm tra đã Load unpacked + bật
  extension chưa, rồi bấm icon extension xem trạng thái.
- `hasTab: false` → chưa mở tab opencut.app (hoặc localhost:3000).
- Token: mặc định tự lấy từ tab Rexi đã đăng nhập; nếu không được, dán JWT
  vào popup (lấy ở DevTools → Application → Local Storage → `rexi_token`).
- Backend khác mặc định: sửa Base trong popup (lần đầu sẽ hỏi quyền host).
