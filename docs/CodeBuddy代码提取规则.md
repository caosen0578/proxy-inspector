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
| prompt | 请求体 `prompt` 字段（代码上文）。由 `promptAny` 统一处理：对话接口取 `messages`、补全接口取 `prompt`，两边兼容 |
| promptSize / promptMd5 | 对 prompt 算 UTF-8 字节数 / MD5（纯计算） |

---

## 三、`/v2/chat/completions` — Craft/Agent 对话接口

### 代码提取规则（三级优先级）

**优先级 1：工具调用写入代码（最高）**

从所有 `delta.tool_calls` 的 `function.arguments` 里还原写入代码，JSON.parse 后按优先级取：
`new_str ?? content ?? code ?? newText`
- `write_to_file` → 取 `content`（完整文件代码）
- `replace_in_file` → 取 `new_str`（替换后代码片段）
- `read_file` / `read_lints` / `search` 等只读工具 → 无上述字段，自动跳过
- 多个写入工具调用结果用 `\n\n` 拼接

#### ⚠️ 工具调用分片重组规则（重要 / 抗模型精度问题）

SSE 把 `tool_calls` 拆成多个分片流式传输；且**模型精度问题**会引入多种异常，
必须充分容错才能稳定拿到 `arguments`：

| 异常表现 | 成因 |
|---------|------|
| 多个工具调用都标 `index:0` | 模型不递增 index |
| `function.name` 黏连成 `write_to_filewrite_to_file` | 模型把同一次 write 拆进多个带 name 的分片 |
| 同一次 write 整个发两遍 | 模型重复输出 |
| content 被拆到多个分片中间 | 流式分片 |

**做法：完全不依赖 `id` / `name` / `index`。**（早期"按边界切分"的 `sseToolCalls` 已废弃，
因为它依赖 name/id，遇到上面的黏连/重复就会把 `arguments` 劈半成非法 JSON 而丢失代码。）

现行算法（`src/reporter-mapping.js` → `toolCallsCode()` + `splitJsonObjects()`）：

1. 把**所有** `tool_calls[].function.arguments` 分片**按出现顺序全量拼接**成一个大字符串；
2. 用**括号配平**（正确处理字符串内的引号/转义/花括号）从中切出一个个**完整 JSON 对象**；
3. 每个对象按 `new_str ?? content ?? code ?? newText` 取代码；
4. **按代码文本去重**（同一次 write 发两遍时只保留一份，避免重复上送、代码量虚高）；
5. 半截 / 非法 JSON 分片 `try/catch` 跳过，不影响其它合法对象。

这样无论名字黏连、id 重复、index 恒 0、content 被拆几段、还是整次重复，都能正确还原。

示例（同一次 write 被拆进两个带 name 的分片，名字黏连）：
```
data:{"choices":[{"delta":{"tool_calls":[{"function":{"name":"write_to_file","arguments":"{\"content\":\"class A {"}}]}}]}
data:{"choices":[{"delta":{"tool_calls":[{"function":{"name":"write_to_file","arguments":" int x; }\"}"}}]}}]}
```
→ 拼接为 `{"content":"class A { int x; }"}` → 正确提取 `class A { int x; }`。

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

## 四、result 与 acceptResult 的区别（重要）

两者**取值规则不同**：

| 字段 | transform | 取什么 |
|------|-----------|--------|
| **result** | `sseContent` | **SSE 解析后的全部内容**（拼接所有 `choices[0].delta.content` / `choices[0].text`），不含工具调用 arguments |
| **acceptResult** | `sseCodeAll` | **AI 实际产出代码**（上面"代码提取规则"三级优先：工具调用 / 围栏 / 补全裸代码） |

> 补全接口 `/v2/completions`：`result` 与 `acceptResult` 往往一致（都来自 `choices[0].text`）。
> 对话接口 `/v2/chat/completions`：纯工具调用时 `delta.content` 可能为空 → `result` 为空，而 `acceptResult` 有代码。

---

## 五、过滤机制（两接口通用）

1. **内容过滤（入队 + 发送前都校验）**：`result` 或 `acceptResult` **任一为空 → 不上送**。
   - 入队时：`reporter.push()` → `_passesContentFilter` 不过则不入队。
   - 发送前：`_flush()` 对每条再校验一次（按当前映射重算），不过则**直接丢弃**（不发、不重试）。
     这样能挡住"旧规则入队 / `reporter-queue.json` 持久化"的历史脏条目。
2. **业务成功判定**：上送后检查 `data.code === '0'`；`code:"1"` 视为失败 → 自动重试（最多 5 次）。

---

## 六、对照表

| 接口 | result（全部内容） | acceptResult（代码） | codeLines/codeSize |
|------|------------------|---------------------|--------------------|
| `/v2/completions` | `choices[0].text` 全量拼接 | 同左（补全裸代码即代码） | 按 acceptResult 算 |
| `/v2/chat/completions` | `delta.content` 拼接（说明文字，可能为空） | 工具调用 `write_to_file.content` + `replace_in_file.new_str` | 按 acceptResult 算 |

> **核心理念**：`acceptResult` 是"AI 实际写入本地文件的那部分代码"；`result` 是模型这轮回复的完整文本内容。两者任一为空都不上送。
