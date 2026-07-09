// 新版本检查：请求 settings.updateCheckUrl（仅管理员可改）指向的内网地址——
// 后端接口或静态 version.json 均可，只要返回一条 JSON 数据：
//   { "version": "1.2.0", "downloadUrl": "http://.../xxx.zip", "notes": "更新说明" }
// 与本地 package.json 的 version 比较，供面板横幅通知 + 手动「检查更新」。
// 只通知不自动更新（分发方式是解压覆盖）。拉取失败静默返回 error，不打扰使用。
// 联调：behavior-validator 提供 GET /api/version/latest 模拟接口（见其 README 用法三）。
const settings = require('./settings');

const PKG_VERSION = require('../package.json').version;
const CACHE_MS = 10 * 60 * 1000; // 后端缓存 10 分钟：多标签页/频繁刷新不重复外呼（前端自身 2h 轮询）
let cache = null; // { at, result }

// 从任意版本串里提取「点分数字」段：'版本号：fat001- v1.0.2' → '1.0.2'。提不出返回 ''。
// 发版习惯是改页头版本号（appVersion 显示串），比较两侧都按此提取，对格式宽容。
function extractVersion(s) {
  const m = /(\d+(?:\.\d+)+)/.exec(String(s || ''));
  return m ? m[1] : '';
}

// 版本比较：先各自提取点分数字，按 . 逐段【数值】比较（1.0.9 < 1.0.10 正确），段数不齐按 0 补
function cmpVersion(a, b) {
  const pa = extractVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = extractVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 本地当前版本：优先取「上送设置」里的版本号显示串（发版时改它即可，与页头一致），
// 提取不出（如没按 vX.Y.Z 格式填）再退回 package.json 的 version。
function currentVersion() {
  return extractVersion(settings.get().appVersion) || PKG_VERSION;
}

// 版本停用状态（供 proxy 每请求查询，纯内存布尔）。
// 仅在「成功拿到检查结果」时更新；检查失败保持上一次状态——服务临时不可达不误伤（fail-open）。
let disabledState = { disabled: false, minVersion: '', downloadUrl: '' };
function isDisabled() { return disabledState.disabled; }
function disabledInfo() { return { ...disabledState }; }

async function check(force) {
  const url = (settings.get().updateCheckUrl || '').trim();
  const current = currentVersion();
  if (!url) { disabledState = { disabled: false, minVersion: '', downloadUrl: '' }; return { enabled: false, current }; }
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;

  let result;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    if (!m || typeof m.version !== 'string') throw new Error('返回数据缺少 version 字段');
    // minVersion（可选）：低于此版本 → 本版本停用（代理拦新请求，上送队列不受影响）
    const minVersion = typeof m.minVersion === 'string' ? (extractVersion(m.minVersion) || '') : '';
    const disabled = !!minVersion && cmpVersion(current, minVersion) < 0;
    const downloadUrl = typeof m.downloadUrl === 'string' ? m.downloadUrl : '';
    disabledState = { disabled, minVersion, downloadUrl };
    result = {
      enabled: true,
      current,
      latest: extractVersion(m.version) || m.version, // 展示归一化后的版本（'- v1.0.1' → '1.0.1'）
      hasUpdate: cmpVersion(m.version, current) > 0,
      minVersion,
      disabled,
      downloadUrl,
      notes: typeof m.notes === 'string' ? m.notes : '',
      checkedAt: Date.now(),
    };
  } catch (e) {
    // 失败静默：内网服务临时不可达不该打扰使用，横幅不弹；手动检查时前端会把 error 提示出来。
    // disabledState 保持上一次成功结果（fail-open：从未成功过 = 不停用）。
    result = { enabled: true, current, disabled: disabledState.disabled, error: e.message, checkedAt: Date.now() };
  }
  cache = { at: Date.now(), result };
  return result;
}

// 后端自查定时器：停用管控不能依赖用户开着面板。启动 5 秒后首查，此后每 2 小时。
// unref：不阻止进程退出。检查地址未配置时 check() 直接返回，零开销。
setTimeout(() => { check(false).catch(() => {}); }, 5000).unref();
setInterval(() => { check(true).catch(() => {}); }, 2 * 60 * 60 * 1000).unref();

module.exports = { check, cmpVersion, extractVersion, currentVersion, isDisabled, disabledInfo };
