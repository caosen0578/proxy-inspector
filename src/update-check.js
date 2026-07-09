// 新版本检查：请求 settings.updateCheckUrl（仅管理员可改）指向的内网地址——
// 后端接口或静态 version.json 均可，只要返回一条 JSON 数据：
//   { "version": "1.2.0", "downloadUrl": "http://.../xxx.zip", "notes": "更新说明" }
// 与本地 package.json 的 version 比较，供面板横幅通知 + 手动「检查更新」。
// 只通知不自动更新（分发方式是解压覆盖）。拉取失败静默返回 error，不打扰使用。
// 联调：behavior-validator 提供 GET /api/version/latest 模拟接口（见其 README 用法三）。
const settings = require('./settings');

const CURRENT = require('../package.json').version;
const CACHE_MS = 10 * 60 * 1000; // 后端缓存 10 分钟：多标签页/频繁刷新不重复外呼（前端自身 2h 轮询）
let cache = null; // { at, result }

// 语义化版本比较：去掉前导 v，按 . 逐段数值比较；段数不齐按 0 补
function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function check(force) {
  const url = (settings.get().updateCheckUrl || '').trim();
  if (!url) return { enabled: false, current: CURRENT };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;

  let result;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    if (!m || typeof m.version !== 'string') throw new Error('version.json 缺少 version 字段');
    result = {
      enabled: true,
      current: CURRENT,
      latest: m.version,
      hasUpdate: cmpVersion(m.version, CURRENT) > 0,
      downloadUrl: typeof m.downloadUrl === 'string' ? m.downloadUrl : '',
      notes: typeof m.notes === 'string' ? m.notes : '',
      checkedAt: Date.now(),
    };
  } catch (e) {
    // 失败静默：内网服务临时不可达不该打扰使用，横幅不弹；手动检查时前端会把 error 提示出来
    result = { enabled: true, current: CURRENT, error: e.message, checkedAt: Date.now() };
  }
  cache = { at: Date.now(), result };
  return result;
}

module.exports = { check, CURRENT, cmpVersion };
