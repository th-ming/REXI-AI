const MODELS = [
  { id: "deepseek-ai/deepseek-v4.1-flash",          label: "DeepSeek V4.1 Flash", vision: false },
  { id: "z-ai/glm-5.3",                             label: "GLM-5.3", vision: false },
  { id: "z-ai/glm-5.3-flash",                       label: "GLM-5.3 Flash", vision: false },
  { id: "step-5-preview",                           label: "Step 5 Preview", vision: false },
  { id: "nvidia/nemotron-3-ultra-550b-a55b",        label: "Nemotron 3 Ultra 550B", vision: false },
  { id: "nvidia/nemotron-3.5-super-vl-120b-a12b",   label: "👁 Nemotron 3.5 Super VL 120B", vision: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "👁 Nemotron 3 Nano Omni 30B", vision: true }
];

const MAX_IMAGES = 4, MAX_DIM = 1280;
const history = [];
const images = [];

const $ = (s) => document.querySelector(s);
const sel = $("#model"), input = $("#q"), sendBtn = $("#send"),
      attachBtn = $("#attach"), fileInput = document.createElement("input"),
      thumbs = $("#thumbs"), log = $("#log"), status = $("#status"), drop = $("#drop");

fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true;

const auto = document.createElement("option");
auto.value = "__auto__"; auto.textContent = "🔄 Tự động luân (khuyến nghị)";
sel.appendChild(auto);
MODELS.forEach(m => {
  const o = document.createElement("option");
  o.value = m.id; o.textContent = m.label;
  sel.appendChild(o);
});
sel.value = "__auto__";

/* ── Ảnh: tải lên / dán / kéo thả, downscale trước khi gửi ── */
function downscale(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      const scale = Math.min(1, MAX_DIM / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("ảnh lỗi")); };
    img.src = url;
  });
}

async function addImage(file){
  if (!file || !file.type.startsWith("image/")) return;
  if (images.length >= MAX_IMAGES) { status.textContent = "Tối đa " + MAX_IMAGES + " ảnh"; return; }
  if (file.size > 12 * 1024 * 1024) { status.textContent = "Ảnh quá lớn (>12MB)"; return; }
  try {
    const dataUrl = await downscale(file);
    images.push({ dataUrl });
    renderThumbs();
    status.textContent = images.length + " ảnh đính kèm · gửi sẽ tự dùng model 👁";
  } catch (e) { status.textContent = "Không đọc được ảnh"; }
}

function renderThumbs(){
  thumbs.innerHTML = "";
  thumbs.classList.toggle("on", images.length > 0);
  images.forEach((im, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    const img = document.createElement("img");
    img.src = im.dataUrl;
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Bỏ ảnh";
    x.onclick = () => { images.splice(i, 1); renderThumbs(); };
    d.append(img, x);
    thumbs.appendChild(d);
  });
}

attachBtn.onclick = () => fileInput.click();
fileInput.onchange = () => { [...fileInput.files].forEach(addImage); fileInput.value = ""; };

document.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let took = false;
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) { addImage(it.getAsFile()); took = true; }
  }
  if (took) e.preventDefault();
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; drop.classList.add("on"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("on"); } });
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; drop.classList.remove("on");
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  [...files].forEach(addImage);
});

/* ── Hội thoại ── */
function copyBtn(wrap, text){
  const btn = document.createElement("button");
  btn.className = "copy"; btn.textContent = "Sao chép";
  btn.onclick = () => navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Đã chép ✓"; setTimeout(() => btn.textContent = "Sao chép", 1200);
  });
  wrap.querySelector(".who").appendChild(btn);
}

function addMsg(cls, who){
  const wrap = document.createElement("div");
  wrap.className = "msg " + cls;
  const head = document.createElement("div");
  head.className = "who"; head.textContent = who;
  const b = document.createElement("div");
  b.className = "bubble";
  wrap.append(head, b);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return { wrap, box: b, head };
}

function renderUser(box, text, imgs){
  box.textContent = text;
  imgs.forEach(u => {
    const img = document.createElement("img");
    img.src = u;
    box.appendChild(img);
  });
}

async function send(){
  const text = input.value.trim();
  if (!text && images.length === 0) return;
  input.value = "";

  const imgs = images.map(i => i.dataUrl);
  const content = imgs.length
    ? [{ type: "text", text: text || "Đọc ảnh này." },
       ...imgs.map(u => ({ type: "image_url", image_url: { url: u } }))]
    : text;

  const { wrap, box, head } = addMsg("user", "Bạn");
  renderUser(box, text, imgs);
  history.push({ role: "user", content });

  images.length = 0;
  renderThumbs();

  sendBtn.disabled = true;
  const bot = addMsg("bot", "⏳ đang gọi model…");
  status.textContent = "Đang gửi…";
  log.scrollTop = log.scrollHeight;

  try {
    const r = await fetch("/nchat/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: sel.value, messages: history })
    });
    const j = await r.json();
    if (j.ok){
      bot.box.textContent = j.content;
      bot.head.textContent = "✅ " + j.model + " · key " + j.key;
      copyBtn(bot.wrap, j.content);
      history.push({ role: "assistant", content: j.content });
      status.textContent = "Xong · " + j.model + " · key " + j.key;
    } else {
      bot.wrap.classList.add("err");
      bot.box.textContent = "Tất cả model/key đều lỗi:\n" + (j.tried || []).join("\n");
      bot.head.textContent = "❌ hết đường";
      status.textContent = "Thất bại — thử lại sau";
      history.pop();
    }
  } catch (e) {
    bot.wrap.classList.add("err");
    bot.box.textContent = "Lỗi kết nối server: " + e.message;
    bot.head.textContent = "❌ lỗi";
    history.pop();
  }
  sendBtn.disabled = false;
  input.focus();
}

sendBtn.onclick = send;
input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
input.focus();
