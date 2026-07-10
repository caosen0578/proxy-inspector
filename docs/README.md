# 文档索引

| 文档 | 说明 |
|------|------|
| [使用手册.md](使用手册.md) | 面向用户：打包分发、启动、证书安装、上送配置、日常使用 |
| [使用手册.docx](使用手册.docx) | 上手册的 **Word 分发版**（含示意图 + 截图占位框）。改动后重新生成：`NODE_PATH=$(npm root -g) node scripts/build-manual-docx.js`；示意图改了先跑 `scripts/render-diagrams.js`（需 `@resvg/resvg-js`），图片资源在 `docs/manual-img/` |
| [开发说明.md](开发说明.md) | 面向开发：技术栈、核心模块、代码结构、已修复 Bug 清单 |
| [CodeBuddy代码提取规则.md](CodeBuddy代码提取规则.md) | 两个接口的 SSE 代码提取逻辑（`/v2/completions` vs `/v2/chat/completions`） |
| [字段映射分析.md](字段映射分析.md) | saveRecord 各字段赋值方案及可行性分析 |
| [埋点接口文档-v1.0.md](埋点接口文档-v1.0.md) | 行内用户行为埋点接口原始文档（saveRecord / updateRecordForAccept） |
| [待解决问题.md](待解决问题.md) | 已知问题、待验证项、已解决问题记录 |
| [变更记录.md](变更记录.md) | 按时间+主题汇总的变更日志（上送口径/调试落盘/版本治理/多环境） |
