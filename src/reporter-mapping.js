// 报文 → 埋点接口字段映射（配置驱动）
//
// 映射配置形如：
//   { "目标字段": { source, ...参数, transform } }
//
// source 取值来源：
//   const   固定值          —— { source:'const', value:'CODE_CHAT' }
//   uuid    随机 UUID       —— { source:'uuid' }
//   config  上送配置项       —— { source:'config', key:'reporterTriggerVersion' }
//   req     请求 body（JSON）—— { source:'req', path:'messages' }
//   res     响应 body（JSON）—— { source:'res', path:'choices.0.message.content' }
//   record  报文元数据        —— { source:'record', path:'statusCode' }（url/method/statusCode/timestamp）
//
// path 支持点号路径与数组下标，如 'choices.0.message.content'。
// transform 可选，对取到的值做二次处理，见 TRANSFORMS。
// 取不到值时降级为 null（const/uuid 除外），不阻断上送。

const crypto = require('crypto');

function safeParse(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}

// 按点号路径取值，支持数组下标：a.b.0.c
function getByPath(obj, path) {
  if (obj == null || !path) return undefined;
  return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

// 解析 SSE 流式响应体（text/event-stream）为 chunk 对象数组
// 每行形如 `data: {json}`，忽略空行、注释行与 `data: [DONE]`
function parseSSE(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* 跳过半截 chunk */ }
  }
  return out;
}
function sseUsage(raw, field) {
  const chunks = parseSSE(raw);
  for (let i = chunks.length - 1; i >= 0; i--) {
    const u = chunks[i] && chunks[i].usage;
    if (u && u[field] != null) return u[field];
  }
  return null;
}

// 从 markdown 文本中提取 ``` 围栏代码块的代码（去掉语言标记与围栏本身）。
// 多个代码块用空行拼接；若没有任何围栏代码块，返回原文（避免纯文字回复被清空）。
function extractCodeBlocks(text) {
  if (typeof text !== 'string' || !text) return '';
  const re = /```[^\n`]*\n?([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text))) blocks.push(m[1].replace(/\s+$/, ''));
  return blocks.length ? blocks.join('\n\n') : text;
}

// SSE 拼接正文（content 对话 / text 补全），module 级供多处复用
function sseJoinContent(raw) {
  return parseSSE(raw).map(c => {
    const ch = c.choices && c.choices[0];
    if (!ch) return '';
    return (ch.delta && ch.delta.content) || ch.text || '';
  }).join('');
}

// 重组 SSE 流里的 tool_calls → 按出现顺序的工具调用数组。
//
// ⚠️ 关键：本模型(glm5-0)偶发把一次响应里的多个工具调用都标成 index:0。
// 若按 index 归并，多个调用的 name 会被拼成 write_to_filewrite_to_file，
// 且 arguments 被首尾相接拼成非法 JSON（{...}{...}）→ JSON.parse 失败 → 代码全丢。
// 因此改为按"边界"切分：分片带 id 或 function.name = 新调用开始；
// 只带 arguments（无 id、无 name）= 上一个调用的续传分片。
// 这样既兼容标准 OpenAI（index 递增），也兼容本模型（index 恒 0）。
function sseToolCalls(raw) {
  const calls = [];
  let cur = null;
  for (const c of parseSSE(raw)) {
    const ch = c.choices && c.choices[0];
    const tcs = ch && ch.delta && ch.delta.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const fn = tc.function || {};
      if (tc.id || fn.name) {            // 新工具调用开始
        cur = { name: fn.name || '', args: fn.arguments || '' };
        calls.push(cur);
      } else if (cur) {                  // 续传分片：只追加 arguments
        if (fn.arguments) cur.args += fn.arguments;
      }
    }
  }
  return calls;
}

