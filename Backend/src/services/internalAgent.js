// internalAgent.js — agent-loop chạy HOÀN TOÀN bằng API provider (không cần opencode.exe/dsh),
// nên hoạt động cả trên Linux/container (Render/VPS). Protocol: ReAct JSON — model bắt buộc
// trả 1 object JSON mỗi bước hoặc file → parse được. executeTool + stop: model nào cũng dùng được.

const { executeTool, TOOL_REGISTRY, getAgentChain } = require('./agentService');
const db = require('../config/db');
const { decryptKey } = require('../utils/cryptoKeys');
const { PROVIDER_ENDPOINTS } = require('../model-scanner.scheduler');

const AGENT_PROVIDER = (process.env.AGENT_PROVIDER || 'groq').toLowerCase();
const AGENT_MODEL = process.env.AGENT_MODEL || 'openai/gpt-oss-120b';
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '10');
const TOTAL_DEADLINE_MS = parseInt(process.env.AGENT_DEADLINE_MS || '120000'); // 2 phút: luôn trả lời trước khi proxy timeout
const TOOL_TIMEOUT_MS = parseInt(process.env.AGENT_TOOL_TIMEOUT_MS || '40000'); // tool nặng (browser) fail nhanh

// Fallback chain DONG (thay FALLBACK_PROVIDERS cung): lay tu getAgentChain()
// (env -> DB agent_chain -> mac dinh deepseek/xkiro/kiosapi). Doi qua API, khong can deploy.
async function getFallbackChain(excludeProvider, excludeModel) {
  try {
    const chain = await getAgentChain();
    return chain.filter(f => !(f.provider === excludeProvider && f.model === excludeModel));
  } catch {
    return [
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'unorouter', model: 'deepseek-v4.1-flash:free' },
      { provider: 'xkiro', model: 'mistralai/mistral-small-2603' },
      { provider: 'kiosapi', model: 'sensenova-6.8-flash' },
    ].filter(f => !(f.provider === excludeProvider && f.model === excludeModel));
  }
}

// Tim provider tu model id user chon (ai_models, uu tien dang active)
async function resolveModelProvider(modelId) {
  try {
    const m = String(modelId || '').trim();
    if (!m) return null;
    const short = m.includes('/') ? m.split('/').pop() : m;
    const rows = await new Promise((res) => db.all(
      'SELECT ma_nha_cung_cap FROM ai_models WHERE (LOWER(ma_model) = LOWER(?) OR LOWER(ma_model) = LOWER(?)) AND kich_hoat = 1 ORDER BY thu_tu_hien_thi LIMIT 1',
      [m, short], (e, r) => res(e ? [] : (r || []))));
    if (rows.length) return String(rows[0].ma_nha_cung_cap).toLowerCase();
  } catch { /* ignore */ }
  return null;
}

async function getKey(provider) {
  const rows = await new Promise((res) => db.all(
    "SELECT gia_tri_khoa FROM khoa_api WHERE LOWER(ten_nha_cung_cap) = ? AND gia_tri_khoa IS NOT NULL AND TRIM(gia_tri_khoa) <> '' LIMIT 1",
    [provider], (e, r) => res(e ? [] : (r || []))));
  if (!rows.length) return process.env[`${provider.toUpperCase()}_API_KEY`] || null;
  try { return decryptKey(rows[0].gia_tri_khoa).trim(); } catch { return rows[0].gia_tri_khoa; }
}

function chatUrl(provider) {
  const ep = PROVIDER_ENDPOINTS[provider];
  if (ep && ep.endpoint) return ep.endpoint.replace(/\/models\/?$/, '') + '/chat/completions';
  throw new Error(`Không biết chat endpoint cho provider ${provider}`);
}

