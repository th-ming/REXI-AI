/**
 * edgeTTS.js â€” Edge TTS Thuáº§n Node.js (WebSocket trá»±c tiáº¿p tá»›i Microsoft Edge TTS)
 * KhÃ´ng cáº§n cÃ i Python/pip, hoáº¡t Ä‘á»™ng trÃªn má»i mÃ´i trÆ°á»ng (local + Render).
 * DÃ¹ng chung cho: /api/services/tts (trang chá»§) vÃ  Agent Mode tool text_to_speech.
 *
 * FIX 2026-08:
 *  - Microsoft cháº·n handshake cÅ© (401) â€” yÃªu cáº§u token má»›i
 *    (TrustedClientToken 6A5AA1D4EAFF...) + Sec-MS-GEC (SHA256 cá»§a Windows file time
 *    ticks lÃ m trÃ²n 5 phÃºt + token) + Sec-MS-GEC-Version + Origin/UA má»›i.
 *  - Format X-Timestamp pháº£i khá»›p chÃ­nh xÃ¡c edge_tts (rany2/edge-tts):
 *      + config: X-Timestamp:<"%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)">  (KHÃ”NG cÃ³ Z)
 *      + ssml:   X-Timestamp:<ISO-8601 cÃ³ mili-giÃ¢y>Z                                        (cÃ³ Z)
 *    Sai format â†’ server nháº­n handshake nhÆ°ng KHÃ”NG tráº£ audio.
 *  - perMessageDeflate: false (khá»›p test Ä‘Ã£ chá»©ng minh hoáº¡t Ä‘á»™ng).
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const { generateSecMsGecV2 } = require('./edgeTTS-drm.js');
const WIN_EPOCH = 11644473600n; // Unix â†’ Windows file time epoch (1601-01-01)

const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const VOICES_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'
  + `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

// â”€â”€â”€ Danh sÃ¡ch giá»ng THáº¬T cá»§a engine (fetch Ä‘á»™ng tá»« Microsoft, khÃ´ng hardcode) â”€â”€â”€
// Cache 6h. Tráº£ vá» null náº¿u khÃ´ng gá»i Ä‘Æ°á»£c VÃ€ chÆ°a tá»«ng cache (caller tá»± fallback).
let _voiceListCache = { list: null, ts: 0 };
const VOICE_LIST_TTL = 6 * 60 * 60 * 1000;

function mapGender(g) {
  const s = String(g || '').toLowerCase();
  if (s === 'female') return 'Ná»¯';
  if (s === 'male') return 'Nam';
  return g || '';
}

// "Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)" â†’ "HoaiMy"
function shortNameFromFriendly(friendly, fallback) {
  const s = String(friendly || '')
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Online.*$/i, '')
    .trim();
  return s || fallback || '';
}

/**
 * Láº¥y danh sÃ¡ch giá»ng nÃ³i THáº¬T Ä‘ang cÃ³ trÃªn engine Microsoft Edge TTS.
 * @param {boolean} force bá» qua cache
 * @returns {Promise<Array<{id,name,locale,language,gender,friendlyName,engine}>>|null}
 */
