const fs = require('fs');
const axios = require('axios');
const { EventEmitter } = require('events');
const config = require('./config');
const { REPORTER_BATCH_SIZE, REPORTER_FLUSH_MS, REPORTER_MAX_ATTEMPTS,
        REPORTER_QUEUE_FILE, REPORTER_HISTORY_MAX } = config;
const settings = require('./settings');
const { toSaveRecord } = require('./reporter-mapping');
const debugLog = require('./debug-log');

// 已送达历史里每条 body 的最大留存长度（仅供 UI 预览；全量从 trafficStore 取）
const HISTORY_BODY_MAX = 65536; // 64KB

// 队列落盘 debounce 窗口：合并突发写入，降低同步 I/O 对事件循环的阻塞
const PERSIST_DEBOUNCE_MS = 250;

// 上送目标是否就绪：raw 看 reporterUrl，behavior 看 reporterBaseUrl
function targetReady(cfg) {
  if (!cfg.reporterEnabled) return false;
  return cfg.reporterFormat === 'behavior' ? !!cfg.reporterBaseUrl : !!cfg.reporterUrl;
}

// 持久化上送队列：
//   - 每次入队/状态变更立即写盘 → 应用被杀掉重启后可恢复，绝不漏送
//   - 发送成功才从队列移除；失败保留为 failed，下个周期自动重试
//   - 通过 EventEmitter('change') 把队列快照推给 WebUI 实时展示
class Reporter extends EventEmitter {
  constructor() {
    super();
    this.queue = [];          // 待送 / 发送中 / 失败 的条目（持久化）
    this.history = [];         // 最近已送达（仅内存，供 UI 展示）
    this.sentTotal = 0;        // 本次进程累计送达数
    this.qid = 0;              // 队列条目自增 ID
    this.flushing = false;
    // 本会话已入队过的抓包 record.id，用于补送去重。
    // 注意：record.id 仅在单次运行内唯一（trafficStore 重启从 1 计数），
    // 故不从持久化的旧队列 seed，否则会与新会话 id 撞号导致新报文被误判已送。
    this.enqueuedIds = new Set();
    this._load();
    this.timer = setInterval(() => this._flush(), REPORTER_FLUSH_MS);
  }

