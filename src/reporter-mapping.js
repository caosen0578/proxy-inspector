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

// 返回文本里所有 ``` 围栏代码块（去掉语言标记与围栏本身）的数组；无则空数组。
function codeBlocksOf(text) {
  if (typeof text !== 'string' || !text) return [];
  const re = /```[^\n`]*\n?([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text))) blocks.push(m[1].replace(/\s+$/, ''));
  return blocks;
}
// 从 markdown 文本中提取 ``` 围栏代码块的代码（去掉语言标记与围栏本身）。
// 多个代码块用空行拼接；若没有任何围栏代码块，返回原文（避免纯文字回复被清空）。
function extractCodeBlocks(text) {
  const blocks = codeBlocksOf(text);
  return blocks.length ? blocks.join('\n\n') : (typeof text === 'string' ? text : '');
}

// SSE 拼接正文（content 对话 / text 补全），module 级供多处复用
function sseJoinContent(raw) {
  return parseSSE(raw).map(c => {
    const ch = c.choices && c.choices[0];
    if (!ch) return '';
    return (ch.delta && ch.delta.content) || ch.text || '';
  }).join('');
}

// 从一段文本里按括号配平切出一个个顶层 JSON 对象（正确处理字符串内的引号/转义/花括号）。
// 用于把流式拼接出来的 tool_calls arguments 还原成完整对象，不依赖 id/name/index 切分。
// 返回 [{ obj, start }]，start 为对象在原文中的起始偏移（供按偏移回配工具名）。
function splitJsonObjects(s) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objs.push({ obj: JSON.parse(s.slice(start, i + 1)), start }); } catch { /* 半截/非法 JSON 跳过 */ }
        start = -1;
      }
    }
  }
  return objs;
}

// 从 tool_calls 参数里提取写入的代码：优先 new_str，其次 content/code/newText。
//
// ⚠️ 本模型(glm5-0)偶发把同一次 write 的 content 拆进多个带 name 的分片里
// （表现为 write_to_filewrite_to_file），按 id/name/index 切分会把 content 劈成两半、
// 两半都不是合法 JSON 而全部丢失。因此这里【完全不依赖 id/name/index】：
// 把所有 arguments 分片按出现顺序全量拼接，再用括号配平切出每个完整 JSON 对象。
// 这样无论同一调用被拆几段、还是多个真实调用首尾相接（{...}{...}），都能正确还原。
// 工具名黏连清洗：模型偶发把 name 重复黏成 write_to_filewrite_to_file → 折叠为单个。
function collapseGluedName(name) {
  const m = /^(.+?)\1+$/.exec(name || '');
  return m ? m[1] : (name || '');
}

// 解析本轮全部工具调用 → [{ name, obj }]，按流式出现顺序。
// name 回配：arguments 分片拼接时记录每个带 name 分片对应的缓冲区偏移，
// 切出的每个 JSON 对象按其起始偏移取"最近一个不超过它的 name"（黏连/重复也能对上，配不上为 ''）。
function toolCallsAll(raw) {
  let buf = '';
  const nameMarks = []; // { offset, name }
  for (const c of parseSSE(raw)) {
    const ch = c.choices && c.choices[0];
    const tcs = ch && ch.delta && ch.delta.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const nm = tc.function && tc.function.name;
      if (nm) nameMarks.push({ offset: buf.length, name: collapseGluedName(nm) });
      const a = tc.function && tc.function.arguments;
      if (typeof a === 'string') buf += a;
    }
  }
  return splitJsonObjects(buf).map(({ obj, start }) => {
    let name = '';
    for (const m of nameMarks) { if (m.offset <= start) name = m.name; else break; }
    return { name, obj };
  }).filter(it => it.obj && typeof it.obj === 'object');
}

// 从工具调用对象里取写入代码（无则 undefined）。字段优先级 new_str→content→code→newText。
function codeOfToolCall(obj) {
  const code = obj.new_str ?? obj.content ?? obj.code ?? obj.newText;
  return (typeof code === 'string' && code) ? code : undefined;
}
function filePathOfToolCall(obj) {
  const fp = obj.filePath ?? obj.file_path ?? obj.target_file ?? obj.path;
  return typeof fp === 'string' ? fp : '';
}

// 返回本轮工具写入的文件数组 [{ name, filePath, code }]（按出现顺序、按 code 去重）。
// 写码工具实测为 write_to_file(字段 content) 与 replace_in_file(字段 new_str)。
// 去重：精度问题会让模型把同一次 write 整个发两遍，按 code 文本去重，避免重复上送、虚高代码量。
function toolCallsWrites(raw) {
  const out = [];
  const seen = new Set();
  for (const it of toolCallsAll(raw)) {
    const code = codeOfToolCall(it.obj);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ name: it.name, filePath: filePathOfToolCall(it.obj), code });
  }
  return out;
}

