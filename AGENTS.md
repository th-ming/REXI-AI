# AGENTS — dự án REXI-AI (`D:\Rexi AI`)

> Luật riêng của dự án, nạp tự động khi session chạy với cwd = `D:\Rexi AI`.
> Luật universal (memory, phong cách, Render safety, tự làm hết...) nằm ở global `~/.config/opencode/AGENTS.md` — không lặp lại.

## ⛔ LUẬT GHIM CỨNG #1 — CẤM CHẠY LOCAL, MỌI THỨ PHẢI CHẠY TRÊN CLOUD (user chốt 11/11/2026)

**NGHIÊM CẤM** mọi thành phần của sản phẩm phụ thuộc vào **máy local của user** để chạy. Cụ thể cấm:

- Server/model chạy trên máy user (vd `tools/VieNeu-TTS` port 8000).
- **cloudflared quick tunnel** (`.trycloudflare.com`) trỏ về máy user.
- Mọi watchdog / tunnel-manager / daemon trên máy user để giữ service sống.
- Dùng `localhost` / `127.0.0.1` / quick tunnel làm backend cho tính năng production.

**Lý do:** máy user tắt / ngủ / mạng lag → production chết; quick tunnel đổi URL mỗi lần restart, không SLA (đã xảy ra: TTS vieNeu prod sập 11/11 vì server local treo + tunnel chết).

**Bắt buộc:**
- Mọi service (kể cả TTS) chạy trên hạ tầng **cloud có SLA**: Render / HuggingFace Spaces / API cloud.
- Engine nào không chạy nổi trên cloud free (model nặng) → chọn phương án cloud khác (**HF Space, API hosted**) hoặc **bỏ engine đó**. **TUYỆT ĐỐI KHÔNG fallback về local.**
- Khi thêm/sửa tính năng: tự kiểm "cái này có đang phụ thuộc máy local không?" → nếu có thì thiết kế lại cho cloud.

Vi phạm luật này = lỗi nghiêm trọng.

## 🧠 BỘ NHỚ DỰ ÁN — TTS VIENEU (đọc trước khi đụng vào TTS)

> Mục đích: sau này agent tự biết TTS của dự án là gì, chạy ở đâu, gọi thế nào — khỏi mò lại.

**VieNeu-TTS là gì:** engine TTS tiếng Việt **miễn phí**, `vieneu` v3.8.3, model `pnnbao-ump/VieNeu-TTS-v3-Turbo` (ONNX/CPU, torch-free, ~595MB), **25 preset giọng Việt + clone giọng**. API **OpenAI-compatible**.

**Hợp đồng API (engine phải phơi ra đúng cái này):**
- `GET /health` → `{ ok: true }`
- `GET /v1/voices` → `{ object:"list", data:[{id,name}] }`
- `POST /v1/audio/speech` — body `{ model, voice, input, response_format:"wav" }` → WAV binary
- `POST /v1/clone` — multipart `file` + `text` (+`ref_text?`) → WAV giọng clone

**Backend Rexi gọi qua đâu:** env `VIENEU_BASE_URL` trên Render service `rexi-ai-backend` (`srv-davqgebtqb8s73de1m00`). Có env này thì:
- `GET /api/services/tts/voices` → trả 25 giọng (`engine:"vieneu"`, `voice_clone:true`)
- `POST /api/services/tts` → ưu tiên VieNeu; nhận `engine:"vieneu"|"edge-tts"` để buộc; **fallback Edge khi VieNeu chết**
- `POST /api/services/tts/clone` → forward `/v1/clone` → WAV base64
- Route code: `Backend/src/routes/services.routes.js` (L478, L625, L687, L740, L958).

**Lịch sử (tại sao từng chạy local):**
- Nhóm đã **build sẵn bản HuggingFace Space** cho VieNeu: `D:\backups\repos-rescue\VieNeu-TTS\space\` (`app.py` + `Dockerfile` Docker SDK, `app_port: 7860`, 16GB RAM).
- Nhưng lại **deploy bằng local + cloudflared quick tunnel** (server `D:\Rexi AI\tools\VieNeu-TTS` port 8000, `tools/tunnel-manager.ps1`, task `RexiTunnels`, watchdog `RexiVieNeuWatchdog`), vì `AUDIT-2026-09-20.md` chốt *"Render free không chạy nổi model"*.
- **Sự cố 11/11/2026:** server local treo + tunnel chết + Render `VIENEU_BASE_URL` trỏ tunnel cũ → **TTS prod sập**.

**QUYẾT ĐỊNH 11/11/2026 (user chốt):** bỏ hẳn local → **deploy VieNeu lên HuggingFace Space** → đặt `VIENEU_BASE_URL` = URL Space → **gỡ sạch local** (kill server 8000, cloudflared, watchdog, task). Theo luật #1 (cấm chạy local).

**Dọn local khi xong (danh sách):** `tools/VieNeu-TTS` (port 8000), `tools/tunnel-manager.ps1`, task `RexiTunnels` + `RexiVieNeuWatchdog`, cloudflared :8000.

## Ghi chú nền (2026-11-11)

- `.gitignore` dòng `tools/VieNeu-TTS/` → tool local KHÔNG nằm trong repo (đúng tinh thần luật #1).
- Bản đồ kiến trúc: xem `STRUCTURE.md` / `docs/map.html` (luật global #19).
- Luật bổ sung (plan-first, self-verify) giữ nguyên trong `.agents/AGENTS.md`.
