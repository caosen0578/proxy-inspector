#!/usr/bin/env node
// 离线分发打包脚本（方式 B：纯内网无 npm 源）
// 把运行所需文件（含已打补丁的 node_modules）复制到 dist/proxy-inspector 并压缩为 zip。
// 自动排除：证书私钥、个人配置、运行时队列、临时资料等敏感/无关文件。
//
// 用法：npm run package

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const APP_NAME = 'proxy-inspector';
const STAGE = path.join(OUT_DIR, APP_NAME);

// 需要分发的文件/目录（离线模式包含 node_modules）
const INCLUDE = [
  'src',
  'web',
  'mapping-presets',
  'patches',
  'node_modules',
  'package.json',
  'package-lock.json',
  'README.md',
];

// 二次保险：即使被 INCLUDE 命中也绝不打包的敏感/无关项
const DENY = new Set([
  'certs',              // 含本机 CA 私钥，泄露=可伪造 HTTPS
  'settings.json',      // 个人配置（apiToken / UM 号）
  'reporter-queue.json',// 运行时抓包队列数据
  'rules.json',         // 个人规则
]);

function log(msg) { process.stdout.write(msg + '\n'); }

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

function copyItem(name) {
  if (DENY.has(name)) { log(`  跳过(敏感): ${name}`); return false; }
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) { log(`  跳过(不存在): ${name}`); return false; }
  const to = path.join(STAGE, name);
  fs.cpSync(from, to, { recursive: true, filter: (s) => !DENY.has(path.basename(s)) });
  const stat = fs.statSync(from);
  log(`  + ${name}${stat.isDirectory() ? '/' : ''}`);
  return true;
}

function zipStage() {
  const zipPath = path.join(OUT_DIR, `${APP_NAME}.zip`);
  rmrf(zipPath);
  try {
    if (process.platform === 'win32') {
      // PowerShell 自带，无需额外依赖
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(`cd "${OUT_DIR}" && zip -rq "${APP_NAME}.zip" "${APP_NAME}"`, { stdio: 'ignore' });
    }
    return fs.existsSync(zipPath) ? zipPath : null;
  } catch (e) {
    log('  压缩失败（可手动压缩 dist/' + APP_NAME + ' 目录）: ' + e.message);
    return null;
  }
}

function dirSizeMB(p) {
  let bytes = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp); else bytes += fs.statSync(fp).size;
    }
  })(p);
  return (bytes / 1048576).toFixed(1);
}

// ── 执行 ────────────────────────────────────────────────
log('清理旧的 dist/ ...');
rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

log('复制分发文件：');
INCLUDE.forEach(copyItem);

log(`暂存目录大小：${dirSizeMB(STAGE)} MB`);

log('压缩为 zip ...');
const zip = zipStage();

log('\n✅ 打包完成');
log(`  目录：${path.relative(ROOT, STAGE)}`);
if (zip) log(`  压缩包：${path.relative(ROOT, zip)}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`);
log('\n对方使用（需先装 Node.js）：');
log('  1) 解压');
log(`  2) cd ${APP_NAME}`);
log('  3) npm start');
log('  4) 浏览器/系统代理指向 127.0.0.1:8899，打开 http://127.0.0.1:8900');
