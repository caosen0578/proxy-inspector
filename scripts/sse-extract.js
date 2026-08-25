#!/usr/bin/env node
/**
 * sse-extract.js —— 模型原始 SSE 响应的提取逻辑（独立版，零依赖）。
 *
 * 场景：网关已抓到「请求头 + 请求体(提示词) + 模型 SSE 响应」，头和请求体不需要提取，
 * 需要提取的只有 SSE。本文件把 reporter-mapping.js 里响应侧的全部逻辑剥出来，
 * 不依赖 settings/config/record 结构，输入就是一段 SSE 原文字符串。
 *
 * 两种用法：
 *   1) 当模块： const { extract } = require('./sse-extract'); extract(sseRawString)
 *   2) 当 CLI： node scripts/sse-extract.js <sse原文文件>        → 打印提取结果摘要
 *              node scripts/sse-extract.js <sse原文文件> --json  → 输出完整 JSON
 *
 * 与旧链路(CodeBuddy 处理后的流)的差异，见文件末尾 diagnose() ——
 * 它会告诉你这段样本里 tool_calls 的实际形态，据此判断哪些补丁还需要。
 */

'use strict';

// ── 1. SSE 切帧 ───────────────────────────────────────────────────────────
// 逐行扫描：只认 `data:` 行；丢弃空行、注释行、event:/id:/retry: 等字段行；
// 丢弃空 payload 与 [DONE]；JSON 解析失败静默跳过（半截 chunk 不能炸整条）。
function parseSSE(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* 半截 chunk */ }
  }
  return out;
}

// ── 2. 正文拼接 ───────────────────────────────────────────────────────────
// 一次同时兼容两种流：对话流取 delta.content，补全流取 choices[0].text。
function joinContent(chunks) {
  return chunks.map(c => {
    const ch = c.choices && c.choices[0];
    if (!ch) return '';
    return (ch.delta && ch.delta.content) || ch.text || '';
  }).join('');
}

// 有些模型把思维链单独放 delta.reasoning_content（原始流才有，CodeBuddy 会吃掉）。
// 单独拼出来，不混进 result —— 混进去会污染代码行数统计。
function joinReasoning(chunks) {
  return chunks.map(c => {
    const d = c.choices && c.choices[0] && c.choices[0].delta;
    return (d && (d.reasoning_content || d.reasoning)) || '';
  }).join('');
}

// ── 3. 围栏代码块 ─────────────────────────────────────────────────────────
function codeBlocksOf(text) {
  if (typeof text !== 'string' || !text) return [];
  const re = /```[^\n`]*\n?([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text))) blocks.push(m[1].replace(/\s+$/, ''));
  return blocks;
}

// ── 4. tool_calls 还原 ────────────────────────────────────────────────────
// 括号配平切分：正确处理字符串内的引号、反斜杠转义、字符串里的花括号。
// 返回 [{ obj, start }]，start 为该对象在拼接缓冲区中的起始偏移。
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
        try { objs.push({ obj: JSON.parse(s.slice(start, i + 1)), start }); } catch { /* 非法 JSON */ }
        start = -1;
      }
    }
  }
  return objs;
}

// 工具名黏连折叠：write_to_filewrite_to_file → write_to_file
function collapseGluedName(name) {
  const m = /^(.+?)\1+$/.exec(name || '');
  return m ? m[1] : (name || '');
}

