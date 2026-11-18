// edgeTTS DRM v2 — port tu rany2/edge-tts drm.py (issue #290)
// Token v2 = "<CS64 16hex>-<SHA256 64hex>", Sec-MS-GEC-Version = "2-<chromium full>"
const crypto = require("crypto");

const WIN_EPOCH = 11644473600n;
const U32 = 0xFFFFFFFFn;

const CS64_COEFFICIENTS = [
  [0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn], [0x3BEB65BCn, 0x29514038n],
  [0xC89C5933n, 0xB328CBDFn], [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn],
  [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn], [0x06064CF3n, 0xFA51A3DAn],
  [0xDA79FA60n, 0x207CC464n], [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n],
  [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJ0 = 0xF2F90B1An;
const CS64_ADJ1 = 0x0B1A0000n;

function rol16(v) { v &= U32; return ((v << 16n) | (v >> 16n)) & U32; }

function wordsLE4Even(buf) {
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const keyA = BigInt(digest.readUInt32LE(0)) | 1n;
  const keyB = BigInt(digest.readUInt32LE(4)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & U32, (keyB * CS64_FACTOR) & U32];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => (coef * factors[i % 2]) & U32);
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  const words = wordsLE4Even(Buffer.concat([Buffer.from([0]), data]));
  for (let i = 0; i < words.length; i++) {
    const word = BigInt(words[i]);
    let term = (word * (i % 2 === 0 ? keyA : keyB)) & U32;
    let offset = (rol16(word) * (i % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn)) & U32;
    if (i === 0) { term = (term + CS64_ADJ0 * factors[0]) & U32; offset = (offset + CS64_ADJ1) & U32; }
    terms.push(term); offsets.push(offset);
  }
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & U32);
    let q = (t * 0x76F50F34n) & U32;
    swapAcc = (swapAcc + (rol16(q) * 0xC3EFEA97n + q)) & U32;
    t = rol16((offsets[i + 1] + y) & U32);
    q = (t * 0x1881CE3Cn) & U32;
    swapLast = (rol16(q) * 0x35BD1EC9n + q) & U32;
    swapAcc = (swapAcc + swapLast) & U32;
    state = (state * keyA + x) & U32;
    state = (rol16(state) * 0xCF98B111n) & U32;
    state = (rol16(state) * 0x87085B9Fn) & U32;
    state = (rol16(state) * 0x12CEB96Dn) & U32;
    state = (rol16(state) * 0x257E1D83n) & U32;
    acc = (acc + state) & U32;
    t = (state * keyB + y) & U32;
    t = (rol16(t) * 0xA27416F5n) & U32;
    t = (rol16(t) * 0xD38396FFn) & U32;
    state = (rol16((rol16(t) * 0x7C932B89n) & U32) * 0xBFA49F69n) & U32;
    acc = (acc + state) & U32;
  }
  return [(swapLast ^ state) & U32, (swapAcc ^ acc) & U32];
}

function generateSecMsGecV2(unixTimestampSec) {
  let ticks = BigInt(Math.floor((unixTimestampSec || Date.now() / 1000)));
  ticks += WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const data = Buffer.from(`${ticks.toString()}6A5AA1D4EAFF4E9FB37E23D68491D6F4`, "ascii");
  const digest = crypto.createHash("sha256").update(data).digest();
  const [a, b] = cs64Digest(data, digest);
  const hex = (n) => n.toString(16).toUpperCase().padStart(16, "0").slice(-16);
  return `${hex(a)}-${digest.toString("hex").toUpperCase()}`;
}

module.exports = { generateSecMsGecV2 };