// 从 tool_calls 参数里提取写入的代码：优先 new_str，其次 content/code/newText
function toolCallsCode(raw) {
  const out = [];
  for (const c of sseToolCalls(raw)) {
    let obj; try { obj = JSON.parse(c.args); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const code = obj.new_str ?? obj.content ?? obj.code ?? obj.newText;
    if (typeof code === 'string' && code) out.push(code);
  }
  return out.join('\n\n');
}

// 是否为补全接口 /v2/completions 的响应：chunk 用 choices[0].text（裸代码、无围栏）；
// 对话接口 /v2/chat/completions 用 choices[0].delta.content。以此可靠区分两类报文。
function isCompletionStyle(raw) {
  for (const c of parseSSE(raw)) {
    const ch = c.choices && c.choices[0];
    if (!ch) continue;
    if (ch.delta && typeof ch.delta.content === 'string') return false; // 对话流
    if (typeof ch.text === 'string') return true;                       // 补全流
  }
  return false;
}

// 统一提取「AI 实际产出的代码」，覆盖文档描述的两类接口：
//   1) Agent/Craft：工具调用 write_to_file.content / replace_in_file.new_str
//   2) 对话带围栏：delta.content 里的 ``` 代码块
//   3) 代码补全：choices[0].text 全量（裸代码、无围栏）—— 全文即写入代码
// 对话纯文字（无围栏、无工具）返回空，不计入代码统计。
function extractGeneratedCode(raw) {
  const tool = toolCallsCode(raw);
  if (tool) return tool;
  const content = sseJoinContent(raw);
  if (/```/.test(content)) return extractCodeBlocks(content);
  if (isCompletionStyle(raw)) return content; // 补全裸代码
  return '';
}

// 转换函数注册表：transform 名 → (value) => newValue
const TRANSFORMS = {
  // OpenAI messages 数组 → 拼接文本
  joinMessages(v) {
    if (!Array.isArray(v)) return typeof v === 'string' ? v : '';
    return v.map(m => (m && typeof m.content === 'string') ? `${m.role || ''}: ${m.content}` : '')
            .filter(Boolean).join('\n');
  },
  isoDate(v) { const d = new Date(v ?? Date.now()); return isNaN(d) ? null : d.toISOString(); },
  string(v) { return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); },
  number(v) { const n = Number(v); return isNaN(n) ? null : n; },
  // —— SSE 流式响应（作用于原始响应文本，配合 source:'resText'）——
  // 同时兼容对话格式（choices[].delta.content）与补全格式（choices[].text）
  sseContent(raw) { return sseJoinContent(raw); },
  sseModel(raw) { const c = parseSSE(raw)[0]; return c ? (c.model ?? null) : null; },
  sseFinishReason(raw) {
    const cs = parseSSE(raw);
    for (let i = cs.length - 1; i >= 0; i--) { const fr = cs[i].choices && cs[i].choices[0] && cs[i].choices[0].finish_reason; if (fr) return fr; }
    return null;
  },
  ssePromptTokens(raw) { return sseUsage(raw, 'prompt_tokens'); },
  sseCompletionTokens(raw) { return sseUsage(raw, 'completion_tokens'); },
  sseTotalTokens(raw) { return sseUsage(raw, 'total_tokens'); },
  // 从已拼接文本里只取 markdown 代码块
  extractCode(v) { return extractCodeBlocks(typeof v === 'string' ? v : ''); },
  // SSE 流式 → 拼接正文 → 只取 markdown 代码块
  sseCode(raw) { return extractCodeBlocks(sseJoinContent(raw)); },
  // SSE 流式 → 从 tool_calls 参数里提取写入的代码（new_str/content，写文件型补全用）
  sseToolCode(raw) { return toolCallsCode(raw); },
  // 综合：覆盖三类接口的「AI 实际产出代码」（Agent 工具调用 / 对话围栏 / 补全裸代码）。
  // 纯说明文字、只读工具(read_file/read_lints) 一律返回空，不计入统计。
  sseCodeAll(raw) { return extractGeneratedCode(raw); },
  // 生成代码行数：按 extractGeneratedCode 的结果统计
  sseCodeLines(raw) {
    const code = extractGeneratedCode(raw);
    return code ? code.split('\n').length : 0;
  },
  // 生成代码字节数（UTF-8）
  sseCodeSize(raw) {
    const code = extractGeneratedCode(raw);
    return code ? Buffer.byteLength(code, 'utf8') : 0;
  },
};

// 默认映射 —— 用户行为埋点接口 v1.0 saveRecord 字段
// 适配：OpenAI 风格请求体 + SSE 流式响应（如 CodeBuddy/dsv4）
const DEFAULT_MAPPING = {
  // —— 必填 ——
  pluginVersion:      { source: 'config', key: 'reporterTriggerVersion' },
  createdBy:          { source: 'um' }, // UM号=系统用户名（右上角自动获取），统计个人代码生成率
  sessionId:          { source: 'record', path: 'requestHeaders.x-conversation-id' },
  requestId:          { source: 'record', path: 'requestHeaders.x-request-trace-id' },
  type:               { source: 'const',  value: 'CODE_CHAT' },
  result:             { source: 'resText', transform: 'sseCodeAll' }, // 只上送 markdown 代码块里的代码
  acceptResult:       { source: 'resText', transform: 'sseCodeAll' },
  prompt:             { source: 'req',    path: 'messages', transform: 'joinMessages' },
  scope:              { source: 'record', path: 'requestHeaders.x-ide-type' },
  isStatistics:       { source: 'const',  value: 1 },
  modelName:          { source: 'resText', transform: 'sseModel' },
  promptTokens:       { source: 'resText', transform: 'ssePromptTokens' },
  completionTokens:   { source: 'resText', transform: 'sseCompletionTokens' },
  totalTokens:        { source: 'resText', transform: 'sseTotalTokens' },
  // —— 选填 ——
  cost:               { source: 'record', path: 'duration' },
  apiStatusCode:      { source: 'record', path: 'statusCode', transform: 'string' },
  clientResponseCode: { source: 'record', path: 'statusCode', transform: 'string' },
  triggerType:        { source: 'const',  value: 'auto' },
  apiUrl:             { source: 'record', path: 'url' },
  finishReason:       { source: 'resText', transform: 'sseFinishReason' },
  // 生成代码量统计（与 result 同源，按 AI 实际产出代码计算）
  codeLines:          { source: 'resText', transform: 'sseCodeLines' },
  codeSize:           { source: 'resText', transform: 'sseCodeSize' },
  // 补全接口上下文（来自请求体 extra.*，对话接口无则降级 null）
  language:           { source: 'req',    path: 'extra.language' },
  filePath:           { source: 'req',    path: 'extra.file_name' },
  repository:         { source: 'req',    path: 'extra.repo_name' },
};

// 解析单个字段的取值
function resolveField(spec, ctx) {
  let value;
  switch (spec.source) {
    case 'const':  value = spec.value; break;
    case 'uuid':   return crypto.randomUUID(); // 不参与 transform
    case 'config': value = ctx.config ? ctx.config[spec.key] : undefined; break;
    case 'um':     return ctx.config ? (ctx.config.umAccount || '') : ''; // UM号=系统用户名

    case 'req':    value = getByPath(ctx.req, spec.path); break;
    case 'res':    value = getByPath(ctx.res, spec.path); break;
    case 'reqText': value = ctx.reqText; break; // 原始请求文本（配合 transform）
    case 'resText': value = ctx.resText; break; // 原始响应文本（SSE 等非 JSON 用）
    case 'record': value = getByPath(ctx.record, spec.path); break;
    default:       value = undefined;
  }
  if (spec.transform && TRANSFORMS[spec.transform]) {
    value = TRANSFORMS[spec.transform](value);
  }
  // const 允许 undefined/0/'' 原样保留；其余取不到时降级 null
  if (value === undefined) value = spec.source === 'const' ? spec.value : null;
  return value;
}

/**
 * 按映射配置将一条抓包记录转换为上送请求体
 * @param {object} record  报文对象（url/method/statusCode/timestamp/requestBody/responseBody）
 * @param {object} opts    { mapping, config } —— mapping 为空则用 DEFAULT_MAPPING；config 提供 config 来源的值
 */
function toSaveRecord(record, opts = {}) {
  const mapping = (opts.mapping && Object.keys(opts.mapping).length) ? opts.mapping : DEFAULT_MAPPING;
  const ctx = {
    req: safeParse(record.requestBody) || {},
    res: safeParse(record.responseBody) || {},
    reqText: record.requestBody || '',
    resText: record.responseBody || '',
    record,
    config: opts.config || {},
  };
  const out = {};
  for (const [field, spec] of Object.entries(mapping)) {
    out[field] = resolveField(spec, ctx);
  }
  return out;
}

module.exports = { toSaveRecord, DEFAULT_MAPPING, TRANSFORMS, getByPath, safeParse };
