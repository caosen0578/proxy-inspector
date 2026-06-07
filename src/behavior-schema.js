// 用户行为埋点接口 v1.0 —— 两个上送接口的目标字段 schema（取自接口文档）
// 字段映射页面据此铺行，并展示 类型/必填/示例值/描述。

const SAVE_RECORD = [
  { name: 'pluginVersion',      type: 'String',  required: true,  example: 'IDEA_3.1.4.1',  desc: '当前插件版本号' },
  { name: 'createdBy',          type: 'String',  required: true,  example: 'chenyulan480',  desc: '操作用户 ID' },
  { name: 'sessionId',          type: 'String',  required: true,  example: '0dc82829-...',  desc: '会话唯一标识 (UUID)' },
  { name: 'requestId',          type: 'String',  required: true,  example: '78ee7d17-...',  desc: '请求唯一标识 (UUID)，用于关联后续更新' },
  { name: 'type',               type: 'String',  required: true,  example: 'CODE_CHAT',     desc: '附录 Type 枚举' },
  { name: 'result',             type: 'String',  required: true,  example: '您好，我是...', desc: 'AI 生成的完整回复内容' },
  { name: 'acceptResult',       type: 'String',  required: true,  example: '您好，我是...', desc: '接受结果' },
  { name: 'prompt',             type: 'String',  required: true,  example: '你是谁',        desc: '用户输入的提示词内容' },
  { name: 'scope',              type: 'String',  required: true,  example: 'RooCode',       desc: 'AI 工具' },
  { name: 'isStatistics',       type: 'Integer', required: true,  example: '0',             desc: '是否纳入统计：0-否，1-是' },
  { name: 'modelName',          type: 'String',  required: true,  example: 'aicoder-qwen3', desc: '具体使用的模型名称' },
  { name: 'promptTokens',       type: 'Integer', required: true,  example: '1000',          desc: '输入 token 数' },
  { name: 'completionTokens',   type: 'Integer', required: true,  example: '100',           desc: '输出 token 数' },
  { name: 'totalTokens',        type: 'Integer', required: true,  example: '10100',         desc: '总 token 数' },
  { name: 'cost',               type: 'Integer', required: false, example: '77',            desc: '总耗时 (单位：毫秒)' },
  { name: 'apiStatusCode',      type: 'String',  required: false, example: '00000',         desc: 'AI 服务返回的状态码' },
  { name: 'clientResponseCode', type: 'String',  required: false, example: '0',             desc: '客户端自定义的状态码' },
  { name: 'promptSize',         type: 'Integer', required: false, example: '100',           desc: '提示词（Prompt）的大小 / 字节数' },
  { name: 'isUseCache',         type: 'Integer', required: false, example: '0',             desc: '是否命中缓存：0-否，1-是' },
  { name: 'language',           type: 'String',  required: false, example: 'null',          desc: '用户指定的编程语言' },
  { name: 'waitCost',           type: 'String',  required: false, example: '95',            desc: '等待耗时（单位：毫秒）' },
  { name: 'batchNo',            type: 'String',  required: false, example: 'null',          desc: '批量处理编号' },
  { name: 'promptMd5',          type: 'String',  required: false, example: 'null',          desc: '提示词内容的 MD5 值' },
  { name: 'acceptCodeLines',    type: 'Integer', required: false, example: '10',            desc: '接受的代码行数' },
  { name: 'acceptCodeSize',     type: 'Integer', required: false, example: '20',            desc: '接受的代码大小（字节）' },
  { name: 'resultId',           type: 'Integer', required: false, example: '0',             desc: '结果 ID' },
  { name: 'triggerType',        type: 'String',  required: false, example: 'auto',          desc: '默认传 auto' },
  { name: 'commandType',        type: 'String',  required: false, example: 'null',          desc: '命令类型' },
  { name: 'codeLines',          type: 'Integer', required: false, example: '123',           desc: 'AI 生成的代码总行数' },
  { name: 'codeSize',           type: 'Integer', required: false, example: '123',           desc: 'AI 生成的代码总大小（字节）' },
  { name: 'apiUrl',             type: 'String',  required: false, example: 'http://...',    desc: '实际调用的 AI 服务 URL' },
  { name: 'requestWaitCost',    type: 'String',  required: false, example: '561',           desc: '请求等待耗时（单位：毫秒）' },
  { name: 'repository',         type: 'String',  required: false, example: 'null',          desc: '知识库' },
  { name: 'filePath',           type: 'String',  required: false, example: 'null',          desc: '文件路径' },
  { name: 'templateUuid',       type: 'String',  required: false, example: '',              desc: 'AI 使用了模板，代码聊天模板' },
  { name: 'modelScope',         type: 'String',  required: false, example: 'base',          desc: '模型范围分类' },
  { name: 'instructionPath',    type: 'String',  required: false, example: '',              desc: '操作指南路径，无则为空串' },
  { name: 'knowledgeUuid',      type: 'String',  required: false, example: '',              desc: '关联的知识 UUID，无则为空串' },
  { name: 'usage',              type: 'String',  required: false, example: 'null',          desc: '使用方式' },
  { name: 'finishReason',       type: 'String',  required: false, example: 'null',          desc: '完成理由' },
];

const UPDATE_RECORD = [
  { name: 'requestId',       type: 'String',  required: true, example: '78ee7d17-...', desc: '关联的原始请求 ID，需与 saveRecord 一致' },
  { name: 'actionType',      type: 'String',  required: true, example: 'codeCopy',     desc: '用户操作类型：codeCopy/codeAccept/codeEdit 等' },
  { name: 'acceptResult',    type: 'String',  required: true, example: '您好，我是...', desc: '操作时的结果快照或变更后的内容' },
  { name: 'acceptCodeLines', type: 'Integer', required: true, example: '10',           desc: '操作涉及的代码行数' },
  { name: 'acceptCodeSize',  type: 'Integer', required: true, example: '20',           desc: '操作涉及的代码大小（字节）' },
];

// 两个目标接口的定义（含固定路径）
const TARGETS = {
  saveRecord:            { label: '新增行为记录 saveRecord',          path: '/api/userBehavior/saveRecord',            fields: SAVE_RECORD },
  updateRecordForAccept: { label: '更新行为记录 updateRecordForAccept', path: '/api/userBehavior/updateRecordForAccept', fields: UPDATE_RECORD },
};

module.exports = { SAVE_RECORD, UPDATE_RECORD, TARGETS };
