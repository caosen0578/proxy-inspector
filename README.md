# Proxy Inspector

HTTP/HTTPS 抓包代理工具，支持规则引擎、报文上送和实时 Web 面板。

## 快速启动

```bash
npm install
npm start
```

浏览器打开 http://127.0.0.1:28900，然后把系统/浏览器代理设为 `127.0.0.1:28899`。

## 端口说明

| 端口 | 用途 |
|------|------|
| 28899 | HTTP/HTTPS 代理（浏览器/系统指向这里） |
| 28900 | Web UI 面板 |

## HTTPS 抓包配置

首次发起一次 HTTPS 请求后，会在 `./certs/certs/ca.pem` 自动生成根证书。
可在 Web UI 顶部横幅/按钮下载，或直接访问下列地址（两者内容相同，仅扩展名不同）：

| 平台 | 下载地址 | 说明 |
| --- | --- | --- |
| Windows | `http://127.0.0.1:28900/api/ca.cer` | 双击 `.cer` → 安装证书 → 本地计算机 → 「将所有证书放入下列存储」→ 选「受信任的根证书颁发机构」 |
| macOS | `http://127.0.0.1:28900/api/ca.pem` | 钥匙串访问 → 导入 → 设为始终信任 |
| Linux | `http://127.0.0.1:28900/api/ca.pem` | 复制到 `/usr/local/share/ca-certificates/`（改名 `.crt`）后 `update-ca-certificates` |
| 手机 | `http://127.0.0.1:28900/api/ca.pem` | 下载后安装描述文件并信任 |

> Windows 不识别 `.pem` 双击安装，请使用 `.cer`；安装后重启浏览器，HTTPS 警告消失、图片正常加载。

> **注意**：`http-mitm-proxy@0.9.0` 默认把服务器证书签成 2 年有效期，会被 Chrome/Edge 以 `ERR_CERT_VALIDITY_TOO_LONG` 拒绝（即使根证书已信任）。本项目通过 `patches/http-mitm-proxy+0.9.0.patch` 将其改为 397 天（≤398 天上限）。`npm install` 会经 `postinstall` 自动重新应用补丁，无需手动处理。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | 28899 | 代理监听端口 |
| `UI_PORT` | 28900 | Web UI 端口 |
| `CERTS_DIR` | ./certs | 证书目录 |
| `REPORTER_FORMAT` | raw | 上送格式：`raw` 原始报文批量 / `behavior` 映射为埋点接口 |
| `REPORTER_URL` | （空）| raw 模式上送地址 |
| `REPORTER_BASE_URL` | （空）| behavior 模式埋点平台 BaseURL |
| `REPORTER_TOKEN` | （空）| behavior 模式鉴权 token（放入 `pf-api-Token` 头） |
| `REPORTER_TRIGGER_VERSION` | proxy-inspector | behavior 模式 `triggerVersion` 默认值 |

> 上述均可在 `settings.json` 持久化，或通过 Web UI / `PUT /api/settings` 动态修改，优先级高于环境变量默认值。

## 规则引擎

规则按顺序匹配，命中第一条后执行对应动作，不再继续匹配。

### 支持的匹配模式

| 形式 | 示例 | 说明 |
|------|------|------|
| 字符串包含 | `api.example.com` | URL 包含该字符串 |
| Glob 通配符 | `**/api/users*` | 支持 `*` `**` `?` |
| 正则表达式 | `/\/api\/v[12]\//` | 首尾斜杠包裹 |

### 动作类型

#### mock — 直接返回模拟响应

```json
{
  "pattern": "*api.example.com/users*",
  "method": "GET",
  "action": "mock",
  "mockStatus": 200,
  "mockContentType": "application/json",
  "mockBody": "{\"code\":0,\"data\":[]}"
}
```

#### modify — 追加请求/响应头

```json
{
  "pattern": "*example.com*",
  "method": "*",
  "action": "modify",
  "addRequestHeaders": { "X-Debug": "true" },
  "addResponseHeaders": { "Access-Control-Allow-Origin": "*" }
}
```

