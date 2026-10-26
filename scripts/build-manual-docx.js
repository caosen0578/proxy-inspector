// 生成《Proxy Inspector 使用手册》Word 版（含示意图 + 截图占位框）
// 图片来自 docs/manual-img/*.png（示意图用 scripts/render-diagrams.js 生成；占位框请后续替换为真实截图）
// 运行：NODE_PATH=$(npm root -g) node scripts/build-manual-docx.js
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, ImageRun, TableOfContents, PageNumber, Header, Footer, PageBreak,
} = require('docx');

const IMG_DIR = path.join(__dirname, '..', 'docs', 'manual-img');
const CONTENT_W = 9360;             // US Letter 1" 边距内容宽（DXA）
const YAHEI = 'Microsoft YaHei';
const MONO = 'Consolas';
const COLORS = {
  h1: '1A73E8', h2: '174EA6',
  code: 'F1F3F4', codeText: '202124',
  noteBg: 'E8F0FE', noteBar: '4A90D9',
  warnBg: 'FEF7E0', warnBar: 'F9AB00',
  tblHead: 'D5E8F0', border: 'CCCCCC', grey: '5F6368',
};

// 读取 PNG 内在宽高（IHDR）
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function loadImg(name) {
  const buf = fs.readFileSync(path.join(IMG_DIR, name + '.png'));
  return { buf, ...pngSize(buf) };
}
const IMG = {
  overview: loadImg('overview'),
  startup: loadImg('startup'),
  kylin: loadImg('kylin-steps'),
  cert: loadImg('cert-trust'),
  certStore: loadImg('cert-store'),
  phMain: loadImg('ph-main'),
  phDownloadCert: loadImg('ph-download-cert'),
  phCertWizard: loadImg('ph-cert-wizard'),
  phKylinTerm: loadImg('ph-kylin-terminal'),
  phReport: loadImg('ph-report-settings'),
  phMapping: loadImg('ph-field-mapping'),
  phQueue: loadImg('ph-report-queue'),
};

// ---------- 内容辅助函数 ----------
function runsOf(runs, base = {}) {
  return (Array.isArray(runs) ? runs : [runs]).map((r) =>
    typeof r === 'string'
      ? new TextRun({ text: r, font: YAHEI, ...base })
      : new TextRun({
        text: r.t, bold: !!r.b || !!base.bold,
        font: r.c ? MONO : YAHEI,
        color: r.color || (r.c ? '0B5394' : base.color),
        shading: r.c ? { fill: COLORS.code, type: ShadingType.CLEAR } : undefined,
        ...(base.size ? { size: base.size } : {}),
      }));
}
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
function P(runs, opts = {}) {
  return new Paragraph({ children: runsOf(runs), spacing: { after: opts.after ?? 120, before: opts.before ?? 0 } });
}
const bullet = (runs) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runsOf(runs), spacing: { after: 60 } });
const num = (runs, ref = 'steps') => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runsOf(runs), spacing: { after: 60 } });

// 提示框
function callout(lines, kind = 'note') {
  const bg = kind === 'warn' ? COLORS.warnBg : COLORS.noteBg;
  const bar = kind === 'warn' ? COLORS.warnBar : COLORS.noteBar;
  const paras = lines.map((ln, i) => new Paragraph({ children: runsOf(ln), spacing: { after: i === lines.length - 1 ? 0 : 60 } }));
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { fill: bg, type: ShadingType.CLEAR },
      margins: { top: 100, bottom: 100, left: 200, right: 160 },
      borders: {
        top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
        left: { style: BorderStyle.SINGLE, size: 24, color: bar },
      },
      children: paras,
    })] })],
  });
}
// 代码块
function code(lines) {
  const paras = lines.map((ln, i) => new Paragraph({
    children: [new TextRun({ text: ln || ' ', font: MONO, size: 20, color: COLORS.codeText })],
    spacing: { after: i === lines.length - 1 ? 0 : 40, line: 264 },
  }));
  const b = { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0' };
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { fill: COLORS.code, type: ShadingType.CLEAR },
      margins: { top: 100, bottom: 100, left: 160, right: 120 },
      borders: { top: b, bottom: b, left: b, right: b },
      children: paras,
    })] })],
  });
}
// 图片 + 图注
let figN = 0;
function figure(img, caption, dispW = 560) {
  figN += 1;
  const h = Math.round((img.h / img.w) * dispW);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 },
      children: [new ImageRun({ type: 'png', data: img.buf, transformation: { width: dispW, height: h },
        altText: { title: caption, description: caption, name: 'fig' + figN } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 },
      children: [new TextRun({ text: `图 ${figN}　${caption}`, font: YAHEI, size: 18, italics: true, color: COLORS.grey })] }),
  ];
}
// 表格
function dataTable(headers, rows, cols) {
  const border = { style: BorderStyle.SINGLE, size: 1, color: COLORS.border };
  const borders = { top: border, bottom: border, left: border, right: border };
  const mkCell = (txt, w, head) => new TableCell({
    borders, width: { size: w, type: WidthType.DXA },
    shading: head ? { fill: COLORS.tblHead, type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: (Array.isArray(txt) && Array.isArray(txt[0]) ? txt : [txt]).map((seg) =>
      new Paragraph({ children: runsOf(seg, { size: 20, bold: head }), spacing: { after: 0 } })),
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: cols,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((hd, i) => mkCell(hd, cols[i], true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => mkCell(c, cols[i], false)) })),
    ],
  });
}
const spacer = () => new Paragraph({ children: [new TextRun('')], spacing: { after: 60 } });

