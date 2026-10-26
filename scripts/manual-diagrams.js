// SVG 示意图定义（中文用 Microsoft YaHei 渲染）
const C = {
  boxFill: '#E8F0FE', boxStroke: '#4A90D9',
  altFill: '#FEF7E0', altStroke: '#F9AB00',
  okFill: '#E6F4EA', okStroke: '#188038', ok: '#188038',
  badFill: '#FCE8E6', badStroke: '#D93025', bad: '#D93025',
  greyFill: '#F1F3F4', greyStroke: '#BDC1C6',
  text: '#202124', sub: '#5F6368', arrow: '#5F6368', accent: '#1A73E8',
};

// 通用：一个圆角框，lines 为多行文字（第一行标题加粗）
function box(x, y, w, h, lines, o = {}) {
  const fill = o.fill || C.boxFill, stroke = o.stroke || C.boxStroke;
  const cx = x + w / 2;
  const n = lines.length;
  const lh = o.lh || 20;
  const startY = y + h / 2 - ((n - 1) * lh) / 2 + 6;
  let t = '';
  lines.forEach((ln, i) => {
    const bold = i === 0 ? 'font-weight="700"' : '';
    const size = i === 0 ? (o.titleSize || 15) : (o.subSize || 13);
    const col = i === 0 ? (o.titleColor || C.text) : (o.subColor || C.sub);
    t += `<text x="${cx}" y="${startY + i * lh}" font-family="Microsoft YaHei" font-size="${size}" ${bold} fill="${col}" text-anchor="middle">${ln}</text>`;
  });
  const dash = o.dash ? 'stroke-dasharray="6 4"' : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.6" ${dash}/>${t}`;
}

