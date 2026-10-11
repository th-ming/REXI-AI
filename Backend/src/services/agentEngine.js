/**
 * Agent Engine Service — chạy Agent Mode qua 2 engine: opencode hoặc DeepSeek Harness (dsh).
 * Được dùng bởi chat.routes.js (cả 2 endpoint messages + messages/stream).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { stripAnsi, AnsiStreamCleaner } = require('../utils/stripAnsi');

// ── opencode ──────────────────────────────────────────────
const OPENCODE_BIN_PATH = process.env.OPENCODE_BIN_PATH ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.opencode', 'bin', 'opencode.exe') : '');
const IS_OPENCODE_AVAILABLE = fs.existsSync(OPENCODE_BIN_PATH);

// ── DeepSeek Harness (dsh) ────────────────────────────────
// Ưu tiên: dsh trong PATH (đã cài global), fallback: npx
function findDshCmd() {
  if (process.env.DSH_BIN_PATH && fs.existsSync(process.env.DSH_BIN_PATH)) return process.env.DSH_BIN_PATH;
  const candidates = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'npm-global', 'dsh.cmd') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'dsh.cmd') : null,
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return 'dsh'; // nếu trong PATH thì dùng trực tiếp
}
const DSH_BIN = findDshCmd();
const DSH_PATCH_FILE = path.join(__dirname, '..', 'config', 'dsh-agent-patch.yml');
const DSH_SETTINGS = path.join(process.env.USERPROFILE || '', '.dsh', 'settings.yaml');
// Kha dung khi: co patch tinh + (settings cua user HOAC home tu quan + node bin).
// Home tu quan (dsh-home-template) khong can ~/.dsh cua user.
const IS_DSH_AVAILABLE = fs.existsSync(DSH_PATCH_FILE) && (fs.existsSync(DSH_SETTINGS) ||
  (fs.existsSync(path.join(__dirname, '..', '..', 'dsh-home-template', 'profiles', 'headless', 'package.json')) && !!findDshNodeBin()));

// dsh.cmd chỉ là shim gọi `node lib/bin.js`. Spawn node TRỰC TIẾP để tránh
// cmd.exe parse quote kép làm gãy arg có dấu cách (vd "D:\Rexi AI\...patch.yml").
// Spawn array + shell:false vốn đã miễn nhiễm tiêm lệnh, không cần cmd.exe.
function findDshNodeBin() {
  const fromCmd = (() => {
    try {
      const dir = path.dirname(findDshCmd());
      const c = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
    return null;
  })();
  if (fromCmd) return fromCmd;
  const local = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(local)) return local;
  return null;
}

const NO_COLOR_ENV = { ...process.env, LANG: 'en_US.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CLICOLOR: '0', CLICOLOR_FORCE: '0' };

// ── dsh: patch ĐỘNG theo model user chọn (như opencode -m) ─────────────
// dsh-agent-patch.yml tĩnh chốt cứng xkiro/deepseek-v4-pro. Ở đây sinh thêm
// 1 patch overlay (--patch repeatable, cái sau thắng) với provider+model
// user pick: override `llm` (route OpenAI-compatible) + `agent-default-model`.
const DSH_OAI_PROVIDERS = {
  xkiro: 'https://api.xkiro.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  unorouter: 'https://api.unorouter.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  bai: 'https://api.b.ai/v1',
  kiosapi: 'https://router.kiosapi.com/v1',
  grok: 'https://api.x.ai/v1',
  xagentrouter: 'https://agentrouter.org/v1',
  mintrouter: 'https://mintrouter.ai/v1',
};

// Tên env chứa key cho route dsh (chat.routes set từ khoa_api). Phải khớp 2 đầu.
function dshKeyEnvName(provider) {
  return 'REXI_' + String(provider || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
}

// Route key trong settings dsh: namespace `rexi-` để KHÔNG đụng settings.yaml
// của user (settings user merge vào và thắng khi trùng tên route — verify:
// route `xkiro` bị settings user đè mất model, route lạ `rexitest` chạy OK).
function dshRouteName(provider) {
  return 'rexi-' + String(provider || '').toLowerCase();
}

// Resolve provider cho dsh: hint (user pick) → ai_models → 'xkiro' (giữ hành vi cũ).
async function resolveDshProvider(modelId, hint) {
  const h = String(hint || '').trim().toLowerCase();
  if (h && DSH_OAI_PROVIDERS[h]) return h;
  const m = String(modelId || '').trim();
  if (m) {
    try {
      const db = require('../config/db');
      const short = m.includes('/') ? m.split('/').pop() : m;
      const rows = await new Promise((res) => db.all(
        'SELECT ma_nha_cung_cap FROM ai_models WHERE (LOWER(ma_model) = LOWER(?) OR LOWER(ma_model) = LOWER(?)) AND kich_hoat = 1 ORDER BY thu_tu_hien_thi LIMIT 1',
        [m, short], (e, r) => res(e ? [] : (r || []))));
      if (rows.length) {
        const p = String(rows[0].ma_nha_cung_cap).toLowerCase();
        if (DSH_OAI_PROVIDERS[p]) return p;
      }
    } catch { /* ignore → fallback xkiro */ }
  }
  return 'xkiro';
}

