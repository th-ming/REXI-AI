import React, { useState, useEffect } from 'react';
import { t, getLang } from '../i18n';
const T = t; // alias tránh bị che bởi biến template 't'
import {
  Video, Download, Loader2, Code,
  Sparkles, Check, ArrowLeft, ArrowRight, Info,
  Monitor, Smartphone, Square, Play, Palette, Type, Layers
} from 'lucide-react';

const FORMATS = [
  { id: 'landscape', label: '16:9', desc: 'YouTube, Facebook', icon: Monitor, w: 1920, h: 1080 },
  { id: 'square', label: '1:1', desc: 'Instagram, TikTok', icon: Square, w: 1080, h: 1080 },
  { id: 'portrait', label: '9:16', desc: 'Reels, Shorts', icon: Smartphone, w: 1080, h: 1920 },
];

const GSAP_CDN = '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>';

// Pseudo-random deterministic (sin-hash) — seek-safe, KHÔNG Math.random
const prand = (i, salt = 0) => {
  const x = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Vòng lặp hữu hạn lấp đầy thời lượng: tween kéo dur/K rồi repeat (K-1) lần → tổng đúng dur.
// repeat:-1 làm tl.duration() = 1 vòng → renderer clamp → video đứng hình sau 1 giây (bug cũ).
const fullDur = (dur, cycle) => {
  const K = Math.max(2, Math.ceil(dur / Math.max(cycle, 0.5)));
  return { seg: dur / K, rep: K - 1 };
};

// Film grain + scanlines dùng chung (CSS keyframes — renderer đóng băng theo frame)
const FX_CSS = `
  .fx-grain{position:absolute;inset:-60%;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");animation:fxgrain .8s steps(4) infinite}
  @keyframes fxgrain{0%{transform:translate(0,0)}25%{transform:translate(-2%,3%)}50%{transform:translate(3%,-2%)}75%{transform:translate(-3%,-3%)}100%{transform:translate(0,0)}}
  .fx-scan{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.14) 0 2px,transparent 2px 4px)}
  .fx-vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 42%,rgba(0,0,0,.72) 100%)}
`;

const EASY_TEMPLATES = [
  {
    id: 'title-cinema',
    name: 'Tiêu Đề Điện Ảnh',
    desc: 'Aurora trôi suốt video + gradient quét qua chữ + film grain + vignette',
    category: 'intro',
    fields: [
      { key: 'title', label: 'Tiêu đề chính', placeholder: 'VD: CHÀO MỪNG ĐẾN VỚI Rexi AI', default: 'CHÀO MỪNG ĐẾN VỚI Rexi AI' },
      { key: 'subtitle', label: 'Phụ đề', placeholder: 'VD: Trợ lý đa mô hình — miễn phí', default: 'Trợ lý đa mô hình — miễn phí' },
    ],
    build: (f, dur) => { const A = fullDur(dur, 3); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:#05060f;font-family:'Segoe UI',sans-serif;">
  <div id="au1" style="position:absolute;width:60vw;height:60vw;left:-12%;top:-18%;border-radius:50%;filter:blur(50px);background:radial-gradient(circle,#4f46e5 0%,transparent 65%);opacity:.55;will-change:transform"></div>
  <div id="au2" style="position:absolute;width:55vw;height:55vw;right:-14%;top:22%;border-radius:50%;filter:blur(55px);background:radial-gradient(circle,#0891b2 0%,transparent 65%);opacity:.45;will-change:transform"></div>
  <div id="au3" style="position:absolute;width:50vw;height:50vw;left:24%;bottom:-22%;border-radius:50%;filter:blur(60px);background:radial-gradient(circle,#a21caf 0%,transparent 65%);opacity:.4;will-change:transform"></div>
  <div class="fx-vignette"></div>
  <div class="fx-grain" style="opacity:.07"></div>
  <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:60px;">
    <h1 id="tc-title" class="clip" data-start="0.2" data-duration="${dur - 0.2}" data-track-index="0"
      style="font-size:78px;font-weight:900;letter-spacing:-2px;background:linear-gradient(90deg,#22d3ee,#818cf8,#e879f9,#22d3ee);background-size:300% 100%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:0 0 22px;will-change:transform">${escapeHtml(f.title)}</h1>
    <p id="tc-sub" class="clip" data-start="1.2" data-duration="${Math.max(0.8, dur - 1.2)}" data-track-index="1"
      style="font-size:25px;color:#94a3b8;letter-spacing:6px;margin:0;will-change:transform">${escapeHtml(f.subtitle)}</p>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#au1', { x: 0, y: 0 }, { x: 130, y: 90, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.fromTo('#au2', { x: 0, y: 0 }, { x: -150, y: -70, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.fromTo('#au3', { x: 0, y: 0 }, { x: 70, y: 110, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.fromTo('#tc-title', { backgroundPosition: '0% 50%' }, { backgroundPosition: '200% 50%', duration: ${dur}, ease: 'none' }, 0);
  tl.set('#tc-title', { opacity: 0 }, 0);
  tl.set('#tc-title', { opacity: 1 }, 0.2);
  tl.fromTo('#tc-title', { y: -80 }, { y: 0, duration: 0.9, ease: 'power4.out' }, 0.2);
  tl.set('#tc-sub', { opacity: 0 }, 0);
  tl.set('#tc-sub', { opacity: 1 }, 1.2);
  tl.fromTo('#tc-sub', { letterSpacing: '20px', y: 26 }, { letterSpacing: '6px', y: 0, duration: 0.8, ease: 'power3.out' }, 1.2);
  window.__timelines = window.__timelines || {};
  window.__timelines['title-cinema'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'gradient-drift',
    name: 'Nền Gradient Chạy',
    desc: 'Gradient trôi suốt video + particles bay + glow + title gradient',
    category: 'promo',
    fields: [
      { key: 'title', label: 'Nội dung chính', placeholder: 'VD: SALE 50% HÔM NAY', default: 'SALE 50% HÔM NAY' },
    ],
    build: (f, dur) => { const A = fullDur(dur, 4); const P = Array.from({ length: 14 }, (_, i) => ({
      left: Math.round(prand(i, 1) * 96), size: Math.round(4 + prand(i, 2) * 8), delay: +(prand(i, 3) * dur * 0.45).toFixed(2), drift: Math.round((prand(i, 4) - 0.5) * 80),
    })); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:#0a0a0f;font-family:'Segoe UI',sans-serif;">
  <div id="gd-bg" style="position:absolute;inset:-30%;background:linear-gradient(45deg,#ee7752,#e73c7e,#23a6d5,#23d5ab);background-size:400% 400%;will-change:transform"></div>
  ${P.map((p, i) => `<div id="gd-p${i}" style="position:absolute;left:${p.left}%;top:104%;width:${p.size}px;height:${p.size}px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 0 12px rgba(255,255,255,.5);will-change:transform"></div>`).join('\n  ')}
  <div class="fx-vignette"></div>
  <div class="fx-grain" style="opacity:.06"></div>
  <div style="position:relative;display:flex;align-items:center;justify-content:center;height:100%;">
    <h1 id="gd-title" class="clip" data-start="0.3" data-duration="${dur - 0.3}" data-track-index="0"
      style="font-size:68px;font-weight:900;color:white;text-shadow:0 6px 28px rgba(0,0,0,0.35);text-align:center;padding:40px;margin:0;will-change:transform">${escapeHtml(f.title)}</h1>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#gd-bg', { backgroundPosition: '0% 50%' }, { backgroundPosition: '200% 50%', duration: ${A.seg}, ease: 'none', repeat: ${A.rep} }, 0);
  ${P.map((p, i) => `tl.set('#gd-p${i}', { opacity: 0 }, 0);
  tl.set('#gd-p${i}', { opacity: 1 }, ${p.delay});
  tl.fromTo('#gd-p${i}', { y: 0 }, { y: '-115vh', x: ${p.drift}, duration: ${(dur * 0.62).toFixed(2)}, ease: 'none' }, ${p.delay});`).join('\n  ')}
  tl.set('#gd-title', { opacity: 0 }, 0);
  tl.set('#gd-title', { opacity: 1 }, 0.3);
  tl.fromTo('#gd-title', { scale: 0.72 }, { scale: 1, duration: 0.8, ease: 'back.out(1.7)' }, 0.3);
  window.__timelines = window.__timelines || {};
  window.__timelines['gradient-drift'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'text-reveal',
    name: 'Hiện Chữ Dần',
    desc: '3 dòngcascade từ dưới lên + shimmer quét suốt + camera lùi nhẹ',
    category: 'promo',
    fields: [
      { key: 'line1', label: 'Dòng 1', placeholder: 'VD: Sản phẩm mới ra mắt', default: 'Sản phẩm mới ra mắt' },
      { key: 'line2', label: 'Dòng 2', placeholder: 'VD: Giảm giá 30%', default: 'Giảm giá 30%' },
      { key: 'line3', label: 'Dòng 3', placeholder: 'VD: Chỉ trong tuần này!', default: 'Chỉ trong tuần này!' },
    ],
    build: (f, dur) => { const A = fullDur(dur, 3.5); const S = fullDur(dur, 2.5); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at 50% 30%,#1e1b4b,#0a0a0a);font-family:'Segoe UI',sans-serif;">
  <div id="tr-shimmer" style="position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.09) 50%,transparent 60%);background-size:250% 100%;will-change:transform"></div>
  <div class="fx-grain" style="opacity:.05"></div>
  <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:60px;perspective:1200px;">
    <h1 id="tr-l1" class="clip" data-start="0" data-duration="${dur}" data-track-index="0"
      style="font-size:58px;font-weight:800;color:#fff;margin:0 0 18px;will-change:transform">${escapeHtml(f.line1)}</h1>
    <h2 id="tr-l2" class="clip" data-start="0.35" data-duration="${dur - 0.35}" data-track-index="1"
      style="font-size:42px;font-weight:600;color:#60a5fa;margin:0 0 18px;will-change:transform">${escapeHtml(f.line2)}</h2>
    <p id="tr-l3" class="clip" data-start="0.7" data-duration="${dur - 0.7}" data-track-index="2"
      style="font-size:25px;color:#94a3b8;margin:0 0 26px;will-change:transform">${escapeHtml(f.line3)}</p>
    <svg id="tr-line" width="220" height="6" viewBox="0 0 220 6" style="overflow:visible">
      <line x1="0" y1="3" x2="220" y2="3" stroke="#22d3ee" stroke-width="4" stroke-linecap="round" id="tr-draw"/>
    </svg>
  </div>
</div>
<script>
  const line = document.getElementById('tr-draw');
  const L = 220; line.setAttribute('stroke-dasharray', L); line.setAttribute('stroke-dashoffset', L);
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#tr-shimmer', { backgroundPosition: '120% 50%' }, { backgroundPosition: '-120% 50%', duration: ${S.seg}, ease: 'none', repeat: ${S.rep} }, 0);
  ['#tr-l1', '#tr-l2', '#tr-l3'].forEach((sel, i) => {
    tl.set(sel, { opacity: 0 }, 0);
  });
  tl.set('#tr-l1', { opacity: 1 }, 0);
  tl.fromTo('#tr-l1', { y: 90, rotationX: 28 }, { y: 0, rotationX: 0, duration: 0.75, ease: 'power4.out' }, 0);
  tl.set('#tr-l2', { opacity: 1 }, 0.35);
  tl.fromTo('#tr-l2', { y: 90, rotationX: 28 }, { y: 0, rotationX: 0, duration: 0.75, ease: 'power4.out' }, 0.35);
  tl.set('#tr-l3', { opacity: 1 }, 0.7);
  tl.fromTo('#tr-l3', { y: 70, rotationX: 24 }, { y: 0, rotationX: 0, duration: 0.7, ease: 'power4.out' }, 0.7);
  tl.fromTo(line, { strokeDashoffset: L }, { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut' }, 0.8);
  tl.set('#tr-line', { opacity: 1 }, 0.8);
  window.__timelines = window.__timelines || {};
  window.__timelines['text-reveal'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'card-grid',
    name: '3 Thẻ Tính Năng',
    desc: 'Thẻ pop-in + trôi nổi suốt video (lệch pha) + aurora + camera lùi nhẹ',
    category: 'intro',
    fields: [
      { key: 'card1', label: 'Thẻ 1 — tiêu đề', placeholder: 'VD: 🚀 Nhanh', default: '🚀 Nhanh' },
      { key: 'card1d', label: 'Thẻ 1 — mô tả', placeholder: 'VD: Tốc độ vượt trội', default: 'Tốc độ vượt trội' },
      { key: 'card2', label: 'Thẻ 2 — tiêu đề', placeholder: 'VD: 🔒 An toàn', default: '🔒 An toàn' },
      { key: 'card2d', label: 'Thẻ 2 — mô tả', placeholder: 'VD: Bảo mật tuyệt đối', default: 'Bảo mật tuyệt đối' },
      { key: 'card3', label: 'Thẻ 3 — tiêu đề', placeholder: 'VD: ✨ Hiện đại', default: '✨ Hiện đại' },
      { key: 'card3d', label: 'Thẻ 3 — mô tả', placeholder: 'VD: Công nghệ mới nhất', default: 'Công nghệ mới nhất' },
    ],
    build: (f, dur) => { const A = fullDur(dur, 3); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:#0b1120;font-family:'Segoe UI',sans-serif;padding:60px;display:flex;align-items:center;justify-content:center;">
  <div id="cg-au1" style="position:absolute;width:55vw;height:55vw;left:-14%;top:-20%;border-radius:50%;filter:blur(55px);background:radial-gradient(circle,#1d4ed8 0%,transparent 65%);opacity:.5;will-change:transform"></div>
  <div id="cg-au2" style="position:absolute;width:50vw;height:50vw;right:-16%;bottom:-24%;border-radius:50%;filter:blur(60px);background:radial-gradient(circle,#0891b2 0%,transparent 65%);opacity:.4;will-change:transform"></div>
  <div class="fx-grain" style="opacity:.06"></div>
  <div id="cg-world" style="position:relative;display:flex;gap:44px;perspective:1400px;will-change:transform">
    <div id="cg-c1" class="clip" data-start="0" data-duration="${dur}" data-track-index="0"
      style="background:linear-gradient(150deg,#16324f,#0d1526);border-radius:22px;padding:42px 36px;width:290px;text-align:center;border:1px solid #2b3f5c;box-shadow:0 24px 60px rgba(0,0,0,.45);will-change:transform">
      <h3 style="color:#fff;font-size:25px;margin:0 0 10px;">${escapeHtml(f.card1)}</h3>
      <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6;">${escapeHtml(f.card1d)}</p>
    </div>
    <div id="cg-c2" class="clip" data-start="0.15" data-duration="${dur - 0.15}" data-track-index="1"
      style="background:linear-gradient(150deg,#16324f,#0d1526);border-radius:22px;padding:42px 36px;width:290px;text-align:center;border:1px solid #2b3f5c;box-shadow:0 24px 60px rgba(0,0,0,.45);will-change:transform">
      <h3 style="color:#fff;font-size:25px;margin:0 0 10px;">${escapeHtml(f.card2)}</h3>
      <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6;">${escapeHtml(f.card2d)}</p>
    </div>
    <div id="cg-c3" class="clip" data-start="0.3" data-duration="${dur - 0.3}" data-track-index="2"
      style="background:linear-gradient(150deg,#16324f,#0d1526);border-radius:22px;padding:42px 36px;width:290px;text-align:center;border:1px solid #2b3f5c;box-shadow:0 24px 60px rgba(0,0,0,.45);will-change:transform">
      <h3 style="color:#fff;font-size:25px;margin:0 0 10px;">${escapeHtml(f.card3)}</h3>
      <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6;">${escapeHtml(f.card3d)}</p>
    </div>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#cg-au1', { x: 0, y: 0 }, { x: 110, y: 70, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.fromTo('#cg-au2', { x: 0, y: 0 }, { x: -90, y: -60, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.fromTo('#cg-world', { scale: 1.08 }, { scale: 1, duration: ${dur}, ease: 'power2.out' }, 0);
  ['#cg-c1', '#cg-c2', '#cg-c3'].forEach((sel, i) => {
    tl.set(sel, { opacity: 0 }, 0);
    tl.set(sel, { opacity: 1 }, 0.15 * i);
    tl.fromTo(sel, { scale: 0.6, y: 46, rotationY: i === 1 ? 0 : (i === 0 ? -14 : 14) }, { scale: 1, y: 0, rotationY: 0, duration: 0.65, ease: 'back.out(1.6)' }, 0.15 * i);
    tl.fromTo(sel, { y: 0 }, { y: -16, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0.7 + 0.35 * i);
  });
  window.__timelines = window.__timelines || {};
  window.__timelines['card-grid'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'countdown',
    name: 'Đếm Ngược',
    desc: 'Đếm từng số có pulse + ring vẽ theo + particles bung lúc "BẮT ĐẦU"',
    category: 'promo',
    fields: [
      { key: 'number', label: 'Số bắt đầu (đếm về 1)', placeholder: 'VD: 3', default: '3' },
      { key: 'message', label: 'Thông báo', placeholder: 'VD: BẮT ĐẦU!', default: 'BẮT ĐẦU!' },
    ],
    build: (f, dur) => { const N = Math.max(2, Math.min(10, parseInt(f.number, 10) || 3)); const msgT = Math.max(1.2, dur - 1.2); const step = msgT / N; const B = fullDur(dur, 4); const RL = Math.round(2 * Math.PI * 100); const dots = Array.from({ length: 18 }, (_, i) => {
      const ang = prand(i, 5) * Math.PI * 2; const dist = 140 + prand(i, 6) * 260;
      return { dx: Math.round(Math.cos(ang) * dist), dy: Math.round(Math.sin(ang) * dist), size: Math.round(5 + prand(i, 7) * 9), d: +(prand(i, 8) * 0.25).toFixed(2) };
    }); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:linear-gradient(135deg,#141b33,#0f2744,#0a1a2e);background-size:300% 300%;font-family:'Segoe UI',sans-serif;">
  <div id="cd-bg" style="position:absolute;inset:0;will-change:transform"></div>
  <div class="fx-vignette"></div>
  <div class="fx-grain" style="opacity:.06"></div>
  <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;">
    <svg width="230" height="230" viewBox="0 0 230 230" style="position:absolute;">
      <circle cx="115" cy="115" r="100" fill="none" stroke="rgba(148,163,184,.15)" stroke-width="6"/>
      <circle id="cd-ring" cx="115" cy="115" r="100" fill="none" stroke="#22d3ee" stroke-width="6" stroke-linecap="round" transform="rotate(-90 115 115)"/>
    </svg>
    <div style="position:relative;width:230px;height:230px;display:flex;align-items:center;justify-content:center;">
      ${Array.from({ length: N }, (_, i) => `<div id="cd-n${i}" class="clip" data-start="${(i * step).toFixed(2)}" data-duration="${step.toFixed(2)}" data-track-index="${i}"
        style="position:absolute;font-size:150px;font-weight:900;background:linear-gradient(135deg,#22d3ee,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1;opacity:0;will-change:transform">${N - i}</div>`).join('\n      ')}
    </div>
    <div id="cd-msg" class="clip" data-start="${msgT.toFixed(2)}" data-duration="${Math.max(0.6, dur - msgT).toFixed(2)}" data-track-index="${N}"
      style="position:relative;font-size:40px;color:#fff;font-weight:800;letter-spacing:8px;margin-top:18px;opacity:0;will-change:transform">${escapeHtml(f.message)}</div>
    ${dots.map((d, i) => `<div id="cd-d${i}" style="position:absolute;left:50%;top:38%;width:${d.size}px;height:${d.size}px;border-radius:50%;background:#22d3ee;box-shadow:0 0 14px rgba(34,211,238,.8);opacity:0;will-change:transform"></div>`).join('\n    ')}
  </div>
</div>
<script>
  const ring = document.getElementById('cd-ring');
  ring.setAttribute('stroke-dasharray', ${RL}); ring.setAttribute('stroke-dashoffset', ${RL});
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#cd-bg', { backgroundPosition: '0% 0%' }, { backgroundPosition: '100% 100%', duration: ${B.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${B.rep} }, 0);
  ${Array.from({ length: N }, (_, i) => {
    const t0 = (i * step).toFixed(2); const t1 = ((i + 1) * step).toFixed(2);
    return `tl.set('#cd-n${i}', { opacity: 1 }, ${t0});
  tl.set('#cd-n${i}', { opacity: 0 }, ${t1});
  tl.fromTo('#cd-n${i}', { scale: 1.35 }, { scale: 1, duration: ${Math.min(0.5, step).toFixed(2)}, ease: 'power2.out' }, ${t0});
  tl.fromTo(ring, { strokeDashoffset: RL }, { strokeDashoffset: ${Math.round(RL * (1 - (i + 1) / N))}, duration: ${step.toFixed(2)}, ease: 'none' }, ${t0});`;
  }).join('\n  ')}
  tl.set('#cd-msg', { opacity: 1 }, ${msgT.toFixed(2)});
  tl.fromTo('#cd-msg', { scale: 0.7, letterSpacing: '20px' }, { scale: 1, letterSpacing: '8px', duration: 0.6, ease: 'back.out(1.8)' }, ${msgT.toFixed(2)});
  ${dots.map((d, i) => `tl.set('#cd-d${i}', { opacity: 0 }, 0);
  tl.set('#cd-d${i}', { opacity: 1 }, ${msgT.toFixed(2)});
  tl.fromTo('#cd-d${i}', { x: 0, y: 0, scale: 1, opacity: 1 }, { x: ${d.dx}, y: ${d.dy}, scale: 0.2, opacity: 0, duration: ${(dur - msgT + 0.4).toFixed(2)}, ease: 'power2.out', delay: ${d.d} }, ${msgT.toFixed(2)});`).join('\n  ')}
  window.__timelines = window.__timelines || {};
  window.__timelines['countdown'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'news-ticker',
    name: 'Bản Tin Chạy',
    desc: 'Breaking news — ticker chạy liên tục suốt video + badge LIVE pulse',
    category: 'intro',
    fields: [
      { key: 'headline', label: 'Tiêu đề chính', placeholder: 'VD: TIN NÓNG HÔM NAY', default: 'TIN NÓNG HÔM NAY' },
      { key: 'ticker', label: 'Dòng tin chạy', placeholder: 'VD: Thị trường tăng trưởng 5% trong quý này', default: 'Thị trường tăng trưởng 5% trong quý này' },
    ],
    build: (f, dur) => { const tickDur = Math.max(1.2, dur - 0.7); const K = Math.max(2, Math.ceil(tickDur / 4)); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:linear-gradient(135deg,#0f0f23,#1a1a3e);font-family:'Segoe UI',sans-serif;">
  <div class="fx-grain" style="opacity:.05"></div>
  <div style="position:relative;display:flex;flex-direction:column;justify-content:center;font-family:'Segoe UI',sans-serif;height:100%;">
    <div id="nt-head" class="clip" data-start="0" data-duration="${dur}" data-track-index="0"
      style="padding:40px 60px 24px;will-change:transform">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
        <span id="nt-live" style="display:flex;align-items:center;gap:8px;background:#dc2626;color:#fff;font-size:15px;font-weight:800;letter-spacing:2px;padding:6px 14px;border-radius:6px;">
          <span id="nt-dot" style="width:10px;height:10px;border-radius:50%;background:#fff;display:inline-block;will-change:transform"></span>LIVE</span>
      </div>
      <h1 style="font-size:50px;font-weight:900;color:#fff;margin:0;line-height:1.2;">${escapeHtml(f.headline)}</h1>
    </div>
    <div id="nt-bar" class="clip" data-start="0.3" data-duration="${dur - 0.3}" data-track-index="1"
      style="background:#dc2626;padding:18px 0;overflow:hidden;margin:0 60px;border-radius:10px;box-shadow:0 10px 30px rgba(220,38,38,.25);will-change:transform">
      <div id="nt-ticker" style="font-size:25px;color:#fff;font-weight:600;letter-spacing:1px;white-space:nowrap;display:inline-block;will-change:transform">
        ${escapeHtml(f.ticker)}&nbsp;&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;&nbsp;${escapeHtml(f.ticker)}&nbsp;&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;&nbsp;${escapeHtml(f.ticker)}</div>
    </div>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.set('#nt-head', { opacity: 0 }, 0);
  tl.set('#nt-head', { opacity: 1 }, 0);
  tl.fromTo('#nt-head', { x: -60 }, { x: 0, duration: 0.55, ease: 'power4.out' }, 0);
  tl.set('#nt-live', { opacity: 0 }, 0);
  tl.set('#nt-live', { opacity: 1 }, 0.35);
  tl.fromTo('#nt-live', { scale: 0.5 }, { scale: 1, duration: 0.45, ease: 'back.out(2)' }, 0.35);
  tl.fromTo('#nt-dot', { scale: 1 }, { scale: 0.55, duration: 0.6, ease: 'sine.inOut', yoyo: true, repeat: ${Math.max(2, Math.ceil(dur / 1.2)) - 1} }, 0.8);
  tl.set('#nt-bar', { opacity: 1 }, 0.3);
  tl.fromTo('#nt-bar', { scaleX: 0, transformOrigin: 'left' }, { scaleX: 1, duration: 0.5, ease: 'power3.out' }, 0.3);
  tl.fromTo('#nt-ticker', { x: '0%' }, { x: '-33.333%', duration: ${(tickDur / K).toFixed(2)}, ease: 'none', repeat: ${K - 1} }, 0.7);
  window.__timelines = window.__timelines || {};
  window.__timelines['news-ticker'] = tl; tl.play();
</script>`; }
  },
  {
    id: 'quote-card',
    name: 'Thẻ Trích Dẫn',
    desc: 'Quote nổi + nền gradient trôi suốt + glow + thẻ trôi nhẹ',
    category: 'intro',
    fields: [
      { key: 'quote', label: 'Câu nói', placeholder: 'VD: Thành công là tổng của nỗ lực hàng ngày', default: 'Thành công là tổng của nỗ lực hàng ngày' },
      { key: 'author', label: 'Tác giả', placeholder: 'VD: Aristotle', default: 'Aristotle' },
    ],
    build: (f, dur) => { const A = fullDur(dur, 4); return `<meta charset="UTF-8">${GSAP_CDN}
<style>${FX_CSS}</style>
<div style="position:relative;width:100%;height:100%;overflow:hidden;background:#141021;font-family:'Segoe UI',sans-serif;">
  <div id="qc-bg" style="position:absolute;inset:-35%;background:linear-gradient(135deg,#1a1a2e,#7c2d5e,#e94560,#1a1a2e);background-size:400% 400%;will-change:transform"></div>
  <div id="qc-glow" style="position:absolute;width:46vw;height:46vw;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:50%;filter:blur(60px);background:radial-gradient(circle,rgba(233,69,96,.5) 0%,transparent 65%);opacity:0;will-change:transform,opacity"></div>
  <div class="fx-vignette"></div>
  <div class="fx-grain" style="opacity:.06"></div>
  <div style="position:relative;display:flex;align-items:center;justify-content:center;height:100%;padding:60px;">
    <div id="qc-card" style="max-width:820px;text-align:center;will-change:transform">
      <div id="qc-mark" class="clip" data-start="0" data-duration="${dur}" data-track-index="0"
        style="font-size:130px;color:rgba(255,255,255,0.18);line-height:1;margin-bottom:-34px;will-change:transform">\u201C</div>
      <p id="qc-text" class="clip" data-start="0.3" data-duration="${dur - 0.3}" data-track-index="1"
        style="font-size:34px;color:#fff;font-style:italic;line-height:1.55;margin:0 0 26px;text-shadow:0 4px 24px rgba(0,0,0,.3);will-change:transform">
        ${escapeHtml(f.quote)}</p>
      <p id="qc-author" class="clip" data-start="0.8" data-duration="${dur - 0.8}" data-track-index="2"
        style="font-size:21px;color:rgba(255,255,255,0.75);font-weight:600;letter-spacing:3px;margin:0;will-change:transform">
        — ${escapeHtml(f.author)}</p>
    </div>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#qc-bg', { backgroundPosition: '0% 50%' }, { backgroundPosition: '200% 50%', duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0);
  tl.set('#qc-glow', { opacity: 0 }, 0);
  tl.set('#qc-glow', { opacity: 0.5 }, 0.5);
  tl.fromTo('#qc-glow', { scale: 0.85 }, { scale: 1.1, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 0.5);
  tl.set('#qc-mark', { opacity: 0 }, 0);
  tl.set('#qc-mark', { opacity: 1 }, 0);
  tl.fromTo('#qc-mark', { scale: 0.5 }, { scale: 1, duration: 0.55, ease: 'back.out(1.7)' }, 0);
  tl.set('#qc-text', { opacity: 0 }, 0);
  tl.set('#qc-text', { opacity: 1 }, 0.3);
  tl.fromTo('#qc-text', { y: 40 }, { y: 0, duration: 0.7, ease: 'power4.out' }, 0.3);
  tl.set('#qc-author', { opacity: 0 }, 0);
  tl.set('#qc-author', { opacity: 1 }, 0.8);
  tl.fromTo('#qc-author', { y: 24, letterSpacing: '10px' }, { y: 0, letterSpacing: '3px', duration: 0.6, ease: 'power3.out' }, 0.8);
  tl.fromTo('#qc-card', { y: 0 }, { y: -12, duration: ${A.seg}, ease: 'sine.inOut', yoyo: true, repeat: ${A.rep} }, 1.4);
  window.__timelines = window.__timelines || {};
  window.__timelines['quote-card'] = tl; tl.play();
</script>`; }
  },
];

const CATEGORIES = [
  { id: 'all', label: 'Tất cả', icon: Layers },
  { id: 'intro', label: 'Giới thiệu', icon: Sparkles },
  { id: 'promo', label: 'Quảng cáo', icon: Palette },
];

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return btoa(binary);
}

export default function VideoCreatorTab({ API_BASE, authToken, showToast }) {
  const lang = getLang();
  const [step, setStep] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState(EASY_TEMPLATES[0]);
  const [fields, setFields] = useState(() => {
    const t = EASY_TEMPLATES[0];
    return t.fields.reduce((acc, f) => ({ ...acc, [f.key]: T(getLang(), f.default) }), {});
  });
  const [html, setHtml] = useState(() => EASY_TEMPLATES[0].build(EASY_TEMPLATES[0].fields.reduce((acc, f) => ({ ...acc, [f.key]: T(getLang(), f.default) }), {}), 5));
  const [format, setFormat] = useState('landscape');
  const [duration, setDuration] = useState(5);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState('');
    const [videoUrl, setVideoUrl] = useState(null);
    const [downloaded, setDownloaded] = useState(false);
  const [videoSize, setVideoSize] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advHtml, setAdvHtml] = useState('');
  const [status, setStatus] = useState(null);
  const [category, setCategory] = useState('all');
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiImageUrl, setAiImageUrl] = useState('');
  const [aiScenes, setAiScenes] = useState(1);
  const [aiBusy, setAiBusy] = useState(false);

  const selectedFormat = FORMATS.find(f => f.id === format);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const headers = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const res = await fetch(`${API_BASE}/services/video/status`, { headers, credentials: 'include' });
        const data = await res.json();
        if (data.success) setStatus(data);
      } catch { setStatus(null); }
    };
    checkStatus();
  }, [API_BASE, authToken]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (step === 3 && !rendering && !videoUrl) handleRender();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [step, rendering, videoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const rebuildHtml = (tpl, flds, dur) => {
    const merged = tpl.fields.reduce((acc, f) => ({ ...acc, [f.key]: flds[f.key] ?? T(getLang(), f.default) }), {});
    return tpl.build(merged, dur ?? duration);
  };

  const pickTemplate = (tpl) => {
    const defaults = tpl.fields.reduce((acc, f) => ({ ...acc, [f.key]: T(getLang(), f.default) }), {});
    setSelectedTemplate(tpl);
    setFields(defaults);
    setHtml(rebuildHtml(tpl, defaults, duration));
    setVideoUrl(null);
    setStep(2);
    setPreviewTemplate(null);
  };

  const openPreview = (tpl) => {
    setPreviewTemplate(tpl);
  };

  const updateField = (key, value) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    setHtml(rebuildHtml(selectedTemplate, next, duration));
    setVideoUrl(null);
  };

  const handleRender = async () => {
    if (!html.trim()) return;
    setRendering(true);
    setRenderProgress(T(getLang(), 'Đang gửi nội dung đến server...'));
    setVideoUrl(null);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      setRenderProgress(T(getLang(), 'Đang render video... (mất 30-60 giây)'));
      const res = await fetch(`${API_BASE}/services/video/render`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ html, width: selectedFormat.w, height: selectedFormat.h, fps: 30, duration })
      });
      if (res.status === 404 || res.status === 410) {
        setRenderProgress('');
        showToast(T(getLang(), 'Link render đã hết hạn (server restart) — render lại nhé.'), 'error');
        return;
      }
      const data = await res.json();
      if (data.success && data.video) {
        const url = 'data:video/mp4;base64,' + data.video;
        setVideoUrl(url);
        setVideoSize(data.size);
        setRenderProgress('');
        setStep(4);
        showToast(`${T(getLang(), 'Video render thành công!')} (${(data.size / 1024 / 1024).toFixed(1)}MB)`, 'success');
      } else {
        setRenderProgress('');
        showToast(data.error || T(getLang(), 'Render thất bại'), 'error');
      }
    } catch (err) {
      setRenderProgress('');
      showToast(T(getLang(), 'Lỗi: ') + err.message, 'error');
    } finally {
      setRendering(false);
    }
  };

  const handleAiVideo = async () => {
    if (!aiPrompt.trim()) { showToast(T(getLang(), 'Nhập mô tả video trước nhé.'), 'error'); return; }
    setAiBusy(true);
    setVideoUrl(null);
    setRenderProgress(aiScenes > 1
      ? `${T(getLang(), 'AI đang kể truyện: chia ')}${aiScenes} ${T(getLang(), 'cảnh, tạo từng clip rồi ghép lại... (có thể mất ~')}${aiScenes * 25} ${T(getLang(), 'giây')}`
      : T(getLang(), 'AI đang tạo video... (20-90 giây, dùng Space công khai miễn phí)'));
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const res = await fetch(`${API_BASE}/services/generate-video`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ prompt: aiPrompt.trim(), image_url: aiImageUrl.trim() || undefined, scenes: aiScenes })
      });
      const data = await res.json();
      if (data.success && data.video) {
        setVideoUrl(data.video.startsWith('data:') ? data.video : ('data:' + (data.mimeType || 'video/mp4') + ';base64,' + data.video));
        setVideoSize(data.bytes || 0);
        setRenderProgress('');
        setStep(4);
        showToast(`${T(getLang(), 'Video AI xong!')} (${data.provider || 'ai'}${data.scenes ? `, ${data.scenes} ${T(getLang(), 'cảnh')} ~${data.durationSec}s` : ''})`, 'success');
      } else {
        setRenderProgress('');
        showToast(data.error || T(getLang(), 'Tạo video AI thất bại'), 'error');
      }
    } catch (err) {
      setRenderProgress('');
      showToast(T(getLang(), 'Lỗi: ') + err.message, 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = `rexi_video_${Date.now()}.mp4`;
    a.click();
    setDownloaded(true);
    showToast(T(getLang(), 'Đã tải video MP4!'), 'success');
  };

  const startOver = () => {
    setStep(1);
    setVideoUrl(null);
    setRenderProgress('');
  };

  useEffect(() => {
    if (!videoUrl || downloaded) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [videoUrl, downloaded]);

  const previewSrc = `data:text/html;base64,${utf8ToBase64(showAdvanced ? advHtml || html : html)}`;
  const ready = status?.ready === true;
  const filteredTemplates = category === 'all' ? EASY_TEMPLATES : EASY_TEMPLATES.filter(t => t.category === category);

  const STEPS = [
    { n: 1, label: 'Chọn mẫu', icon: Palette },
    { n: 2, label: 'Nhập nội dung', icon: Type },
    { n: 3, label: 'Xem & Render', icon: Play },
    { n: 4, label: 'Tải video', icon: Download },
  ];

  return (
    <div className="rexi-lightfix flex flex-col h-full w-full bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
<div className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center">
             <Video size={18} className="text-[#4a7dff]" />
           </div>
           <div>
             <h1 className="text-sm font-bold text-slate-800">{T(getLang(), 'Tạo Video')}</h1>
             <p className="text-[10px] text-slate-500">{T(getLang(), 'Tạo video HTML animation đẹp mắt')}</p>
           </div>
        </div>
        {/* Format Selector */}
        <div className="flex items-center gap-1 p-1 bg-slate-50 rounded-xl border border-slate-200">
          {FORMATS.map(f => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                  format === f.id
                    ? 'bg-[#4a7dff]/20 text-[#4a7dff] border border-[#4a7dff]/30'
                    : 'text-slate-800 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon size={12} />
                <span className="hidden sm:inline">{T(getLang(), f.label)}</span>
              </button>
            );
          })}
        </div>
        {/* Duration Selector */}
        <div className="flex items-center gap-1 p-1 bg-slate-50 rounded-xl border border-slate-200">
          {[5, 10, 15, 30].map(d => (
            <button
              key={d}
              onClick={() => setDuration(d)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                duration === d
                  ? 'bg-[#4a7dff]/20 text-[#4a7dff] border border-[#4a7dff]/30'
                  : 'text-slate-800 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              {d}s
            </button>
          ))}
        </div>
      </div>

{/* Step Indicator */}
        <div className="flex items-center justify-center gap-1 px-4 py-2.5 border-b border-slate-200 bg-slate-50">
          {STEPS.map((s, i) => {
            return (
              <React.Fragment key={s.n}>
                {i > 0 && <div className={`w-8 h-px ${step > s.n ? 'bg-[#4a7dff]/60' : 'bg-slate-200/10'}`} />}
                <button
                  onClick={() => s.n < step && setStep(s.n)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                    step === s.n
                      ? 'bg-[#4a7dff]/15 text-[#4a7dff] border border-[#4a7dff]/30'
                      : step > s.n
                        ? 'text-emerald-400 hover:bg-slate-100'
                        : 'text-slate-600'
                  }`}
                  title={s.n < step ? (lang === 'vi' ? 'Quay lại bước này' : 'Go back to this step') : T(getLang(), s.label)}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                    step > s.n ? 'bg-emerald-500 text-white' : step === s.n ? 'bg-[#4a7dff] text-white' : 'bg-slate-200/10 text-slate-500'
                  }`}>
                    {step > s.n ? '✓' : s.n}
                  </span>
                  <span className="hidden sm:inline">{T(getLang(), s.label)}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

      {/* Status Warning */}
      {status && !ready && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-start gap-2">
          <Info size={13} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[10px] text-amber-200/80 leading-relaxed">
            {T(getLang(), 'Chưa cấu hình render video (thiếu ffmpeg hoặc Chrome/Chromium). Trên server: chạy')} <code className="bg-black/30 px-1 py-0.5 rounded font-mono text-[9px]">npx playwright install chromium</code> {T(getLang(), 'trong Backend. Bạn vẫn xem được preview.')}
          </p>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {/* Step 1: Pick Template */}
        {step === 1 && (
          <div className="p-5 max-w-5xl mx-auto">
            <div className="text-center mb-5">
              <h2 className="text-lg font-bold text-white">{T(getLang(), 'Chọn mẫu video')}</h2>
              <p className="text-[11px] text-slate-500 mt-1">{T(getLang(), 'Bấm chọn mẫu — sau đó điền nội dung của bạn')}</p>
            </div>

            {/* Tạo video bằng AI (free) — HF Spaces */}
            <div className="mb-6 rounded-2xl border border-[#4a7dff]/30 bg-[#4a7dff]/5 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={14} className="text-[#4a7dff]" />
                <p className="text-xs font-bold text-slate-800">{T(getLang(), 'Tạo video bằng AI (miễn phí)')}</p>
              </div>
              <p className="text-[10px] text-slate-500 mb-3">
                {T(getLang(), 'Mô tả cảnh bạn muốn — AI dựng video MP4. Dán URL ảnh để làm video từ ảnh (image → video).')}
              </p>
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={2}
                placeholder={t(lang, 'phVcPrompt')}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#4a7dff]/30"
              />
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <label className="text-[10px] text-slate-500 whitespace-nowrap">{T(getLang(), 'Số cảnh (1 cảnh ≈ 3 giây):')}</label>
                <select
                  value={aiScenes}
                  onChange={(e) => setAiScenes(parseInt(e.target.value, 10) || 1)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#4a7dff]/30"
                >
                  {[1, 2, 3, 4, 6].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {aiScenes > 1 && (
                  <span className="text-[10px] text-[#4a7dff]">
                    {T(getLang(), 'Kể truyện ngắn — AI tự chia')} {aiScenes} {T(getLang(), 'cảnh rồi ghép thành video ~')}{aiScenes * 3} {T(getLang(), 'giây')}
                  </span>
                )}
              </div>
              <div className="flex flex-col sm:flex-row gap-2 mt-2">
                <input
                  value={aiImageUrl}
                  onChange={(e) => setAiImageUrl(e.target.value)}
                  placeholder={t(lang, 'phVcImg')}
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#4a7dff]/30"
                />
                <button
                  onClick={handleAiVideo}
                  disabled={aiBusy}
                  className={`px-5 py-2 rounded-lg text-xs font-bold text-white shadow transition-all active:scale-95 ${aiBusy ? 'bg-slate-400 cursor-not-allowed' : 'bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff]'}`}
                >
                  {aiBusy ? T(getLang(), 'Đang tạo...') : T(getLang(), 'Tạo video AI')}
                </button>
              </div>
              {renderProgress && aiBusy && <p className="text-[10px] text-slate-500 mt-2">{renderProgress}</p>}
            </div>

            {/* Category Filter */}
            <div className="flex items-center justify-center gap-2 mb-5">
              {CATEGORIES.map(c => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCategory(c.id)}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-medium transition-all ${
                      category === c.id
                        ? 'bg-[#4a7dff]/15 text-[#4a7dff] border border-[#4a7dff]/30'
                        : 'bg-slate-50 text-slate-800 border border-slate-200 hover:text-slate-900 hover:border-slate-300'
                    }`}
                  >
                    <Icon size={12} />
                    {T(getLang(), c.label)}
                  </button>
                );
              })}
            </div>

            {/* Template Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredTemplates.map(t => {
                const previewHtml = t.build(t.fields.reduce((a, f) => ({ ...a, [f.key]: T(getLang(), f.default) }), {}), duration);
                const previewSrc = `data:text/html;base64,${utf8ToBase64(previewHtml)}`;
                return (
                  <button
                    key={t.id}
                    onClick={() => openPreview(t)}
                    className={`group rounded-2xl overflow-hidden border transition-all text-left active:scale-[0.98] ${
                      selectedTemplate.id === t.id
                        ? 'border-[#4a7dff]/60 ring-2 ring-[#4a7dff]/30 shadow-lg shadow-[#4a7dff]/10'
                        : 'border-slate-200 hover:border-[#4a7dff]/40 hover:shadow-lg hover:shadow-[#4a7dff]/5'
                    }`}
                  >
                    {/* Video Preview */}
                    <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
                      <iframe
                        src={previewSrc}
                        className="w-full h-full border-0 pointer-events-none"
                        sandbox="allow-scripts"
                        loading="lazy"
                        title={T(getLang(), t.name)}
                      />
                      {/* Play Button Overlay */}
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/30">
                        <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center shadow-xl">
                          <Play size={24} className="text-gray-900 ml-1" fill="currentColor" />
                        </div>
                      </div>
                      {/* Duration Badge */}
                      <span className="absolute bottom-2 right-2 px-2 py-0.5 bg-slate-900/75 rounded text-[10px] text-white font-medium">0:{String(duration).padStart(2, '0')}</span>
                      {/* Selected Badge */}
                      {selectedTemplate.id === t.id && (
                        <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#4a7dff] text-white text-xs font-bold flex items-center justify-center shadow-lg">✓</span>
                      )}
                    </div>
                    {/* Info */}
                    <div className="px-4 py-3 bg-slate-50">
                      <p className="text-xs font-bold text-slate-800">{T(getLang(), t.name)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{T(getLang(), t.desc)}</p>
                    </div>
                  </button>
                );
              })}
            </div>

<div className="flex justify-center mt-6">
               <button
                 onClick={() => setStep(2)}
                 className="px-8 py-3 rounded-xl bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff] text-white font-bold text-sm shadow-lg shadow-[4a7dff]/20 transition-all flex items-center gap-2 active:scale-95"
               >
                 {T(getLang(), 'Chọn mẫu này')} <ArrowRight size={16} />
               </button>
             </div>
          </div>
        )}

        {/* Step 2: Edit Fields */}
        {step === 2 && (
          <div className="p-5 max-w-2xl mx-auto">
<div className="flex items-center justify-between mb-4">
               <div>
                 <h2 className="text-base font-bold text-slate-800">{T(getLang(), 'Nhập nội dung')}</h2>
                 <p className="text-[11px] text-slate-500 mt-0.5">
                   {T(getLang(), 'Mẫu:')} <span className="text-[#4a7dff]">{T(getLang(), selectedTemplate.name)}</span>
                 </p>
               </div>
               <button onClick={() => setStep(1)} className="text-[11px] text-slate-400 hover:text-slate-800 flex items-center gap-1 transition-colors">
                 <ArrowLeft size={12} /> {T(getLang(), 'Đổi mẫu')}
               </button>
             </div>
            <div className="space-y-3">
{selectedTemplate.fields.map(f => (
                 <div key={f.key} className="space-y-1.5">
                   <label className="text-[11px] font-semibold text-slate-600">{T(getLang(), f.label)}</label>
                   <input
                     type="text"
                     value={fields[f.key] ?? T(getLang(), f.default)}
                     onChange={e => updateField(f.key, e.target.value)}
                     placeholder={T(getLang(), f.placeholder)}
                     className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder-slate-500 outline-none focus:border-[#4a7dff]/50 focus:ring-2 focus:ring-[4a7dff]/10 transition-all"
                   />
                 </div>
               ))}
            </div>
<div className="flex justify-between mt-6">
               <button onClick={() => setStep(1)} className="px-5 py-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold transition-all flex items-center gap-2 active:scale-95">
                 <ArrowLeft size={14} /> {T(getLang(), 'Quay lại')}
               </button>
               <button onClick={() => setStep(3)} className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff] text-white text-xs font-bold shadow-lg shadow-[4a7dff]/20 transition-all flex items-center gap-2 active:scale-95">
                 {T(getLang(), 'Xem trước')} <ArrowRight size={14} />
               </button>
             </div>
          </div>
        )}

        {/* Step 3: Preview & Render */}
        {step === 3 && (
          <div className="p-5 max-w-4xl mx-auto">
<div className="flex items-center justify-between mb-3">
               <div>
                 <h2 className="text-base font-bold text-slate-800">{T(getLang(), 'Xem trước video')}</h2>
                 <p className="text-[11px] text-slate-500 mt-0.5">
                   {T(getLang(), selectedFormat.label)} • {selectedFormat.w}×{selectedFormat.h}
                 </p>
               </div>
               <button onClick={() => setStep(2)} className="text-[11px] text-slate-400 hover:text-slate-800 flex items-center gap-1 transition-colors">
                 <ArrowLeft size={12} /> {T(getLang(), 'Sửa nội dung')}
               </button>
             </div>

{/* Preview */}
             <div className="rounded-2xl overflow-hidden bg-slate-50 border border-slate-200 shadow-2xl">
               <div style={{ aspectRatio: `${selectedFormat.w}/${selectedFormat.h}` }}>
                 <iframe
                   src={previewSrc}
                   className="w-full h-full border-0"
                   sandbox="allow-scripts"
                   title="Preview"
                   style={{ pointerEvents: 'none' }}
                 />
               </div>
             </div>

{/* Render Controls */}
             <div className="mt-4 p-4 bg-slate-50 rounded-2xl border border-slate-200">
               {renderProgress ? (
                 <div className="flex items-center gap-3">
                   <Loader2 size={18} className="animate-spin text-[4a7dff]" />
                   <span className="text-sm text-[4a7dff]">{renderProgress}</span>
                 </div>
               ) : videoUrl ? (
                 <div className="flex items-center gap-4">
                   <div className="w-16 h-10 rounded-lg overflow-hidden bg-slate-50 border border-slate-200 shrink-0">
                     <video src={videoUrl} className="w-full h-full object-cover" muted />
                   </div>
                   <div className="flex-1 min-w-0">
                     <p className="text-sm font-bold text-emerald-300">{T(getLang(), 'Video đã render xong!')}</p>
                     <p className="text-[10px] text-slate-500">{T(getLang(), selectedFormat.label)} • {selectedFormat.w}×{selectedFormat.h} • {(videoSize / 1024 / 1024).toFixed(1)}MB</p>
                   </div>
                   <button onClick={handleDownload} className="px-5 py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5 hover:bg-emerald-500/30 transition-all active:scale-95">
                     <Download size={14} /> {T(getLang(), 'Tải MP4')}
                   </button>
                 </div>
               ) : (
                 <div className="flex items-center justify-between flex-wrap gap-3">
                   <p className="text-[11px] text-slate-500">{T(getLang(), 'Sẵn sàng render. Bấm nút để tạo file MP4 (mất 30-60 giây).')}</p>
                   <button
                     onClick={handleRender}
                     disabled={rendering}
                     className="px-8 py-3 rounded-xl bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff] text-white font-bold text-sm shadow-lg shadow-[4a7dff]/20 disabled:opacity-50 transition-all flex items-center gap-2 active:scale-95"
                   >
                     {rendering ? <Loader2 size={16} className="animate-spin" /> : <Video size={16} />}
                     {rendering ? T(getLang(), 'Đang render...') : T(getLang(), 'Render MP4')}
                   </button>
                 </div>
               )}
             </div>
          </div>
        )}

{/* Step 4: Done */}
         {step === 4 && (
           <div className="p-8 max-w-md mx-auto text-center">
             <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-4">
               <Check size={32} className="text-emerald-400" />
             </div>
              <h2 className="text-lg font-bold text-slate-800">{T(getLang(), 'Video đã xong!')}</h2>
              <p className="text-[11px] text-slate-500 mt-1.5">
                {T(getLang(), 'Bấm nút bên dưới để tải file MP4 về thư mục Downloads.')}
              </p>
              {!downloaded && (
                <p className="text-[11px] text-amber-600 mt-2 flex items-center justify-center gap-1.5">
                  <Info size={12} /> {T(getLang(), 'Video chỉ tồn tại trong phiên này — hãy tải về máy trước khi rời trang.')}
                </p>
              )}
             <div className="mt-5 space-y-2.5">
               <button
                 onClick={handleDownload}
                 className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-bold text-sm shadow-lg shadow-emerald-500/20 transition-all flex items-center justify-center gap-2 active:scale-95"
               >
                 <Download size={16} /> {T(getLang(), 'Tải video MP4')}
               </button>
               <button
                 onClick={startOver}
                 className="w-full py-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold transition-all active:scale-95"
               >
                 {T(getLang(), 'Tạo video khác')}
               </button>
             </div>
           </div>
         )}
      </div>

{/* Footer - Advanced HTML */}
       <div className="border-t border-slate-200 bg-slate-50">
         <button
           onClick={() => setShowAdvanced(!showAdvanced)}
           className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] text-slate-800 hover:text-slate-600 transition-colors"
         >
           <Code size={11} /> {showAdvanced ? T(getLang(), 'Ẩn code') : T(getLang(), 'Chế độ code (nâng cao)')}
         </button>
         {showAdvanced && (
           <div className="px-4 pb-3 flex gap-2">
             <div className="flex-1">
               <textarea
                 value={advHtml || html}
                 onChange={e => { setAdvHtml(e.target.value); }}
                 rows={6}
                 className="w-full p-3 bg-slate-900 text-green-300 font-mono text-[11px] leading-relaxed outline-none resize-none border border-slate-200 rounded-xl placeholder-slate-500"
                 placeholder={t(lang, 'phVcHtml')}
                 spellCheck={false}
               />
             </div>
             <button
               onClick={() => { if (advHtml.trim()) setHtml(advHtml); setStep(3); }}
               className="self-end px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff] text-white text-xs font-bold shadow-lg shadow-[4a7dff]/20 transition-all active:scale-95"
             >
               {T(getLang(), 'Dùng code này')}
             </button>
           </div>
         )}
       </div>

{/* Preview Modal */}
       {previewTemplate && (
         <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50" style={{transition:'background-color .2s'}} onClick={() => setPreviewTemplate(null)}>
           <div className="bg-slate-50 rounded-2xl border border-slate-200 shadow-2xl w-[90vw] max-w-4xl overflow-hidden" onClick={e => e.stopPropagation()}>
             {/* Modal Header */}
             <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
               <div>
                 <h3 className="text-sm font-bold text-slate-800">{T(getLang(), previewTemplate.name)}</h3>
                 <p className="text-[10px] text-slate-500">{T(getLang(), previewTemplate.desc)}</p>
               </div>
               <button onClick={() => setPreviewTemplate(null)} className="w-8 h-8 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-600 hover:text-slate-800 transition-all">
                 ✕
               </button>
             </div>
             {/* Preview Area */}
             <div className="p-5">
               <div className="rounded-xl overflow-hidden bg-slate-50 border border-slate-200" style={{ aspectRatio: '16/9' }}>
                 <iframe
                   src={`data:text/html;base64,${utf8ToBase64(previewTemplate.build(previewTemplate.fields.reduce((a, f) => ({ ...a, [f.key]: T(getLang(), f.default) }), {}), duration))}`}
                   className="w-full h-full border-0"
                   sandbox="allow-scripts"
                   title={T(getLang(), previewTemplate.name)}
                 />
               </div>
             </div>
             {/* Modal Footer */}
             <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200">
               <p className="text-[10px] text-slate-500">{T(getLang(), 'Thời lượng: ')}{duration}s • {T(getLang(), selectedFormat.label)} ({selectedFormat.w}×{selectedFormat.h})</p>
               <div className="flex gap-2">
                 <button onClick={() => setPreviewTemplate(null)} className="px-4 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-300 text-xs font-semibold transition-all">
                   {T(getLang(), 'Đóng')}
                 </button>
                 <button onClick={() => pickTemplate(previewTemplate)} className="px-5 py-2 rounded-xl bg-gradient-to-r from-[#4a7dff] to-[#3d6ae6] hover:from-[#3d6ae6] hover:to-[#4a7dff] text-white text-xs font-bold shadow-lg shadow-[4a7dff]/20 transition-all flex items-center gap-1.5">
                   {T(getLang(), 'Chọn mẫu này')} <ArrowRight size={14} />
                 </button>
               </div>
             </div>
           </div>
         </div>
       )}
    </div>
  );
}