  // ── 持久化 ──────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(REPORTER_QUEUE_FILE)) {
        const data = JSON.parse(fs.readFileSync(REPORTER_QUEUE_FILE, 'utf8'));
        this.queue = Array.isArray(data.queue) ? data.queue : [];
        this.qid = data.qid || this.queue.reduce((m, e) => Math.max(m, e.qid || 0), 0);
        // 上次中断时正在发送的条目，复位为待送以确保重试
        let recovered = 0;
        this.queue.forEach(e => { if (e.status === 'sending') { e.status = 'pending'; recovered++; } });
        if (this.queue.length) {
          console.log(`[reporter] 从磁盘恢复 ${this.queue.length} 条未完成上送任务` +
                      (recovered ? `（其中 ${recovered} 条上次中断，已复位重试）` : ''));
        }
      }
    } catch (e) {
      console.warn('[reporter] 队列文件读取失败，忽略:', e.message);
      this.queue = [];
    }
  }

  // debounce 落盘：合并突发期间（如一批 SSE 同时完成）的多次写入为一次，
  // 避免每步状态变更都同步阻塞事件循环。最坏丢失窗口 = PERSIST_DEBOUNCE_MS。
  _persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  // 立即同步落盘（进程退出时调用，确保不丢未写入的变更）
  _persistNow() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try {
      fs.writeFileSync(REPORTER_QUEUE_FILE, JSON.stringify({ qid: this.qid, queue: this.queue }));
    } catch (e) {
      console.warn('[reporter] 队列持久化失败:', e.message);
    }
  }

  // ── 入队 ────────────────────────────────────────────
  // 返回 true=已入队，false=被跳过（未就绪/不匹配/未完成/重复）
  push(record) {
    const cfg = settings.get();
    if (!targetReady(cfg)) return false;
    if (!urlMatches(record.url, cfg.reporterFilters)) return false;
    if (record.statusCode == null) return false;          // 未完成的不送（响应还没回来）
    if (record.id != null && this.enqueuedIds.has(record.id)) return false; // 去重，避免补送重复

    // 提前计算上送报文：result（SSE 全部内容）与 acceptResult（提取出的代码）
    // 任一为空都跳过——既无内容、或本轮没产出代码，都不上送。
    // 这里算一次 body，同时用于内容过滤与调试 CSV，避免重复计算。
    const body = toSaveRecord(record, { mapping: settings.mappingForUrl(record.url), config: cfg });
    if (!body.result || !body.acceptResult) return false;

    // 调试落 JSONL（仅管理员开启，默认关）：这是"确定要上送"的记录，正好命中此处。
    // 每条 record 因 enqueuedIds 去重只入队一次，故不会重复写。写失败不影响上送。
    if (cfg.debugLogEnabled) {
      debugLog.append({
        time: new Date().toISOString(),
        id: record.id,                 // = 抓包页记录 id，可据此搜索对应报文
        requestId: body.requestId,
        prompt: body.prompt,
        result: body.result,
        acceptResult: body.acceptResult,
        requestRaw: record.requestBody || '',    // 请求完整报文体
        responseRaw: record.responseBody || '',  // 响应完整报文体（SSE 原文，供取证复现代码提取）
      });
    }

    if (record.id != null) this.enqueuedIds.add(record.id);
    const entry = {
      qid: ++this.qid,
      status: 'pending',
      attempts: 0,
      lastError: null,
      enqueuedAt: Date.now(),
      sentAt: null,
      url: record.url,
      method: record.method,
      record: {
        id: record.id,
        timestamp: record.timestamp,
        method: record.method,
        url: record.url,
        requestHeaders: record.requestHeaders,
        requestBody: truncate(record.requestBody, 524288),   // 512KB：messages 历史可能很大
        statusCode: record.statusCode,
        responseHeaders: record.responseHeaders,
        responseBody: truncate(record.responseBody, 5242880), // 5MB：reasoning 模型 SSE 流可达数 MB
        duration: record.duration,
      },
    };
    this.queue.push(entry);
    this._persist();                       // 入队即落盘，先保证不丢
    this.emit('change', this.snapshot());
    if (this._waitingCount() >= REPORTER_BATCH_SIZE) this._flush();
    return true;
  }

  // 补送候选：抓包列表里"匹配过滤、已完成、未送过"的报文（不入队，仅供弹窗预览/勾选）
  backfillCandidates(records) {
    const cfg = settings.get();
    const items = records.filter(r =>
      r.statusCode != null &&
      urlMatches(r.url, cfg.reporterFilters) &&
      !(r.id != null && this.enqueuedIds.has(r.id))
    ).map(r => ({
      id: r.id, url: r.url, method: r.method, statusCode: r.statusCode,
      timestamp: r.timestamp, duration: r.duration,
    }));
    return { enabled: targetReady(cfg), count: items.length, items };
  }

  // 补送：把指定（或全部候选）历史报文重新入队
  // 用于"上送开关开晚了"导致前面接口漏送的场景。ids 为空=全部候选。
  backfill(records, ids) {
    const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
    let enqueued = 0;
    // records 为新→旧，反转成旧→新入队，保持时间顺序
    for (const rec of records.slice().reverse()) {
      if (idSet && !idSet.has(rec.id)) continue;
      if (this.push(rec)) enqueued++;
    }
    return { scanned: records.length, enqueued };
  }

  _waitingCount() {
    // 仅统计待送（failed 为终态，不自动重试）
    return this.queue.filter(e => e.status === 'pending').length;
  }

  // 内容过滤（入队、发送共用）：要求 result（SSE 全部内容）与 acceptResult（提取代码）
  // 都非空，任一为空都不上送。按当前映射重算，故能挡住"旧规则入队/持久化历史"的条目。
  _passesContentFilter(entry, cfg) {
    const mapping = settings.mappingForUrl(entry.record.url);
    const preview = toSaveRecord(entry.record, { mapping, config: cfg });
    return !!preview.result && !!preview.acceptResult;
  }

  // ── 发送 ────────────────────────────────────────────
  async _flush() {
    if (this.flushing || !this.queue.length) return;
    const cfg = settings.get();
    // 上送关闭/未配置：不发送，但保留队列在磁盘（不丢，开启后继续送）
    if (!targetReady(cfg)) return;

    this.flushing = true;
    try {
      const batch = this.queue
        .filter(e => e.status === 'pending')   // failed 为终态，不在此自动重试
        .slice(0, REPORTER_BATCH_SIZE);

      for (const entry of batch) {
        // 发送前二次校验：result 或 acceptResult 为空则丢弃（不发、不重试）。
        // 覆盖"旧规则/持久化历史入队"的条目——它们入队时也许通过了，但按当前规则不该上送。
        if (!this._passesContentFilter(entry, cfg)) {
          this.queue = this.queue.filter(e => e !== entry);
          console.log(`[reporter] 条目 #${entry.qid} result/acceptResult 为空，按规则丢弃不上送`);
          this._persist();
          this.emit('change', this.snapshot());
          continue;
        }
        entry.status = 'sending';
        this._persist();
        this.emit('change', this.snapshot());

        const ok = await this._send(entry, cfg);
        if (ok) {
          this.queue = this.queue.filter(e => e !== entry);
          entry.status = 'sent';
          entry.sentAt = Date.now();
          this.sentTotal++;
          this._addHistory(entry);
        } else if (entry.attempts >= REPORTER_MAX_ATTEMPTS) {
          entry.status = 'failed';        // 达上限 → 终态，停止自动重试，等手动
          console.warn(`[reporter] 条目 #${entry.qid} 已达 ${REPORTER_MAX_ATTEMPTS} 次上限，停止自动重试：`, entry.lastError);
        } else {
          entry.status = 'pending';       // 未达上限，下个周期继续自动重试
        }
        this._persist();
        this.emit('change', this.snapshot());
      }
    } finally {
      this.flushing = false;
    }
  }

  async _send(entry, cfg) {
    let url, body, extra = {};
    if (cfg.reporterFormat === 'behavior') {
      url = cfg.reporterBaseUrl + config.BEHAVIOR_SAVE_PATH;
      body = toSaveRecord(entry.record, { mapping: settings.mappingForUrl(entry.record.url), config: cfg });
      extra.headers = { [config.BEHAVIOR_TOKEN_HEADER]: cfg.reporterToken || '' };
      // 调试落盘（默认关）：会把上送原始报文=用户代码写到磁盘，投产环境勿开。
      // 需要排查“传值/类型”问题时，设环境变量 DEBUG_UPLOAD=1 再启动即可。
      if (process.env.DEBUG_UPLOAD === '1') dumpUploadDebug(url, body);
    } else {
      url = cfg.reporterUrl;
      body = { records: [entry.record] };
    }
    // 单次发送；重试由 _flush 按周期驱动，最多 REPORTER_MAX_ATTEMPTS 次。
    // 超时取配置 reporterTimeoutMs（仅管理员可改）：须 > 后端最坏响应时间，否则后端慢成功时
    // 客户端先超时→误判失败→重发→重复上送（接收端幂等兜底，但调大此值能从源头减少重发）。
    const timeout = Number(cfg.reporterTimeoutMs) > 0 ? Number(cfg.reporterTimeoutMs) : config.REPORTER_TIMEOUT_MS;
    try {
      const resp = await axios.post(url, body, { timeout, ...extra });
      entry.response = buildResponseSnapshot(resp.status, resp.statusText, resp.data);
      // 埋点接口即便 HTTP 200 也可能业务失败：靠响应体 code/success 判定真正成败
      // 成功：code === '0'（或 success === true）；失败：code 非 0（如 code:'1', msg:'requestId不能为空'）
      const biz = bizResult(cfg, resp.data);
      if (!biz.ok) {
        entry.attempts++;
        entry.lastError = `${biz.msg || '上送被接口拒绝'}（第 ${entry.attempts}/${REPORTER_MAX_ATTEMPTS} 次）`;
        entry.response.ok = false; // 详情里也显示为失败
        return false;
      }
      return true;
    } catch (err) {
      entry.attempts++;
      entry.lastError = `${err.message}（第 ${entry.attempts}/${REPORTER_MAX_ATTEMPTS} 次）`;
      // 记录上送接口的错误响应（有响应=接口拒绝，无响应=网络/超时）
      entry.response = err.response
        ? buildResponseSnapshot(err.response.status, err.response.statusText, err.response.data)
        : { ok: false, status: null, statusText: null, body: err.message };
      return false;
    }
  }

  _addHistory(entry) {
    // 已送达条目需可预览上送报文，但完整 record 的响应体可达数 MB，
    // 100 条全量留存最坏占用数百 MB。这里只保留裁剪后的 body（前端预览时
    // 会优先从 /api/traffic/:id 拉未截断全量，trafficStore 在则不受影响）。
    const rec = entry.record || {};
    const slim = {
      ...entry,
      record: {
        ...rec,
        requestBody: truncate(rec.requestBody, HISTORY_BODY_MAX),
        responseBody: truncate(rec.responseBody, HISTORY_BODY_MAX),
      },
    };
    this.history.unshift(slim);
    if (this.history.length > REPORTER_HISTORY_MAX) this.history.length = REPORTER_HISTORY_MAX;
  }

  // ── 手动操作（供 UI 调用）────────────────────────────
  retryFailed() {
    // 手动重试：终态 failed 复位为待送，并重置计数（重新获得最多 5 次）
    this.queue.forEach(e => { if (e.status === 'failed') { e.status = 'pending'; e.attempts = 0; e.lastError = null; } });
    this._persist();
    this.emit('change', this.snapshot());
    this._flush();
    return this.snapshot();
  }

  // 单条重试：把指定 qid 复位为待送并重置计数，立即触发发送。
  // 适用于任意非发送中状态（failed / pending），sending 中的不打断。
  retryOne(qid) {
    const entry = this.queue.find(e => e.qid === Number(qid));
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.status === 'sending') return { ok: false, reason: 'sending' };
    entry.status = 'pending';
    entry.attempts = 0;
    entry.lastError = null;
    this._persist();
    this.emit('change', this.snapshot());
    this._flush();
    return { ok: true, snapshot: this.snapshot() };
  }

  clearQueue() {
    this.queue = [];
    this._persist();
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  // 取单条队列详情：原始报文 + 实际将上送的报文体预览
  getEntry(qid) {
    const entry = this.queue.find(e => e.qid === Number(qid))
               || this.history.find(e => e.qid === Number(qid)); // 已送达的从历史里找
    if (!entry) return null;
    const cfg = settings.get();
    let preview, target, uploadHeaders;
    if (cfg.reporterFormat === 'behavior') {
      target = (cfg.reporterBaseUrl || '') + config.BEHAVIOR_SAVE_PATH;
      preview = toSaveRecord(entry.record, { mapping: settings.mappingForUrl(entry.record.url), config: cfg });
      // apiToken 仅管理员可见：报文展示一律掩码，明文不下发到前端（实际上送仍用真实值）
      uploadHeaders = { 'content-type': 'application/json', [config.BEHAVIOR_TOKEN_HEADER]: maskToken(cfg.reporterToken) };
    } else {
      target = cfg.reporterUrl || '';
      preview = { records: [entry.record] };
      uploadHeaders = { 'content-type': 'application/json' };
    }
    return {
      qid: entry.qid, status: entry.status, attempts: entry.attempts,
      lastError: entry.lastError, enqueuedAt: entry.enqueuedAt, sentAt: entry.sentAt,
      url: entry.url, method: entry.method,
      format: cfg.reporterFormat, target,
      uploadMethod: 'POST',     // 上送固定 POST
      uploadHeaders,            // 上送时实际发送的请求头
      record: entry.record,   // 抓到的原始报文
      preview,                // 按当前映射/格式计算的上送报文体
      response: entry.response || null, // 上送接口的返回（状态码 + 响应体），未发送过则为 null
    };
  }

  snapshot() {
    const count = s => this.queue.filter(e => e.status === s).length;
    return {
      stats: {
        queued: this.queue.length,
        pending: count('pending'),
        sending: count('sending'),
        failed: count('failed'),
        sentTotal: this.sentTotal,
      },
      queue: this.queue.map(e => ({
        qid: e.qid, status: e.status, url: e.url, method: e.method,
        attempts: e.attempts, lastError: e.lastError, enqueuedAt: e.enqueuedAt,
        recordId: e.record && e.record.id != null ? e.record.id : null, // 原始抓包 ID
      })),
      // history 内部存完整 entry，快照只投影精简字段，避免 WS 每次推送大报文
      history: this.history.slice(0, 30).map(e => ({
        qid: e.qid, url: e.url, method: e.method,
        attempts: e.attempts, sentAt: e.sentAt,
        recordId: e.record && e.record.id != null ? e.record.id : null,
      })),
    };
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this._persistNow(); // 退出时强制同步写盘，不走 debounce
  }
}

