# 待办：代码补全开代理后不回写 IDE —— 待验证

状态：**待用户实测确认**（2026-06-07 记）

## 已排查 / 已排除
- 代理转发**请求体 100% 完整**：实测 157 字节含中文/换行/转义，经代理后字节数、MD5、content-length 完全一致，无截断/改编码/转 chunked → **prompt 没被改坏**。
- 响应**流式实时透传**正常（分片逐个到达，非缓冲后一次性吐出）。
- 已对 `*/completions*` 启用「低延迟直通」：不强制 gzip、关 Nagle、强制 `Connection: close`。
- 抓到的一条补全报文里 **模型本身返回空**（`text:""`, `finish_reason:"stop"`），可能只是该位置无补全，**不能证明是代理的锅**。

## 决定性验证步骤（待用户做）
1. IDE 里敲一段**确定会出补全**的代码（不开代理能看到灰色 ghost text）。
2. **开代理**触发同样补全。
3. 点该条 → SSE 格式解析 → 看「拼接正文」：
   - **正文有内容但 IDE 没插入** → IDE 端问题（延迟/被取消/检测到代理），工具侧难解；但统计采集不受影响。
   - **正文为空** → 上游收到正确 prompt 却返回空，是请求头/鉴权/路由差异 → 把该条**完整请求头**发来对比定位。

## 接口信息备忘
- 补全接口：`POST http://codebuddy.pab.com.cn/v2/completions`（HTTP 明文）
- text_completion 格式：`choices[].text`（非 chat 的 delta.content）
- 请求头：`connection: close` / `proxy-connection: close`、`x-agent-intent: CodeCompletion`
- 请求体：`stream:true`, `stop:["\n\n","\n\n\n"]`, model `codewise-7b`