// 仅取工具写入的代码（拼接），供 acceptResult 的代码统计用。
function toolCallsCode(raw) {
  return toolCallsWrites(raw).map(w => w.code).join('\n\n');
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
  const seen = new Set();
  const parts = [];
  const add = (code) => {
    if (typeof code !== 'string' || !code || seen.has(code)) return;
    seen.add(code); parts.push(code);
  };
  // 1) 工具写入代码（write_to_file/replace_in_file）
  for (const w of toolCallsWrites(raw)) add(w.code);
  // 2) 旁白里的围栏代码块 —— 即使有工具代码也并入（原先在此短路，会丢同轮旁白里贴的代码）。
  //    按 code 文本去重，避免"模型先贴预览再写文件"造成重复。
  const content = sseJoinContent(raw);
  const blocks = codeBlocksOf(content);
  if (blocks.length) blocks.forEach(add);
  else if (!parts.length && isCompletionStyle(raw)) add(content); // 补全裸代码（无工具、无围栏时）
  return parts.join('\n\n');
}

// 非代码工具的单行留痕参数摘要：单个字符串值 >120 字截断并标注总长，整行 >300 字截断。
// 代码块（写码工具）永不截断——这里只作用于 read_file/todo_write/execute_command 等。
// 全文永远可在调试 JSONL 的 requestRaw/responseRaw 里查到，result 只留可读摘要。
function toolArgsSummary(obj) {
  const compact = {};
  for (const [k, v] of Object.entries(obj)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    compact[k] = (s && s.length > 120) ? s.slice(0, 120) + `…(共${s.length}字)` : v;
  }
  let line;
  try { line = JSON.stringify(compact); } catch { line = '(参数序列化失败)'; }
  return line.length > 300 ? line.slice(0, 300) + '…' : line;
}

// result 用「完整回复 + 全量工具留痕」：模型旁白 + 本轮所有工具调用按流式顺序排列——
//   写码工具（write_to_file/replace_in_file）→ `[工具名] 文件 \`路径\`：` + ``` 围栏代码块（不截断，按 code 去重）
//   其余工具（read_file/todo_write/execute_command/delete_file 等）→ `> 调用 工具名: {参数摘要}` 单行留痕
// 时序可排查"先读了什么→改了什么→跑了什么命令"；acceptResult 里的代码正是围栏块内容，口径一致。
// 纯聊天/补全（无任何工具调用）时与旧 sseContent 完全一致，不改变既有行为。
function sseFullReply(raw) {
  const narration = sseJoinContent(raw).replace(/\s+$/, '');
  const items = toolCallsAll(raw);
  if (!items.length) return narration;
  const parts = [];
  if (narration) parts.push(narration);
  const seenCode = new Set();
  for (const it of items) {
    const code = codeOfToolCall(it.obj);
    if (code) {
      if (seenCode.has(code)) continue; // 同一次 write 重复发两遍只留一份
      seenCode.add(code);
      const fp = filePathOfToolCall(it.obj);
      const label = (it.name ? '[' + it.name + '] ' : '') + (fp ? '文件 `' + fp + '`：' : '文件（未命名）：');
      parts.push(label + '\n```\n' + code.replace(/\s+$/, '') + '\n```');
    } else {
      parts.push('> 调用 ' + (it.name || '(未知工具)') + ': ' + toolArgsSummary(it.obj));
    }
  }
  return parts.join('\n\n');
}

// messages 数组 → 拼接文本（"role: content"，逐条换行）
function messagesToText(v) {
  if (!Array.isArray(v)) return typeof v === 'string' ? v : '';
  return v.map(m => (m && typeof m.content === 'string') ? `${m.role || ''}: ${m.content}` : '')
          .filter(Boolean).join('\n');
}

// 从请求体原文里取「提示词」，两个接口都兼容：
//   对话 /v2/chat/completions：请求体 messages 数组 → 拼接
//   补全 /v2/completions：请求体 prompt 字段（代码上文）
function promptFromReqText(raw) {
  const obj = safeParse(raw);
  if (!obj) return typeof raw === 'string' ? raw : '';
  if (Array.isArray(obj.messages)) return messagesToText(obj.messages);
  if (typeof obj.prompt === 'string') return obj.prompt;
  return '';
}

