#!/usr/bin/env node
// 管理员令牌签发脚本 —— 【仅分发者本人使用，不要打进分发包】。
// 用私钥(secrets/admin-private-key.pem)签发绑定某使用者、带过期时间的临时管理员令牌。
//
// 用法：
//   node scripts/gen-admin-token.js --user 张三的系统用户名 [--hours 1]
//   node scripts/gen-admin-token.js -u zhangsan -h 8
//
//   --user / -u   绑定的系统用户名（大小写不敏感，必填）。使用者在面板右上角能看到自己的用户名。
//   --hours / -h  有效小时数（默认 1 小时，可小数，如 0.5）。
//
// 把输出的令牌字符串发给该使用者，他在面板「管理员解锁」框粘贴即可。
// 令牌只在他本机、且只在有效期内可用；他机器重启后会话也会失效，需重新解锁。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user' || a === '-u') out.user = argv[++i];
    else if (a === '--hours' || a === '-h') out.hours = parseFloat(argv[++i]);
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const args = parseArgs(process.argv);
if (!args.user) {
  console.error('用法: node scripts/gen-admin-token.js --user <系统用户名> [--hours 1]');
  process.exit(1);
}
const hours = (args.hours && args.hours > 0) ? args.hours : 1;

const keyPath = path.join(__dirname, '..', 'secrets', 'admin-private-key.pem');
if (!fs.existsSync(keyPath)) {
  console.error(`找不到私钥: ${keyPath}\n请确认 secrets/admin-private-key.pem 在本机（绝不要分发）。`);
  process.exit(1);
}
const privateKey = fs.readFileSync(keyPath, 'utf8');

const now = Math.floor(Date.now() / 1000);
const payload = {
  sub: String(args.user).trim(),         // 绑定使用者（验证时大小写不敏感）
  iat: now,
  exp: now + Math.round(hours * 3600),
};
const payloadB64 = b64url(JSON.stringify(payload));
const sig = crypto.sign(null, Buffer.from(payloadB64), privateKey);
const token = `${payloadB64}.${b64url(sig)}`;

console.log('\n=== 管理员令牌（发给该使用者）===');
console.log(token);
console.log('\n绑定用户:', payload.sub);
console.log('有效期至:', new Date(payload.exp * 1000).toLocaleString(), `（${hours} 小时）`);
console.log('提示: 使用者重启程序后需重新解锁；令牌只在该用户本机有效。\n');
