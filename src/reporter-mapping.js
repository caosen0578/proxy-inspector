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
  sseContent(raw) {
    return parseSSE(raw).map(c => {
      const ch = c.choices && c.choices[0];
      if (!ch) return '';
      return (ch.delta && ch.delta.content) || ch.text || '';
    }).join('');
  },
  sseModel(raw) { const c = parseSSE(raw)[0]; return c ? (c.model ?? null) : null; },
  sseFinishReason(raw) {
    const cs = parseSSE(raw);
    for (let i = cs.length - 1; i >= 0; i--) { const fr = cs[i].choices && cs[i].choices[0] && cs[i].choices[0].finish_reason; if (fr) return fr; }
    return null;
  },
  ssePromptTokens(raw) { return sseUsage(raw, 'prompt_tokens'); },
  sseCompletionTokens(raw) { return sseUsage(raw, 'completion_tokens'); },
  sseTotalTokens(raw) { return sseUsage(raw, 'total_tokens'); },
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
  result:             { source: 'resText', transform: 'sseContent' },
  acceptResult:       { source: 'resText', transform: 'sseContent' },
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
