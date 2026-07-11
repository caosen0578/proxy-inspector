const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { DEFAULT_MAPPING } = require('./reporter-mapping');

// 自动获取系统用户名作为 UM 号默认值（createdBy）。
// 统一转小写：显示与上送 createdBy 都用小写，避免大小写不一致。
function detectUm() {
  let name = '';
  try { name = os.userInfo().username || ''; }
  catch { name = process.env.USERNAME || process.env.USER || ''; }
  return String(name).trim().toLowerCase();
}

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const defaults = {
  // 界面显示的软件名称（浏览器标题 + 页头），可在「上送设置」里修改
  appTitle: '资金同业代码解析工具',
  // 界面显示的版本号（页头中间），可在「上送设置」里修改
  appVersion: '版本号：fat001- v1.0.0',
  // 局域网访问开关（仅管理员）。false=只绑回环 127.0.0.1（内核级安全，局域网访问不到）；
  // true=绑 0.0.0.0 并放开 Host 白名单，局域网其他机器可访问本机面板/代理。
  // ⚠️ 开启=暴露抓到的代码/令牌 + 代理变开放代理，仅在明确需要时临时开。改后需重启生效。
  lanAccess: false,
  // 上送总开关
  reporterEnabled: !!config.REPORTER_URL,
  // 上送目标地址（raw 模式）
  reporterUrl: config.REPORTER_URL || '',
  // 上送格式：'raw' | 'behavior'
  reporterFormat: config.REPORTER_FORMAT || 'raw',
  // behavior 模式配置
  reporterBaseUrl: config.REPORTER_BASE_URL || '',
  reporterToken: config.REPORTER_TOKEN || '',
  reporterTriggerVersion: config.REPORTER_TRIGGER_VERSION || 'proxy-inspector',
  // 单次上送 HTTP 超时（毫秒）。需 > 上送后端最坏响应时间，避免后端慢成功时客户端误超时重发→重复上送。
  // 仅管理员可改（PUT /settings 已 requireAdmin）。范围 1000~120000，越界自动夹取。
  reporterTimeoutMs: config.REPORTER_TIMEOUT_MS,
  // 新版本检查地址（内网 version.json，见 src/update-check.js）。空 = 关闭检查。
  // 仅管理员可改（PUT /settings 已 requireAdmin）——防止被指到恶意下载源。
  updateCheckUrl: config.UPDATE_CHECK_URL || '',
  // 调试：把每条"需要上送的记录"同步落一份本地 JSONL（upload-debug-log.jsonl），供离线检索。
  // 仅管理员可改（PUT /settings 已 requireAdmin）。⚠️ 会把 prompt/代码/请求报文明文写盘，默认关。
  debugLogEnabled: false,
  // UM 号（= 系统用户名），上送 createdBy 用，统计个人代码生成率。
  // 默认自动取系统用户名；仅当用户在界面手动改过(umAccountManual=true)才持久化沿用，
  // 否则每次启动按当前机器重新探测——避免拷贝 settings.json 到别的机器后显示错误的用户名。
  umAccount: detectUm(),
  umAccountManual: false,
  // behavior 模式字段映射，按"上送目标接口"分两套（见接口文档 saveRecord / updateRecordForAccept）：
  //   saveRecord: AI 响应后保存记录，可从抓包报文映射
  //   updateRecordForAccept: 用户采纳/编辑反馈，来自 IDE 端操作事件，抓包无法获取（默认空）
  //   每套：{ match: 触发该上送的抓包 URL 规则, mapping: {目标字段→取值来源} }
  reporterTargets: {
    saveRecord:            { match: '*/completions*', mapping: { ...DEFAULT_MAPPING } },
    // 能从抓包映射的：requestId（与 saveRecord 关联）+ acceptResult（尽力填 AI 结果快照）；
    // actionType / acceptCodeLines / acceptCodeSize 为 IDE 端用户操作，抓包无法获取，留空。
    updateRecordForAccept: { match: '', mapping: {
      requestId:    { source: 'record',  path: 'requestHeaders.x-conversation-message-id' },
      acceptResult: { source: 'resText', transform: 'sseCodeAll' },
    } },
  },
  // URL 过滤白名单（数组）。为空 = 不过滤，上送全部。
  // 每项支持：子串包含 / *通配符* / /正则/
  reporterFilters: [],
  // 低延迟直通：匹配的 URL 走快速通道（不强制 gzip、关 Nagle、转发零处理），
  // 用于行内代码补全等延迟敏感的流式接口，尽量不破坏 IDE 回写。采集/上送仍正常。
  streamPassthrough: ['*/completions*'],
};