// 调试：把「实际上送的原始报文」+「逐字段类型」落盘到项目根 last-upload-debug.json，
// 用于排查“某个字段的值/类型有问题导致接口反序列化失败”。每次上送覆盖写，仅最近一条。
function dumpUploadDebug(url, body) {
  try {
    const json = JSON.stringify(body);
    const fields = {};
    for (const k of Object.keys(body || {})) {
      const v = body[k];
      fields[k] = { type: Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v),
                    preview: typeof v === 'string' ? (v.length > 120 ? v.slice(0, 120) + '…' : v) : v };
    }
    let jsonValid = true, jsonErr = null;
    try { JSON.parse(json); } catch (e) { jsonValid = false; jsonErr = e.message; }
    const out = {
      at: new Date().toISOString(), url,
      byteLength: Buffer.byteLength(json, 'utf8'),
      jsonValid, jsonErr,
      fields,
      rawBody: json,   // 原始字节，逐字符可查
    };
    fs.writeFileSync(require('path').join(__dirname, '..', 'last-upload-debug.json'), JSON.stringify(out, null, 2));
  } catch { /* 调试失败不影响主流程 */ }
}

// 构造上送接口响应快照（状态码 + 文本化的响应体），供 UI 展示。
// 响应体超过 64KB 截断，避免个别接口回大报文撑爆内存。
function buildResponseSnapshot(status, statusText, data) {
  let body;
  if (data == null) body = '';
  else if (typeof data === 'string') body = data;
  else { try { body = JSON.stringify(data); } catch { body = String(data); } }
  if (body.length > 65536) body = body.slice(0, 65536) + '...[truncated]';
  return {
    ok: typeof status === 'number' && status >= 200 && status < 300,
    status: status ?? null,
    statusText: statusText || '',
    body,
    at: Date.now(),
  };
}

