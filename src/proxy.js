const Proxy = require('http-mitm-proxy');
const trafficStore = require('./traffic-store');
const ruleEngine = require('./rule-engine');
const reporter = require('./reporter');
const config = require('./config');
const settings = require('./settings');
const zlib = require('zlib');

// 关闭 Nagle 算法，降低小分片流式（SSE）的转发延迟
function noDelay(sock) { try { if (sock) sock.setNoDelay(true); } catch {} }

// 按 content-encoding 解压报文体（仅用于存档/展示/上送的副本；转发给上游的原始字节不变）
function decodeBody(buf, encoding) {
  if (!buf || !buf.length) return '';
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch { /* 解压失败则回退原始文本 */ }
  return buf.toString('utf8');
}

function buildUrl(ctx) {
  const req = ctx.clientToProxyRequest;
  const host = req.headers.host || '';
  const proto = ctx.isSSL ? 'https' : 'http';
  return `${proto}://${host}${req.url}`;
}

// 是否为"打到代理/界面自身端口"的请求（本机某服务恰好占用同端口，或自环轮询）
// 这类请求会污染抓包列表甚至造成自我转发死循环，直接短路丢弃。
const SELF_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const SELF_PORTS = new Set([String(config.PROXY_PORT), String(config.UI_PORT)]);
function isSelfRequest(ctx) {
  if (ctx.isSSL) return false; // 直连代理端口的一般是明文
  const host = (ctx.clientToProxyRequest.headers.host || '').trim();
  const [hostname, port] = host.split(':');
  return SELF_HOSTS.has(hostname) && SELF_PORTS.has(port || '');
}

function startProxy() {
  const proxy = Proxy();

  proxy.use(Proxy.gunzip);

  proxy.onError((ctx, err) => {
    if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNREFUSED'].includes(err.code)) return;
    console.error('[proxy] error:', err.message);
  });

  proxy.onRequest((ctx, callback) => {
    const req = ctx.clientToProxyRequest;

    // 自指请求短路：本机服务占用了代理/界面同端口时的轮询等噪音，不记录不转发，防自环
    if (isSelfRequest(ctx)) {
      ctx.proxyToClientResponse.writeHead(421, { 'content-type': 'text/plain' });
      ctx.proxyToClientResponse.end('proxy-inspector: refused self-directed request');
      return;
    }

    const url = buildUrl(ctx);
    const method = req.method;
    const rule = ruleEngine.match(url, method);

    // 低延迟直通：延迟敏感的流式接口（如行内代码补全）走快速通道
    if (settings.isPassthrough(url)) {
      ctx._passthrough = true;
      // 不强制 gzip，避免压缩缓冲破坏 SSE 实时性（gunzip 中间件默认会设成 gzip）
      ctx.proxyToServerRequestOptions.headers['accept-encoding'] = 'identity';
      // 关闭客户端侧 Nagle，分片即时下发
      noDelay(req.socket);
    }

    const reqChunks = [];
    ctx.onRequestData((ctx2, chunk, cb) => { reqChunks.push(chunk); cb(null, chunk); });

    ctx.onRequestEnd((ctx2, cb) => {
      const requestBody = decodeBody(Buffer.concat(reqChunks), req.headers['content-encoding']);
      const record = trafficStore.add({
        method,
        url,
        requestHeaders: { ...req.headers },
        requestBody,
        statusCode: null,
        responseHeaders: null,
        responseBody: null,
        duration: null,
        _startAt: Date.now(),
        rule: rule ? rule.id : null,
      });
      ctx._recordId = record.id;
      ctx._startAt = record._startAt;
      cb();
    });

    // Mock：直接返回，不转发
    if (rule && rule.action === 'mock') {
      const record = trafficStore.add({
        method, url,
        requestHeaders: { ...req.headers },
        requestBody: '',
        statusCode: rule.mockStatus || 200,
        responseHeaders: { 'content-type': rule.mockContentType || 'application/json' },
        responseBody: rule.mockBody || '{}',
        duration: 0,
        _startAt: Date.now(),
        rule: rule.id,
      });
      reporter.push(record);
      ctx.proxyToClientResponse.writeHead(rule.mockStatus || 200, {
        'content-type': rule.mockContentType || 'application/json',
        'x-proxied-by': 'proxy-inspector',
      });
      ctx.proxyToClientResponse.end(rule.mockBody || '{}');
      return;
    }

    // Block：直接返回 403
    if (rule && rule.action === 'block') {
      ctx.proxyToClientResponse.writeHead(403, { 'content-type': 'text/plain' });
      ctx.proxyToClientResponse.end('Blocked by proxy-inspector');
      return;
    }

    // Modify：追加请求头
    if (rule && rule.action === 'modify' && rule.addRequestHeaders) {
      Object.assign(ctx.proxyToServerRequestOptions.headers, rule.addRequestHeaders);
    }

    callback();
  });

  proxy.onResponse((ctx, callback) => {
    const res = ctx.serverToProxyResponse;

    // 直通：关闭两端 Nagle，SSE 分片即时透传给 IDE
    if (ctx._passthrough) {
      noDelay(res.socket);
      noDelay(ctx.proxyToClientResponse.socket);
      // 强制 Connection: close —— 行内补全客户端常靠"连接关闭"判定流结束才回写，
      // MITM 默认 keep-alive 会让 IDE 一直等不到结束而丢弃补全。
      if (res.headers) { res.headers['connection'] = 'close'; delete res.headers['keep-alive']; }
      try { ctx.proxyToClientResponse.shouldKeepAlive = false; } catch {}
    }

    const resChunks = [];

    ctx.onResponseData((ctx2, chunk, cb) => { resChunks.push(chunk); cb(null, chunk); });

    ctx.onResponseEnd((ctx2, cb) => {
      const responseBody = decodeBody(Buffer.concat(resChunks), res.headers['content-encoding']);
      const duration = ctx._startAt ? Date.now() - ctx._startAt : null;
      const updated = trafficStore.update(ctx._recordId, {
        statusCode: res.statusCode,
        responseHeaders: { ...res.headers },
        responseBody,
        duration,
      });
      if (updated) reporter.push(updated);
      cb();
    });

    // Modify：追加响应头
    const url = buildUrl(ctx);
    const rule = ruleEngine.match(url, ctx.clientToProxyRequest?.method);
    if (rule && rule.action === 'modify' && rule.addResponseHeaders) {
      Object.assign(res.headers, rule.addResponseHeaders);
    }

    callback();
  });

  proxy.listen({ port: config.PROXY_PORT, sslCaDir: config.CERTS_DIR }, (err) => {
    if (err) { console.error('\x1b[31m[proxy] 启动失败:\x1b[0m', err); process.exit(1); }
    // 启动横幅由 index.js 统一打印，这里只补一条证书路径
    console.log(`\x1b[90m  根证书: ${require('path').resolve(config.CERTS_DIR, 'certs', 'ca.pem')}\x1b[0m`);
  });

  return proxy;
}

module.exports = { startProxy };
