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
- Nguồn chính của mọi service (kể cả TTS) phải là **hạ tầng cloud có SLA**: Render / GH Actions runner / HuggingFace Spaces / API cloud. Production KHÔNG được BẮT BUỘC phụ thuộc máy user.
- Engine nào không chạy nổi trên cloud free (model nặng) → chọn phương án cloud khác (**GH Actions runner, HF Space, API hosted**) hoặc **bỏ engine đó**.
- Ngoại lệ do user chốt 11/11: local server + tunnel-manager được GIỮ chạy làm **fallback**, nhưng phải luôn có nguồn cloud đứng trước (vd TTS: `VIENEU_BASE_URL_CLOUD` ưu tiên hơn `VIENEU_BASE_URL`).
- Khi thêm/sửa tính năng: tự kiểm "cái này có đang phụ thuộc máy local không?" → nếu có thì thiết kế lại cho cloud.

Vi phạm luật này (bắt buộc phụ thuộc local) = lỗi nghiêm trọng.

## 🧠 BỘ NHỚ DỰ ÁN — TTS VIENEU (đọc trước khi đụng vào TTS)

> Mục đích: sau này agent tự biết TTS của dự án là gì, chạy ở đâu, gọi thế nào — khỏi mò lại.

**VieNeu-TTS là gì:** engine TTS tiếng Việt **miễn phí**, `vieneu` v3.8.3, model `pnnbao-ump/VieNeu-TTS-v3-Turbo` (ONNX/CPU, torch-free, ~595MB), **25 preset giọng Việt + clone giọng**. API **OpenAI-compatible**.

**Hợp đồng API (engine phải phơi ra đúng cái này):**
- `GET /health` → `{ ok: true }`
- `GET /v1/voices` → `{ object:"list", data:[{id,name}] }`
- `POST /v1/audio/speech` — body `{ model, voice, input, response_format:"wav" }` → WAV binary
- `POST /v1/clone` — multipart `file` + `text` (+`ref_text?`) → WAV giọng clone

**Backend Rexi gọi qua đâu:** env `VIENEU_BASE_URL_CLOUD` (ưu tiên — cloud ghi) / `VIENEU_BASE_URL` (fallback) trên Render service `rexi-ai-backend` (`srv-davqgebtqb8s73de1m00`). Có env này thì:
- `GET /api/services/tts/voices` → trả 25 giọng (`engine:"vieneu"`, `voice_clone:true`)
- `POST /api/services/tts` → ưu tiên VieNeu; nhận `engine:"vieneu"|"edge-tts"` để buộc; **fallback Edge khi VieNeu chết**
- `POST /api/services/tts/clone` → forward `/v1/clone` → WAV base64
- Route code: `Backend/src/routes/services.routes.js` (L478, L625, L687, L740, L958).

**Lịch sử (tại sao từng chạy local):**
- Nhóm đã **build sẵn bản HuggingFace Space** cho VieNeu: `D:\backups\repos-rescue\VieNeu-TTS\space\` (`app.py` + `Dockerfile` Docker SDK, `app_port: 7860`, 16GB RAM).
- Nhưng lại **deploy bằng local + cloudflared quick tunnel** (server `D:\Rexi AI\tools\VieNeu-TTS` port 8000, `tools/tunnel-manager.ps1`, task `RexiTunnels`, watchdog `RexiVieNeuWatchdog`), vì `AUDIT-2026-09-20.md` chốt *"Render free không chạy nổi model"*.
- **Sự cố 11/11/2026:** server local treo + tunnel chết + Render `VIENEU_BASE_URL` trỏ tunnel cũ → **TTS prod sập**.

**CHỐT CUỐI 11/11/2026 (user chốt — ĐÈ quyết định cũ "deploy HF Space + gỡ sạch local"):**
- **KHÔNG gỡ local** (user: *"ko ngắt cái gì nhưng mọi thứ đều phải chạy tốt trên cloud"*) — server local + tunnel-manager tiếp tục chạy, chỉ là **fallback**, KHÔNG được là nguồn chính.
- **Nguồn cloud chính** = repo `th-ming/rexi-tts-cloud`: workflow `vieneu-tts-cloud.yml` (cron `0 */6 * * *` + push/dispatch) chạy model VieNeu trên Ubuntu runner + cloudflared quick tunnel → **wire Render env `VIENEU_BASE_URL_CLOUD`** (kèm `VIENEU_BASE_URL` cho tương thích) → sleep 19800s giữ tunnel sống. Secret `RENDER_KEY` = key acct3.
- **Backend ưu tiên `VIENEU_BASE_URL_CLOUD` trước `VIENEU_BASE_URL`** (`services.routes.js` ~L455, commit `04ab28e`) → local manager rotate tunnel không đè được nguồn cloud.
- **HF Space KHÔNG dùng được** (điều tra kỹ 11/11): token `traminh09818` chỉ có scope inference (không có token write nào trên máy), account chưa có Space nào, các Space public VieNeu của người khác đều là Gradio (không có API `/v1/`). Muốn dùng HF sau này cần user tự tạo token write.
- **Trạng thái đã nghiệm thu:** deploy `dep-dbq54dv4` live (commit `04ab28e`), prod `POST /api/services/tts` trả WAV thật ~330KB (3/3 lần), `engine:"vieneu"`, `voices_reachable:true`.
- Lịch sử bug đã sửa: workflow từng trỏ service Render đã xóa (`srv-dajo...`, 404) + `|| true` nuốt lỗi → wire câm; đã sửa service ID + fail loudly khi PUT/DEPLOY khác 200.

## Ghi chú nền (2026-11-11)

- `.gitignore` dòng `tools/VieNeu-TTS/` → tool local KHÔNG nằm trong repo (đúng tinh thần luật #1).
- Bản đồ kiến trúc: xem `STRUCTURE.md` / `docs/map.html` (luật global #19).
- Luật bổ sung (plan-first, self-verify) giữ nguyên trong `.agents/AGENTS.md`.