// ---------- 正文 ----------
const bodyC = [];
// 封面
bodyC.push(
  new Paragraph({ spacing: { before: 2400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Proxy Inspector', font: YAHEI, bold: true, size: 64, color: COLORS.h1 })] }),
  new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '使用手册', font: YAHEI, bold: true, size: 44 })] }),
  new Paragraph({ spacing: { before: 480 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'HTTP/HTTPS 抓包代理工具', font: YAHEI, size: 26, color: COLORS.grey })] }),
  new Paragraph({ spacing: { before: 80 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '抓取 AI 接口报文 → 映射为用户行为埋点接口 → 上送埋点平台 → 统计个人代码生成率', font: YAHEI, size: 20, color: COLORS.grey })] }),
  new Paragraph({ spacing: { before: 1200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '支持 Windows 与 麒麟 / 信创 Linux', font: YAHEI, size: 22 })] }),
  new Paragraph({ children: [new PageBreak()] }),
);
// 目录
bodyC.push(
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('目录')] }),
  new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: '（在 Word 中按 F9 或右键「更新域」可刷新页码）', font: YAHEI, size: 18, color: COLORS.grey })] }),
  new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-2' }),
  new Paragraph({ children: [new PageBreak()] }),
);

// 工作原理
bodyC.push(h1('工作原理总览'));
bodyC.push(P('把浏览器 / IDE / 系统的代理指向本工具的代理端口（127.0.0.1:28899），工具即可抓取经过的 AI 接口报文，解析后映射为埋点「saveRecord」接口字段，进入上送队列上送到埋点平台，从而统计个人代码生成率。管理界面在 28900 端口，用浏览器打开即可查看流量与配置。'));
bodyC.push(...figure(IMG.overview, '整体工作原理与数据流'));

// 一、打包
bodyC.push(h1('一、打包（分发给别人用）'));
bodyC.push(callout([[{ t: '适用：', b: true }, '把工具发给同事 / 部署到内网无 npm 源的机器。']], 'note'));
bodyC.push(spacer());
bodyC.push(num([{ t: '在' }, { t: '本机', b: true }, { t: '（已能正常运行的机器）双击运行 ' }, { t: 'pack.cmd', c: true }], 'pack'));
bodyC.push(num([{ t: '脚本会自动：' }, { t: 'npm install', c: true }, { t: '（含证书补丁）→ 复制运行所需文件到 ' }, { t: 'dist\\proxy-inspector\\', c: true }], 'pack'));
bodyC.push(num([{ t: '把 ' }, { t: 'dist\\proxy-inspector', c: true }, { t: ' 整个文件夹' }, { t: '压缩成 zip', b: true }, { t: ' 发给对方' }], 'pack'));
bodyC.push(P([{ t: '打包会自动排除', b: true }, { t: '（不会带上你的私人数据）：' }], { before: 120 }));
bodyC.push(bullet([{ t: 'certs/', c: true }, { t: '（含本机 CA 私钥，每台机器要生成自己的）' }]));
bodyC.push(bullet([{ t: 'settings.json', c: true }, { t: '（你的 apiToken、UM 号等个人配置）' }]));
bodyC.push(bullet([{ t: 'reporter-queue.json', c: true }, { t: '（你抓到的报文队列）' }]));
bodyC.push(bullet('临时 / 文档文件'));
bodyC.push(callout([[{ t: '⚠️ 不要手动整个目录拷贝分发', b: true }, { t: '，否则会带上 ' }, { t: 'settings.json', c: true }, { t: '，导致对方机器显示你的 UM 号、用你的 token。务必用 ' }, { t: 'pack.cmd', c: true }, { t: '。' }]], 'warn'));

