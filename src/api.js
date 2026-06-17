const express = require('express');
const path = require('path');
const trafficStore = require('./traffic-store');
const ruleEngine = require('./rule-engine');
const settings = require('./settings');
const reporter = require('./reporter');
const config = require('./config');
const admin = require('./admin');

// 管理员会话从请求头 x-admin-session 读取（前端解锁后带上）
function sidOf(req) { return req.get('x-admin-session') || ''; }
// 保护中间件：非管理员一律 403，前端据此挡住「上送设置」「字段映射」的写操作
function requireAdmin(req, res, next) {
  if (!admin.isAdmin(sidOf(req))) return res.status(403).json({ error: 'admin_required' });
  next();
}

function buildRouter() {
  const r = express.Router();

  // ── 管理员解锁 / 锁定 / 状态 ──
  // 解锁：粘贴分发者签发的令牌，验签通过则开内存会话（重启失效、到 exp 失效）
  r.post('/admin/unlock', (req, res) => {
    const result = admin.unlock((req.body && req.body.token) || '');
    if (!result.ok) return res.status(401).json({ error: result.reason });
    res.json({ ok: true, sid: result.sid, exp: result.exp });
  });
  r.post('/admin/lock', (req, res) => { admin.lock(sidOf(req)); res.json({ ok: true }); });
  r.get('/admin/state', (req, res) => res.json(admin.state(sidOf(req))));
  // 令牌签发（仅本机存在私钥时可用，即分发者机器）。私钥在=授权，故不另需管理员会话。
  r.get('/admin/issuer', (req, res) => res.json({ available: admin.canIssue(), user: admin.currentUser() }));
  r.post('/admin/issue', (req, res) => {
    const { user, hours } = req.body || {};
    const result = admin.issue(user, hours);
    if (!result.ok) return res.status(result.reason === 'no_key' ? 403 : 400).json({ error: result.reason });
    res.json(result);
  });

  r.get('/traffic', (req, res) => {
    const { url, method, status, page, size } = req.query;
    res.json(trafficStore.list({ url, method, status, page: +page || 1, size: +size || 50 }));
  });

  r.get('/traffic/:id', (req, res) => {
    const rec = trafficStore.get(+req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(rec);
  });

  r.delete('/traffic', (req, res) => {
    trafficStore.clear();
    res.json({ ok: true });
  });

  r.get('/rules', (req, res) => res.json(ruleEngine.list()));

  r.post('/rules', (req, res) => {
    const { pattern, method, action, mockStatus, mockBody, mockContentType,
            addRequestHeaders, addResponseHeaders } = req.body;
    if (!pattern) return res.status(400).json({ error: 'pattern required' });
    if (!['mock', 'modify', 'block'].includes(action))
      return res.status(400).json({ error: 'action must be mock|modify|block' });
    res.status(201).json(ruleEngine.add({
      pattern, method: method || '*', action,
      mockStatus, mockBody, mockContentType,
      addRequestHeaders, addResponseHeaders,
    }));
  });

  r.put('/rules/:id', (req, res) => {
    const updated = ruleEngine.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  r.delete('/rules/:id', (req, res) => {
    if (!ruleEngine.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // 根证书下载（用于浏览器/系统信任）
  // ext: pem（Linux/macOS 友好）或 cer（Windows 双击安装友好），内容相同
  function sendCa(res, ext) {
    const fs = require('fs');
    const caPath = require('path').join(config.CERTS_DIR, 'certs', 'ca.pem');
    if (!fs.existsSync(caPath)) return res.status(404).json({ error: '证书尚未生成，请先发起一次 HTTPS 请求' });
    res.setHeader('content-type', ext === 'cer' ? 'application/x-x509-ca-cert' : 'application/x-pem-file');
    res.setHeader('content-disposition', `attachment; filename="proxy-inspector-ca.${ext}"`);
    res.sendFile(caPath);
  }
  r.get('/ca.pem', (req, res) => sendCa(res, 'pem'));
  r.get('/ca.cer', (req, res) => sendCa(res, 'cer'));

  // 上送设置（开关 / 地址 / URL 过滤列表）
  // 读取：非管理员不下发 apiToken 明文（管理员相关 tab 前端也会隐藏，这里是后端兜底）
  r.get('/settings', (req, res) => {
    const s = settings.get();
    if (!admin.isAdmin(sidOf(req)) && s.reporterToken) s.reporterToken = ''; // 掩掉，避免直接调 API 拿明文
    res.json(s);
  });
  // 写入：仅管理员（含上送地址/Token/字段映射等敏感配置）
  r.put('/settings', requireAdmin, (req, res) => res.json(settings.update(req.body || {})));

  // 上送队列：状态快照 / 手动重试失败项 / 清空队列
  // 字段映射预览：用给定映射 + 一条流量（默认最近一条，可指定 recordId）算出上送报文体
  r.post('/mapping/preview', (req, res) => {
    const { toSaveRecord } = require('./reporter-mapping');
    const { mapping, recordId, match } = req.body || {};
    let record;
    if (recordId) record = trafficStore.get(+recordId);
    else if (match) record = trafficStore.list({ size: 500 }).items.find(rec => settings.matchPattern(rec.url, match));
    else record = trafficStore.list({ size: 1 }).items[0];
    if (!record) return res.json({ record: null, preview: null, note: match ? '没有匹配该接口规则的流量，先抓一条再预览' : '暂无流量记录，先抓一条请求再预览' });
    const cfg = settings.get();
    const preview = toSaveRecord(record, { mapping, config: cfg });
    res.json({
      record: { id: record.id, url: record.url, method: record.method, statusCode: record.statusCode },
      preview,
    });
  });

  // 两个上送接口的目标字段 schema（字段名/类型/必填/示例/描述）
  r.get('/mapping/schema', (req, res) => {
    res.json(require('./behavior-schema').TARGETS);
  });

  // 内置预设映射（供 UI「重置为预设」）
  r.get('/mapping/preset', (req, res) => {
    const fs = require('fs');
    const p = path.join(__dirname, '..', 'mapping-presets', 'codebuddy-sse.json');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'preset not found' });
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  });

  // 补送候选列表（供弹窗勾选）
  r.get('/queue/backfill/candidates', (req, res) => {
    const items = trafficStore.list({ size: 100000 }).items;
    res.json(reporter.backfillCandidates(items));
  });

  // 补送：把抓包列表里漏送的历史报文重新入队（body.ids 指定子集，省略=全部）
  r.post('/queue/backfill', (req, res) => {
    const items = trafficStore.list({ size: 100000 }).items;
    const ids = req.body && req.body.ids;
    const result = reporter.backfill(items, ids);
    res.json(result);
  });

  r.get('/queue', (req, res) => res.json(reporter.snapshot()));
  r.get('/queue/:qid', (req, res) => {
    const entry = reporter.getEntry(req.params.qid);
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json(entry);
  });
  r.post('/queue/retry', (req, res) => res.json(reporter.retryFailed()));
  r.post('/queue/:qid/retry', (req, res) => {
    const result = reporter.retryOne(req.params.qid);
    if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
    res.json(result.snapshot);
  });
  r.delete('/queue', (req, res) => res.json(reporter.clearQueue()));

  r.get('/status', (req, res) => {
    const s = settings.get();
    res.json({
      proxyPort: config.PROXY_PORT,
      uiPort: config.UI_PORT,
      reporterEnabled: s.reporterEnabled,
      reporterUrl: s.reporterUrl || null,
      reporterFilterCount: s.reporterFilters.length,
      trafficCount: trafficStore.records.length,
      ruleCount: ruleEngine.list().length,
    });
  });

  return r;
}

function createApp(wss) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'web', 'public')));
  app.use('/api', buildRouter());

  // 把 trafficStore 事件广播到所有 WebSocket 客户端
  function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }
  trafficStore.on('record', rec => broadcast({ type: 'record', data: rec }));
  trafficStore.on('record-update', rec => broadcast({ type: 'record-update', data: rec }));
  trafficStore.on('clear', () => broadcast({ type: 'clear' }));
  // 上送队列变更实时推送
  reporter.on('change', snap => broadcast({ type: 'queue', data: snap }));
  // 新客户端连上时推一次当前队列快照
  wss.on('connection', ws => { try { ws.send(JSON.stringify({ type: 'queue', data: reporter.snapshot() })); } catch {} });

  return app;
}

module.exports = { createApp };
