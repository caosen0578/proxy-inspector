# saveRecord 字段赋值方案逐项确认（用户行为埋点接口 v1.0）

> 依据 v1.0 文档（2026-05-20）。原表「字段名/类型/必填/示例值/描述」基础上新增「最终赋值方案」。
> 图例：✅ 抓包可取 ｜ ⚠️ 需你确认 ｜ ❌ 抓包取不到（行为/IDE 端数据）
>
> 接口：`POST /api/userBehavior/saveRecord`，鉴权头 `apiToken`。
> 抓包样例：CodeBuddy IDE → `POST /v2/chat/completions`，OpenAI 请求体 + SSE 流式响应（model=dsv4）。
> 报文头一律小写：`x-user-id`、`x-conversation-id`、`x-request-trace-id`、`x-ide-name`、`x-ide-version` 等。

## saveRecord 参数详解

| 字段名 | 类型 | 必填 | 示例值 | 描述 | 最终赋值方案 |
|--------|------|------|--------|------|--------------|
| pluginVersion | String | 是 | `"IDEA_3.1.4.1"` | 插件版本号 | ✅ `x-ide-version`(4.2.4)。⚠️ 或用配置固定值？ |
| createdBy | String | 是 | `"chenyulan480"` | 操作用户 ID | ✅ 请求头 `x-user-id`（a4c0683e…）。⚠️ 要的是登录名还是 UUID？ |
| sessionId | String | 是 | `"0dc82829-…"` | 会话 UUID | ✅ 请求头 `x-conversation-id` |
| requestId | String | 是 | `"78ee7d17-…"` | 请求 UUID，关联后续更新 | ⚠️ 现取 `x-request-trace-id`。候选 `x-conversation-request-id`/`x-conversation-message-id`。**定一个** |
| type | String | 是 | `"CODE_CHAT"` | 见 Type 枚举 | ⚠️ 现固定 `CODE_CHAT`。可否按 `x-agent-intent`(craft) 映射？craft→哪个枚举 |
| result | String | 是 | `"您好…"` | AI 完整回复 | ✅ `resText`+`sseContent`（拼 SSE delta.content） |
| acceptResult | String | 是 | `"您好…"` | 接受结果 | ⚠️ 现同 result。语义是"用户最终接受的内容"，抓包阶段没有，**是否该留空/等 updateRecord？** |
| prompt | String | 是 | `"你是谁"` | 用户输入提示词 | ⚠️ 现取全部 messages 拼接（含 50KB system）。**是否只取最后一条 user？是否截断？** |
| scope | String | 是 | `"RooCode"` | AI 工具 | ✅ `x-ide-name`(CodeBuddyIDE)。⚠️ 还是固定写死你方工具名？ |
| isStatistics | Integer | 是 | `0` | 是否纳入统计 0/1 | ⚠️ 现固定 `1`。**默认 0 还是 1？** |
| modelName | String | 是 | `"aicoder-qwen3"` | 模型名称 | ✅ `resText`+`sseModel`=`dsv4`。⚠️ 或用请求 `model`(custom:dsv4)？ |
| promptTokens | Integer | 是 | `1000` | 输入 token | ⚠️ `ssePromptTokens`。**必填，但 SSE 末 chunk 若无 usage 会是 null——需确认流里有 usage** |
| completionTokens | Integer | 是 | `100` | 输出 token | ⚠️ 同上 `sseCompletionTokens` |
| totalTokens | Integer | 是 | `10100` | 总 token | ⚠️ 同上 `sseTotalTokens` |
| cost | Integer | 否 | `77` | 总耗时(ms) | ✅ `record.duration`（响应耗时） |
| apiStatusCode | String | 否 | `"00000"` | AI 服务状态码 | ⚠️ 现取 HTTP 状态码字符串"200"。**要的是业务码(00000)吗？SSE 体里没有** |
| clientResponseCode | String | 否 | `"0"` | 客户端自定义码 | ⚠️ 现取 HTTP 状态码。客户端码抓包没有，**固定 "0"？** |
| promptSize | Integer | 否 | `100` | prompt 字节数 | ⚠️ 可加 transform 算字节数。要吗？ |
| isUseCache | Integer | 否 | `0` | 是否命中缓存 0/1 | ❌ 抓包无 → 固定 `0` |
| language | String | 否 | `null` | 编程语言 | ❌ IDE 端 → `null` |
| waitCost | String | 否 | `"95"` | 等待耗时(ms) | ⚠️ 可用 duration。与 cost 区别？ |
| batchNo | String | 否 | `null` | 批量编号 | ❌ → `null` |
| promptMd5 | String | 否 | `null` | prompt 的 MD5 | ⚠️ 可对 prompt 算 MD5（加 transform）。要吗？ |
| acceptCodeLines | Integer | 否 | `10` | 接受代码行数 | ❌ 用户操作 → `null`（属 updateRecord） |
| acceptCodeSize | Integer | 否 | `20` | 接受代码大小 | ❌ 用户操作 → `null`（属 updateRecord） |
| resultId | Integer | 否 | `0` | 结果 ID | ❌ → `null` 或 `0` |
| triggerType | String | 否 | `"auto"` | 默认 auto | ✅ 固定 `auto` |
| commandType | String | 否 | `null` | 命令类型 | ❌ → `null` |
| codeLines | Integer | 否 | `123` | AI 生成代码总行数 | ⚠️ 可从 result 数代码行（不准）。或 `null` |
| codeSize | Integer | 否 | `123` | AI 生成代码大小 | ⚠️ 可用 result 字节数。或 `null` |
| apiUrl | String | 否 | `"http://…"` | 实际调用 URL | ✅ `record.url` |
| requestWaitCost | String | 否 | `"561"` | 请求等待耗时(ms) | ⚠️ 与 cost/waitCost 三者区别？可用 duration |
| repository | String | 否 | `null` | 知识库 | ❌ → `null` |
| filePath | String | 否 | `null` | 文件路径 | ❌ IDE 端 → `null` |
| templateUuid | String | 否 | `""` | 代码聊天模板 | ❌ → `""` |
| modelScope | String | 否 | `"base"` | 模型范围分类 | ❌ → `null` 或固定 `base`？ |
| instructionPath | String | 否 | `""` | 操作指南路径 | ❌ → `""` |
| knowledgeUuid | String | 否 | `""` | 关联知识 UUID | ❌ → `""` |
| usage | String | 否 | `null` | 使用方式 | ❌ → `null` |
| finishReason | String | 否 | `null` | 完成理由 | ✅ `resText`+`sseFinishReason`=`tool_calls` |