// 二、启动
bodyC.push(h1('二、启动（运行工具）'));
bodyC.push(callout([[{ t: '前提：', b: true }, { t: '机器已安装 ' }, { t: 'Node.js', b: true }, { t: '（命令行执行 ' }, { t: 'node -v', c: true }, { t: ' 能看到版本即可）。' }]], 'note'));
bodyC.push(...figure(IMG.startup, '三种启动方式：按操作系统选择'));

bodyC.push(h2('方式 A：双击 start.cmd（推荐，最简单）'));
bodyC.push(bullet('自动设置端口并启动，弹出黑色命令行窗口'));
bodyC.push(bullet('启动成功后会显示彩色提示和访问地址'));
bodyC.push(bullet([{ t: '改端口：', b: true }, { t: '用记事本打开 ' }, { t: 'start.cmd', c: true }, { t: '，改顶部两行 ' }, { t: 'set PROXY_PORT=', c: true }, { t: ' / ' }, { t: 'set UI_PORT=', c: true }, { t: ' 即可' }]));

bodyC.push(h2('方式 B：命令行'));
bodyC.push(code(['cd proxy-inspector', 'npm install   :: 仅第一次需要（离线包已自带依赖，可跳过）', 'npm start']));

bodyC.push(h2('方式 C：麒麟 / 信创 Linux（终端运行）'));
bodyC.push(callout([
  [{ t: '麒麟等信创系统的文件管理器', b: true }, { t: '双击 ' }, { t: '.sh', c: true }, { t: ' 默认不会执行', b: true }, { t: '（安全策略），必须在' }, { t: '终端', b: true }, { t: '里运行。' }],
  [{ t: '前提：已安装' }, { t: '与本机 CPU 架构匹配', b: true }, { t: '的 Node.js（鲲鹏 / 飞腾为 ' }, { t: 'aarch64', c: true }, { t: '、兆芯 / 海光为 ' }, { t: 'x86_64', c: true }, { t: '；终端执行 ' }, { t: 'node -v', c: true }, { t: ' 能看到版本即可）。' }],
], 'warn'));
bodyC.push(spacer());
bodyC.push(...figure(IMG.kylin, '麒麟 / 信创：终端启动四步'));
bodyC.push(num([{ t: '打开' }, { t: '终端', b: true }, { t: '，' }, { t: 'cd', c: true }, { t: ' 到解压后的目录：' }], 'kylin'));
bodyC.push(code(['cd ~/下载/proxy-inspector      # 换成你实际的解压路径']));
bodyC.push(num([{ t: '首次', b: true }, { t: '赋予执行权限（只需一次）：' }], 'kylin'));
bodyC.push(code(['chmod +x start.sh']));
bodyC.push(num('启动：', 'kylin'));
bodyC.push(code(['bash start.sh', '# 或改端口：PROXY_PORT=28899 UI_PORT=28900 bash start.sh']));
bodyC.push(num([{ t: '保持这个终端窗口开着', b: true }, { t: '即为运行中；退出按 ' }, { t: 'Ctrl+C', b: true }, { t: '（会先持久化上送队列再退出）。' }], 'kylin'));
bodyC.push(callout([[{ t: '若 ' }, { t: 'bash start.sh', c: true }, { t: ' 报 ' }, { t: "$'\\r': command not found", c: true }, { t: ' 之类错误，是脚本被 Windows 改成了 CRLF 换行，执行一次转换即可：' }, { t: "sed -i 's/\\r$//' start.sh", c: true }, { t: '。' }]], 'note'));
bodyC.push(...figure(IMG.phKylinTerm, '麒麟 / 信创终端 bash start.sh 启动成功画面（请替换为实际截图）'));

bodyC.push(P([{ t: '启动后：', b: true }], { before: 120 }));
bodyC.push(bullet([{ t: '代理端口 28899', b: true }, { t: ' ← 把浏览器 / 系统 / IDE 的代理设为 ' }, { t: '127.0.0.1:28899', c: true }]));
bodyC.push(bullet([{ t: '界面 28900', b: true }, { t: ' ← 浏览器打开 ' }, { t: 'http://127.0.0.1:28900', c: true }]));

