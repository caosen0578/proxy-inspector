# CodeBuddy 两个接口的代码提取规则

> 对应实现：`src/reporter-mapping.js` → `extractGeneratedCode()`

---

## 一、接口识别

| 接口 | URL | 请求头 `x-agent-intent` | SSE 格式 |
|------|-----|------------------------|---------|
| 代码补全 | `/v2/completions` | `CodeCompletion` | `choices[0].text`（裸代码） |
| Craft/Agent 对话 | `/v2/chat/completions` | `craft` | `choices[0].delta.content` + 可能含 `tool_calls` |

识别方式：检查 SSE chunk 是否有 `choices[0].delta.content`（对话）或 `choices[0].text`（补全）。

---

## 二、`/v2/completions` — 代码补全接口

### 代码提取规则

每个 SSE chunk 格式：
```json
{"choices":[{"text":"@ApiModelProperty...","finish_reason":""}],"usage":null}
```

**提取方式**：直接拼接所有 `choices[0].text`，全量文本即代码。无需识别围栏，全文就是代码。

```
result = 所有 SSE chunk 的 choices[0].text 拼接
```

### 各字段提取

| 字段 | 提取方式 |
|------|---------|
| result / acceptResult | 全量 `choices[0].text` 拼接（完整代码） |
| codeLines | `result.split('\n').length` |
| codeSize | `Buffer.byteLength(result, 'utf8')` |
| modelName | 任意 chunk 的 `model` 字段 |
| promptTokens | 最后含 `usage` 的 chunk → `usage.prompt_tokens` |
| completionTokens | 最后含 `usage` 的 chunk → `usage.completion_tokens` |
| totalTokens | 最后含 `usage` 的 chunk → `usage.total_tokens` |
| finishReason | 最后含 `finish_reason` 的 chunk → `choices[0].finish_reason` |
| language | 请求体 `extra.language` |
| filePath | 请求体 `extra.file_name` |
| repository | 请求体 `extra.repo_name` |
| prompt | 请求体 `prompt` 字段（代码上文） |

---

## 三、`/v2/chat/completions` — Craft/Agent 对话接口

### 代码提取规则（三级优先级）

**优先级 1：工具调用写入代码（最高）**

遍历 SSE 中所有 `delta.tool_calls`，拼接 `function.arguments`，JSON.parse 后提取：
- `write_to_file` → `arguments.content`（完整文件代码）
- `replace_in_file` → `arguments.new_str`（替换后代码片段）
- `read_file` / `read_lints` / `search` 等只读工具 → 无上述字段，自动跳过
- 多个写入工具调用结果用 `\n\n` 拼接

#### ⚠️ 工具调用分片重组规则（重要）

SSE 把 `tool_calls` 拆成多个分片流式传输，必须正确重组才能拿到完整的 `arguments`。

**坑**：本模型（glm5-0）偶发会把**一次响应里的多个工具调用都标成 `index:0`**。
此时若按 `index` 归并，会把多个调用拼到一起：
- name 拼成 `write_to_filewrite_to_file`（表象）
- arguments 首尾相接拼成非法 JSON `{...}{...}` → `JSON.parse` 失败 → **代码全部丢失**

**正确做法（按边界切分，不按 index 归并）**：

| 分片特征 | 判定 |
|---------|------|
| 带 `id` 或 `function.name` | 新工具调用开始 |
| 只带 `function.arguments`（无 id、无 name） | 上一个调用的续传分片，仅追加 arguments |

这样既兼容标准 OpenAI（index 递增），也兼容本模型（index 恒 0）。
`replace_in_file` 偶发出现两次同理——按边界拆开后两段 `new_str` 都能正常提取。

> 实现见 `src/reporter-mapping.js` → `sseToolCalls()`

示例（两个 `write_to_file` 都在 index:0）：
```
data:{"choices":[{"index":0,"delta":{"tool_calls":[{"id":"t1","index":0,"function":{"name":"write_to_file","arguments":"{...A...}"}}]}}]}
data:{"choices":[{"index":0,"delta":{"tool_calls":[{"id":"t2","index":0,"function":{"name":"write_to_file","arguments":"{...B...}"}}]}}]}
```
→ 正确拆成两个调用，A、B 的 content 都提取，用 `\n\n` 拼接。

**优先级 2：delta.content ``` 围栏代码块**

若无工具调用，检查 `delta.content` 拼接后是否含 ` ``` `，有则提取围栏内代码。

**优先级 3：纯说明文字 → 返回空**

无工具调用、无围栏 → `extractGeneratedCode` 返回 `''` → `reporter.push()` 跳过，**不入队不上送**。

### 判断逻辑伪代码

```
function extractGeneratedCode(raw):
  tool = toolCallsCode(raw)        // 遍历 tool_calls 提取写入代码
  if tool != '': return tool       // 有写入工具调用，直接用

  content = sseJoinContent(raw)    // 拼接所有 delta.content
  if content 含 ```: return extractCodeBlocks(content)  // 有围栏，取围栏内
  if isCompletionStyle(raw): return content             // 补全接口裸代码

  return ''                        // 纯说明文字，丢弃
```

---

## 四、过滤机制（两接口通用）

1. **入队前过滤**：`reporter.push()` 先跑 `toSaveRecord`，若 `result` 为空 → `return false`，不入队
2. **业务成功判定**：上送后检查 `data.code === '0'`；`code:"1"` 视为失败 → 自动重试（最多 5 次）

---

## 五、对照表

| 接口 | result/acceptResult 取什么 | codeLines/codeSize 怎么算 |
|------|--------------------------|--------------------------|
| `/v2/completions` | SSE `choices[0].text` 全量拼接 | 全量文本的行数/字节数 |
| `/v2/chat/completions` | 工具调用：`write_to_file.content` + `replace_in_file.new_str` | 工具调用代码的行数/字节数之和 |

> **核心理念**：`result`/`acceptResult` 提取的是"AI 实际写入本地文件的那部分代码"，纯聊天说明文字不计入。