#### block — 直接返回 403 阻断请求

```json
{
  "pattern": "*analytics*",
  "action": "block"
}
```

## 报文上送

每条请求响应完成时异步上送，支持两种格式（`reporterFormat`）：

- **`raw`**：原始报文批量上送到 `reporterUrl`（见下方）
- **`behavior`**：映射为「用户行为埋点接口」逐条上送到 `reporterBaseUrl + /ap/userBehavior/saveRecord`

### behavior 模式（埋点接口映射）

适用于 modelgate 等 OpenAI 兼容网关：从抓到的 chat/completions 报文提取字段，映射为 `saveRecord` 请求体后逐条 POST，鉴权 token 放入 `pf-api-Token` 请求头。

**字段映射按接口分套**（`reporterMappings`，数组）。每个接口一套：`{ name, match, mapping }`——`match` 为 URL 匹配规则（子串 / `*通配*` / `/正则/`，空=匹配全部）。上送时按 `record.url` 选用**首个匹配**的接口映射；无匹配回退内置默认。可在「字段映射」标签页用下拉切换/新建/删除接口。

每套映射的字段定义如下（默认按 OpenAI chat/completions + SSE 假设）。

每个目标字段声明它的取值来源，**改映射只需改配置，无需改代码**。来源类型：

| source | 含义 | 写法 |
| --- | --- | --- |
| `const` | 固定值 | `{ "source":"const", "value":"CODE_CHAT" }` |
| `uuid` | 每条随机 UUID | `{ "source":"uuid" }` |
| `config` | 取上送配置项 | `{ "source":"config", "key":"reporterTriggerVersion" }` |
| `req` | 请求 body（JSON）按路径取 | `{ "source":"req", "path":"model" }` |
| `res` | 响应 body（JSON）按路径取 | `{ "source":"res", "path":"choices.0.message.content" }` |
| `record` | 报文元数据 | `{ "source":"record", "path":"statusCode" }` |