bodyC.push(h2('端口被占用怎么办'));
bodyC.push(P([{ t: '启动时若端口被占用，命令行会提示占用进程的 ' }, { t: 'PID 和名称', b: true }, { t: '，并询问：' }]));
bodyC.push(code(['是否结束该进程 (PID xxxx) 并继续启动？ [y/N]']));
bodyC.push(P([{ t: '输入 ' }, { t: 'y', c: true }, { t: ' 回车即结束占用进程并继续启动；输入 ' }, { t: 'n', c: true }, { t: ' 取消。（也可改 ' }, { t: 'start.cmd', c: true }, { t: ' 顶部端口避开冲突。）' }]));

// 三、证书
bodyC.push(h1('三、HTTPS 抓包：安装根证书'));
bodyC.push(P('抓 HTTPS 必须信任根证书，否则浏览器 / IDE 报「不安全」。'));
bodyC.push(...figure(IMG.cert, '同一台机器：装不装根证书的两种结果'));
bodyC.push(num([{ t: '打开界面 ' }, { t: 'http://127.0.0.1:28900', c: true }, { t: '，先访问一次任意 HTTPS 网站（让证书生成）' }], 'cert'));
bodyC.push(num([{ t: '点界面顶部横幅或右上角 ' }, { t: '「⬇ 下载根证书」', b: true }, { t: '（Windows 用 ' }, { t: '.cer', c: true }, { t: '）' }], 'cert'));
bodyC.push(num([{ t: '双击 ' }, { t: '.cer', c: true }, { t: ' → 安装证书 → ' }, { t: '本地计算机', b: true }, { t: ' → 「将所有证书放入下列存储」→ 选 ' }, { t: '「受信任的根证书颁发机构」', b: true }, { t: ' → 完成' }], 'cert'));
bodyC.push(num([{ t: '重启浏览器 / IDE', b: true }], 'cert'));
bodyC.push(...figure(IMG.phDownloadCert, '界面「⬇ 下载根证书」按钮位置（请替换为实际截图）'));
bodyC.push(...figure(IMG.certStore, 'Windows 证书导入向导：选「受信任的根证书颁发机构」'));
bodyC.push(...figure(IMG.phCertWizard, 'Windows 证书导入向导实际界面（请替换为实际截图）'));
bodyC.push(callout([[{ t: 'Windows 不认 ' }, { t: '.pem', c: true }, { t: ' 双击安装，务必用 ' }, { t: '.cer', c: true }, { t: '。' }]], 'note'));

bodyC.push(h2('麒麟 / 信创 Linux 安装证书'));
bodyC.push(P([{ t: '改点 ' }, { t: '「⬇ 下载根证书」', b: true }, { t: ' 里的 ' }, { t: '.pem', c: true }, { t: '，然后二选一——' }]));
bodyC.push(bullet([{ t: '导入浏览器', b: true }, { t: '（推荐，最省事）：麒麟自带浏览器 / 火狐 → 设置 → 隐私与安全 → 证书 → 「查看证书」→ 「证书颁发机构」标签 → ' }, { t: '导入', b: true }, { t: ' ' }, { t: 'ca.pem', c: true }, { t: ' → 勾选「信任由此证书颁发机构来标识网站」→ 确定，重启浏览器。' }]));
bodyC.push(bullet([{ t: '导入系统信任库', b: true }, { t: '（需管理员）：' }]));
bodyC.push(code(['sudo cp ca.pem /usr/local/share/ca-certificates/proxy-inspector.crt', 'sudo update-ca-certificates']));
bodyC.push(P([{ t: '（银河麒麟 V10 适用；部分信创发行版命令略有差异）。', color: COLORS.grey }]));

