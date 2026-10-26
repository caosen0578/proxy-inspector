// 把 manual-diagrams.js 里的 SVG 示意图 / 截图占位框渲染为 PNG，输出到 docs/manual-img/。
// 仅当示意图有改动时才需要重跑；日常重建 Word 用 build-manual-docx.js 直接读这些 PNG 即可。
// 运行：cd scripts && npm i @resvg/resvg-js && node render-diagrams.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const D = require('./manual-diagrams.js');

const OUT = path.join(__dirname, '..', 'docs', 'manual-img');
fs.mkdirSync(OUT, { recursive: true });
const FONT = { font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } };

function render(name, svg) {
  const w = parseInt(svg.match(/width="(\d+)"/)[1], 10);
  const buf = new Resvg(svg, { ...FONT, fitTo: { mode: 'width', value: w * 2 } }).render().asPng();
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  console.log('  ', name + '.png', buf.length, 'bytes');
}

console.log('rendering diagrams →', OUT);
// 示意图
render('overview', D.overview);
render('startup', D.startup);
render('kylin-steps', D.kylinSteps);
render('cert-trust', D.cert);
render('cert-store', D.certStore);
// 截图占位框（用户后续替换为真实截图）
render('ph-main', D.placeholder('管理界面主界面：左侧实时流量列表 + 顶部「⬇ 下载根证书」'));
render('ph-download-cert', D.placeholder('顶部横幅 / 右上角「⬇ 下载根证书」按钮位置（Windows 选 .cer）'));
render('ph-cert-wizard', D.placeholder('Windows 证书导入向导：勾选「受信任的根证书颁发机构」这一步'));
render('ph-kylin-terminal', D.placeholder('麒麟 / 信创：终端执行 bash start.sh 启动成功画面'));
render('ph-report-settings', D.placeholder('「上送设置」标签页：格式 / BaseURL / apiToken / 白名单'));
render('ph-field-mapping', D.placeholder('「字段映射」标签页：两个上送接口分开配'));
render('ph-report-queue', D.placeholder('「上送队列」→「补送历史报文」：勾选批量 / 单条补送'));
console.log('done.');
