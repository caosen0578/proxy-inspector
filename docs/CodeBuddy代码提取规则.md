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

### 代码提取规则（工具代码 ∪ 围栏代码，2026-07 起为并集）

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

**优先级 2：delta.content ``` 围栏代码块（与工具代码并集，不再短路）**

检查 `delta.content` 拼接后是否含 ` ``` `，有则提取围栏内代码，**并入**工具代码。
> 2026-07 修复：早期这里是"有工具代码就直接返回、忽略围栏"（短路），会丢掉同一轮里
> 模型既写文件又在旁白贴的代码。现改为并集（按代码文本去重，避免"先贴预览再写文件"重复）。

**优先级 3：纯说明文字 → 返回空**

无工具调用、无围栏 → `extractGeneratedCode` 返回 `''` → `reporter.push()` 跳过，**不入队不上送**。

### 判断逻辑伪代码

```
function extractGeneratedCode(raw):
  parts = []
  for w in toolCallsWrites(raw): add(parts, w.code)   // 工具写入代码（去重）

  content = sseJoinContent(raw)                        // 拼接所有 delta.content
  blocks = codeBlocksOf(content)
  if blocks 非空: for b in blocks: add(parts, b)       // 围栏代码并入（不再短路）
  else if parts 为空 and isCompletionStyle(raw): add(parts, content)  // 补全裸代码

  return parts.join('\n\n')       // 全空 → '' → 丢弃
```

---

## 四、result 与 acceptResult 的区别（重要）

两者**取值规则不同**：

| 字段 | transform | 取什么 |
|------|-----------|--------|
| **result** | `sseFullReply` | **完整回复 + 全量工具留痕**：`delta.content` 旁白 + 本轮所有工具调用按流式顺序排列——写码工具为 `[工具名] 文件 \`路径\`：` + ``` 围栏代码块（不截断、按 code 去重），其余工具为 `> 调用 工具名: {参数摘要}` 单行（单值>120字/整行>300字截断，全文可查调试 JSONL）。纯聊天/补全无工具时即旧 `sseContent` 行为 |
| **acceptResult** | `sseCodeAll` | **AI 实际产出代码**（上面"代码提取规则"：工具写入 ∪ 围栏 / 补全裸代码） |

> 补全接口 `/v2/completions`：`result` 与 `acceptResult` 往往一致（都来自 `choices[0].text`）。
> 对话接口 `/v2/chat/completions`：`result` 现含工具写入的文件内容，`acceptResult` 是其中的代码部分。
>
> **2026-07 修复（重要）**：早期 `result=sseContent` 只取 `delta.content` 旁白 → Agent 写码轮次
> `result` 只剩一行标题、代码全丢；更严重的是**纯工具调用、旁白为空的轮次 `result=''`，被下面
> 第五节的内容过滤直接丢弃、整轮不上送**（这正是"应用到文件的代码没上送"的一个主因）。改用
> `sseFullReply` 后，工具写入的代码进入 `result` → 非空 → 这类轮次恢复上送。

---

## 五、过滤机制（两接口通用）

1. **内容过滤（入队 + 发送前都校验）**：`result` 或 `acceptResult` **任一为空 → 不上送**。
   - 入队时：`reporter.push()` → `_passesContentFilter` 不过则不入队。
   - 发送前：`_flush()` 对每条再校验一次（按当前映射重算），不过则**直接丢弃**（不发、不重试）。
     这样能挡住"旧规则入队 / `reporter-queue.json` 持久化"的历史脏条目。
2. **业务成功判定**：上送后检查 `data.code === '0'`；`code:"1"` 视为失败 → 自动重试（最多 5 次）。

---

## 六、对照表

| 接口 | result（完整回复） | acceptResult（代码） | 计数字段 |
|------|------------------|---------------------|--------------------|
| `/v2/completions` | `choices[0].text` 全量拼接 | 同左（补全裸代码即代码） | 见下计数口径（两对相等，回复即代码） |
| `/v2/chat/completions` | `delta.content` 旁白 + 全量工具留痕（流序：写码工具=围栏块带 `[工具名]`+filePath，其余=`> 调用` 单行摘要） | 工具写入 `write_to_file.content` + `replace_in_file.new_str` ∪ 旁白围栏代码 | 见下计数口径 |

> **计数口径（2026-07-11 定）**：计数字段与文本字段一一对应——`codeLines`/`codeSize` 数 **result**（完整回复），
> `acceptCodeLines`/`acceptCodeSize` 数 **acceptResult**（接受的代码）。两对由此有真实差异
> （旁白/留痕行只计入 codeLines），采纳率 = acceptCodeLines/codeLines 有梯度。
>
> **核心理念**：`acceptResult` 是"AI 实际写入本地文件的那部分代码"；`result` 是模型这轮回复的完整内容（含写入的文件）。两者任一为空都不上送。
>
> **被动抓包的固有边界**：`replace_in_file` 只有 `new_str`（改动块），合并后的**整文件内容留在 IDE 本地、不经过网络**，无法补齐；`execute_command` 若用 shell 写文件也抓不到"生成代码"。