// Sinh file patch yml tạm cho 1 lần chạy dsh. Trả null nếu provider/model không dùng được
// (giữ hành vi cũ: chỉ patch tĩnh). Caller tự xóa file sau khi process đóng.
function buildDshDynamicPatch(provider, modelId) {
  // Chi override agent-default-model. Providers do settings.yaml cua DSH_HOME
  // tam cung cap (buildDshHome) — khai trung route o ca patch lan settings
  // lam route rot dang ky (NO_ADAPTER).
  const p = String(provider || '').toLowerCase();
  const route = DSH_OAI_PROVIDERS[p] ? dshRouteName(p) : null;
  const model = String(modelId || '').trim();
  if (!route || !model) return null;
  const q = (s) => JSON.stringify(s);
  const yml = [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${q(route)}`,
    `    model: ${q(model)}`,
    '',
  ].join('\n');
  try {
    const f = path.join(os.tmpdir(), `rexi-dsh-${Date.now()}-${Math.floor(Math.random() * 1e6)}.yml`);
    fs.writeFileSync(f, yml, 'utf8');
    return f;
  } catch { return null; }
}

function cleanupTmpPatches(files) {
  for (const f of files || []) {
    try {
      const st = fs.statSync(f);
      if (st.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
      else fs.unlinkSync(f);
    } catch { /* ignore */ }
  }
}

// ── DSH_HOME do backend quản lý (1 home tạm/request) ───────────────────
// settings.yaml thắng --patch cho `providers`, nên route+model user chọn phải
// nằm trong settings của home tạm này. Key qua env (REXI_<PROV>_KEY), không
// secret trong file. Không động vào ~/.dsh của user, an toàn concurrent.
const DSH_TEMPLATE_DIR = path.join(__dirname, '..', '..', 'dsh-home-template');
function buildDshHome(provider, modelId) {
  const p = String(provider || '').toLowerCase();
  const route = DSH_OAI_PROVIDERS[p] ? dshRouteName(p) : null;
  const model = String(modelId || '').trim();
  if (!route || !model) return null;
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rexi-dsh-home-'));
    const prof = path.join(home, 'profiles', 'headless');
    fs.mkdirSync(prof, { recursive: true });
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      fs.copyFileSync(path.join(DSH_TEMPLATE_DIR, 'profiles', 'headless', f), path.join(prof, f));
    }
    const q = (s) => JSON.stringify(s);
    const settings = [
      '# Rexi-managed DSH_HOME (sinh dong theo model user chon).',
      'llm-pi-ai:',
      '  providers:',
      `    ${route}:`,
      `      displayName: ${q('Rexi ' + p)}`,
      `      apiKeyEnv: ${q(dshKeyEnvName(p))}`,
      '      api: openai-completions',
      `      baseURL: ${q(DSH_OAI_PROVIDERS[p])}`,
      '      models:',
      `        - id: ${q(model)}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(home, 'settings.yaml'), settings, 'utf8');
    return home;
  } catch { return null; }
}

