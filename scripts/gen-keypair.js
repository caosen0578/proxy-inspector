#!/usr/bin/env node
// 生成/轮换管理员密钥对 —— 【仅分发者本人使用，不要打进分发包】。
//
// 用法：node scripts/gen-keypair.js
//   - 私钥写入 secrets/admin-private-key.pem（保密、绝不分发）
//   - 公钥打印到屏幕：把它复制进 src/admin-pubkey.js 替换原公钥
//
// 轮换后果：旧公钥被替换后，所有用旧私钥签发的令牌立即失效（需重新签发）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });

const dir = path.join(__dirname, '..', 'secrets');
fs.mkdirSync(dir, { recursive: true });
const keyPath = path.join(dir, 'admin-private-key.pem');
if (fs.existsSync(keyPath)) {
  fs.copyFileSync(keyPath, keyPath + '.bak-' + Date.now()); // 旧私钥留个备份，避免误覆盖
}
fs.writeFileSync(keyPath, priv);

console.log('\n私钥已写入:', keyPath, '（保密，绝不分发）');
console.log('\n=== 把下面的公钥复制进 src/admin-pubkey.js 替换原公钥 ===\n');
console.log(pub);