// 四、上送
bodyC.push(h1('四、配置上送（埋点平台）'));
bodyC.push(num([{ t: '界面右侧点 ' }, { t: '「上送设置」', b: true }, { t: ' 标签' }], 'report'));
bodyC.push(num([{ t: '上送格式', b: true }, { t: ' 选 ' }, { t: 'behavior', c: true }, { t: '（映射为埋点 saveRecord 接口）' }], 'report'));
bodyC.push(num([{ t: '填 ' }, { t: '埋点平台 BaseURL（含 /api）', b: true }, { t: '（如 ' }, { t: 'http://appdes.fat.qa.pab.com.cn/api', c: true }, { t: '）' }], 'report'));
bodyC.push(num([{ t: '填 ' }, { t: 'apiToken', b: true }, { t: '（向埋点工具组申请）' }], 'report'));
bodyC.push(num([{ t: 'URL 过滤白名单', b: true }, { t: ' 填 ' }, { t: '*/completions*', c: true }, { t: '（只上送 AI 补全 / 对话接口）' }], 'report'));
bodyC.push(num([{ t: '点 ' }, { t: '保存设置', b: true }], 'report'));
bodyC.push(num([{ t: '用' }, { t: '右上角「上送 开 / 关」', b: true }, { t: '开关一键开启上送（或在本页开关）' }], 'report'));
bodyC.push(...figure(IMG.phReport, '「上送设置」标签页（请替换为实际截图）'));
bodyC.push(P([{ t: '实际上送地址 = BaseURL + ' }, { t: '/userBehavior/saveRecord', c: true }, { t: '，鉴权头 ' }, { t: 'apiToken', c: true }, { t: '。' }]));
bodyC.push(callout([[{ t: '注意：', b: true }, { t: '/api', c: true }, { t: '（各环境网关前缀）写在 BaseURL 里，如 ' }, { t: 'http://xxx.com.cn/api', c: true }, { t: ' → 实际打到 ' }, { t: 'http://xxx.com.cn/api/userBehavior/saveRecord', c: true }, { t: '。' }]], 'note'));

bodyC.push(h2('上送超时（仅管理员）'));
bodyC.push(P([{ t: '「上送设置」底部 ' }, { t: '「上送超时（毫秒）」', b: true }, { t: '：单次上送等待后端响应的最长时间，默认 ' }, { t: '15000', b: true }, { t: '，范围 1000~120000。' }]));
bodyC.push(bullet([{ t: '务必大于上送后端的最坏响应时间。', b: true }, { t: '若设得太小，后端「慢成功」时客户端会先超时、误判失败而' }, { t: '重发，造成重复上送', b: true }, { t: '。' }]));
bodyC.push(bullet([{ t: '和其它上送设置一样，' }, { t: '仅管理员', b: true }, { t: '可改（非管理员保存会被拒）。' }]));

bodyC.push(h2('UM 号（= createdBy，统计个人代码生成率）'));
bodyC.push(bullet([{ t: '右上角 ' }, { t: '「UM xxx」', b: true }, { t: ' 自动取当前机器系统用户名' }]));
bodyC.push(bullet('不对就点一下手动改，改后会记住（每台机器各自独立）'));

// 五、日常使用
bodyC.push(h1('五、日常使用'));
bodyC.push(...figure(IMG.phMain, '管理界面主界面（请替换为实际截图）'));
bodyC.push(dataTable(
  ['功能', '位置', '说明'],
  [
    ['看流量', '左侧列表', [[{ t: '实时显示抓到的请求，可按 URL / 方法 / 状态 / ' }, { t: '类型', b: true }, { t: ' 筛选' }]]],
    ['看报文详情', '点左侧某条', [[{ t: '请求 / 响应头、Body，' }, { t: '可一键复制', b: true }]]],
    [[[{ t: 'SSE 解析', b: true }]], '响应 Body 区「⊞ SSE 格式解析」', '流式响应解析出正文 / 思考链 / tokens'],
    ['配字段映射', '「字段映射」标签', '两个上送接口分开配，字段来自接口文档'],
    ['看上送队列', '「上送队列」标签', '待送 / 失败统计，点条目预览上送报文'],
    [[[{ t: '补送漏送的', b: true }]], '「上送队列」→「补送历史报文」', '上送开晚了？勾选历史报文批量 / 单条补送'],
    ['加规则', '「规则管理」标签', 'mock / 改头 / 拦截（与上送独立，按需用）'],
  ],
  [1500, 3200, 4660],
));
bodyC.push(spacer());
bodyC.push(...figure(IMG.phMapping, '「字段映射」标签页（请替换为实际截图）'));
bodyC.push(...figure(IMG.phQueue, '「上送队列」→「补送历史报文」（请替换为实际截图）'));

