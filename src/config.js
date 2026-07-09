module.exports = {
  // 监听网卡：默认只绑本机回环 127.0.0.1（安全默认）。
  // ⚠️ 切勿改成 0.0.0.0 —— 那会把「Web 面板(含管理员解锁、抓到的代码)」和「MITM 代理」
  //    暴露到局域网：面板泄露他人代码、代理变成开放代理(任何人可借道/被抓包)。
  //    确有跨机需求再用环境变量 BIND_HOST 显式覆盖，并自行做好网络隔离。
  BIND_HOST: process.env.BIND_HOST || '127.0.0.1',
  // 代理监听端口（冷门高位端口，避免与常见开发服务冲突；可用环境变量 PROXY_PORT 覆盖）
  PROXY_PORT: process.env.PROXY_PORT || 28899,
  // Web UI 端口（可用环境变量 UI_PORT 覆盖；也兼容通用 PORT 变量）
  UI_PORT: process.env.UI_PORT || process.env.PORT || 28900,
  // 证书存放目录
  CERTS_DIR: process.env.CERTS_DIR || require('path').join(__dirname, '..', 'certs'),
  // 代理→上游「建立连接(TCP + TLS 握手)」的超时(毫秒)。连接在此时间内没握手成功
  // (路由黑洞/丢包/被 TLS 中间设备静默拦截/DNS 卡顿)，就主动断开并给客户端 504，
  // 避免客户端(如 CodeBuddy)一直干等到它自身更短的 headers timeout(表现为偶发 3003：
  // Cannot connect to API: Headers Timeout Error，且后台无日志——请求根本没到后台)。
  // 只约束「连接建立」这一段：连接一旦就绪即撤销计时，之后等模型出首字/流式思考再久也
  // 不打断，故不影响 SSE 补全。默认 10s(到 API 的 TCP+TLS 正常应在数秒内完成)。
  UPSTREAM_CONNECT_TIMEOUT_MS: +process.env.UPSTREAM_CONNECT_TIMEOUT_MS || 10000,
  // 新版本检查地址（内网 version.json），空=关闭。也可在面板「上送设置」里配（仅管理员）
  UPDATE_CHECK_URL: process.env.UPDATE_CHECK_URL || '',
  // 报文上送目标地址（raw 模式：直接 POST {records:[...]}）
  REPORTER_URL: process.env.REPORTER_URL || '',
  // 上送格式：'raw' 原始报文批量 | 'behavior' 映射为用户行为埋点接口
  REPORTER_FORMAT: process.env.REPORTER_FORMAT || 'raw',
  // behavior 模式：埋点平台 BaseURL（如 http://sjdps.fat.git.pab.com.cn）
  REPORTER_BASE_URL: process.env.REPORTER_BASE_URL || '',
  // behavior 模式：鉴权 token（放入 apiToken header）
  REPORTER_TOKEN: process.env.REPORTER_TOKEN || '',
  // behavior 模式：插件版本标识（saveRecord.pluginVersion 默认值）
  REPORTER_TRIGGER_VERSION: process.env.REPORTER_TRIGGER_VERSION || 'proxy-inspector',
  // 埋点接口固定路径与鉴权 header 名（用户行为埋点接口 v1.0）
  // 注意：路径不含 /api 前缀 —— /api（或各环境网关的 context path）由用户在
  // 「上送地址(reporterBaseUrl)」里配置，如 http://xxx.com.cn/api。
  // 实际上送 = reporterBaseUrl + 下面路径 = http://xxx.com.cn/api/userBehavior/saveRecord。
  BEHAVIOR_SAVE_PATH: '/userBehavior/saveRecord',
  BEHAVIOR_UPDATE_PATH: '/userBehavior/updateRecordForAccept',
  BEHAVIOR_TOKEN_HEADER: 'apiToken',
  // 上送并发/批量配置
  REPORTER_BATCH_SIZE: 10,
  REPORTER_FLUSH_MS: 2000,
  REPORTER_RETRY: 3,
  // 单条最多自动重试次数；达上限后转为终态 failed，不再自动重试，需手动「重试失败项」
  REPORTER_MAX_ATTEMPTS: 5,
  // 单次上送 HTTP 超时（毫秒）。必须 > 上送后端的最坏响应时间，否则后端「慢成功」时
  // 客户端会先超时→误判失败→重发→重复上送。默认 15s（后端同步转发上游上限约 5~6s，留足余量）。
  // 可在「上送设置」(仅管理员) 调整；接收端幂等是兜底，调大此值只是减少无谓重发。
  REPORTER_TIMEOUT_MS: +process.env.REPORTER_TIMEOUT_MS || 15000,
  // 内存中最多保留的流量条数
  MAX_TRAFFIC_RECORDS: process.env.MAX_TRAFFIC_RECORDS || 2000,
  // 上送队列持久化文件（应用重启后从此恢复未完成任务，防止漏送）
  REPORTER_QUEUE_FILE: process.env.REPORTER_QUEUE_FILE || require('path').join(__dirname, '..', 'reporter-queue.json'),
  // UI 展示的"已完成"历史最大条数
  REPORTER_HISTORY_MAX: 100,
};