let state = { ...defaults };
load();

function load() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      state = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
      // 迁移：旧版 reporterMappings(数组) / reporterMapping(对象) → reporterTargets.saveRecord
      if (!state.reporterTargets) {
        let mapping = { ...DEFAULT_MAPPING }, match = '*/chat/completions*';
        if (Array.isArray(state.reporterMappings) && state.reporterMappings[0]) {
          mapping = state.reporterMappings[0].mapping; match = state.reporterMappings[0].match || match;
        } else if (state.reporterMapping) {
          mapping = state.reporterMapping;
        }
        state.reporterTargets = { saveRecord: { match, mapping }, updateRecordForAccept: { match: '', mapping: {} } };
      }
      delete state.reporterMapping;
      delete state.reporterMappings;
      state.reporterTargets = normalizeTargets(state.reporterTargets);
      // 迁移：修复 result 缺代码（2026-07）。旧默认映射 result=sseContent 只取旁白，
      // Agent 工具写码轮 result 丢代码、纯工具轮更被内容过滤整轮丢弃。已分发机器的
      // settings.json 都存着旧映射会盖住新 DEFAULT_MAPPING，故在此自动升级。
      // 只动"恰好还是旧默认形态"的（source:resText+transform:sseContent），用户自定义的不碰。
      const savedResult = state.reporterTargets.saveRecord.mapping.result;
      if (savedResult && savedResult.source === 'resText' && savedResult.transform === 'sseContent') {
        savedResult.transform = 'sseFullReply';
        console.log('[settings] 映射迁移: result sseContent → sseFullReply（补齐工具写入代码）');
      }
      // 迁移：修复/补齐 acceptCodeLines、acceptCodeSize（2026-07，后端按必填校验且用于采纳统计）。
      // 实测事故：早期 UI 不认识 field 源，用户在字段映射页保存一次就把 path 吞掉
      // （残留 {source:'field',transform:lineCount} 无 path）→ getByPath(out,undefined)=undefined
      // → 计数恒 0 上送。此处自愈：field 源缺 path 的补 path:'acceptResult'；整个字段缺失的按默认补。
      const savedMapping = state.reporterTargets.saveRecord.mapping;
      [['acceptCodeLines', 'lineCount'], ['acceptCodeSize', 'byteSize']].forEach(([f, tr]) => {
        const spec = savedMapping[f];
        if (spec && spec.source === 'field' && !spec.path) {
          spec.path = 'acceptResult';
          console.log(`[settings] 映射迁移: ${f} 补回丢失的 path=acceptResult（此前计数恒 0）`);
        } else if (!spec && Object.keys(savedMapping).length) {
          savedMapping[f] = { source: 'field', path: 'acceptResult', transform: tr };
          console.log(`[settings] 映射迁移: 补齐缺失字段 ${f}（后端必填）`);
        }
      });
      // 非手动设置则始终按当前机器重新探测（防止拷贝来的 settings.json 带着别人的用户名）
      if (!state.umAccountManual || !state.umAccount) state.umAccount = detectUm();
      // 统一小写：兼容历史 settings.json 里存的大写用户名
      state.umAccount = String(state.umAccount || '').toLowerCase();
    } catch {
      state = { ...defaults };
    }
  }
}

function save() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state, null, 2));
}

function get() {
  return { ...state };
}