// 判定埋点接口的业务成败：HTTP 200 不代表成功，要看响应体 code/success。
//   behavior 模式：兼容两种格式
//     - 原始埋点接口格式：code === '0'（或 success === true）
//     - 内网统一格式（user-behavior-track）：resultCode === '00000000'
//   raw 模式：无统一响应契约，沿用 HTTP 状态（能走到这里就是 2xx）= 成功。
function bizResult(cfg, data) {
  if (cfg.reporterFormat !== 'behavior') return { ok: true };
  if (data == null || typeof data !== 'object') return { ok: true }; // 非 JSON 响应，不强判，按 HTTP 成功处理
  const code = data.code;
  const ok = (code === '0' || code === 0) ||
             (code == null && data.success === true) ||
             data.resultCode === '00000000';
  return { ok, msg: data.msg || data.message || data.resultMessage || '' };
}

// apiToken 掩码：报文展示用，不暴露明文。空→空；否则一律固定掩码（不泄露长度/首尾）。
function maskToken(token) {
  if (!token) return '';
  return '••••••••（仅管理员可见）';
}

// 过滤列表为空 → 全部匹配；否则命中任意一条即匹配
// 单条规则支持三种写法：
//   /正则/        —— 用正则匹配
//   含 * 的通配符  —— * 匹配任意字符（包括 /），适合 URL
//   纯字符串       —— 子串包含
function urlMatches(url, filters) {
  if (!filters || filters.length === 0) return true;
  return filters.some(p => {
    if (!p) return false;
    if (p.startsWith('/') && p.endsWith('/') && p.length > 1) {
      try { return new RegExp(p.slice(1, -1)).test(url); } catch { return false; }
    }
    if (p.includes('*')) {
      try {
        const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$');
        return re.test(url);
      } catch { return false; }
    }
    return url.includes(p);
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str, maxLen) {
  if (!str) return str;
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > maxLen ? str.slice(0, maxLen) + '...[truncated]' : str;
}


module.exports = new Reporter();
module.exports.urlMatches = urlMatches;
