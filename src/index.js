const http = require('http');
const net = require('net');
const readline = require('readline');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { createApp } = require('./api');
const { startProxy } = require('./proxy');
const reporter = require('./reporter');
const config = require('./config');

// ── 终端颜色（无依赖；NO_COLOR 或非 TTY 时自动关闭）──────────
const useColor = !process.env.NO_COLOR;
const C = new Proxy({
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
}, { get: (t, k) => (useColor ? (t[k] || '') : '') });
const c = (color, s) => `${C[color]}${s}${C.reset}`;

function banner() {
  console.log('');
  console.log(c('cyan', '  ┌────────────────────────────────────────────┐'));
  console.log(c('cyan', '  │') + c('bold', '   ⚡ Proxy Inspector  HTTP/HTTPS 抓包代理   ') + c('cyan', '│'));
  console.log(c('cyan', '  └────────────────────────────────────────────┘'));
  console.log('');
}

// ── 端口占用检测与处理 ──────────────────────────────────────
function portInUse(port) {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', e => res(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port); // 与真实 server.listen(port) 一致的绑定方式，避免 IPv4/IPv6 漏检
  });
}

function findPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && /LISTENING/i.test(m[3]) && m[1].endsWith(':' + port)) return m[4];
      }
    } else {
      const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim();
      return out.split(/\s+/)[0] || null;
    }
  } catch { /* ignore */ }
  return null;
}

function procName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1] : '未知';
    }
    return execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim() || '未知';
  } catch { return '未知'; }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch { return false; }
}

function ask(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => { rl.close(); res(a.trim()); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensurePortFree(port, label) {
  if (!(await portInUse(port))) return;
  const pid = findPid(port);
  const name = pid ? procName(pid) : '未知';
  console.log(c('yellow', `⚠ 端口 ${port}（${label}）已被占用`) +
              (pid ? c('gray', `  占用进程：PID ${pid} (${name})`) : c('gray', '  （未能识别占用进程）')));

  if (!process.stdin.isTTY) {
    console.log(c('red', `✗ 非交互环境无法处理端口占用，已退出。可改用环境变量换端口后重试。`));
    process.exit(1);
  }
  if (!pid) {
    console.log(c('red', '✗ 未能定位占用进程，请手动处理后重试，已退出。'));
    process.exit(1);
  }

  const a = await ask(c('bold', `是否结束该进程 (PID ${pid} ${name}) 并继续启动？ [y/N] `));
  if (!/^y(es)?$/i.test(a)) {
    console.log(c('gray', '已取消启动。'));
    process.exit(1);
  }
  if (!killPid(pid)) {
    console.log(c('red', `✗ 结束进程失败（可能需要管理员权限），已退出。`));
    process.exit(1);
  }
  await sleep(500);
  if (await portInUse(port)) {
    console.log(c('red', `✗ 端口 ${port} 仍被占用，已退出。`));
    process.exit(1);
  }
  console.log(c('green', `✓ 已结束 PID ${pid}，端口 ${port} 已释放。`));
}

// ── 启动 ────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const app = createApp(wss);
const server = http.createServer(app);
server.on('error', err => {
  console.error(c('red', `✗ Web 面板端口 ${config.UI_PORT} 启动失败: ${err.code || err.message}`));
  process.exit(1);
});
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

(async () => {
  banner();
  // UI 与代理两个端口都先确保可用
  await ensurePortFree(config.UI_PORT, 'Web 面板');
  await ensurePortFree(config.PROXY_PORT, '代理');

  server.listen(config.UI_PORT, () => {
    console.log(c('green', '✓ Web 面板') + '  ' + c('cyan', `http://127.0.0.1:${config.UI_PORT}`));
  });
  startProxy();
  console.log(c('green', '✓ 代理已启动') + '  ' + c('cyan', `127.0.0.1:${config.PROXY_PORT}`) +
              c('gray', '  ← 浏览器/系统代理指向这里'));
  console.log(c('gray', '  按 Ctrl+C 退出（退出前会持久化未完成的上送队列）'));
  console.log('');
})();

// 优雅关闭：持久化队列，确保未完成的上送任务不丢
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(c('yellow', `\n[exit] 收到 ${signal}，持久化上送队列后退出…`));
  reporter.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => shutdown(sig)));
