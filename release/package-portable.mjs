/**
 * package-portable.mjs — 构建 Memory Atlas Windows Portable 发行目录 + ZIP。
 *
 *   node release/package-portable.mjs
 *
 * 产物：
 *   release/out/MemoryAtlas-v<version>-win-x64/   解压即用的目录（可再压缩分发）
 *   release/dist/MemoryAtlas-v<version>-win-x64.zip
 *
 * 布局（打包进 resources/app 的 staging）：
 *   <app>/main.mjs …              桌面壳（Electron 主进程 + renderer + locales）
 *   <app>/glm-retrieval/          随包检索引擎（与源码 provenance 一致）
 *   <app>/atlas/{bin,src,adapters,package.json}
 *                                 Atlas 服务端（正式存储 + 检索工厂）
 *   <app>/runtime/node.exe        官方 Node 24 运行时（目标机器无需安装 Node）
 *   <app>/mcp/atlas-mcp.mjs       统一 MCP server 单文件 bundle
 *
 * 数据独立存储：数据目录默认在 %APPDATA%（绝不写入解压目录）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0-alpha.1';
const APP_NAME = 'MemoryAtlas';
const OUT_DIR = path.join(HERE, 'out');
const STAGING = path.join(HERE, 'staging', 'app');
const DIST = path.join(HERE, 'dist');
const FINAL_NAME = `${APP_NAME}-v${VERSION}-win-x64`;

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log(`[1/6] staging app -> ${STAGING}`);
rmrf(STAGING);
fs.mkdirSync(STAGING, { recursive: true });

// 桌面壳（不含 node_modules / package-lock / 探针脚本）
const desktopSrc = path.join(ROOT, 'desktop');
for (const entry of fs.readdirSync(desktopSrc, { withFileTypes: true })) {
  if (entry.name === 'node_modules' || entry.name === 'package-lock.json' || entry.name === 'docs') continue;
  copy(path.join(desktopSrc, entry.name), path.join(STAGING, entry.name));
}
// 发行包不携带未接线的 WhiteMoon 同步辅助（integrations/ 无运行时引用，且含开发机路径）
rmrf(path.join(STAGING, 'glm-retrieval', 'src', 'integrations'));

// Atlas 服务端
for (const part of ['bin', 'src', 'adapters', 'package.json']) {
  copy(path.join(ROOT, part), path.join(STAGING, 'atlas', part));
}

// Activation 运行时闭包：desktop/event-ledger.mjs 与 activation-explain.mjs
// 以相对路径 import experiments/activation-01..04 的 src 模块（必须在包内保持
// 相同相对布局）。fixtures / 实验结果 / 用户数据不入包。
for (const mod of ['activation-01', 'activation-02', 'activation-03', 'activation-04']) {
  const src = path.join(ROOT, 'experiments', mod, 'src');
  if (!fs.existsSync(src)) throw new Error(`experiments/${mod}/src 缺失，拒绝打包（Activation 运行时依赖）`);
  copy(src, path.join(STAGING, 'atlas', 'experiments', mod, 'src'));
}

// 检索引擎依赖清单自检（桌面端引用的 GLM 适配器必须随包）
const glmSrc = path.join(desktopSrc, 'glm-retrieval');
for (const needed of ['src/adapter.mjs', 'src/store.mjs', 'src/tokenize.mjs', 'src/association.mjs', 'src/graph.mjs', 'package.json']) {
  if (!fs.existsSync(path.join(glmSrc, needed))) throw new Error(`glm-retrieval 缺少 ${needed}，拒绝打包`);
}

// 版本号落到随包 package.json
const stagedPkg = JSON.parse(fs.readFileSync(path.join(STAGING, 'package.json'), 'utf8'));
stagedPkg.version = VERSION;
fs.writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');

// 捆绑 Node 运行时（官方 zip 解包出 node.exe）
console.log('[2/6] bundling Node runtime');
const nodeZip = path.join(HERE, 'vendor', 'node-v24.22.2-win-x64.zip');
if (!fs.existsSync(nodeZip)) throw new Error('vendor/node-v24.22.2-win-x64.zip 缺失：先下载官方 Node 24 win-x64 运行时');
const nodeStage = path.join(HERE, 'staging', 'node-extract');
rmrf(nodeStage);
fs.mkdirSync(nodeStage, { recursive: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath "${nodeZip}" -DestinationPath "${nodeStage}" -Force`], { stdio: 'inherit' });
const extractedRoot = fs.readdirSync(nodeStage)[0];
copy(path.join(nodeStage, extractedRoot, 'node.exe'), path.join(STAGING, 'runtime', 'node.exe'));
for (const lic of ['LICENSE', 'README.md']) {
  const p = path.join(nodeStage, extractedRoot, lic);
  if (fs.existsSync(p)) copy(p, path.join(STAGING, 'runtime', `node-${lic}`));
}

// MCP server bundle
console.log('[3/6] bundling MCP server');
execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(ROOT, 'packages', 'memory-atlas-mcp'), stdio: 'inherit' });
copy(path.join(ROOT, 'packages', 'memory-atlas-mcp', 'dist', 'atlas-mcp.mjs'), path.join(STAGING, 'mcp', 'atlas-mcp.mjs'));

console.log('[4/6] electron-packager');
const { packager } = require('@electron/packager');
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopSrc, 'package.json'), 'utf8'));
const outs = await packager({
  dir: STAGING,
  out: OUT_DIR,
  name: APP_NAME,
  appVersion: VERSION,
  appCopyright: 'Memory Atlas contributors',
  platform: 'win32',
  arch: 'x64',
  electronVersion: desktopPkg.devDependencies.electron.replace(/^\^/, ''),
  overwrite: true,
  asar: false,
  prune: false,
  executableName: APP_NAME,
  win32metadata: {
    FileDescription: 'Memory Atlas — 本地记忆服务与工作台',
    ProductName: 'Memory Atlas'
  }
});
const packagedDirRaw = outs[0];
const packagedDir = path.join(OUT_DIR, FINAL_NAME);
if (path.resolve(packagedDirRaw) !== path.resolve(packagedDir)) {
  rmrf(packagedDir);
  fs.renameSync(packagedDirRaw, packagedDir);
}
console.log(`      packaged -> ${packagedDir}`);

// 发行级顶层文档（README、MCP 接入指南、验证说明来自 release/docs；
// 许可与第三方材料来自仓库根）
console.log('[5/6] top-level release docs');
for (const doc of ['README-RELEASE.md', 'MCP-GUIDE.md', 'VERIFY.md']) {
  const src = path.join(HERE, 'docs', doc);
  if (fs.existsSync(src)) copy(src, path.join(packagedDir, doc));
}
for (const doc of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'FFMPEG-LGPL-SOURCE.md', 'CHANGELOG.md']) {
  const src = path.join(ROOT, doc);
  if (!fs.existsSync(src)) throw new Error(`发行材料缺失：${doc}（拒绝打不完整的包）`);
  copy(src, path.join(packagedDir, doc));
}
if (!fs.existsSync(path.join(ROOT, 'licenses', 'README.md'))) throw new Error('licenses/ 目录缺失（第三方许可全文）');
copy(path.join(ROOT, 'licenses'), path.join(packagedDir, 'licenses'));
for (const example of fs.readdirSync(path.join(HERE, 'examples'))) {
  copy(path.join(HERE, 'examples', example), path.join(packagedDir, 'mcp', 'examples', example));
}

console.log('[6/6] zip');
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });
const zipPath = path.join(DIST, `${FINAL_NAME}.zip`);
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path "${packagedDir}\\*" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force`], { stdio: 'inherit' });

const size = fs.statSync(zipPath).size;
console.log(`\nDONE ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
