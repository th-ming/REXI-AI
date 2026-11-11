# ⛔ QUY TẮC GHIM CỨNG — LẬP KẾ HOẠCH TRƯỚC KHI LÀM (ÁP DỤNG 100%, MỌI SESSION)

> **BẮT BUỘC TUYỆT ĐỐI, KHÔNG NGOẠI LỆ**: Trước khi THỰC THI bất kỳ yêu cầu nào của User — bất kể việc gì (sửa code, deploy, tạo file, chạy lệnh, research, fix bug, đổi config...), dù lớn hay nhỏ — Agent PHẢI gọi `todowrite` lập kế hoạch (danh sách todo từng bước) TRƯỚC, rồi mới được gọi tool khác để làm.
> - Không todowrite trước = vi phạm quy trình, làm sai quy trình dù kết quả đúng cũng tính FAIL.
> - Việc 1 bước nhỏ nhất cũng phải có todo (tối thiểu 1-2 item: "làm X" + "verify X").
> - Trong lúc làm: cập nhật trạng thái todo (`in_progress` → `completed`) theo thời gian thực, không batch cuối.
> - Nếu giữa chừng phát hiện việc mới → bổ sung vào todo list, không làm ngoài kế hoạch lặng lẽ.
> - Quy tắc này ĐÈ LÊN mọi quy định khác về quy trình. Đọc file này là phải tuân thủ ngay từ message đầu tiên.

# QUY ĐỊNH TỰ KIỂM TRA VÀ XÁC MINH BẰNG CHỨNG THỰC TẾ (STRICT SELF-VERIFICATION & PROOF RULE)

# 🔑 TÀI KHOẢN & API KEY CÓ SẴN TRONG DATABASE (KHÔNG CẦN TẠO MỚI)

> Đã test đăng nhập thật ngày 10/08/2026 — dùng các tài khoản này để test, đừng tạo user mới mỗi lần.

## Tài khoản Admin (đã xác minh đăng nhập ✅)
- **`admin` / `admin123`** → role **admin** ✅
- **`admin@rexi.com` / `admin123`** → role **admin** ✅ (fallback seed trong ensure-admin.js)

## Cách lấy token nhanh (test API)
```bash
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login   -H 'Content-Type: application/json'   -d '{"email":"admin","password":"admin123"}' | python -c "import json,sys; print(json.load(sys.stdin)['token'])")
# Sau đó: curl -H "Authorization: Bearer $TOKEN" ...
```

## API Keys đã lưu trong bảng `khoa_api` (DB: D:/Rexi AI/Database/tro_ly_ai.db)
Gemini · Groq · NVIDIA · Cerebras · Cohere · OpenRouter · Mistral · OpenCode · GitHub
→ 109 model active (gemini 13, mistral 32, nvidia 25, groq 11, openrouter 11, cohere 6, cerebras 3, opencode 8)
→ Backend tự đọc/giải mã keys này (AES-256-GCM, xem src/utils/cryptoKeys.js) — agent KHÔNG cần lấy key thủ công.

## Ghi chú
- User thường trong DB (test@rexi.ai, test@test.com...) KHÔNG có password mặc định — không dùng được login, đừng phí thời gian thử.
- Guest: email `guest@rexi.ai`, dùng không cần mật khẩu (chế độ khách tự động).
- File seed admin: `D:/Rexi AI/Database/admin-seed.js` + `Backend/src/ensure-admin.js`.

---
## 1. NGUYÊN TẮC CỐT LÕI
- **Mọi kết quả công việc phải có minh chứng thực tế rõ ràng**: Không bao giờ được phép tuyên bố hoàn thành task, sửa lỗi thành công hay thay đổi UI/UX nếu chưa tự mình chạy lệnh kiểm thử (build, test, log, screenshot) và xác minh kết quả.
- **Tự động lặp lại (Self-Correction Loop)**: Nếu kết quả tự kiểm tra phát hiện lỗi (UI hỏng, lệnh build fail, trắng trang, runtime error), Agent BẮT BUỘC phải tự động phân tích nguyên nhân và thực hiện lại cho đến khi CHÍNH XÁC 100% thì mới báo lại cho User.

## 2. QUY TRÌNH THỰC THI BẮT BUỘC FOR AGENT
1. **Thực thi thay đổi**: Sửa code hoặc thực hiện thao tác.
2. **Tự nghiệm thu (Self-Verification)**:
   - Chạy lệnh build/test (VD: `npm run build`, `node ...`) để đảm bảo không rách JSX, không lỗi cú pháp.
   - Kiểm tra log lỗi chi tiết nếu có bất kỳ cảnh báo runtime nào.
3. **Đánh giá khách quan (Self-Assessment)**:
   - Tự hỏi: *"Kết quả hiện tại đã đúng 100% so với yêu cầu của User chưa? Màn hình có bị hỏng hay trắng trang không?"*
   - Nếu chưa đúng hoặc phát hiện bất thường -> **TỰ ĐỘNG SỬA LẠI NGAY** (Lặp lại bước 1-3).
4. **Cung cấp minh chứng (Proof & Evidence)**:
   - Trả lời User kèm theo bằng chứng cụ thể: Kết quả terminal build thành công, chi tiết thay đổi hoặc mô tả kết quả tự kiểm tra.

---

# ⛔ LUẬT GHIM CỨNG — CẤM CHẠY LOCAL, MỌI THỨ PHẢI CHẠY TRÊN CLOUD (user chốt 11/11/2026)

> **BẮT BUỘC TUYỆT ĐỐI, KHÔNG NGOẠI LỆ.** Mọi thành phần của sản phẩm KHÔNG được phụ thuộc máy local của User để chạy.

- **CẤM**: server/model chạy trên máy user (vd `tools/VieNeu-TTS` port 8000), **cloudflared quick tunnel** (`.trycloudflare.com`) trỏ về máy user, watchdog/tunnel-manager/daemon trên máy user, dùng `localhost`/`127.0.0.1`/quick tunnel làm backend prod.
- **LÝ DO**: máy tắt/ngủ/mạng lag → production chết; quick tunnel đổi URL mỗi restart, không SLA (TTS vieNeu prod đã sập 11/11 vì lý do này).
- **BẮT BUỘC**: mọi service (kể cả TTS) chạy trên cloud có SLA (Render / HuggingFace Spaces / API cloud). Engine không chạy nổi trên cloud free → chọn phương án cloud khác (HF Space, API hosted) hoặc BỎ engine đó — **TUYỆT ĐỐI KHÔNG fallback về local**.
- Khi thêm/sửa tính năng: tự hỏi "cái này có phụ thuộc máy local không?" → nếu có thì thiết kế lại cho cloud.
- Vi phạm = lỗi nghiêm trọng (FAIL).