function arrow(x1, y1, x2, y2, label, o = {}) {
  const col = o.color || C.arrow;
  const mid = `<text x="${(x1 + x2) / 2 + (o.ldx || 0)}" y="${(y1 + y2) / 2 + (o.ldy || -6)}" font-family="Microsoft YaHei" font-size="12" fill="${o.labelColor || C.accent}" text-anchor="middle">${label || ''}</text>`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2" marker-end="url(#ah)" ${o.dash ? 'stroke-dasharray="6 4"' : ''}/>${label ? mid : ''}`;
}

function wrap(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.arrow}"/></marker></defs>
  <rect width="${w}" height="${h}" fill="#FFFFFF"/>${body}</svg>`;
}

// 图1：工作原理总览 / 数据流
const overview = wrap(640, 412, [
  // 顶部横向：客户端 → 代理 → AI 接口
  box(20, 30, 180, 66, ['客户端', '浏览器 / IDE / 系统', '代理指向 127.0.0.1:28899']),
  arrow(200, 63, 250, 63, '经代理'),
  box(250, 30, 150, 66, ['Proxy Inspector', '代理抓包 · 端口 28899']),
  arrow(400, 63, 452, 63, '转发'),
  box(452, 30, 168, 66, ['AI 接口', '*/completions', '（真实目标服务）']),
  // 中间竖向数据流（居中堆叠）
  arrow(325, 96, 325, 140, '抓到报文', { ldx: 48, ldy: -2 }),
  box(195, 140, 260, 58, ['解析 + 字段映射', 'SSE 解析 → saveRecord 字段']),
  arrow(325, 198, 325, 234, ''),
  box(195, 234, 260, 58, ['上送队列', '失败自动重试（至多 5 次）']),
  arrow(325, 292, 325, 328, 'apiToken', { ldx: 40, ldy: 4 }),
  box(195, 328, 260, 64, ['埋点平台', 'BaseURL/api/userBehavior/saveRecord'], { fill: C.okFill, stroke: C.okStroke, subSize: 12.5 }),
  // 管理界面（左侧，指向数据流）
  box(20, 140, 150, 58, ['管理界面', 'http://127.0.0.1:28900'], { fill: C.greyFill, stroke: C.greyStroke, subSize: 12 }),
  arrow(170, 169, 193, 169, '', { dash: true }),
  `<text x="95" y="222" font-family="Microsoft YaHei" font-size="11" fill="${C.sub}" text-anchor="middle">浏览器打开 · 查看流量 / 配置</text>`,
]);

// 图2：启动方式选择（按系统）
const startup = wrap(640, 300, [
  box(240, 20, 160, 46, ['解压后的目录'], { titleSize: 15 }),
  arrow(320, 66, 120, 104, ''),
  arrow(320, 66, 320, 104, ''),
  arrow(320, 66, 520, 104, ''),
  box(30, 104, 180, 54, ['Windows', '双击 start.cmd（推荐）'], { titleColor: C.accent }),
  box(230, 104, 180, 54, ['Windows 命令行', 'npm start'], { titleColor: C.accent }),
  box(430, 104, 180, 54, ['麒麟 / 信创 Linux', '不能双击 .sh'], { fill: C.altFill, stroke: C.altStroke, titleColor: '#B06000' }),
  arrow(520, 158, 520, 196, ''),
  box(400, 196, 220, 84, [
    '必须在「终端」运行',
    '① chmod +x start.sh（首次）',
    '② bash start.sh',
    '③ 保持终端 · Ctrl+C 退出',
  ], { fill: C.altFill, stroke: C.altStroke, titleColor: '#B06000', lh: 19, titleSize: 14, subSize: 12.5 }),
]);

// 图3：麒麟终端启动步骤条
const kylinSteps = wrap(640, 130, [
  box(15, 35, 140, 60, ['① 打开终端', 'cd 到解压目录'], { titleSize: 14 }),
  arrow(155, 65, 178, 65, ''),
  box(178, 35, 140, 60, ['② 赋权（首次）', 'chmod +x start.sh'], { titleSize: 14 }),
  arrow(318, 65, 341, 65, ''),
  box(341, 35, 140, 60, ['③ 启动', 'bash start.sh'], { titleSize: 14, fill: C.okFill, stroke: C.okStroke }),
  arrow(481, 65, 504, 65, ''),
  box(504, 35, 122, 60, ['④ 运行中', '保持终端窗口'], { titleSize: 14 }),
  `<text x="320" y="118" font-family="Microsoft YaHei" font-size="12" fill="${C.sub}" text-anchor="middle">报 $'\\r' 错误：执行 sed -i 's/\\r$//' start.sh 转换换行后重试</text>`,
]);

// 图4：证书信任对比
const cert = wrap(640, 240, [
  box(20, 30, 170, 60, ['浏览器 / IDE'], { titleSize: 15 }),
  // 未装
  arrow(190, 55, 250, 55, 'HTTPS'),
  box(250, 25, 150, 60, ['未安装根证书'], { fill: C.badFill, stroke: C.badStroke, titleColor: C.bad }),
  arrow(400, 55, 458, 55, ''),
  box(458, 25, 165, 60, ['✗ 提示「不安全」', '抓不到 HTTPS'], { fill: C.badFill, stroke: C.badStroke, titleColor: C.bad, subColor: C.bad }),
  // 已装
  arrow(190, 165, 250, 165, 'HTTPS'),
  box(250, 135, 150, 60, ['安装根证书到', '受信任的根颁发机构'], { fill: C.okFill, stroke: C.okStroke, titleColor: C.ok, titleSize: 13.5 }),
  arrow(400, 165, 458, 165, ''),
  box(458, 135, 165, 60, ['✓ 正常握手', '成功抓包并上送'], { fill: C.okFill, stroke: C.okStroke, titleColor: C.ok, subColor: C.ok }),
  `<text x="105" y="112" font-family="Microsoft YaHei" font-size="12" fill="${C.sub}" text-anchor="middle">同一台机器 · 两种状态对比 ↓</text>`,
]);

// 图5：Windows 证书存储选择示意（简化向导）
const certStore = wrap(640, 250, [
  `<rect x="60" y="20" width="520" height="210" rx="8" fill="#FBFBFB" stroke="${C.greyStroke}"/>`,
  `<text x="80" y="52" font-family="Microsoft YaHei" font-size="15" font-weight="700" fill="${C.text}">证书导入向导（双击 .cer 后）</text>`,
  // 步骤1 本地计算机
  `<circle cx="92" cy="86" r="9" fill="${C.accent}"/><text x="92" y="91" font-family="Microsoft YaHei" font-size="12" fill="#fff" text-anchor="middle">1</text>`,
  `<text x="112" y="91" font-family="Microsoft YaHei" font-size="13.5" fill="${C.text}">存储位置选择「本地计算机」</text>`,
  // 步骤2
  `<circle cx="92" cy="120" r="9" fill="${C.accent}"/><text x="92" y="125" font-family="Microsoft YaHei" font-size="12" fill="#fff" text-anchor="middle">2</text>`,
  `<text x="112" y="125" font-family="Microsoft YaHei" font-size="13.5" fill="${C.text}">选「将所有证书放入下列存储」</text>`,
  // 步骤3 高亮选项
  `<circle cx="92" cy="154" r="9" fill="${C.accent}"/><text x="92" y="159" font-family="Microsoft YaHei" font-size="12" fill="#fff" text-anchor="middle">3</text>`,
  box(112, 138, 320, 34, ['受信任的根证书颁发机构'], { fill: C.okFill, stroke: C.okStroke, titleColor: C.ok, titleSize: 14 }),
  `<text x="446" y="159" font-family="Microsoft YaHei" font-size="13" fill="${C.ok}">← 选这个</text>`,
  // 提示
  `<text x="80" y="205" font-family="Microsoft YaHei" font-size="12.5" fill="${C.bad}">注意：Windows 用 .cer（不认 .pem 双击）；装完重启浏览器/IDE。麒麟用 .pem。</text>`,
]);

// 截图占位框
function placeholder(caption, w = 600, h = 200) {
  const body = `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="10" fill="${C.greyFill}" stroke="${C.greyStroke}" stroke-width="2" stroke-dasharray="10 6"/>` +
    // 简易相机图标
    `<rect x="${w / 2 - 34}" y="${h / 2 - 34}" width="68" height="50" rx="8" fill="none" stroke="${C.sub}" stroke-width="2.5"/>` +
    `<rect x="${w / 2 - 12}" y="${h / 2 - 42}" width="24" height="12" rx="3" fill="none" stroke="${C.sub}" stroke-width="2.5"/>` +
    `<circle cx="${w / 2}" cy="${h / 2 - 6}" r="13" fill="none" stroke="${C.sub}" stroke-width="2.5"/>` +
    `<text x="${w / 2}" y="${h / 2 + 44}" font-family="Microsoft YaHei" font-size="14" font-weight="700" fill="${C.sub}" text-anchor="middle">截图占位（请替换为实际截图）</text>` +
    `<text x="${w / 2}" y="${h / 2 + 66}" font-family="Microsoft YaHei" font-size="13" fill="${C.accent}" text-anchor="middle">${caption}</text>`;
  return wrap(w, h, body);
}

module.exports = { overview, startup, kylinSteps, cert, certStore, placeholder };