// P2-20(4): quote arg kiểu Windows cho cmd.exe. Prompt của user (chứa `"`, `&`,
// `|`, `^`, `%`...) mà ném thẳng vào argv của cmd.exe sẽ gãy parse, thậm chí
// thoát quote → tiêm lệnh. quoteWinArg bọc quote + nhân đôi `"` trong chuỗi.
// (Bỏ hẳn cmd.exe không được: file .cmd/.bat trên Windows bắt buộc chạy qua shell.)
function quoteWinArg(a) {
  const s = String(a ?? '');
  if (!s) return '""';
  if (!/[\s"`&|<>^%!]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Spawn qua cmd.exe một cách an toàn (shell:false tường minh, /d bỏ autorun).
function spawnViaCmd(bin, args, opts) {
  const cmdLine = ['/d', '/s', '/c', [bin, ...args].map(quoteWinArg).join(' ')];
  return spawn(process.env.COMSPEC || 'cmd.exe', cmdLine, { ...opts, shell: false });
}

function isCmdShim(bin) {
  const b = String(bin || '').toLowerCase();
  return b.endsWith('.cmd') || b.endsWith('.bat');
}

/**
 * Kiểm tra engine có sẵn không.
 * @param {'opencode'|'dsh'} engine
 */
function isEngineAvailable(engine) {
  if (engine === 'dsh') return IS_DSH_AVAILABLE;
  return IS_OPENCODE_AVAILABLE;
}

/**
 * Chạy agent engine, gom stdout/stderr.
 * @param {'opencode'|'dsh'} engine
 * @param {string} prompt
 * @param {string} modelName  (chỉ opencode dùng)
 * @param {string} cwd
 * @param {object} extraEnv  (vd { XKIRO_API_KEY })
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runAgentEngine(engine, prompt, modelName, cwd, extraEnv = {}, dshProvider = '') {
  return new Promise((resolve) => {
    const env = { ...NO_COLOR_ENV, ...extraEnv };
    const rootDir = cwd || path.join(__dirname, '..', '..', '..');
    let args, bin;
    const tmpPatches = [];

    if (engine === 'dsh') {
      // dsh --profile headless --patch <tĩnh> [--patch <động>] "<prompt>"
      // Patch động (sau → thắng): model user chọn, như opencode -m.
      // + DSH_HOME tạm: settings chứa đúng route+model (settings thắng patch
      // cho providers). Không dùng ~/.dsh của user.
      const patches = ['--patch', DSH_PATCH_FILE];
      const dyn = buildDshDynamicPatch(dshProvider, modelName);
      if (dyn) { patches.push('--patch', dyn); tmpPatches.push(dyn); }
      const home = buildDshHome(dshProvider, modelName);
      if (home) { env.DSH_HOME = home; tmpPatches.push(home); }
      const nodeJs = findDshNodeBin();
      if (nodeJs) {
        bin = process.execPath;
        args = [nodeJs, '--profile', 'headless', ...patches, prompt];
      } else {
        bin = DSH_BIN;
        args = ['--profile', 'headless', ...patches, prompt];
      }
    } else {
      // opencode run "<prompt>" -m <model> --auto --pure --title agent-task
      // Model phải có đủ prefix provider (vd: xkiro/deepseek/...) để opencode route đúng.
      // Frontend gửi model_name có thể chỉ là 'deepseek/deepseek-v4-pro' → tự thêm xkiro/.
      const rawModel = (modelName || '').trim();
      const knownProviders = /^(xkiro|nvidia|groq|mistral|cerebras|gemini|openrouter|mintrouter|cohere|agentrouter|bai|kiosapi|unorouter|opencode|kilo)\//i;
      const opencodeModel = knownProviders.test(rawModel)
        ? rawModel
        : rawModel.includes('/')
          ? 'xkiro/' + rawModel
          : 'xkiro/deepseek/deepseek-v4-pro';
      bin = OPENCODE_BIN_PATH;
      args = ['run', prompt, '-m', opencodeModel, '--auto', '--pure', '--title', 'agent-task'];
    }

    let proc;
    if (engine === 'dsh' && isCmdShim(bin)) {
      // Windows: file .cmd/.bat phải chạy qua shell, không spawn trực tiếp được
      proc = spawnViaCmd(bin, args, { cwd: rootDir, timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      proc = spawn(bin, args, { cwd: rootDir, timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += stripAnsi(d.toString()); });
    proc.stderr.on('data', (d) => { stderr += stripAnsi(d.toString()); });
    proc.on('error', (e) => { cleanupTmpPatches(tmpPatches); resolve({ code: -1, stdout, stderr: e.message }); });
    proc.on('close', (code) => { cleanupTmpPatches(tmpPatches); resolve({ code: code ?? 0, stdout, stderr }); });
  });
}

/**
 * Chạy agent engine với stream SSE (dùng cho /messages/stream).
 * @param {'opencode'|'dsh'} engine
 * @param {string} prompt
 * @param {string} modelName
 * @param {string} cwd
 * @param {object} extraEnv
 * @param {(payload:object)=>void} sendSSE
 * @param {()=>void} endStream
 * @returns {()=>void} hàm hủy (kill process)
 */
function runAgentEngineStream(engine, prompt, modelName, cwd, extraEnv, sendSSE, endStream, dshProvider = '') {
  const env = { ...NO_COLOR_ENV, ...extraEnv };
  const rootDir = cwd || path.join(__dirname, '..', '..', '..');
  let args, bin;
  const tmpPatches = [];

  if (engine === 'dsh') {
    const patches = ['--patch', DSH_PATCH_FILE];
    const dyn = buildDshDynamicPatch(dshProvider, modelName);
    if (dyn) { patches.push('--patch', dyn); tmpPatches.push(dyn); }
    const home = buildDshHome(dshProvider, modelName);
    if (home) { env.DSH_HOME = home; tmpPatches.push(home); }
    const nodeJs = findDshNodeBin();
    if (nodeJs) {
      bin = process.execPath;
      args = [nodeJs, '--profile', 'headless', ...patches, prompt];
    } else {
      bin = DSH_BIN;
      args = ['--profile', 'headless', ...patches, prompt];
    }
  } else {
    // Model phải có đủ prefix provider (vd: xkiro/deepseek/...) để opencode route đúng.
    const rawModel = (modelName || '').trim();
    const knownProviders = /^(xkiro|nvidia|groq|mistral|cerebras|gemini|openrouter|mintrouter|cohere|agentrouter|bai|kiosapi|unorouter|opencode|kilo)\//i;
    const opencodeModel = knownProviders.test(rawModel)
      ? rawModel
      : rawModel.includes('/')
        ? 'xkiro/' + rawModel
        : 'xkiro/deepseek/deepseek-v4-pro';
    bin = OPENCODE_BIN_PATH;
    args = ['run', prompt, '-m', opencodeModel, '--auto', '--pure', '--title', 'agent-task'];
  }

  let proc;
  if (engine === 'dsh' && isCmdShim(bin)) {
    proc = spawnViaCmd(bin, args, { cwd: rootDir, timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    proc = spawn(bin, args, { cwd: rootDir, timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  }
  let stdout = '';
  let stderr = '';
  const cleaner = new AnsiStreamCleaner();
  proc.stdout.on('data', (data) => {
    const cleaned = cleaner.push(data.toString());
    if (cleaned) { stdout += cleaned; sendSSE({ type: 'token', text: cleaned }); }
  });
  proc.stderr.on('data', (data) => { stderr += stripAnsi(data.toString()); });
  proc.on('error', () => { cleanupTmpPatches(tmpPatches); sendSSE({ type: 'error', message: 'Lỗi khởi động Agent process.' }); endStream(); });
  proc.on('close', (code) => {
    cleanupTmpPatches(tmpPatches);
    const flushed = cleaner.flush();
    if (flushed) stdout += flushed;
    let finalText;
    if (code !== 0) { finalText = stdout.trim() || stderr.trim() || `[Agent Error] Process exited with code ${code}`; }
    else { finalText = stdout.trim() || "Tôi đã tự động thực thi các câu lệnh và cập nhật tệp tin thành công cho bạn."; }
    sendSSE({ type: 'done', noi_dung: finalText });
    endStream();
  });
  return () => { try { if (!proc.killed) proc.kill(); } catch (e) {} };
}

/**
 * Tự chọn engine theo độ phức tạp của task.
 * - Task ngắn/đơn giản → dsh (nhanh hơn ~30%)
 * - Task dài/nhiều bước/phức tạp → opencode (ổn định hơn)
 * - Nếu engine được chọn không có sẵn → fallback sang cái còn lại.
 * @param {string} prompt
 * @param {'opencode'|'dsh'|'auto'|undefined} requested
 * @returns {'opencode'|'dsh'}
 */
function pickEngine(prompt, requested) {
  const req = String(requested || '').trim().toLowerCase();
  if (req === 'opencode' || req === 'dsh') {
    // Người dùng chọn tay: nếu engine đó có sẵn → dùng, không thì đổi
    if (req === 'opencode' && IS_OPENCODE_AVAILABLE) return 'opencode';
    if (req === 'dsh' && IS_DSH_AVAILABLE) return 'dsh';
    return IS_OPENCODE_AVAILABLE ? 'opencode' : 'dsh';
  }
  // Chế độ AUTO: phân loại độ phức tạp
  const text = String(prompt || '');
  const complexHints = /(viết (lại|mới)|tạo (mới|toàn bộ)|refactor|tái cấu trúc|nhiều file|tích hợp|thiết kế hệ thống|kiến trúc|sửa lỗi ở|fix bug|debug|test|deploy|database|api mới|full|hoàn chỉnh|đầy đủ)/i;
  const isComplex = text.length > 400 || complexHints.test(text);
  // dsh nhanh hơn cho task ngắn; opencode ổn định cho task dài
  const want = isComplex ? 'opencode' : 'dsh';
  if (want === 'dsh' && IS_DSH_AVAILABLE) return 'dsh';
  if (want === 'opencode' && IS_OPENCODE_AVAILABLE) return 'opencode';
  return IS_OPENCODE_AVAILABLE ? 'opencode' : 'dsh';
}

module.exports = {
  OPENCODE_BIN_PATH, IS_OPENCODE_AVAILABLE,
  DSH_BIN, DSH_PATCH_FILE, IS_DSH_AVAILABLE,
  isEngineAvailable, pickEngine, runAgentEngine, runAgentEngineStream,
  resolveDshProvider, dshKeyEnvName, buildDshDynamicPatch,
  quoteWinArg, // export để test (P2-20(4))
};