function update(patch) {
  const next = { ...patch };
  // 过滤列表允许传字符串（按行拆分）或数组
  if (next.reporterFilters !== undefined) {
    next.reporterFilters = normalizeFilters(next.reporterFilters);
  }
  if (next.reporterEnabled !== undefined) next.reporterEnabled = !!next.reporterEnabled;
  if (next.lanAccess !== undefined) next.lanAccess = !!next.lanAccess;
  if (next.debugLogEnabled !== undefined) next.debugLogEnabled = !!next.debugLogEnabled;
  if (next.updateCheckUrl !== undefined) next.updateCheckUrl = String(next.updateCheckUrl).trim();
  if (next.reporterUrl !== undefined) next.reporterUrl = String(next.reporterUrl).trim();
  if (next.reporterFormat !== undefined) {
    next.reporterFormat = next.reporterFormat === 'behavior' ? 'behavior' : 'raw';
  }
  if (next.reporterBaseUrl !== undefined) next.reporterBaseUrl = String(next.reporterBaseUrl).trim().replace(/\/+$/, '');
  if (next.reporterToken !== undefined) next.reporterToken = String(next.reporterToken).trim();
  if (next.reporterTriggerVersion !== undefined) next.reporterTriggerVersion = String(next.reporterTriggerVersion).trim();
  if (next.reporterTimeoutMs !== undefined) {
    // 数字化 + 夹取到 [1000, 120000]；非法值回退默认，避免 0/负数/NaN 把上送超时设崩
    const n = Math.round(Number(next.reporterTimeoutMs));
    next.reporterTimeoutMs = Number.isFinite(n) ? Math.min(120000, Math.max(1000, n)) : config.REPORTER_TIMEOUT_MS;
  }
  if (next.umAccount !== undefined) { next.umAccount = String(next.umAccount).trim().toLowerCase(); next.umAccountManual = true; }
  if (next.streamPassthrough !== undefined) next.streamPassthrough = normalizeFilters(next.streamPassthrough);
  if (next.reporterTargets !== undefined) next.reporterTargets = normalizeTargets(next.reporterTargets);
  state = { ...state, ...next };
  save();
  return get();
}

// 过滤白名单：接受数组或多行字符串 → 去空白行的字符串数组
function normalizeFilters(input) {
  const arr = Array.isArray(input) ? input : String(input).split(/\r?\n/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}

// 映射配置：接受对象或 JSON 字符串；非法/空 → 回退默认映射
function normalizeMapping(input) {
  let obj = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { ...DEFAULT_MAPPING };
    try { obj = JSON.parse(trimmed); } catch { return { ...DEFAULT_MAPPING }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.keys(obj).length) {
    return { ...DEFAULT_MAPPING };
  }
  return obj;
}

// 两个上送目标接口：规范 { saveRecord:{match,mapping}, updateRecordForAccept:{match,mapping} }
function normalizeTargets(input) {
  let obj = input;
  if (typeof input === 'string') { try { obj = JSON.parse(input); } catch { obj = null; } }
  if (!obj || typeof obj !== 'object') obj = {};
  const one = (t, defMatch) => ({
    match: String((t && t.match) || defMatch || '').trim(),
    // 这里允许空 mapping（非必填字段不映射时整套可为空，如 updateRecordForAccept）
    mapping: (t && t.mapping && typeof t.mapping === 'object' && !Array.isArray(t.mapping)) ? t.mapping : {},
  });
  return {
    saveRecord: one(obj.saveRecord, '*/chat/completions*'),
    updateRecordForAccept: one(obj.updateRecordForAccept, ''),
  };
}

// URL 单规则匹配：空=全部匹配；/正则/、*通配*、否则子串包含
function matchPattern(url, pattern) {
  if (!pattern) return true;
  url = url || '';
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 1) {
    try { return new RegExp(pattern.slice(1, -1)).test(url); } catch { return false; }
  }
  if (pattern.includes('*')) {
    try {
      const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return re.test(url);
    } catch { return false; }
  }
  return url.includes(pattern);
}

// 上送 saveRecord 时取其映射（match 不匹配也仍用该映射，URL 过滤由 reporterFilters 负责）
function mappingForUrl(url) {
  const t = state.reporterTargets && state.reporterTargets.saveRecord;
  const mapping = t && t.mapping && Object.keys(t.mapping).length ? t.mapping : { ...DEFAULT_MAPPING };
  return mapping;
}

// 是否走低延迟直通（匹配 streamPassthrough 任一规则）
function isPassthrough(url) {
  const list = state.streamPassthrough || [];
  return list.some(p => matchPattern(url, p));
}

// 启动时的监听网卡：环境变量 BIND_HOST 显式优先；否则由 lanAccess 决定
// （开=0.0.0.0 放开局域网，关=127.0.0.1 只回环）。改 lanAccess 后需重启才换绑。
function bindHost() {
  if (process.env.BIND_HOST) return process.env.BIND_HOST;
  return state.lanAccess ? '0.0.0.0' : '127.0.0.1';
}

module.exports = { get, update, mappingForUrl, matchPattern, isPassthrough, bindHost };