// 全量拼 arguments + 偏移回配 name。完全不依赖 id/index ——
// 模型会把同一次调用的 arguments 拆进多个带 name 的分片，按 id/index 切会劈碎 JSON。
function toolCallsAll(chunks) {
  let buf = '';
  const nameMarks = [];
  for (const c of chunks) {
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

// 非流式兜底：有些网关会把上游的非流式 JSON 响应也走同一条通道。
// 此时没有 data: 行，直接按 choices[0].message 解析。
function nonStreamFallback(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  const msg = obj && obj.choices && obj.choices[0] && obj.choices[0].message;
  if (!msg) return null;
  const items = [];
  for (const tc of (msg.tool_calls || [])) {
    const a = tc.function && tc.function.arguments;
    let parsed = null;
    try { parsed = typeof a === 'string' ? JSON.parse(a) : a; } catch { /* ignore */ }
    if (parsed && typeof parsed === 'object') {
      items.push({ name: collapseGluedName(tc.function && tc.function.name), obj: parsed });
    }
  }
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
    items,
    model: obj.model ?? null,
    usage: obj.usage || null,
    finishReason: (obj.choices[0] && obj.choices[0].finish_reason) || null,
  };
}

function codeOfToolCall(obj) {
  const code = obj.new_str ?? obj.content ?? obj.code ?? obj.newText;
  return (typeof code === 'string' && code) ? code : undefined;
}
function filePathOfToolCall(obj) {
  const fp = obj.filePath ?? obj.file_path ?? obj.target_file ?? obj.path;
  return typeof fp === 'string' ? fp : '';
}

// ── 5. 参数摘要（非代码工具的单行留痕）─────────────────────────────────────
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

// ── 6. 主入口 ─────────────────────────────────────────────────────────────
/**
 * 从一段 SSE 原文提取全部结果字段。
 * @param {string} raw  SSE 原文（已解压、已拼接完整）
 * @returns {{ result, acceptResult, codeLines, codeSize, acceptCodeLines, acceptCodeSize,
 *            modelName, promptTokens, completionTokens, totalTokens, finishReason,
 *            reasoning, isStream, toolNames, writes }}
 */
function extract(raw) {
  const chunks = parseSSE(raw);
  const isStream = chunks.length > 0;

  let content, reasoning, items, model, usage, finishReason;

  if (isStream) {
    content = joinContent(chunks);
    reasoning = joinReasoning(chunks);
    items = toolCallsAll(chunks);
    // model 取第一个 chunk；usage / finish_reason 倒序找（都在流末尾）
    model = chunks[0] ? (chunks[0].model ?? null) : null;
    usage = null;
    for (let i = chunks.length - 1; i >= 0 && !usage; i--) if (chunks[i].usage) usage = chunks[i].usage;
    finishReason = null;
    for (let i = chunks.length - 1; i >= 0 && !finishReason; i--) {
      const ch = chunks[i].choices && chunks[i].choices[0];
      if (ch && ch.finish_reason) finishReason = ch.finish_reason;
    }
  } else {
    const fb = nonStreamFallback(raw);
    if (!fb) return emptyResult();
    ({ content, reasoning, items, model, usage, finishReason } = fb);
  }

  // 是否补全流（choices[0].text 裸代码，无围栏）
  let completionStyle = false;
  for (const c of chunks) {
    const ch = c.choices && c.choices[0];
    if (!ch) continue;
    if (ch.delta && typeof ch.delta.content === 'string') { completionStyle = false; break; }
    if (typeof ch.text === 'string') { completionStyle = true; break; }
  }

  // 工具写入（按 code 文本去重）
  const writes = [];
  const seenCode = new Set();
  for (const it of items) {
    const code = codeOfToolCall(it.obj);
    if (!code || seenCode.has(code)) continue;
    seenCode.add(code);
    writes.push({ name: it.name, filePath: filePathOfToolCall(it.obj), code });
  }

  // acceptResult：工具写入代码 ∪ 旁白围栏代码，按文本去重；都空且是补全流则取全文
  const accParts = [];
  const accSeen = new Set();
  const add = (c) => { if (c && !accSeen.has(c)) { accSeen.add(c); accParts.push(c); } };
  writes.forEach(w => add(w.code));
  const blocks = codeBlocksOf(content);
  if (blocks.length) blocks.forEach(add);
  else if (!accParts.length && completionStyle) add(content);
  const acceptResult = accParts.join('\n\n');

  // result：旁白 + 全量工具留痕，按流式顺序
  const narration = (content || '').replace(/\s+$/, '');
  let result;
  if (!items.length) {
    result = narration;
  } else {
    const parts = [];
    if (narration) parts.push(narration);
    const seen2 = new Set();
    for (const it of items) {
      const code = codeOfToolCall(it.obj);
      if (code) {
        if (seen2.has(code)) continue;
        seen2.add(code);
        const fp = filePathOfToolCall(it.obj);
        const label = (it.name ? '[' + it.name + '] ' : '') + (fp ? '文件 `' + fp + '`：' : '文件（未命名）：');
        parts.push(label + '\n```\n' + code.replace(/\s+$/, '') + '\n```');
      } else {
        parts.push('> 调用 ' + (it.name || '(未知工具)') + ': ' + toolArgsSummary(it.obj));
      }
    }
    result = parts.join('\n\n');
  }

  const lines = (s) => s ? String(s).split('\n').length : 0;
  const bytes = (s) => s ? Buffer.byteLength(String(s), 'utf8') : 0;

  return {
    result,
    acceptResult,
    codeLines: lines(result),
    codeSize: bytes(result),
    acceptCodeLines: lines(acceptResult),
    acceptCodeSize: bytes(acceptResult),
    modelName: model,
    promptTokens: usage ? (usage.prompt_tokens ?? null) : null,
    completionTokens: usage ? (usage.completion_tokens ?? null) : null,
    totalTokens: usage ? (usage.total_tokens ?? null) : null,
    finishReason,
    reasoning,            // 思维链，单独给出，不混进 result
    isStream,
    completionStyle,
    toolNames: items.map(it => it.name || '(未知)'),
    writes,
  };
}

function emptyResult() {
  return {
    result: '', acceptResult: '', codeLines: 0, codeSize: 0,
    acceptCodeLines: 0, acceptCodeSize: 0, modelName: null,
    promptTokens: null, completionTokens: null, totalTokens: null,
    finishReason: null, reasoning: '', isStream: false, completionStyle: false,
    toolNames: [], writes: [],
  };
}

// ── 7. 形态诊断 ───────────────────────────────────────────────────────────
// 告诉你这段样本的 tool_calls 到底长什么样，据此判断旧链路的补丁还需不需要。
function diagnose(raw) {
  const chunks = parseSSE(raw);
  let tcChunks = 0, namedFrags = 0, gluedNames = 0, argFrags = 0, hasIndex = 0, hasId = 0;
  const rawNames = new Set();
  for (const c of chunks) {
    const tcs = c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls;
    if (!Array.isArray(tcs)) continue;
    tcChunks++;
    for (const tc of tcs) {
      if (tc.index != null) hasIndex++;
      if (tc.id) hasId++;
      const nm = tc.function && tc.function.name;
      if (nm) {
        namedFrags++;
        rawNames.add(nm);
        if (collapseGluedName(nm) !== nm) gluedNames++;
      }
      if (typeof (tc.function && tc.function.arguments) === 'string') argFrags++;
    }
  }
  return {
    chunkCount: chunks.length,
    toolCallChunks: tcChunks,
    namedFragments: namedFrags,
    gluedNameFragments: gluedNames,     // >0 说明黏连补丁仍然需要
    argumentFragments: argFrags,
    fragmentsWithIndex: hasIndex,       // 若 == argFrags，说明 index 可靠，可用标准切分
    fragmentsWithId: hasId,
    distinctRawNames: [...rawNames],
    hasReasoning: chunks.some(c => {
      const d = c.choices && c.choices[0] && c.choices[0].delta;
      return d && (d.reasoning_content || d.reasoning);
    }),
  };
}

module.exports = { extract, diagnose, parseSSE, joinContent, toolCallsAll, codeBlocksOf };

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/sse-extract.js <sse原文文件> [--json]');
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const r = extract(raw);
  const d = diagnose(raw);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ extract: r, diagnose: d }, null, 2));
  } else {
    console.log('── 形态诊断 ──');
    console.log(JSON.stringify(d, null, 2));
    console.log('\n── 提取结果 ──');
    console.log(`modelName        : ${r.modelName}`);
    console.log(`finishReason     : ${r.finishReason}`);
    console.log(`tokens           : prompt=${r.promptTokens} completion=${r.completionTokens} total=${r.totalTokens}`);
    console.log(`isStream         : ${r.isStream}   completionStyle: ${r.completionStyle}`);
    console.log(`toolNames        : ${r.toolNames.join(', ') || '(无)'}`);
    console.log(`writes           : ${r.writes.map(w => w.filePath || '(未命名)').join(', ') || '(无)'}`);
    console.log(`reasoning        : ${r.reasoning ? r.reasoning.length + ' 字' : '(无)'}`);
    console.log(`codeLines/Size   : ${r.codeLines} / ${r.codeSize}`);
    console.log(`acceptLines/Size : ${r.acceptCodeLines} / ${r.acceptCodeSize}`);
    console.log('\n── result（前 2000 字）──');
    console.log(r.result.slice(0, 2000));
    console.log('\n── acceptResult（前 2000 字）──');
    console.log(r.acceptResult.slice(0, 2000));
  }
}
