const fs = require('fs');
const axios = require('axios');
const { EventEmitter } = require('events');
const config = require('./config');
const { REPORTER_BATCH_SIZE, REPORTER_FLUSH_MS, REPORTER_MAX_ATTEMPTS,
        REPORTER_QUEUE_FILE, REPORTER_HISTORY_MAX } = config;
const settings = require('./settings');
const { toSaveRecord } = require('./reporter-mapping');

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

  _persist() {
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
        requestBody: truncate(record.requestBody, 65536),
        statusCode: record.statusCode,
        responseHeaders: record.responseHeaders,
        responseBody: truncate(record.responseBody, 65536),
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
    } else {
      url = cfg.reporterUrl;
      body = { records: [entry.record] };
    }
    // 单次发送；重试由 _flush 按周期驱动，最多 REPORTER_MAX_ATTEMPTS 次
    try {
      await axios.post(url, body, { timeout: 5000, ...extra });
      return true;
    } catch (err) {
      entry.attempts++;
      entry.lastError = `${err.message}（第 ${entry.attempts}/${REPORTER_MAX_ATTEMPTS} 次）`;
      return false;
    }
  }

  _addHistory(entry) {
    this.history.unshift({
      qid: entry.qid, url: entry.url, method: entry.method,
      attempts: entry.attempts, sentAt: entry.sentAt,
    });
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

  clearQueue() {
    this.queue = [];
    this._persist();
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  // 取单条队列详情：原始报文 + 实际将上送的报文体预览
  getEntry(qid) {
    const entry = this.queue.find(e => e.qid === Number(qid));
    if (!entry) return null;
    const cfg = settings.get();
    let preview, target, uploadHeaders;
    if (cfg.reporterFormat === 'behavior') {
      target = (cfg.reporterBaseUrl || '') + config.BEHAVIOR_SAVE_PATH;
      preview = toSaveRecord(entry.record, { mapping: settings.mappingForUrl(entry.record.url), config: cfg });
      uploadHeaders = { 'content-type': 'application/json', [config.BEHAVIOR_TOKEN_HEADER]: cfg.reporterToken || '' };
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
      })),
      history: this.history.slice(0, 30),
    };
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this._persist();
  }
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
