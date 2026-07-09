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

// disableAt → 毫秒时间戳。首选「年月日时分秒」字符串（如 '2026-07-15 00:00:00'），
// 【按本机时区】解读（内网机器同区，后端配的墙上时间即所见）；也兼容数字(秒/毫秒)。
// 用【绝对时刻】而非"剩余多少秒"——倒计时才不受代理重启影响（每次都拿 now 比它）。无效返回 0。
// 显式构造本地时间，不用 Date.parse——它对无时区串按本地还是 UTC 各引擎有歧义。
function parseDisableAt(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : Math.round(v * 1000); // >1e12 视为毫秒，否则按秒
  const s = String(v).trim();
  // 年月日[ 时:分[:秒]]，分隔符 - 或 /，日期与时间间空格或 T；时间省略则当天 00:00:00
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const t = Date.parse(s); // 兜底：仍接受带时区 ISO 等其它写法
  return Number.isNaN(t) ? 0 : t;
}

// 版本停用管控状态（供 proxy 每请求实时查询）。仅「成功拿到检查结果」时更新；
// 失败保持上一次状态（fail-open，服务不可达不误伤）。
//   managed     本地版本是否受管控（低于 minVersion）
//   disableAtMs 绝对停用时刻(ms)；0 = 无宽限期（managed 时立即停用）；>0 = 到点才停用（之前倒计时）
let disabledState = { managed: false, minVersion: '', downloadUrl: '', disableAtMs: 0 };
// 「当前是否已停用」：受管控且（无宽限期 或 已过停用时刻）。每次实时比 now——
// 倒计时到点无需重新 check、也不受重启影响即自动生效。
function isDisabled() {
  const s = disabledState;
  if (!s.managed) return false;
  if (!s.disableAtMs) return true;
  return Date.now() >= s.disableAtMs;
}
function disabledInfo() { return { ...disabledState, disabled: isDisabled() }; }

async function check(force) {
  const url = (settings.get().updateCheckUrl || '').trim();
  const current = currentVersion();
  if (!url) { disabledState = { managed: false, minVersion: '', downloadUrl: '', disableAtMs: 0 }; return { enabled: false, current }; }
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;

  let result;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    if (!m || typeof m.version !== 'string') throw new Error('返回数据缺少 version 字段');
    // minVersion（可选）：本地低于此版本 → 本版本"受管控"。
    // disableAt（可选，绝对时刻 ISO/时间戳）：受管控时到此刻才真正停用，之前只倒计时提醒；
    //   不下发 disableAt → 立即停用（旧行为）。绝对时刻 → 倒计时不受重启影响。
    const minVersion = typeof m.minVersion === 'string' ? (extractVersion(m.minVersion) || '') : '';
    const managed = !!minVersion && cmpVersion(current, minVersion) < 0;
    const disableAtMs = managed ? parseDisableAt(m.disableAt) : 0;
    const downloadUrl = typeof m.downloadUrl === 'string' ? m.downloadUrl : '';
    disabledState = { managed, minVersion, downloadUrl, disableAtMs };
    result = {
      enabled: true,
      current,
      latest: extractVersion(m.version) || m.version, // 展示归一化后的版本（'- v1.0.1' → '1.0.1'）
      hasUpdate: cmpVersion(m.version, current) > 0,
      minVersion,
      managed,
      disableAt: disableAtMs,   // 绝对停用时刻(ms)，0 = 无（立即停用或不管控）
      disabled: isDisabled(),   // 当前是否已停用（倒计时到点即 true）
      downloadUrl,
      notes: typeof m.notes === 'string' ? m.notes : '',
      checkedAt: Date.now(),
    };
  } catch (e) {
    // 失败静默：内网服务临时不可达不该打扰使用，横幅不弹；手动检查时前端会把 error 提示出来。
    // disabledState 保持上一次成功结果（fail-open：从未成功过 = 不管控）。
    result = {
      enabled: true, current, error: e.message, checkedAt: Date.now(),
      minVersion: disabledState.minVersion, managed: disabledState.managed,
      disableAt: disabledState.disableAtMs, disabled: isDisabled(), downloadUrl: disabledState.downloadUrl,
    };
  }
  cache = { at: Date.now(), result };
  return result;
}

// 后端自查定时器：停用管控不能依赖用户开着面板。启动 5 秒后首查，此后每 2 小时。
// unref：不阻止进程退出。检查地址未配置时 check() 直接返回，零开销。
setTimeout(() => { check(false).catch(() => {}); }, 5000).unref();
setInterval(() => { check(true).catch(() => {}); }, 2 * 60 * 60 * 1000).unref();

module.exports = { check, cmpVersion, extractVersion, currentVersion, isDisabled, disabledInfo };