bodyC.push(h2('上送失败重试'));
bodyC.push(P([{ t: '失败自动重试最多 ' }, { t: '5 次', b: true }, { t: '，达上限转「失败」终态、停止自动重试。需要时在「上送队列」点 ' }, { t: '「重试失败项」', b: true }, { t: ' 手动重试。' }]));
bodyC.push(callout([[{ t: '注：', b: true }, { t: '自动重试是「至少一次」投递——若后端其实已成功、只是回包慢 / 丢了，重试会让后端' }, { t: '重复收到', b: true }, { t: '同一条。后端（中转服务）按 ' }, { t: 'requestId', c: true }, { t: ' 做了接收端幂等去重，重复不产生脏数据；想从源头少重发，把上面的「上送超时」调到大于后端最坏响应时间即可。' }]], 'note'));

bodyC.push(h2('退出'));
bodyC.push(P([{ t: '命令行窗口按 ' }, { t: 'Ctrl+C', b: true }, { t: '，会先持久化未完成的上送队列再退出（不丢数据）。重启后自动恢复继续送。' }]));

// 六、常见问题
bodyC.push(h1('六、常见问题'));
const faqs = [
  ['换了机器，UM 号显示的还是别人的名字？', [[{ t: '你可能手动整目录拷贝带上了 ' }, { t: 'settings.json', c: true }, { t: '。删掉它重启即按本机重新探测；或点右上角 UM 手动改。今后用 ' }, { t: 'pack.cmd', c: true }, { t: ' 打包可避免。' }]]],
  ['代码补全（行内 ghost text）开了代理就不回写？', [[{ t: '补全是延迟敏感接口。工具已对 ' }, { t: '*/completions*', c: true }, { t: ' 启用「低延迟直通」（不强制 gzip、关 Nagle、强制连接关闭）尽量保通。可在「上送设置」底部「低延迟直通 URL」调整。若仍不行，是 IDE 与 MITM 代理的兼容问题——' }, { t: '注意：统计数据采集不受影响', b: true }, { t: '（报文照样抓到、照样上送）。' }]]],
  ['有些接口漏上送了？', [[{ t: '「上送队列」→「补送历史报文」，勾选补送。前提是抓包列表里还在（默认保留最近 500 条）。' }]]],
  ['上送的 result 是 SSE 原文还是解析后的？', [[{ t: '解析后的纯文本。' }, { t: 'result', c: true }, { t: ' / ' }, { t: 'acceptResult', c: true }, { t: ' 用 ' }, { t: 'sseContent', c: true }, { t: ' 自动拼接流式内容、剥离 ' }, { t: 'data:', c: true }, { t: ' / ' }, { t: '[DONE]', c: true }, { t: ' / 思考链。' }]]],
];
faqs.forEach(([q, a]) => {
  bodyC.push(P([{ t: 'Q：', b: true, color: COLORS.h2 }, { t: q, b: true }], { before: 100, after: 40 }));
  a.forEach((line) => bodyC.push(P([{ t: 'A：', b: true, color: '188038' }, ...line])));
});

// 七、目录说明
bodyC.push(h1('七、目录说明'));
bodyC.push(code([
  'proxy-inspector/',
  '├── start.cmd          # Windows 启动（改端口在这）',
  '├── start.sh           # Linux/麒麟 启动（终端 bash start.sh）',
  '├── pack.cmd           # 打包分发',
  '├── src/               # 后端代码',
  '├── web/               # 界面',
  '├── mapping-presets/   # 字段映射预设',
  '├── patches/           # 证书有效期补丁（勿删）',
  '├── certs/             # 自动生成的本机证书（勿分发）',
  '├── settings.json      # 个人配置（勿分发）',
  '└── reporter-queue.json# 上送队列（自动持久化）',
]));

// ---------- 组装 ----------
const doc = new Document({
  creator: 'Proxy Inspector', title: 'Proxy Inspector 使用手册',
  styles: {
    default: { document: { run: { font: YAHEI, size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 32, bold: true, font: YAHEI, color: COLORS.h1 },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.noteBar, space: 4 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font: YAHEI, color: COLORS.h2 },
        paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 23, bold: true, font: YAHEI },
        paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 260 } } } }] },
      ...['pack', 'kylin', 'cert', 'report', 'steps'].map((ref) => ({
        reference: ref,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 260 } } } }],
      })),
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Proxy Inspector 使用手册', font: YAHEI, size: 16, color: '999999' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '第 ', font: YAHEI, size: 16, color: '999999' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '999999' }), new TextRun({ text: ' 页', font: YAHEI, size: 16, color: '999999' })] })] }) },
    children: bodyC,
  }],
});

const out = path.join(__dirname, '..', 'docs', '使用手册.docx');
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log('written:', out, buf.length, 'bytes'); });
