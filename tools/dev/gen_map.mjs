// tools/dev/gen_map.mjs
// Sinh ban do kien truc REXI-AI tu QUET THAT repo.
// Output: STRUCTURE.md + docs/map.html (nhung JSON graph vao tools/dev/map.template.html)
// Chay: node tools/dev/gen_map.mjs   (tu project root)
// KHONG sua tay output - se bi ghi de.

import fs from 'fs';
import path from 'path';

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const TEMPLATE = path.join(ROOT, 'tools', 'dev', 'map.template.html');
const OUT_MAP = path.join(ROOT, 'docs', 'map.html');
const OUT_STRUCT = path.join(ROOT, 'STRUCTURE.md');

const SKIP_DIRS = new Set(['node_modules','.git','dist','build','.venv','venv','ocr_venv','__pycache__',
  '.agents','skills','temp','Temp','.playwright-mcp','.pw-tmp','.pw-tmp-e2e','.pw-tmp-repl','.pw-user-e2e',
  'scan_results','vendor','.next','.turbo','coverage']);
const SKIP_FILE_RE = /\.(db|png|jpe?g|gif|webp|mp3|wav|mp4|bin|exe|dll|so|wasm|map|ico|svg|ttf|woff2?|lock)$/i;

// ---------- fs helpers ----------
function walk(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; walk(full, acc); }
    else if (!SKIP_FILE_RE.test(e.name)) acc.push(full);
  }
  return acc;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const base = (p) => p.split('/').pop();

// ---------- layer classification ----------
function layerOf(r) {
  if (r === 'Frontend/index.html' || r === 'Frontend/src/main.jsx') return 'entry';
  if (r === 'Backend/server.js' || r === 'Backend/video-worker.js') return 'entry';
  if (r.startsWith('Frontend/src/components/') || r === 'Frontend/src/App.jsx' || r === 'Frontend/src/AdminPanel.jsx') return 'ui';
  if (r.startsWith('Frontend/src/')) return 'flib';
  if (r.startsWith('Backend/src/routes/')) return 'routes';
  if (r.startsWith('Backend/src/middleware/')) return 'middleware';
  if (r.startsWith('Backend/src/services/brain/')) return 'brain';
  if (r.startsWith('Backend/src/services/')) return 'services';
  if (r.startsWith('Backend/src/')) return 'butils';
  if (/^(render\.yaml|vercel\.json|package\.json|deploy\/)/.test(r)) return 'deploy';
  return 'butils';
}

// ---------- collect files ----------
const targets = [
  ['Frontend/src', ['.js', '.jsx']],
  ['Backend/src', ['.js']],
  ['Backend', ['.js']], // server.js, video-worker.js, decrypt_tokens.js...
  ['tools', ['.mjs', '.js']],
];
let files = [];
for (const [dir, exts] of targets) {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of walk(d)) {
    if (exts.some(e => f.endsWith(e))) files.push(f);
  }
}
files.push(path.join(ROOT, 'Frontend', 'index.html'));
for (const extra of ['render.yaml', 'vercel.json', 'package.json']) {
  const p = path.join(ROOT, extra); if (fs.existsSync(p)) files.push(p);
}
// dedupe
files = [...new Set(files)].filter(f => fs.existsSync(f));

const relSet = new Set(files.map(rel));

