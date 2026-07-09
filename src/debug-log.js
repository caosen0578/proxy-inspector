// 管理员调试：把「需要上送的记录」同步落一份本地 JSONL，供离线检索/核对。
//
// ⚠️ 会把 prompt / result / 产出代码 / 请求完整报文 明文写盘（敏感）。
//    仅管理员在面板开启（settings.debugLogEnabled，默认关），定位同 DEBUG_UPLOAD——排查工具。
//
// 格式：JSONL —— 每条记录一行 JSON（换行/逗号等一律转义进字符串，永不错位，grep/jq/pandas 都好处理）。
// 字段：time(ISO时间) id(=抓包页记录 id，可搜索对应) requestId prompt result acceptResult
//       requestRaw(请求完整报文体) responseRaw(响应完整报文体/SSE 原文，供取证复现)
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'upload-debug-log.jsonl');

// 追加一行 JSON。失败只告警，绝不影响上送主流程。
// row 的键顺序即列顺序（JSON.stringify 保留插入顺序），由调用方按约定字段传入。
function append(row) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch (e) {
    console.warn('[debug-log] JSONL 写入失败:', e.message);
  }
}

module.exports = { append, LOG_FILE };
