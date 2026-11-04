/**
 * 发版时跑一次：node scripts/bump-version.mjs
 *
 * 干三件事：
 *   1. 把 package.json 的版本写进 manifest.json 的 js 字段（?ver=），
 *      让 ST 加载扩展时 URL 变化，浏览器不得不重新拉取入口文件；
 *   2. 生成 core/version.js，供运行时拼静态资源地址；
 *   3. 给所有相对 import 加上 ?v=版本号——这一步是关键。
 *      入口文件带版本号只解决 index.js 本身，它 import 的 core/*.js、ui/*.js
 *      如果 URL 不变，浏览器仍然吃旧缓存，界面就会「明明更新了却没变」。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = String(pkg.version || '0.0.0').trim();

/* 1. manifest */
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.js = `index.js?ver=${ver}`;
manifest.version = ver;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

/* 2. version.js */
fs.writeFileSync(
  path.join(ROOT, 'core', 'version.js'),
  `/** 由 scripts/bump-version.mjs 自动生成，不要手改。 */\nexport const VERSION = '${ver}';\n`,
  'utf8',
);

/* 3. 所有相对 import 加 ?v= */
const TARGETS = [
  'index.js',
  ...fs.readdirSync(path.join(ROOT, 'core')).filter((f) => f.endsWith('.js')).map((f) => 'core/' + f),
  ...fs.readdirSync(path.join(ROOT, 'ui')).filter((f) => f.endsWith('.js')).map((f) => 'ui/' + f),
];

const IMPORT_RE = /(\bfrom\s+['"])(\.{1,2}\/[^'"?]+\.js)(\?[^'"]*)?(['"])/g;

let touched = 0;
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(IMPORT_RE, (_m, p1, p2, _q, p4) => `${p1}${p2}?v=${ver}${p4}`);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    touched++;
  }
}

console.log(`版本 ${ver}`);
console.log(`  manifest.js → index.js?ver=${ver}`);
console.log(`  core/version.js 已生成`);
console.log(`  ${touched} 个文件的 import 已加版本参数`);