## updateRecordForAccept（用户操作反馈）

> 这 5 个字段来自**用户在 IDE 里采纳/复制/编辑代码**的操作，**抓 AI 请求报文拿不到**，需要 IDE 端事件源。当前抓包方案无法实现此接口，仅作记录。

| 字段名 | 类型 | 必填 | 描述 | 能否抓包取 |
|--------|------|------|------|-----------|
| requestId | String | 是 | 关联原始请求 ID | ⚠️ 需与 saveRecord 一致，靠同一标识关联 |
| actionType | String | 是 | codeCopy/codeAccept/codeEdit | ❌ 用户操作事件 |
| acceptResult | String | 是 | 操作结果快照 | ❌ |
| acceptCodeLines | Integer | 是 | 操作代码行数 | ❌ |
| acceptCodeSize | Integer | 是 | 操作代码大小 | ❌ |

## 待你拍板（汇总）

1. **requestId**：`x-request-trace-id` / `x-conversation-request-id` / `x-conversation-message-id`？（要与 updateRecord 能对上）
2. **createdBy**：要登录名还是用户 UUID（`x-user-id`）？
3. **scope**：取 `x-ide-name` 还是固定写你方工具名？
4. **isStatistics**：默认 0 还是 1？
5. **type**：固定 `CODE_CHAT` 还是按 `x-agent-intent` 映射？
6. **modelName**：用响应的 `dsv4` 还是请求的 `custom:dsv4`？
7. **必填的 token 三项**：真实 SSE 流末尾有没有 `usage`？没有则恒为 null，必填校验会挂。
8. **apiStatusCode**：要 AI 业务码（`00000`）还是 HTTP 码？业务码 SSE 流里没有。
9. **acceptResult**（saveRecord 里的必填项）：抓包阶段用户还没"接受"，填什么？
10. **cost/waitCost/requestWaitCost** 三个耗时字段的区别，分别对应什么？
