module.exports = {
  // 代理监听端口（冷门高位端口，避免与常见开发服务冲突；可用环境变量 PROXY_PORT 覆盖）
  PROXY_PORT: process.env.PROXY_PORT || 28899,
  // Web UI 端口（可用环境变量 UI_PORT 覆盖；也兼容通用 PORT 变量）
  UI_PORT: process.env.UI_PORT || process.env.PORT || 28900,
  // 证书存放目录
  CERTS_DIR: process.env.CERTS_DIR || require('path').join(__dirname, '..', 'certs'),
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
  BEHAVIOR_SAVE_PATH: '/api/userBehavior/saveRecord',
  BEHAVIOR_UPDATE_PATH: '/api/userBehavior/updateRecordForAccept',
  BEHAVIOR_TOKEN_HEADER: 'apiToken',
  // 上送并发/批量配置
  REPORTER_BATCH_SIZE: 10,
  REPORTER_FLUSH_MS: 2000,
  REPORTER_RETRY: 3,
  // 单条最多自动重试次数；达上限后转为终态 failed，不再自动重试，需手动「重试失败项」
  REPORTER_MAX_ATTEMPTS: 5,
  // 内存中最多保留的流量条数
  MAX_TRAFFIC_RECORDS: 500,
  // 上送队列持久化文件（应用重启后从此恢复未完成任务，防止漏送）
  REPORTER_QUEUE_FILE: process.env.REPORTER_QUEUE_FILE || require('path').join(__dirname, '..', 'reporter-queue.json'),
  // UI 展示的"已完成"历史最大条数
  REPORTER_HISTORY_MAX: 100,
};