function buildSystemPrompt(allowedTools) {
  const list = (allowedTools && allowedTools.length)
    ? TOOL_REGISTRY.filter(t => allowedTools.includes(t.name))
    : TOOL_REGISTRY;
  const tools = list.map(t => {
    const params = (t.parameters && t.parameters.properties)
      ? Object.entries(t.parameters.properties).map(([k, v]) => `"${k}": (${v.type || 'string'}) ${String(v.description || '').slice(0, 90)}`).join('; ')
      : '';
    return `- ${t.name}: ${String(t.description || '').slice(0, 160)}${params ? ' | tham số: ' + params : ''}`;
  }).join('\n');
  return `Bạn là agent nội bộ của Rexi AI, chạy trên server Linux. Bạn giải quyết việc bằng cách lặp lại các bước.

TOOL KHẢ DỤNG:
${tools}

MỖI BƯỚC bạn CHỈ ĐƯỢC trả về ĐÚNG một JSON object (không markdown, không giải thích thêm), dạng:
1) Cần dùng tool:
{"thought":"<ngắn gọn>","tool":"<tên tool>","args":{...}}
2) Đã xong, trả lời người dùng:
{"thought":"<ngắn gọn>","answer":"<câu trả lời cuối, tiếng Việt>"}

QUY TẮC (bắt buộc):
- Tối đa ${MAX_STEPS} bước. Bước ${MAX_STEPS} (cuối cùng) BẮT BUỘC trả "answer", không được gọi tool.
- Đã đủ thông tin để trả lời (vd search_web hoặc browser_navigate vừa trả kết quả) → trả "answer" NGAY, KHÔNG gọi thêm tool. Đừng lan man.
- KHÔNG gọi lại cùng một tool với cùng tham số. Kiểm tra kết quả (OBSERVATION) trước khi bước tiếp.
- Tool lỗi hoặc rỗng 1 lần → thử cách khác; vẫn lỗi → trả "answer" nêu rõ lỗi.
- Tuyệt đối không bịa kết quả tool.
ĐỌC NỘI DUNG WEB: browser_navigate TRẢ LUÔN tiêu đề + text trang → tóm tắt/trả lời ngay. Đọc lại → browser_read (trả thêm "viewportText" = phần đang nhìn thấy + scrollY).
ĐIỀU KHIỂN WEB: bấm nút / chọn đáp án / điền form / mở link → browser_act với mô tả tiếng Việt (vd "bấm nút Next", "chọn đáp án B, chọn ô thứ 2"). browser_act TRẢ VỀ LUÔN nội dung trang sau hành động — đọc field "text" để xác nhận rồi mới trả lời, KHÔNG đoán. Cuộn thuần → browser_scroll(deltaY). KHÔNG dùng browser_screenshot (bạn không đọc được ảnh). Thông tin mới → search_web; đọc 1 URL bất kỳ → web_analyze.`;
}

function extractJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fence ? fence[1] : s;
  const start = cand.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cand.length; i++) {
    const ch = cand[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(cand.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

async function callModel(baseUrl, key, model, messages) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 2000 }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* noop */ }
  if (!res.ok) { const e = new Error(`LLM ${res.status}: ${(json && (json.error?.message || json.message)) || text.slice(0, 160)}`); e.status = res.status; throw e; }
  let content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content)
    || (json && json.choices && json.choices[0] && json.choices[0].text) || '';
  if (!content && json) { // SSE-flavored body fallback
    content = String(text).split('\n').filter(l => l.startsWith('data:')).map(l => { try { const j = JSON.parse(l.slice(5)); return j.choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  }
  return String(content);
}

async function runInternalAgent(prompt, { provider, model, onEvent, allowedTools } = {}) {
  // Dung model user chon (resolve provider tu DB); fallback chain dong
  model = model || AGENT_MODEL;
  if (!provider || provider === 'auto') {
    provider = (await resolveModelProvider(model)) || AGENT_PROVIDER;
  }
  provider = String(provider).toLowerCase();
  // Chain: model user chon truoc, sau do fallback dong (env/DB/mac dinh)
  const chain = [{ provider, model }]
    .concat(await getFallbackChain(provider, model));
  let lastErr = null;
  for (const cand of chain) {
    try {
      const r = await runAgentLoop(prompt, cand.provider, cand.model, onEvent, allowedTools);
      console.log(`[Agent] served by ${cand.provider}/${cand.model} (${r.rounds || '?'} rounds)`);
      return r;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      console.warn(`[Agent] failover ${cand.provider}/${cand.model}: ${msg.slice(0, 180)}`);
      // Chỉ failover khi lỗi provider (credit/hết quota/model chết/key), không retry lỗi logic
      if (!/LLM (400|401|402|403|404|429|5\d\d)|chưa có API key|Không biết chat endpoint/i.test(msg)) throw e;
      if (onEvent) onEvent({ failover: cand.provider, error: msg.slice(0, 160) });
    }
  }
  throw lastErr || new Error('Không có provider AI khả dụng');
}

async function runAgentLoop(prompt, provider, model, onEvent, allowedTools) {
  const key = await getKey(provider);
  if (!key) throw new Error(`Provider ${provider} chưa có API key trong khoa_api (env AGENT_PROVIDER/AGENT_MODEL để đổi)`);
  const baseUrl = chatUrl(provider);
  const messages = [{ role: 'system', content: buildSystemPrompt(allowedTools) }, { role: 'user', content: String(prompt) }];
  const steps = [];
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  let lastSig = '';
  let repeat = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() > deadline) break; // hết giờ -> tổng hợp trả lời, không ném lỗi
    const lastStep = step === MAX_STEPS - 1;
    // Bước cuối: ép model trả lời, cấm gọi thêm tool (đảm bảo luôn có đáp án)
    if (lastStep) {
      messages.push({ role: 'user', content: 'ĐÂY LÀ BƯỚC CUỐI. Bắt buộc trả ĐÚNG JSON {"thought":"...","answer":"..."} — KHÔNG gọi thêm tool. Dùng mọi thông tin đã có.' });
    }
    const raw = await callModel(baseUrl, key, model, messages);
    const act = extractJson(raw);
    if (onEvent) onEvent({ step, raw: raw.slice(0, 400) });
    if (lastStep) {
      // Ép lấy đáp án: ưu tiên answer; nếu model vẫn không trả JSON thì dùng text thô làm câu trả lời
      const ans = (act && act.answer) ? String(act.answer) : String(raw).trim();
      if (ans) {
        steps.push({ step: step + 1, thought: (act && act.thought) || '', answer: ans.slice(0, 20000) });
        return { success: true, provider, model, steps, answer: ans, rounds: step + 1, forced: true };
      }
      break;
    }
    if (!act || typeof act !== 'object') {
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: 'OBSERVATION: phản hồi không phải JSON hợp lệ. Trả lời ĐÚNG 1 object JSON như hướng dẫn.' });
      continue;
    }
    if (act.answer) {
      steps.push({ step: step + 1, thought: act.thought || '', answer: String(act.answer).slice(0, 20000) });
      return { success: true, provider, model, steps, answer: String(act.answer), rounds: step + 1 };
    }
    if (act.tool) {
      const sig = act.tool + '|' + JSON.stringify(act.args || {});
      if (sig === lastSig) repeat++; else { repeat = 0; lastSig = sig; }
      let toolResult;
      if (allowedTools && allowedTools.length && !allowedTools.includes(act.tool)) {
        toolResult = { error: 'Tool "' + act.tool + '" không được phép trong ngữ cảnh này. Chỉ dùng: ' + allowedTools.join(', ') };
      } else if (repeat >= 2) {
        toolResult = { error: 'Bạn đã gọi lại y hệt ' + act.tool + ' nhiều lần. ĐỔI cách khác hoặc trả "answer" với thông tin đã có.' };
      } else {
        try {
          toolResult = await Promise.race([
            executeTool(act.tool, act.args || {}),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`tool ${act.tool} timeout`)), TOOL_TIMEOUT_MS)),
          ]);
        } catch (e) { toolResult = { error: String(e && e.message || e) }; }
      }
      const slim = JSON.stringify(toolResult).slice(0, 6000);
      steps.push({ step: step + 1, thought: act.thought || '', tool: act.tool, args: act.args, result: slim.slice(0, 500) });
      messages.push({ role: 'assistant', content: JSON.stringify({ thought: act.thought || '', tool: act.tool, args: act.args }) });
      messages.push({ role: 'user', content: `OBSERVATION (${act.tool}): ${slim}` });
      continue;
    }
    // JSON hợp lệ nhưng thiếu cả answer lẫn tool -> nhắc định dạng rồi tiếp
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: 'OBSERVATION: JSON thiếu "answer" hoặc "tool". Trả lại ĐÚNG định dạng.' });
  }
  // Hết bước/hết giờ mà chưa có answer: gọi 1 lần tổng hợp để LUÔN trả về câu trả lời thay vì báo lỗi trần bước
  try {
    messages.push({ role: 'user', content: 'Hết ngân sách bước. Trả lời NGƯỜI DÙNG NGAY bằng tiếng Việt, tóm tắt mọi thông tin đã có ở trên, KHÔNG gọi thêm tool.' });
    const finalRaw = await callModel(baseUrl, key, model, messages);
    const fin = extractJson(finalRaw);
    const ans = (fin && fin.answer) ? String(fin.answer) : String(finalRaw).trim();
    if (ans) {
      steps.push({ step: steps.length + 1, answer: ans.slice(0, 20000) });
      return { success: true, provider, model, steps, answer: ans, rounds: steps.length, forced: true };
    }
  } catch { /* ignore, rơi xuống fallback dưới */ }
  return { success: false, error: `Đạt trần ${MAX_STEPS} bước mà chưa có câu trả lời`, steps };
}

module.exports = { runInternalAgent };
