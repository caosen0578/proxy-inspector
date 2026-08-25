#!/usr/bin/env node
/**
 * upstream-probe.js —— CodeBuddy服务端 ↔ 上游大模型 链路的一次性取样探针。
 *
 * 只做一件事：把经过它的请求/响应原样落到 JSONL，不解析、不映射、不落库、不上送。
 * 目的是搞清三件事：
 *   ① CodeBuddy 控制台的「网络代理地址」到底是正向代理还是 BaseURL(反向代理)
 *   ② 请求里有没有用户身份(apiKey / 工号 / 自定义头)
 *   ③ 模型端点是 HTTP 还是 HTTPS
 *
 * 同一个端口同时支持三种进来的姿势，用哪种由日志里的 mode 字段告诉你：
 *   - mode=reverse  : 相对路径请求 → 控制台填的是 BaseURL，转发给 UPSTREAM。最干净，无需 MITM。
 *   - mode=forward  : 绝对 URL 请求(GET http://host/path) → 正向代理走明文 HTTP，能看全文。
 *   - mode=tunnel   : CONNECT 方法 → 正向代理走 HTTPS，本探针只盲转发并记录目标 host:port，
 *                     看不到报文。看到这个就说明必须上 MITM(给 CodeBuddy 服务端装 CA)。
 *
 * 用法(服务器上直接跑，Node>=20)：
 *   node scripts/upstream-probe.js
 * 然后把 CodeBuddy 控制台的「网络代理地址」填成 http://<本机IP>:8899 ，触发一次对话。
 *
 * 安全提醒：落盘文件含全量 prompt / 代码 / apiKey，取完样立刻删，别留在服务器上。
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

// ---- 配置(字面量，取样脚本不搞环境变量)----------------------------------
const PORT = 8899;
// reverse 模式下把请求转发到哪里。若控制台填的是 BaseURL，这里填真实模型地址。
const UPSTREAM = 'https://api.example-model.com';
// 落盘位置
const OUT_FILE = path.join(__dirname, '..', 'upstream-probe.jsonl');
// 单条 body 最多记多少字符，防止把整个上下文撑爆磁盘。设 0 表示不截断。
const MAX_BODY = 2 * 1024 * 1024;
// -------------------------------------------------------------------------

let seq = 0;

function nowIso() {
  return new Date().toISOString();
}

function clip(str) {
  if (!MAX_BODY || str.length <= MAX_BODY) return { text: str, truncated: false };
  return { text: str.slice(0, MAX_BODY), truncated: true, originalLength: str.length };
}

function write(record) {
  fs.appendFileSync(OUT_FILE, JSON.stringify(record) + '\n', 'utf8');
}

/** 按 content-encoding 解压；解不开就原样返回 hex 提示，不让探针自己崩掉。 */
function decodeBody(buf, headers) {
  if (!buf || !buf.length) return '';
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf).toString('utf8');
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf8');
  } catch (e) {
    return `<<decode ${enc} failed: ${e.message}; raw ${buf.length} bytes>>`;
  }
  return buf.toString('utf8');
}

function readBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 处理一条普通 HTTP 请求。绝对 URL → forward 模式；相对路径 → reverse 模式转 UPSTREAM。
 */
async function handleRequest(req, res) {
  const id = ++seq;
  const startedAt = Date.now();
  const isAbsolute = /^https?:\/\//i.test(req.url || '');
  const mode = isAbsolute ? 'forward' : 'reverse';
  const target = new URL(isAbsolute ? req.url : (UPSTREAM.replace(/\/+$/, '') + req.url));

  const reqBodyBuf = await readBody(req);

  const base = {
    id,
    mode,
    at: nowIso(),
    clientIp: req.socket.remoteAddress,
    method: req.method,
    rawUrl: req.url,
    target: target.href,
    requestHeaders: req.headers,
    requestBody: clip(decodeBody(reqBodyBuf, req.headers)),
  };

  const agent = target.protocol === 'https:' ? https : http;
  const outHeaders = { ...req.headers };
  // 转给上游时 Host 要改成上游的，否则很多网关直接 421/404
  outHeaders.host = target.host;

  const upstreamReq = agent.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: outHeaders,
      // 取样阶段不为自签证书卡住
      rejectUnauthorized: false,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      const chunks = [];
      // SSE 必须边收边转，不能等 end，否则 CodeBuddy 那头会一直吊着
      upstreamRes.on('data', (c) => {
        chunks.push(c);
        res.write(c);
      });
      upstreamRes.on('end', () => {
        res.end();
        const buf = Buffer.concat(chunks);
        write({
          ...base,
          status: upstreamRes.statusCode,
          responseHeaders: upstreamRes.headers,
          responseBody: clip(decodeBody(buf, upstreamRes.headers)),
          durationMs: Date.now() - startedAt,
        });
        console.log(`[${id}] ${mode} ${req.method} ${target.href} -> ${upstreamRes.statusCode} (${Date.now() - startedAt}ms)`);
      });
    }
  );

  upstreamReq.on('error', (err) => {
    // fail-open 的雏形：上游挂了也要给客户端一个明确回应，并把失败也记下来
    write({ ...base, error: err.message, durationMs: Date.now() - startedAt });
    console.error(`[${id}] ${mode} ${target.href} ERROR ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('probe upstream error: ' + err.message);
  });

  if (reqBodyBuf.length) upstreamReq.write(reqBodyBuf);
  upstreamReq.end();
}

/**
 * CONNECT：HTTPS 正向代理。这里只做盲隧道，看不到内容——
 * 但只要日志里出现 mode=tunnel，就已经回答了问题①和③。
 */
function handleConnect(req, clientSocket, head) {
  const id = ++seq;
  const [host, portStr] = String(req.url).split(':');
  const port = Number(portStr) || 443;

  write({
    id,
    mode: 'tunnel',
    at: nowIso(),
    clientIp: clientSocket.remoteAddress,
    method: 'CONNECT',
    target: `${host}:${port}`,
    requestHeaders: req.headers,
    note: 'HTTPS 正向代理盲隧道，报文不可见；要看内容需给 CodeBuddy 服务端装 CA 做 MITM',
  });
  console.log(`[${id}] tunnel CONNECT ${host}:${port}  <-- 需要 MITM 才能看内容`);

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    console.error(`[${id}] tunnel ${host}:${port} ERROR ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', () => upstream.end());
}

const server = http.createServer();
server.on('request', (req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('probe fatal', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.on('connect', handleConnect);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`upstream-probe listening on 0.0.0.0:${PORT}`);
  console.log(`  reverse 模式转发目标 UPSTREAM = ${UPSTREAM}`);
  console.log(`  样本落盘 -> ${OUT_FILE}`);
  console.log('  把 CodeBuddy 控制台「网络代理地址」填成 http://<本机IP>:' + PORT + ' 后触发一次对话');
});