// ---------- parse each file ----------
const F = {}; // rel -> info
function countFn(src) {
  let c = 0;
  c += (src.match(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/g) || []).length;
  c += (src.match(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g) || []).length;
  c += (src.match(/router\.(?:get|post|put|delete|patch|use)\(/g) || []).length;
  return c;
}
for (const f of files) {
  const r = rel(f), src = read(f);
  const imports = [];
  for (const m of src.matchAll(/(?:import\s+[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) imports.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(m[1]);
  const endpoints = [];
  if (r.startsWith('Backend/src/routes/') || r === 'Backend/server.js') {
    for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g)) endpoints.push(m[1].toUpperCase() + ' ' + m[2]);
    for (const m of src.matchAll(/router\.use\(\s*['"`]([^'"`]+)['"`]/g)) endpoints.push('USE ' + m[1]);
    for (const m of src.matchAll(/app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g)) endpoints.push(m[1].toUpperCase() + ' ' + m[2]);
  }
  const calls = new Set();
  for (const m of src.matchAll(/(?:apiFetch|apiFetchPublic|fetch)\(\s*[`'"]([^`'"]+)/g)) {
    let p = m[1]; if (p.startsWith('/')) calls.add(p.startsWith('/api') ? p : '/api' + p);
  }
  for (const m of src.matchAll(/[`'"](\/api\/[A-Za-z0-9_\/:\-\.]+)[`'"]/g)) calls.add(m[1]);
  F[r] = {
    rel: r, layer: layerOf(r), size: Buffer.byteLength(src), loc: src.split('\n').length,
    functions: countFn(src), imports: [...new Set(imports)], endpoints: [...new Set(endpoints)],
    calls: [...calls], src
  };
}

// ---------- resolve local imports ----------
function resolveImport(fromRel, spec) {
  let s = spec;
  if (s.startsWith('@/')) s = path.posix.join('Frontend/src', s.slice(2));
  if (!s.startsWith('.') && !s.startsWith('Frontend/') && !s.startsWith('Backend/')) return null;
  let p = s.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), s)) : s;
  for (const cand of [p, p + '.js', p + '.jsx', p + '/index.js', p + '/index.jsx', p + '.mjs']) {
    if (relSet.has(cand)) return cand;
  }
  return null;
}

// ---------- server.js mounts ----------
const serverPath = path.join(ROOT, 'Backend', 'server.js');
const serverSrc = read(serverPath);
const varToFile = {};
for (const m of serverSrc.matchAll(/const\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  const res = resolveImport('Backend/server.js', m[2].startsWith('.') ? path.posix.join('Backend/src', m[2].replace(/^\.\//, '')) : m[2]);
  varToFile[m[1]] = res || m[2];
}
// better: resolve requires relative to Backend/
for (const m of serverSrc.matchAll(/const\s+(\w+)\s*=\s*require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
  const cand = path.posix.normalize(path.posix.join('Backend', m[2]));
  const hit = [cand, cand + '.js', cand + '/index.js'].find(x => relSet.has(x));
  if (hit) varToFile[m[1]] = hit;
}
const mounts = []; // {mount, file}
const mountToFile = {};
for (const m of serverSrc.matchAll(/app\.use\(\s*['"`](\/api\/[^'"`]+)['"`]\s*,\s*(\w+)/g)) {
  const file = varToFile[m[2]] || ('(server) ' + m[2]);
  mounts.push({ mount: m[1], file });
  if (relSet.has(file)) mountToFile[m[1]] = file;
}

// ---------- build nodes ----------
const nodes = [];
const addNode = (n) => nodes.push(n);
for (const r in F) {
  const f = F[r];
  addNode({
    id: r, label: base(r), short: base(r), layer: f.layer, path: r, type: r.split('.').pop(),
    size: f.size, loc: f.loc, functions: f.functions,
    imports: f.imports.filter(i => resolveImport(r, i)),
    endpoints: f.endpoints, calls: f.calls,
    imp: (f.layer === 'entry' ? 2 : 0) + (f.size > 30000 ? 1 : 0) + (f.endpoints.length > 3 ? 1 : 0),
    searchText: (r + ' ' + f.endpoints.join(' ') + ' ' + f.calls.join(' ')).toLowerCase()
  });
}
// endpoint nodes
const epId = (method, full) => 'EP:' + method + ' ' + full;
for (const r in F) {
  const f = F[r];
  if (!r.startsWith('Backend/src/routes/')) continue;
  // find mount for this file
  let mount = '';
  for (const mo of mounts) if (mo.file === r) { mount = mo.mount; break; }
  for (const ep of f.endpoints) {
    const sp = ep.indexOf(' ');
    const method = ep.slice(0, sp), p = ep.slice(sp + 1);
    const full = mount ? mount + (p === '/' ? '' : p) : p;
    const id = epId(method, full);
    if (nodes.find(n => n.id === id)) continue;
    addNode({
      id, label: method + ' ' + full, short: method + ' ' + full, layer: 'endpoint',
      method, path: full, parent: r, type: 'endpoint',
      searchText: (method + ' ' + full).toLowerCase(), imp: 1
    });
  }
}
// db table nodes
const initSrc = read(path.join(ROOT, 'Backend', 'src', 'init-db.js'));
const tables = [...new Set([...initSrc.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][\w]*)/g)].map(m => m[1]))];
for (const t of tables) addNode({ id: 'DB:' + t, label: t, short: '『' + t + '』', layer: 'db', type: 'table', searchText: ('db table ' + t).toLowerCase(), imp: 1 });

// ---------- build edges ----------
const edges = [];
const edgeSet = new Set();
function addEdge(s, t, kind) {
  if (!s || !t || s === t) return; const k = s + '|' + t + '|' + kind;
  if (edgeSet.has(k)) return; edgeSet.add(k); edges.push({ source: s, target: t, kind });
}
for (const r in F) {
  for (const i of F[r].imports) { const rr = resolveImport(r, i); if (rr) addEdge(r, rr, 'import'); }
}
for (const mo of mounts) { if (relSet.has(mo.file)) addEdge('Backend/server.js', mo.file, 'mount'); }
for (const r in F) {
  if (!r.startsWith('Backend/src/routes/')) continue;
  let mount = ''; for (const mo of mounts) if (mo.file === r) { mount = mo.mount; break; }
  for (const ep of F[r].endpoints) {
    const sp = ep.indexOf(' '); const method = ep.slice(0, sp), p = ep.slice(sp + 1);
    const full = mount ? mount + (p === '/' ? '' : p) : p;
    addEdge(r, epId(method, full), 'route');
  }
}
// API request edges: frontend call -> endpoint (matched) or route file
function patternOf(full) {
  let x = full.replace(/[:*][A-Za-z_][\w]*/g, '[^/]+').replace(/[{}]/g, '');
  x = x.replace(/\{[^}]*\}/g, '[^/]+');
  if (!x.endsWith('/')) x += '/?';
  return new RegExp('^' + x.replace(/[.+^${}()|\[\]\\]/g, m => m === '[' || m === ']' ? m : '\\' + m) + '$');
}
const epNodes = nodes.filter(n => n.layer === 'endpoint');
const apiEdges = new Set();
for (const r in F) {
  const f = F[r]; if (f.layer !== 'ui' && f.layer !== 'flib') continue;
  for (const c of f.calls) {
    const full = c.replace(/\/+$/, '');
    let hit = null;
    for (const en of epNodes) {
      if (en.path.replace(/\/+$/, '') === full) { hit = en.id; break; }
      try { if (patternOf(en.path).test(full)) { hit = en.id; break; } } catch {}
    }
    if (hit) { if (!apiEdges.has(r + '>' + hit)) { apiEdges.add(r + '>' + hit); addEdge(r, hit, 'api'); } }
    else {
      // attach to route file by prefix
      const seg = full.split('/')[2]; // after /api
      let rf = null;
      for (const m in mountToFile) if (m === '/api/' + seg) rf = mountToFile[m];
      if (rf) { if (!apiEdges.has(r + '>' + rf)) { apiEdges.add(r + '>' + rf); addEdge(r, rf, 'api'); } }
    }
  }
}

// ---------- route file -> service deps already captured via import edges ----------

// ---------- write STRUCTURE.md ----------
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const layerNames = { entry:'Entry / khởi động', ui:'Frontend UI', flib:'Frontend lib & utils',
  routes:'Backend routes', endpoint:'API request', middleware:'Middleware', services:'Backend services',
  brain:'Brain (AI/memory/NLP)', butils:'Backend utils/config/scheduler', deploy:'Deploy / runtime', db:'DB tables' };
const byLayer = {}; nodes.forEach(n => (byLayer[n.layer] = byLayer[n.layer] || []).push(n));

const L = [];
L.push('# REXI-AI — Bản đồ kiến trúc');
L.push('');
L.push('> **TỰ SINH** bởi `tools/dev/gen_map.mjs` từ quét repo thật — **KHÔNG sửa tay** (sẽ bị ghi đè).');
L.push('> Cập nhật: `node tools/dev/gen_map.mjs` (từ project root). Bản đồ tương tác 2D/3D: [`docs/map.html`](docs/map.html).');
L.push('> Sinh lúc: `' + now + '`');
L.push('');
const nFiles = nodes.filter(n => n.layer !== 'endpoint' && n.layer !== 'db').length;
L.push('**Thống kê:** ' + nFiles + ' file/module · ' + nodes.filter(n=>n.layer==='endpoint').length + ' API request · '
  + tables.length + ' bảng DB · ' + edges.length + ' liên kết · '
  + nodes.filter(n=>n.layer==='services').length + ' service · ' + nodes.filter(n=>n.layer==='ui').length + ' UI component.');
L.push('');

L.push('## 1. Sơ đồ tầng (luồng dữ liệu)');
L.push('');
L.push('```mermaid');
L.push('flowchart TD');
L.push('  subgraph CLIENT["🖥️ Client (trình duyệt)"]');
L.push('    HTML["Frontend/index.html"] --> MAIN["src/main.jsx"]');
L.push('    MAIN --> APP["App.jsx"]');
L.push('    APP --> UI["components/* (màn hình tab)"]');
L.push('    APP --> ADMIN["AdminPanel.jsx"]');
L.push('    UI --> LIB["config.js · i18n.js · utils"]');
L.push('  end');
L.push('  subgraph SRV["⚙️ Backend (Node/Express)"]');
L.push('    SERVER["server.js (Express + Helmet + Session + WS)"]');
L.push('    MW["middleware (auth · rateLimit · audit · session)"]');
L.push('    ROUTES["src/routes/* (API)"]');
L.push('    SVC["src/services/*"]');
L.push('    BRAIN["src/services/brain/* (RAG · memory · NLP)"]');
L.push('    UTIL["src/utils · config · scheduler"]');
L.push('    SERVER --> MW --> ROUTES --> SVC');
L.push('    SVC --> BRAIN');
L.push('    ROUTES --> UTIL');
L.push('    SVC --> UTIL');
L.push('  end');
L.push('  subgraph DATA["🗄️ Dữ liệu"]');
L.push('    PG[("PostgreSQL (prod, DB_TYPE=postgresql)")]');
L.push('    SQLITE[("SQLite (local dev)")]');
L.push('  end');
L.push('  subgraph EXT["🌐 Dịch vụ ngoài"]');
L.push('    LLM["AI providers (NVIDIA · Mistral · xKiro · HF…)"]');
L.push('    API["YouTube · TikTok · GitHub · HF Inference"]');
L.push('  end');
L.push('  UI -->|"/api/* (fetch, Bearer token)"| SERVER');
L.push('  SVC --> PG');
L.push('  SVC --> SQLITE');
L.push('  SVC --> LLM');
L.push('  SVC --> API');
L.push('```');
L.push('');

L.push('## 2. Mount API (server.js → routes), & luồng request');
L.push('');
L.push('| Mount | Route file | Endpoints |');
L.push('|---|---|---|');
for (const mo of mounts) {
  const cnt = (F[mo.file]?.endpoints || []).length;
  L.push('| `' + mo.mount + '` | `' + mo.file + '` | ' + cnt + ' |');
}
L.push('');
L.push('Request đi từ **ui/flib → /api/… → middleware → route → service → DB/AI**. Mọi call `apiFetch()` ở frontend tự gắn `Authorization: Bearer <token>` (xem `Frontend/src/config.js`).');
L.push('');

for (const layer of ['entry','ui','flib','routes','middleware','services','brain','butils','deploy']) {
  const arr = (byLayer[layer] || []).slice().sort((a,b)=>b.size-a.size);
  if (!arr.length) continue;
  L.push('## ' + layerNames[layer] + ' (' + arr.length + ')');
  L.push('');
  L.push('| File | Dòng | Hàm≈ | KB | Endpoints | Import nội bộ |');
  L.push('|---|---:|---:|---:|---:|---|');
  for (const n of arr) {
    const f = F[n.id];
    L.push('| `' + n.path + '` | ' + (n.loc||'') + ' | ' + (typeof n.functions==='number'?n.functions:'') + ' | '
      + ((n.size||0)/1024).toFixed(1) + ' | ' + ((f?.endpoints||[]).length || '') + ' | '
      + ((n.imports||[]).length || '') + ' |');
  }
  L.push('');
}

// endpoint full table
L.push('## 3. API Request (method + path) theo router (' + nodes.filter(n=>n.layer==='endpoint').length + ')');
L.push('');
for (const mo of mounts) {
  const eps = nodes.filter(n => n.layer === 'endpoint' && n.parent === mo.file);
  if (!eps.length) continue;
  L.push('### `' + mo.mount + '` — `' + mo.file + '`');
  L.push('');
  for (const e of eps) L.push('- `' + e.method + ' ' + e.path + '`');
  L.push('');
}

L.push('## 4. Bảng dữ liệu DB (' + tables.length + ')');
L.push('');
L.push([...tables].sort().map(t => '`' + t + '`').join(' · '));
L.push('');
L.push('> Schema khai báo ở `Backend/src/init-db.js` (CREATE TABLE IF NOT EXISTS khi khởi động). Prod dùng PostgreSQL (Supabase) qua `DB_TYPE=postgresql`; local dùng SQLite.');
L.push('');

L.push('## 5. Deploy / runtime');
L.push('');
L.push('- `render.yaml` — service `rexi-ai-backend` (Render free, oregon, Node 24). Build: `Backend npm i` → `npx playwright install chromium` → `Frontend npm i && npm run build`. Start: `cd Backend && node server.js`.');
L.push('- Backend phục vụ luôn `Frontend/dist` (SPA). Health check: `GET /api/health`.');
L.push('- Prod env (Postgres, JWT_SECRET, ADMIN_*, HF_TOKEN…): `docs/PROD-ENV.md`.');
L.push('- Domain: https://rexiai.bot.cd');
L.push('');

fs.writeFileSync(OUT_STRUCT, L.join('\n'), 'utf8');

// ---------- write map.html ----------
const data = {
  generated: now,
  nodes: nodes.map(n => ({ id:n.id, label:n.label, short:n.short, layer:n.layer, path:n.path,
    method:n.method, type:n.type, size:n.size, loc:n.loc, functions:n.functions,
    imports:(n.imports||[]).map(i => { const r = resolveImport(n.path, i); return r || i; }),
    endpoints:n.endpoints, calls:n.calls, imp:n.imp, searchText:n.searchText })),
  edges
};
let tpl = read(TEMPLATE);
if (!tpl) { console.error('MISSING template: ' + TEMPLATE); process.exit(1); }
const html = tpl.replace('/*__MAP_DATA__*/null', JSON.stringify(data));
fs.mkdirSync(path.dirname(OUT_MAP), { recursive: true });
fs.writeFileSync(OUT_MAP, html, 'utf8');

console.log('OK  files=' + nFiles + '  nodes=' + nodes.length + '  edges=' + edges.length
  + '  endpoints=' + nodes.filter(n=>n.layer==='endpoint').length + '  tables=' + tables.length);
console.log('    -> ' + rel(OUT_STRUCT));
console.log('    -> ' + rel(OUT_MAP));