- `path` 支持点号路径与数组下标，如 `choices.0.message.content`、`data.stats.in`。
- `record` 可取字段：`url` / `method` / `statusCode` / `timestamp`。
- `reqText` / `resText`：取**原始报文文本**（不解析 JSON），用于 SSE 流式等非 JSON 响应，需配合 transform。
- 可选 `transform`：
  - 通用：`joinMessages`（messages 数组拼文本）、`isoDate`（时间戳转 ISO）、`string`、`number`。
  - **SSE 流式响应**（配合 `source:'resText'`）：
    - `sseContent` —— 拼接所有 `delta.content`（对话）/ `choices[].text`（补全），**自动剥离 `data:`、`[DONE]` 与思考链**，得纯文本回答
    - `sseCode` —— 只取正文里的 markdown ` ``` ` 围栏代码块
    - `sseToolCode` —— 只取 `tool_calls` 参数里写入的代码（`new_str`/`content`/`code`，写文件型补全 replace_in_file/write_file）
    - **`sseCodeAll`** —— markdown 代码块 + 工具调用代码**都覆盖**；`result`/`acceptResult` 默认用它，**只上送代码**以统计代码生成率
    - `sseModel` / `sseFinishReason` / `ssePromptTokens` / `sseCompletionTokens` / `sseTotalTokens` —— 取模型名 / 结束原因 / token 用量
  - **`result` / `acceptResult` 默认上送的是 `sseCodeAll` 提取出的纯代码**（对话贴码、行内补全、工具调用写文件三种都覆盖），不是 SSE 原文。
- `record` 也可取报文头：如 `requestHeaders.x-request-trace-id`、`responseHeaders.x-request-id`（头名一律小写）。

### 内置预设：CodeBuddy / dsv4（SSE 流式）

真实抓到的腾讯云 CodeBuddy IDE 请求为 OpenAI 风格请求体 + **SSE 流式响应**（`text/event-stream`，逐 chunk `delta.content`）。对应映射见 [`mapping-presets/codebuddy-sse.json`](mapping-presets/codebuddy-sse.json)，要点：

| 目标字段 | 来源 | 说明 |
| --- | --- | --- |
| `requestId` | `requestHeaders.x-request-trace-id` | 请求头里的链路 ID |
| `modelId` | `req.model` | 如 `custom:dsv4` |
| `modelName` | `resText` + `sseModel` | 流里的 `model`，如 `dsv4` |
| `prompt` | `req.messages` + `joinMessages` | 拼接 system/user 内容 |
| `result` / `acceptResult` | `resText` + `sseCodeAll` | **只取代码**（markdown 代码块 + 工具调用 new_str）|
| `promptTokens` 等 | `resText` + `sseUsage*` | 末个含 `usage` 的 chunk |
| `finalReason` | `resText` + `sseFinishReason` | 如 `tool_calls` |

应用预设：把该 JSON 作为 `reporterMapping` 通过 `PUT /api/settings` 提交即可。
- 取不到值时降级为 `null`（`const` 保留原值），不阻断上送。

**默认映射**（`src/reporter-mapping.js` 的 `DEFAULT_MAPPING`，节选）：

```json
{
  "modelId":      { "source": "req",    "path": "model" },
  "prompt":       { "source": "req",    "path": "messages", "transform": "joinMessages" },
  "result":       { "source": "res",    "path": "choices.0.message.content" },
  "promptTokens": { "source": "res",    "path": "usage.prompt_tokens" },
  "opStatusCode": { "source": "record", "path": "statusCode" },
  "requestedAt":  { "source": "record", "path": "timestamp", "transform": "isoDate" }
}
```

**适配非 OpenAI 报文**：拿到真实报文后，把对应字段的 `path` 改成实际结构即可。例如响应是 `{ data: { answer, stats:{in,out} } }`：

```json
{
  "result":           { "source": "res", "path": "data.answer" },
  "promptTokens":     { "source": "res", "path": "data.stats.in" },
  "completionTokens": { "source": "res", "path": "data.stats.out" }
}
```

**配置示例**（`PUT /api/settings` 或 settings.json）：

```json
{
  "reporterEnabled": true,
  "reporterFormat": "behavior",
  "reporterBaseUrl": "http://sjdps.fat.git.pab.com.cn",
  "reporterToken": "在 av-pengxuemeng835 申请的 token",
  "reporterTriggerVersion": "modelgate",
  "reporterFilters": ["*/v1/chat/completions*"]
}
```

### raw 模式上送格式

```http
POST {REPORTER_URL}
Content-Type: application/json