async function listEdgeVoices(force = false) {
  const now = Date.now();
  if (!force && _voiceListCache.list && (now - _voiceListCache.ts) < VOICE_LIST_TTL) {
    return _voiceListCache.list;
  }
  try {
    const res = await fetch(VOICES_LIST_URL, {
      headers: { 'User-Agent': EDGE_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    const list = (Array.isArray(raw) ? raw : [])
      .map((v) => {
        const id = String(v.ShortName || '');
        const locale = String(v.Locale || '');
        const friendlyName = String(v.FriendlyName || id);
        return {
          id,
          name: shortNameFromFriendly(friendlyName, id),
          locale,
          language: (locale.split('-')[0] || '').toLowerCase(),
          gender: mapGender(v.Gender),
          friendlyName,
          engine: 'edge-tts',
        };
      })
      .filter((v) => v.id);
    if (!list.length) throw new Error('danh sÃ¡ch rá»—ng');
    _voiceListCache = { list, ts: now };
    return list;
  } catch (e) {
    // Lá»—i máº¡ng táº¡m thá»i â†’ tráº£ cache cÅ© náº¿u cÃ³, ngÆ°á»£c láº¡i null (caller tá»± xá»­ lÃ½)
    return _voiceListCache.list;
  }
}

// Láº¥y locale (vd 'vi-VN') tá»« voice id ('vi-VN-HoaiMyNeural') â€” dÃ¹ng cho SSML xml:lang.
function localeFromVoice(voiceName, fallback = 'vi-VN') {
  const m = /^([a-z]{2,3}-[A-Z]{2})-/.exec(String(voiceName || ''));
  return m ? m[1] : fallback;
}

// Sec-MS-GEC: SHA256( ticks + token ) uppercased.
// ticks = (unix_seconds + WIN_EPOCH) lÃ m trÃ²n xuá»‘ng 5 phÃºt, Ã—10^7 (100-ns intervals).
// DÃ¹ng BigInt vÃ¬ giÃ¡ trá»‹ ~1.3e17 vÆ°á»£t Ä‘á»™ chÃ­nh xÃ¡c an toÃ n cá»§a JS number (2^53).
function generateSecMsGec(skewSec = 0) {
  return generateSecMsGecV2(Math.floor(Date.now() / 1000) + (skewSec || 0));
}

function generateSecMsGecOld(skewSec = 0) { // (deprecated v1)
  let ticks = BigInt(Math.floor(Date.now() / 1000) + (skewSec || 0));
  ticks += WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

// "%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)" â€” dÃ¹ng cho speech.config (KHÃ”NG Z)
function dateToString() {
  const d = new Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

// "YYYY-MM-DDTHH:MM:SS.mmm" â€” dÃ¹ng cho ssml (thÃªm Z á»Ÿ ngoÃ i)
function isoTimestamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/**
 * Tá»•ng há»£p giá»ng nÃ³i qua WebSocket tá»›i Microsoft Edge TTS.
 * @param {string} voiceName  VD: 'vi-VN-HoaiMyNeural'
 * @param {string} text       VÄƒn báº£n cáº§n Ä‘á»c
 * @param {string} rate       VD: '+0%'
 * @param {string} pitch      VD: '+0Hz'
 * @param {string} lang       locale cho SSML xml:lang (máº·c Ä‘á»‹nh suy ra tá»« voiceName)
 * @returns {Promise<Buffer>} Buffer audio MP3
 */
function generateEdgeTTSNode(voiceName, text, rate = '+0%', pitch = '+0Hz', lang) {
  return attemptEdgeConnect(voiceName, text, rate, pitch, lang, 0, 3);
}

function attemptEdgeConnect(voiceName, text, rate, pitch, lang, skewSec, triesLeft) {
  return new Promise((resolve, reject) => {
    const requestId = connectId();
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
      + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&ConnectionId=${connectId()}`
      + `&Sec-MS-GEC=${generateSecMsGec(skewSec)}`
      + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const ws = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      headers: {
        'User-Agent': EDGE_UA,
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Sec-WebSocket-Version': '13',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      }
    });

    let serverDate = null;
    try { ws.on('unexpected-response', (req, res) => { try { serverDate = res && res.headers && res.headers.date; } catch (e) {} }); } catch (e) {}

    const audioBuffers = [];
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        isFinished = true;
        try { ws.close(); } catch(e) {}
        if (audioBuffers.length > 0) resolve(Buffer.concat(audioBuffers));
        else reject(new Error('Edge TTS WebSocket timeout'));
      }
    }, 30000);

    ws.on('open', () => {
      const configMsg = `X-Timestamp:${dateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      ws.send(configMsg);

      const escapedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const ssmlLang = lang || localeFromVoice(voiceName);
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${isoTimestamp()}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${ssmlLang}'><voice name='${voiceName}'><prosody pitch='${pitch}' rate='${rate}'>${escapedText}</prosody></voice></speak>`;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (isFinished) return;

      if (isBinary) {
        // Khung binary (format 2026): "\x00\x80X-RequestId:<id>\r\nContent-Type:audio/mpeg\r\nX-StreamId:<sid>\r\nPath:audio\r\n<mp3 bytes>"
        // Audio náº±m NGAY SAU "Path:audio\r\n" â€” KHÃ”NG cÃ³ \r\n\r\n ngÄƒn cÃ¡ch (Ä‘Ã£ verify thá»±c táº¿).
        const audioMarker = Buffer.from('Path:audio\r\n');
        const idx = data.indexOf(audioMarker);
        if (idx !== -1) {
          audioBuffers.push(data.subarray(idx + audioMarker.length));
        }
      } else {
        const textMsg = data.toString('utf8');
        if (textMsg.includes('Path:turn.end')) {
          isFinished = true;
          clearTimeout(timer);
          try { ws.close(); } catch(e) {}
          if (audioBuffers.length > 0) resolve(Buffer.concat(audioBuffers));
          else reject(new Error('No audio chunks received'));
        }
      }
    });

    ws.on('error', (err) => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timer);
        if (audioBuffers.length > 0) return resolve(Buffer.concat(audioBuffers));
        const is403 = /403/.test(String((err && err.message) || ''));
        if (is403 && triesLeft > 0) {
          let skew = skewSec;
          if (serverDate) { const d = Date.parse(serverDate); if (!isNaN(d)) skew = Math.round((d - Date.now()) / 1000); }
          else { skew = (skewSec || 0) + 300; }
          console.warn('[EdgeTTS] 403 DRM â€” retry voi skew', skew, 's, con', triesLeft - 1, 'lan');
          return resolve(attemptEdgeConnect(voiceName, text, rate, pitch, lang, skew, triesLeft - 1));
        }
        reject(err);
      }
    });

    ws.on('close', () => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timer);
        if (audioBuffers.length > 0) resolve(Buffer.concat(audioBuffers));
        else reject(new Error('WebSocket closed unexpectedly'));
      }
    });
  });
}

module.exports = { generateEdgeTTSNode, listEdgeVoices, localeFromVoice };

