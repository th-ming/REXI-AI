const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const browserStream = require('./src/services/browserStream');
const { killAllOrphanProcesses } = require('./src/utils/safeExec');

// Import cÃ¡c routes cá»§a báº¡n
const authRoutes = require('./src/routes/auth.routes');
const chatRoutes = require('./src/routes/chat.routes');
const servicesRoutes = require('./src/routes/services.routes');
const modelsRoutes = require('./src/routes/models.routes');
const mediaRoutes = require('./src/routes/media.routes');
const workspaceRoutes = require('./src/routes/workspace.routes');
const agentRoutes = require('./src/routes/agent.routes');
const socialRoutes = require('./src/routes/social.routes');
const { rateLimitMiddleware } = require('./src/middleware/rateLimit.middleware');
const { auditMiddleware } = require('./src/middleware/audit.middleware');
const { handleTranscriptionConnection } = require('./src/routes/realtimeTranscription.routes');

const { ensureAdmin, ensureGuestUser } = require('./src/ensure-admin');
const { initDatabase } = require('./src/init-db');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Global error handlers â€” prevent uncaught exceptions from
// crashing the entire server process.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// Session secret â€” resolve SAU khi initDatabase() Ä‘Ã£ set global.__JWT_SECRET (á»•n Ä‘á»‹nh giá»¯a restart).
// PROD: khÃ´ng cho phÃ©p fallback random (session máº¥t sau má»—i restart + secret dá»… Ä‘oÃ¡n).
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (global.__JWT_SECRET) return global.__JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET hoáº·c JWT_SECRET báº¯t buá»™c pháº£i Ä‘Æ°á»£c cáº¥u hÃ¬nh trong production (hoáº·c lÆ°u trong DB bá»Ÿi init-db).');
  }
  return crypto.randomBytes(32).toString('hex');
}

// Khá»Ÿi táº¡o á»©ng dá»¥ng Express
const app = express();
// P1-07: tin IP tá»« reverse proxy (Render/Nginx) Ä‘á»ƒ req.ip + rate-limit Ä‘Ãºng client tháº­t
app.set('trust proxy', 1);
// Æ¯u tiÃªn PORT tá»« file .env Ä‘á»ƒ trÃ¡nh bá»‹ biáº¿n mÃ´i trÆ°á»ng há»‡ thá»‘ng (vd: PORT=20128)
// ghi Ä‘Ã¨ khiáº¿n server cháº¡y sai cá»•ng / xung Ä‘á»™t vá»›i gateway khÃ¡c.
const envPortMatch = fs.existsSync(path.join(__dirname, '..', '.env'))
  ? fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^PORT\s*=\s*(\d+)/m)
  : null;
const PORT = parseInt(envPortMatch && envPortMatch[1], 10) || parseInt(process.env.PORT, 10) || 5000;

// â”€â”€â”€ CÃ¡c middleware KHÃ”NG phá»¥ thuá»™c DB â€” Ä‘Äƒng kÃ½ trÆ°á»›c â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cáº¥u hÃ¬nh CORS - chá»‰ cháº¥p nháº­n frontend Ä‘ang dÃ¹ng
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5173', 'http://[::1]:5000'];
// CORS thá»§ cÃ´ng: cho phÃ©p local + SAME-ORIGIN (FE Ä‘Æ°á»£c serve tá»« backend trÃªn Render â†’ Origin trÃ¹ng Host)
// + ALLOWED_ORIGINS env. TrÆ°á»›c Ä‘Ã¢y same-origin trÃªn Render bá»‹ cháº·n náº¿u quÃªn set ALLOWED_ORIGINS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers.host;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  const sameOrigin = host && (origin === `http://${host}` || origin === `https://${host}`);
  const envAllowed = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : [];
  if (isLocal || sameOrigin || envAllowed.includes(origin) || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
// Helmet FULL â€” báº­t CSP (cho phÃ©p font CDN + hls.js CDN + data:/blob: cho stream & TTS), HSTS, noSniff, X-Frame-Options, v.v.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'], // P3: bỏ unpkg (không dùng); giữ jsdelivr cho GSAP (VideoCreator)
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'data:', 'blob:', 'https:', 'http://localhost:*'],
      connectSrc: ["'self'", 'https:', 'wss:', 'ws:', 'http://localhost:*', 'http://127.0.0.1:*'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://accounts.google.com', 'https://open.maic.chat', 'https://*.maic.chat', 'https://opencut.app', 'https://*.opencut.app', 'http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*', 'https://127.0.0.1:*'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://accounts.google.com']
    }
  },
  crossOriginEmbedderPolicy: false // COEP require-corp cháº·n font/media CDN â€” táº¯t Ä‘á»ƒ khÃ´ng vá»¡ UI
}));
// Import DB route body lon (SQLite base64 ~25MB) — parser rieng chay TRUOC global json
  app.use('/api/admin/import-sqlite', express.json({ limit: '80mb' }));
  app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Bootstrap â€” chá» initDatabase() xong (global.__JWT_SECRET sáºµn sÃ ng)
