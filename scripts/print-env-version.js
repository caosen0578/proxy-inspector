// 从 env/settings-<env>.json 的 appVersion 里提取版本号，输出形如 "-v1.0.0"（带前导连字符，供 zip 文件名直接拼接）。
// 提取不到则输出空串（zip 名不拼版本，不出现多余连字符）。给 dist-release.cmd 用：
//   for /f "delims=" %%v in ('node scripts\print-env-version.js "%ENVFILE%"') do set VER=%%v
// appVersion 形如 "版本号：fat（生产环境）-v1.0.0" → 取其中的点分版本段（可带 v 前缀）。
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const m = String(s.appVersion || '').match(/v?\d+(?:\.\d+)+/i);
  process.stdout.write(m ? '-' + m[0].replace(/\s+/g, '') : '');
} catch {
  process.stdout.write('');
}