{
  "records": [
    {
      "id": 1,
      "timestamp": 1717200000000,
      "method": "POST",
      "url": "https://api.example.com/v1/chat",
      "requestHeaders": { "content-type": "application/json" },
      "requestBody": "{\"model\":\"gpt-4\"}",
      "statusCode": 200,
      "responseHeaders": { "content-type": "application/json" },
      "responseBody": "{\"id\":\"chatcmpl-xxx\"}",
      "duration": 342
    }
  ]
}
```

### 上送开关与 URL 过滤

上送行为可在 Web UI「上送设置」标签页运行时配置，持久化到 `settings.json`：

- **总开关**：关闭时不向平台上送任何报文（抓包与界面展示不受影响）
- **上送地址**：分析平台接口地址
- **URL 过滤白名单**：每行一条，**留空 = 上送全部**；配置后仅命中任意一条的请求才上送。单条支持三种写法：
  - 子串包含：`/v1/chat`
  - 通配符：`*glm*`（`*` 匹配任意字符，含 `/`）
  - 正则：`/embeddings|rerank/`

> 典型场景：只统计代码补全、GLM、向量三个模型的报文，过滤白名单填这三个接口特征即可。

环境变量 `REPORTER_URL` 仍可作为初始默认值；UI 中的设置优先级更高。

### 上送策略

- 每 **2 秒** 或积累 **10 条** 时触发一次上送
- 上送失败按周期自动重试，最多 **5 次**；达上限后转为终态 `failed`，**停止自动重试**，需在「上送队列」点「重试失败项」手动重试（重置计数，重新获得 5 次）
- 单条 body 超过 **64 KB** 自动截断并添加 `...[truncated]`

### 持久化队列（防丢送）

上送任务进入一个**磁盘持久化队列**，保证应用被关闭/崩溃也不漏送：

- **入队即落盘**：每条任务一产生就写入 `reporter-queue.json`，发送成功才移除
- **重启自动恢复**：进程重启时从 `reporter-queue.json` 加载未完成任务继续上送；上次中断时「发送中」的任务复位为「待送」确保重试
- **优雅关闭**：收到 `SIGINT`/`SIGTERM`/`SIGHUP` 时先持久化队列再退出
- **上送关闭时不丢**：关闭上送开关只是暂停发送，队列仍保留在磁盘，重新开启后继续送

队列状态通过 WebSocket 实时推送到 Web UI 「上送队列」标签页，可视化展示：

| 区域 | 内容 |
| --- | --- |
| 统计卡 | 待送 / 发送中 / 失败待重试 / 本次已送达 |
| 待处理队列 | 每条任务的状态徽章、URL、重试次数（鼠标悬停看错误信息）；**点击任意条目弹窗预览报文** |
| 最近送达 | 最近成功上送的记录与时间 |
| 操作 | **重试失败项**（`POST /api/queue/retry`）、**清空队列**（`DELETE /api/queue`） |

## Web UI 功能

| 功能 | 说明 |
|------|------|
| 实时流量 | WebSocket 推送，无需刷新 |
| URL/方法/状态筛选 | 前端实时过滤 |
| 报文详情 | 请求头、请求 body、响应头、响应 body，JSON 自动格式化 |
| 规则管理 | 添加/删除/启用/禁用规则，持久化到 rules.json |
| 清空流量 | 一键清空当前记录 |

## API 接口

Web UI 通过以下 REST 接口与后端交互（均挂载在 `/api` 下，端口 28900）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 服务状态（代理端口、流量数、规则数等） |
| GET | `/api/traffic` | 获取全部流量记录 |
| GET | `/api/traffic/:id` | 获取单条流量详情 |
| DELETE | `/api/traffic` | 清空全部流量 |
| GET | `/api/rules` | 列出全部规则 |
| POST | `/api/rules` | 新增规则 |
| PUT | `/api/rules/:id` | 更新规则（启用/禁用、修改内容） |
| DELETE | `/api/rules/:id` | 删除规则 |
| GET | `/api/ca.pem` | 下载 CA 根证书（PEM，macOS/Linux/手机） |
| GET | `/api/ca.cer` | 下载 CA 根证书（同内容，`.cer` 扩展名，Windows 双击安装） |
| GET | `/api/queue` | 上送队列快照（统计 + 待处理 + 最近送达） |
| GET | `/api/queue/:qid` | 单条队列详情：原始抓包报文 + 实际上送报文体预览 |
| POST | `/api/queue/retry` | 把失败项重新置为待送并立即触发上送 |
| DELETE | `/api/queue` | 清空上送队列（丢弃未送达任务） |

> 实时流量另通过 WebSocket（同端口）推送，无需轮询。

## 项目结构

```
proxy-inspector/
├── src/
│   ├── index.js          # 入口：启动 HTTP server + WebSocket + 代理
│   ├── proxy.js          # MITM 代理核心逻辑
│   ├── api.js            # REST API + WebSocket 广播
│   ├── rule-engine.js    # 规则匹配引擎
│   ├── reporter.js       # 异步报文上送（raw / behavior 两种格式）
│   ├── reporter-mapping.js # 报文 → 埋点接口字段映射
│   ├── traffic-store.js  # 内存流量存储
│   └── config.js         # 配置项
├── web/public/
│   └── index.html        # Web UI（单文件，无构建依赖）
├── certs/                # 自动生成的 CA 证书
├── rules.json            # 规则持久化文件（自动生成）
└── package.json
```