// rá»“i má»›i táº¡o session + Ä‘Äƒng kÃ½ routes + listen.
// QUAN TRá»ŒNG: session PHáº¢I Ä‘Æ°á»£c Ä‘Äƒng kÃ½ TRÆ¯á»šC cÃ¡c routes (Express cháº¡y
// middleware theo thá»© tá»± Ä‘Äƒng kÃ½ â€” session sau routes thÃ¬ req.session undefined).
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function bootstrap() {
  try {
    await initDatabase();
    ensureAdmin().catch(console.error);
    ensureGuestUser().catch(console.error);
  } catch (err) {
    console.error('[init-db] Lá»—i khá»Ÿi táº¡o schema:', err && err.message);
  }

  // (BÆ°á»›c 3.3) Migrate sessions.json â†’ DB + preload Ä‘á»ƒ context engine dÃ¹ng DB
  try {
    const { migrateSessionsFileToDb, preloadSessionsFromDb } = require('./src/services/brain/context/context');
    await migrateSessionsFileToDb().catch(() => {});
    await preloadSessionsFromDb().catch(() => {});
  } catch (e) { console.error('[Brain][Context] Init tá»« DB tháº¥t báº¡i:', e.message); }

  // â”€â”€â”€ Session (PHáº¢I trÆ°á»›c routes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sessionSecret = resolveSessionSecret();
  // FIX PROD: session store bá»n vá»¯ng trÃªn DB (SQLite/PostgreSQL) thay vÃ¬ MemoryStore
  // â†’ user khÃ´ng bá»‹ máº¥t phiÃªn khi restart, guest quota giá»¯ nguyÃªn trÃªn Render
  const { SqliteSessionStore } = require('./src/middleware/sqliteSessionStore');
  app.use(session({
    secret: sessionSecret,
    resave: false,
    // P3-fix(audit): false â€” khÃ´ng lÆ°u session rá»—ng cho má»i request vÃ£ng lai/bot
    // (báº£ng sessions_store phÃ¬nh vÃ´ háº¡n). Guest quota váº«n hoáº¡t Ä‘á»™ng: counters chá»‰
    // Ä‘Æ°á»£c ghi khi thá»±c sá»± gá»­i tin nháº¯n (chat.routes tÄƒng rá»“i save).
    saveUninitialized: false,
    store: new SqliteSessionStore(),
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 giá»
    }
  }));

  // â”€â”€â”€ Rate limit + Audit cho Táº¤T Cáº¢ API routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use('/api', rateLimitMiddleware);
  // Audit trail â€” ghi log má»i request API vÃ o báº£ng audit_log (bá» qua /health, /logs, SSE, proxy)
  app.use('/api', auditMiddleware);

  // â”€â”€ HEALTH CHECK (public, khÃ´ng cáº§n auth) â”€â”€
  app.get('/api/health', (req, res) => {
    const db = require('./src/config/db');
    const started = Date.now();
    db.get('SELECT 1 AS ok', [], (err) => {
      res.json({
        status: 'ok',
        service: 'rexi-ai-backend',
        db: err ? 'error' : 'connected',
        db_type: db.type || 'unknown',
        uptime_seconds: Math.round(process.uptime()),
        response_ms: Date.now() - started,
        timestamp: new Date().toISOString()
      });
    });
  });

  // ── CLIENT DIAG LOG (debug màu UI): FE gửi báo cáo browser, GET để đọc ──
  // Chỉ chứa build/theme/màu computed — không có secret. Buffer RAM 60 dòng,
  // xoay vòng. Endpoint tạm cho session debug, có thể gỡ sau.
  const __clientLog = [];
  app.post('/api/client-log', (req, res) => {
    const b = req.body || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    __clientLog.push({
      at: new Date().toISOString(),
      build: s(b.build, 16),
      theme: s(b.theme, 12),
      storedTheme: s(b.storedTheme, 12),
      rootBg: s(b.rootBg, 64),
      rootColor: s(b.rootColor, 64),
      asideBg: s(b.asideBg, 64),
      tileBg: s(b.tileBg, 64),
      prefersDark: !!b.prefersDark,
      paintDark: !!b.paintDark,
      darkReader: !!b.darkReader,
      url: s(b.url, 200),
      ua: s(b.ua, 300),
      vw: Number(b.vw) || 0,
      vh: Number(b.vh) || 0,
      dpr: Number(b.dpr) || 0,
      touch: !!b.touch,
    });
    if (__clientLog.length > 60) __clientLog.shift();
    res.json({ ok: true });
  });
  app.get('/api/client-log', (req, res) => {
    res.json({ ok: true, count: __clientLog.length, entries: __clientLog });
  });

  const { promptNormalizerMiddleware } = require('./src/middleware/promptNormalizer.middleware');
  const adminRoutes = require('./src/routes/admin.routes');
  const githubRoutes = require('./src/routes/github.routes');
  const scrapeRoutes = require('./src/routes/scrape.routes');

  // Apply Teencode Normalization
  app.use(promptNormalizerMiddleware);

  // LiÃªn káº¿t cÃ¡c API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/services', servicesRoutes);
  app.use('/api/scrape', scrapeRoutes);
  app.use('/api/models', modelsRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/workspace', workspaceRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/social', socialRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin/github', githubRoutes);
  // Real-time transcription
  const { router: realtimeTranscriptionRoutes } = require('./src/routes/realtimeTranscription.routes');
  app.use('/api/services', realtimeTranscriptionRoutes);

  // SSE endpoint: frontend káº¿t ná»‘i Ä‘á»ƒ nháº­n thÃ´ng bÃ¡o model scan hoÃ n táº¥t
  const sseClients = new Set();
  global.__modelScanComplete = (data) => {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch (e) { sseClients.delete(res); }
    }
  };
  app.get('/api/models/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // (TÃ¹y chá»n) Phá»¥c vá»¥ á»©ng dá»¥ng React Ä‘Ã£ build cho mÃ´i trÆ°á»ng production
  const frontendBuildPath = path.join(__dirname, '..', 'Frontend', 'dist');
  const frontendPublicPath = path.join(__dirname, '..', 'Frontend', 'public');
  // Trang phÃ¡p lÃ½ Google OAuth cáº§n URL cÃ´ng khai: /privacy vÃ /terms
  // (báº¯t buá»™c cho consent screen + giÃºp pass verify). Æ¯u tiÃªn báº£n trong dist
  // (do vite build copy tá»« public/), fallback báº£n nguá»“n public/ khi chÆ°a build.
  const legalPage = (name) => (req, res, next) => {
      const candidates = [
          path.join(frontendBuildPath, `${name}.html`),
          path.join(frontendPublicPath, `${name}.html`),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) return next();
      res.type('html').sendFile(found);
  };
  app.get('/privacy', legalPage('privacy'));
  app.get('/terms', legalPage('terms'));
  if (fs.existsSync(frontendBuildPath)) {
      app.use(express.static(frontendBuildPath));
      app.get('/{*path}', (req, res, next) => {
          if (req.path.startsWith('/api')) return next();
          res.sendFile(path.resolve(frontendBuildPath, 'index.html'));
      });
  }

  // P2-audit: Global JSON error handler
  // Truoc day moi loi nem ra ngoai route handler (multer, async throw...) roi vao
  // default error handler cua Express -> tra trang HTML "Internal Server Error"
  // -> FE goi r.json() vo ("Unexpected token <"). Gio moi loi tra JSON.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 ? err.status : 500;
    if (status >= 500) console.error('[Error]', req.method, req.originalUrl, err?.message);
    if (res.headersSent) return next(err);
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Lỗi server nội bộ. Vui lòng thử lại.' : (err?.message || 'Yêu cầu không hợp lệ.'),
    });
  });

  // Khá»Ÿi Ä‘á»™ng server + auto-scanner IPTV + Model Health Scanner
  const { startScheduler } = require('./src/scheduler');
  const { startGitHubScheduler } = require('./src/github-trending-scheduler');
  const { startModelScannerScheduler } = require('./src/model-scanner.scheduler');
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Rexi AI Backend Ä‘ang cháº¡y táº¡i http://localhost:${PORT}`);
    if (process.env.ENABLE_IPTV_SCHEDULER !== 'false') {
      startScheduler();
    }
    startGitHubScheduler();
    // Auto-scan: quÃ©t ngay khi server khá»Ÿi Ä‘á»™ng (sau 5s) + quÃ©t vÃ o giá» cá»‘ Ä‘á»‹nh hÃ ng ngÃ y
    // Máº·c Ä‘á»‹nh 3:00 AM, cÃ³ thá»ƒ Ä‘á»•i giá» tá»« Admin (API /models/admin/models/scan-schedule)
    startModelScannerScheduler();
  });

  // WebSocket server cho Browser Stream
  // P0-03: verifyClient kiá»ƒm tra JWT (token qua query `?token=` hoáº·c Sec-WebSocket-Protocol),
  // dÃ¹ng cÃ¹ng getJWTSecret cá»§a auth.middleware â€” khÃ´ng token/token sai â†’ reject 401.
  const { getJWTSecret } = require('./src/middleware/auth.middleware');
  const verifyBrowserWS = (info, done) => {
    try {
      const reqUrl = info.req.url || '';
      let token = '';
      const q = reqUrl.indexOf('?');
      if (q >= 0) {
        try { token = new URL(reqUrl, 'http://localhost').searchParams.get('token') || ''; } catch (e) {}
      }
      if (!token) {
        const proto = info.req.headers['sec-websocket-protocol'] || '';
        const parts = String(proto).split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) token = parts[parts.length - 1];
      }
      if (!token) return done(false, 401, 'Unauthorized: missing token');
      jwt.verify(token, getJWTSecret());
      done(true);
    } catch (e) {
      done(false, 401, 'Unauthorized: invalid token');
    }
  };
  const wss = new WebSocketServer({
    server,
    path: '/api/services/browser/stream',
    // 4/10: BỎ verifyClient + handleProtocols — auth nằm trong setWSS connection handler.
    // 4/10: BẬT perMessageDeflate — Render proxy chèn WebSocket compression (RSV1 set)
    // mà Node không negotiate → "RSV1 must be clear" → connection chết 1006 ngầm
    // (self-test /browser/ws-selftest xác nhận). Node negotiate → proxy relay frames OK.
    perMessageDeflate: { zlibDeflateOptions: { chunkSize: 1024 } },
  });
  browserStream.setWSS(wss);

  // WebSocket server cho Real-time Transcription
  const transcriptionWSS = new WebSocketServer({ server, path: '/api/services/transcribe-live', perMessageDeflate: { zlibDeflateOptions: { chunkSize: 1024 } } });
  transcriptionWSS.on('connection', async (ws, req) => {
    // Run auth middleware
    const authMiddleware = require('./src/middleware/auth.middleware').authMiddleware;
    await new Promise((resolve) => {
      authMiddleware(req, { 
        status: () => ({ json: () => {} }), 
        json: () => {} 
      }, (err) => {
        if (err) {
          req.authError = err;
        }
        resolve();
      });
    });

    if (req.authError || !req.user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Handle transcription connection
    handleTranscriptionConnection(ws, req);
  });

  // Dá»n dáº¹p file táº¡m (TTS, caption, uploads...) quÃ¡ 1 giá» tuá»•i â€” trÃ¡nh tÃ­ch tá»¥ á»• cá»©ng
  setInterval(() => {
    try {
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) return;
      const cutoff = Date.now() - 60 * 60 * 1000;
      fs.readdirSync(tempDir).forEach(f => {
        try {
          const fp = path.join(tempDir, f);
          const st = fs.statSync(fp);
          if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch (e) {}
      });
    } catch (e) {}
  }, 60 * 60 * 1000);

  // Cleanup orphan processes má»—i 5 phÃºt
  setInterval(() => {
    killAllOrphanProcesses();
  }, 5 * 60 * 1000);

  // â”€â”€â”€ NHáº®C VIá»†C THÃ”NG MINH: quÃ©t má»—i 30s, nháº¯c Ä‘Ãºng giá» â”€â”€â”€
  const { startReminderScheduler } = require('./src/services/reminderScheduler');
  startReminderScheduler();
}

bootstrap().catch(err => {
  console.error('[FATAL] KhÃ´ng thá»ƒ khá»Ÿi Ä‘á»™ng server:', err);
  process.exit(1);
});
