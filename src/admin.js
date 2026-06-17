// 管理员权限：基于 Ed25519 离线签名令牌 + 纯内存会话。
//
// 设计要点（见需求）：
//   - 权限来源是「分发者私钥签发的令牌」，不是本地任何可变白名单文件 →
//     使用者改不了自己的权限（没有私钥就伪造不出有效令牌）。
//   - 令牌绑定系统用户名(sub)，大小写不敏感 → 令牌不能转借给别人用。
//   - 令牌带 exp 过期时间 → 一段时间后自动失效（默认签发 1 小时，可指定）。
//   - 解锁后只在【内存】里开会话 → 进程重启即失效。
//
// 令牌格式：base64url(payloadJSON) + "." + base64url(签名)
//   payload = { sub, iat, exp }（exp 为秒级 Unix 时间戳）

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const PUBLIC_KEY = require('./admin-pubkey');

// 私钥路径：只在分发者本机存在（pack.cmd 已排除，分发副本没有此文件）
const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'secrets', 'admin-private-key.pem');

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 当前系统用户名（小写），用于和令牌 sub 大小写不敏感比对
function currentUser() {
  let name = '';
  try { name = os.userInfo().username || ''; }
  catch { name = process.env.USERNAME || process.env.USER || ''; }
  return String(name).trim().toLowerCase();
}

// 校验令牌：验签 + 查过期 + 查 sub 是否匹配本机用户。
// 返回 { ok, payload?, reason? }；reason: bad_format | bad_signature | expired | wrong_user
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'bad_format' };
  const [payloadB64, sigB64] = token.trim().split('.');
  if (!payloadB64 || !sigB64) return { ok: false, reason: 'bad_format' };

  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
  catch { return { ok: false, reason: 'bad_format' }; }

  // 验签：签名覆盖 payload 的原始 base64url 串
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(payloadB64), PUBLIC_KEY, b64urlDecode(sigB64));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' };

  // sub 绑定系统用户名，大小写不敏感；空 sub 视为不限用户（一般不签这种）
  const sub = String(payload.sub || '').trim().toLowerCase();
  if (sub && sub !== currentUser()) return { ok: false, reason: 'wrong_user' };

  return { ok: true, payload };
}

// ── 内存会话（进程级，重启清空）─────────────────────────
const sessions = new Map(); // sid → { exp(秒), sub }

function newSid() { return crypto.randomBytes(24).toString('hex'); }

// 解锁：校验令牌通过则开会话，会话过期时间 = 令牌 exp。返回 { ok, sid?, exp?, reason? }
function unlock(token) {
  const r = verifyToken(token);
  if (!r.ok) return r;
  const sid = newSid();
  sessions.set(sid, { exp: r.payload.exp, sub: r.payload.sub || '' });
  return { ok: true, sid, exp: r.payload.exp };
}

// 校验会话是否仍是有效管理员（顺便清理过期）
function isAdmin(sid) {
  if (!sid) return false;
  const s = sessions.get(sid);
  if (!s) return false;
  if (s.exp <= Math.floor(Date.now() / 1000)) { sessions.delete(sid); return false; }
  return true;
}

function lock(sid) { if (sid) sessions.delete(sid); }

// 取会话状态（供前端显示剩余时间）
function state(sid) {
  if (!isAdmin(sid)) return { admin: false };
  const s = sessions.get(sid);
  return { admin: true, exp: s.exp, sub: s.sub, user: currentUser() };
}

// 定期清理过期会话，避免内存里堆积
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [sid, s] of sessions) if (s.exp <= now) sessions.delete(sid);
}, 60_000).unref();

// ── 令牌签发（仅本机有私钥时可用）─────────────────────
// 私钥存在 = 分发者本机 → 允许签发；分发副本无私钥 → 不可签发。
function canIssue() {
  try { return fs.existsSync(PRIVATE_KEY_PATH); } catch { return false; }
}

// 签发一个绑定 user、有效 hours 小时的管理员令牌。
// 返回 { ok, token?, sub?, exp?, hours?, reason? }；reason: no_key | no_user
function issue(user, hours) {
  if (!canIssue()) return { ok: false, reason: 'no_key' };
  const sub = String(user || '').trim();
  if (!sub) return { ok: false, reason: 'no_user' };
  let h = parseFloat(hours);
  if (!(h > 0)) h = 1;
  const priv = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, iat: now, exp: now + Math.round(h * 3600) };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(payloadB64), priv);
  return { ok: true, token: `${payloadB64}.${b64urlEncode(sig)}`, sub, exp: payload.exp, hours: h };
}

module.exports = { verifyToken, unlock, isAdmin, lock, state, currentUser, canIssue, issue };