// 转换函数注册表：transform 名 → (value) => newValue
const TRANSFORMS = {
  // OpenAI messages 数组 → 拼接文本
  joinMessages(v) { return messagesToText(v); },
  // 请求体原文 → 提示词（兼容对话 messages / 补全 prompt），配合 source:'reqText'
  promptAny(raw) { return promptFromReqText(raw); },
  // 提示词字节数（UTF-8）：对 promptAny 的结果算
  promptSize(raw) { return Buffer.byteLength(promptFromReqText(raw), 'utf8'); },
  // 提示词 MD5：对 promptAny 的结果算
  promptMd5(raw) { return crypto.createHash('md5').update(promptFromReqText(raw), 'utf8').digest('hex'); },
  isoDate(v) { const d = new Date(v ?? Date.now()); return isNaN(d) ? null : d.toISOString(); },
  string(v) { return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); },
  number(v) { const n = Number(v); return isNaN(n) ? null : n; },
  // —— SSE 流式响应（作用于原始响应文本，配合 source:'resText'）——
  // 同时兼容对话格式（choices[].delta.content）与补全格式（choices[].text）
  sseContent(raw) { return sseJoinContent(raw); },
  // 完整回复：旁白 + 工具写入的文件（带 filePath 的围栏块）。给 result 用。
  sseFullReply(raw) { return sseFullReply(raw); },
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
  // 任意字符串的行数 / UTF-8 字节数（配合 source:'field' 对已解析字段取值计数，如按 acceptResult 算）
  lineCount(v) { return v ? String(v).split('\n').length : 0; },
  byteSize(v)  { return v ? Buffer.byteLength(String(v), 'utf8') : 0; },
};

// 默认映射 —— 用户行为埋点接口 v1.0 saveRecord 字段
// 适配：OpenAI 风格请求体 + SSE 流式响应（如 CodeBuddy/dsv4）
const DEFAULT_MAPPING = {
  // —— 必填 ——
  pluginVersion:      { source: 'config', key: 'reporterTriggerVersion' },
  createdBy:          { source: 'um' }, // UM号=系统用户名（右上角自动获取），统计个人代码生成率
  sessionId:          { source: 'record', path: 'requestHeaders.x-conversation-id' },
  requestId:          { source: 'record', path: 'requestHeaders.x-conversation-message-id' },
  type:               { source: 'const',  value: 'CODE_CHAT' },
  result:             { source: 'resText', transform: 'sseFullReply' }, // 完整回复：旁白 + 工具写入的文件(围栏块)
  acceptResult:       { source: 'resText', transform: 'sseCodeAll' },  // AI 实际产出代码（与 result 中围栏块同源）
  prompt:             { source: 'reqText', transform: 'promptAny' }, // 对话 messages / 补全 prompt 都兼容
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
  // ⚠️ 整数字段必须带数值 transform，否则会把原始响应文本(字符串)发给接口的 Integer 字段
  //    → 接口报 "Cannot deserialize Integer from String"。切勿手动映射成裸 resText！
  promptSize:         { source: 'reqText', transform: 'promptSize' },
  promptMd5:          { source: 'reqText', transform: 'promptMd5' },
  codeLines:          { source: 'resText', transform: 'sseCodeLines' },
  codeSize:           { source: 'resText', transform: 'sseCodeSize' },
  // acceptCodeLines/acceptCodeSize：接口文档标"否"但后端实际按必填校验。被动代理拿不到
  // "用户真实采纳量"，按 acceptResult 的取值直接计数（source:'field'）——acceptResult 若被改映射，这俩自动跟随。
  acceptCodeLines:    { source: 'field', path: 'acceptResult', transform: 'lineCount' },
  acceptCodeSize:     { source: 'field', path: 'acceptResult', transform: 'byteSize' },
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
    case 'field':  value = getByPath(ctx.out, spec.path); break; // 引用同一条已解析出的目标字段（如 acceptResult）
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
  const out = {};
  const ctx = {
    req: safeParse(record.requestBody) || {},
    res: safeParse(record.responseBody) || {},
    reqText: record.requestBody || '',
    resText: record.responseBody || '',
    record,
    config: opts.config || {},
    out, // 供 source:'field' 引用已解析字段——依赖字段（如 acceptResult）须在映射里排在引用者之前
  };
  for (const [field, spec] of Object.entries(mapping)) {
    out[field] = resolveField(spec, ctx);
  }
  return out;
}

module.exports = { toSaveRecord, DEFAULT_MAPPING, TRANSFORMS, getByPath, safeParse };
