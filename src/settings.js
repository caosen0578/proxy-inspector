const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { DEFAULT_MAPPING } = require('./reporter-mapping');

// 自动获取系统用户名作为 UM 号默认值（createdBy）
function detectUm() {
  try { return os.userInfo().username || ''; }
  catch { return process.env.USERNAME || process.env.USER || ''; }
}

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const defaults = {
  // 界面显示的软件名称（浏览器标题 + 页头），可在「上送设置」里修改
  appTitle: '资金同业代码解析工具',
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
      requestId:    { source: 'record',  path: 'requestHeaders.x-request-trace-id' },
      acceptResult: { source: 'resText', transform: 'sseContent' },
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
      // 非手动设置则始终按当前机器重新探测（防止拷贝来的 settings.json 带着别人的用户名）
      if (!state.umAccountManual || !state.umAccount) state.umAccount = detectUm();
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
  if (next.reporterUrl !== undefined) next.reporterUrl = String(next.reporterUrl).trim();
  if (next.reporterFormat !== undefined) {
    next.reporterFormat = next.reporterFormat === 'behavior' ? 'behavior' : 'raw';
  }
  if (next.reporterBaseUrl !== undefined) next.reporterBaseUrl = String(next.reporterBaseUrl).trim().replace(/\/+$/, '');
  if (next.reporterToken !== undefined) next.reporterToken = String(next.reporterToken).trim();
  if (next.reporterTriggerVersion !== undefined) next.reporterTriggerVersion = String(next.reporterTriggerVersion).trim();
  if (next.umAccount !== undefined) { next.umAccount = String(next.umAccount).trim(); next.umAccountManual = true; }
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

module.exports = { get, update, mappingForUrl, matchPattern, isPassthrough };
