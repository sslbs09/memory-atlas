/**
 * verify-portable.mjs — 把发行 ZIP 解压到全新目录（中文+空格路径），
 * 在不依赖全局 Node/npm 的前提下验证发行包：
 *
 *   node release/verify-portable.mjs
 *
 * 检查项：
 *   1. 包内无开发机绝对路径（<Memory Atlas worktrees> / <WhiteMoon repo>）
 *   2. selfcheck 启动（GUI 可起、服务可起、bundled node 可用），退出无孤儿
 *   3. 正常启动 → endpoint.json → HTTP：写入 A/B/C、中文检索、纠正、撤回
 *   4. 双开保护（第二实例退出，服务不受影响）
 *   5. 优雅关闭 → endpoint.json 删除、Atlas 子进程退出、安装目录零写入
 *   6. 重启持久化（纠正后的版本仍在）
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasClient } from '../src/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ZIP = path.join(HERE, 'dist', 'MemoryAtlas-v0.1.0-alpha.1-win-x64.zip');
if (!fs.existsSync(ZIP)) throw new Error('发行 ZIP 不存在，先运行 release/package-portable.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const execP = (cmd, args, timeoutMs = 30000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
    resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
});
const tasklist = async (pid) => {
  const r = await execP('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  return r.stdout.includes(String(pid));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 0. 全新目录（含中文与空格） */
const baseDir = path.join(os.tmpdir(), 'Memory Atlas 发行验证', `run-${Date.now()}`);
const installDir = path.join(baseDir, '程序 目录');
const dataSelfcheck = path.join(baseDir, '数据 自检');
const dataMain = path.join(baseDir, '数据 主');
fs.mkdirSync(installDir, { recursive: true });
console.log(`install dir: ${installDir}`);

/* 1. 解压 */
console.log('[1] extracting zip...');
await execP('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath "${ZIP}" -DestinationPath "${installDir}" -Force`], 300000);
const exe = path.join(installDir, 'MemoryAtlas.exe');
check('zip extracted to Chinese+space path', fs.existsSync(exe));
check('bundled node runtime present', fs.existsSync(path.join(installDir, 'resources', 'app', 'runtime', 'node.exe')));
check('atlas server entry present', fs.existsSync(path.join(installDir, 'resources', 'app', 'atlas', 'bin', 'atlas-server.mjs')));
check('mcp bundle present', fs.existsSync(path.join(installDir, 'resources', 'app', 'mcp', 'atlas-mcp.mjs')));

/* R5 回归：Activation 运行时闭包必须随包（event-ledger / activation-explain 的导入闭包） */
const activationModules = [
  'activation-01/src/events.mjs', 'activation-01/src/tokenizer.mjs',
  'activation-01/src/candidates.mjs', 'activation-01/src/activation.mjs',
  'activation-02/src/event-ids.mjs', 'activation-02/src/strategies.mjs', 'activation-02/src/tiers.mjs',
  'activation-03/src/event-bridge.mjs', 'activation-03/src/evidence.mjs', 'activation-03/src/shadow-strategies.mjs',
  'activation-04/src/attribution-strategies.mjs'
];
const expRoot = path.join(installDir, 'resources', 'app', 'atlas', 'experiments');
const missingActivation = activationModules.filter((m) => !fs.existsSync(path.join(expRoot, ...m.split('/'))));
check('activation runtime modules shipped (R5 closure)', missingActivation.length === 0, missingActivation.join(', ') || 'all present');
if (missingActivation.length === 0) {
  const bundledNode = path.join(installDir, 'resources', 'app', 'runtime', 'node.exe');
  let importSmokeOk = true;
  for (const m of activationModules) {
    const target = path.join(expRoot, ...m.split('/'));
    const probe = await execP(bundledNode, ['--input-type=module', '-e', `await import(${JSON.stringify('file:///' + target.replace(/\\/g, '/'))});`], 30000);
    if (probe.error) { importSmokeOk = false; console.log('   import failed:', m, String(probe.stderr).slice(0, 120)); break; }
  }
  check('activation modules import cleanly via bundled node', importSmokeOk);
}
check('project LICENSE shipped in package', fs.existsSync(path.join(installDir, 'LICENSE')) && fs.readFileSync(path.join(installDir, 'LICENSE'), 'utf8').includes('Memory Atlas contributors'));
check('licenses/ full texts shipped', fs.existsSync(path.join(installDir, 'licenses', 'mcp-typescript-sdk-Apache-2.0.txt')) && fs.existsSync(path.join(installDir, 'licenses', '3d-force-graph-v1.80.1-MIT.txt')));
check('ffmpeg source statement shipped', fs.existsSync(path.join(installDir, 'FFMPEG-LGPL-SOURCE.md')));

/* 2. 无开发机路径 */
console.log('[2] scanning for dev-machine paths...');
const badNeedles = ['<Memory Atlas worktrees>', '<Memory Atlas worktrees>', '<WhiteMoon repo>', '<WhiteMoon repo>', '<Memory Atlas repo>\\'];
const offenders = [];
const walk = (dir, cb) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, cb); else cb(p);
  }
};
walk(path.join(installDir, 'resources', 'app'), (p) => {
  if (!/\.(mjs|js|cjs|json|html)$/.test(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const needle of badNeedles) {
    if (text.includes(needle)) offenders.push(`${p} -> ${needle}`);
  }
});
check('no dev-machine absolute paths in app code', offenders.length === 0, offenders.slice(0, 3).join('; '));

/* 干净环境：去掉一切开发用 env */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MEMORY_ATLAS|ALPHA_EXTERNAL|ATLAS_)/.test(key)) delete env[key];
  }
  return env;
}

const launch = (args) => spawn(exe, args, {
  cwd: installDir,
  windowsHide: false,
  detached: false,
  env: cleanEnv(),
  stdio: ['ignore', 'pipe', 'pipe']
});

async function waitForEndpoint(dataDir, timeoutMs = 90000) {
  const file = path.join(dataDir, 'endpoint.json');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await sleep(500); }
  }
  return null;
}
async function endpointGone(dataDir, timeoutMs = 20000) {
  const file = path.join(dataDir, 'endpoint.json');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!fs.existsSync(file)) return true;
    await sleep(400);
  }
  return false;
}

/* 3. selfcheck 启动（GUI + 服务 + bundled node），退出无孤儿 */
console.log('[3] selfcheck launch...');
const sc = launch(['--selfcheck', 'main', '--data-dir', dataSelfcheck]);
let scOutput = '';
sc.stdout.on('data', (c) => { scOutput += String(c); });
sc.stderr.on('data', (c) => { scOutput += String(c); });
const scEndpoint = await waitForEndpoint(dataSelfcheck, 90000);
check('selfcheck: atlas service started via bundled node', !!scEndpoint, scEndpoint ? scEndpoint.url : 'no endpoint.json in 90s');
const scChildPid = scEndpoint?.pid ?? null;
const scExit = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout-60s'), 60000);
  sc.once('exit', (code) => { clearTimeout(t); resolve(code); });
});
check('selfcheck: app exits by itself (code 0)', scExit === 0, `exit=${scExit}`);
check('selfcheck: endpoint.json removed on quit', await endpointGone(dataSelfcheck));
if (scChildPid) check('selfcheck: atlas child process exited (no orphan)', !(await tasklist(scChildPid)));

/* 4. 正常启动 + HTTP 全流程 */
console.log('[4] main launch + http flow...');
const app1 = launch(['--data-dir', dataMain]);
const endpoint = await waitForEndpoint(dataMain, 90000);
check('main: service started, endpoint.json ready', !!endpoint, endpoint ? endpoint.url : 'timeout');
if (!endpoint) process.exit(1);
const app1Pid = app1.pid;
const client = new AtlasClient({ baseUrl: endpoint.url, readToken: endpoint.readToken, writeToken: endpoint.writeToken, timeoutMs: 10000 });

const health = await client.health();
check('health ok', health.ok === true, JSON.stringify(health).slice(0, 120));

await client.createSpace('interop-demo', '发行验证空间');
const recA = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-a', kind: 'experience', content: '上个月和小林一起看过电影。', source: { kind: 'manual', id: 'verify' } } });
const recB = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-b', kind: 'experience', content: '答应老陈月底前还书。', source: { kind: 'manual', id: 'verify' } } });
const recC = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-c', kind: 'observation', content: '昨天办公室打印机换了墨盒。', source: { kind: 'manual', id: 'verify' } } });
check('write A/B/C via packaged service', recA.ok && recB.ok && recC.ok);

const searchA = await client.search({ spaceId: 'interop-demo', query: '小林 电影' });
check('Chinese search hits A', searchA.records?.some((r) => r.recordId === 'demo-a'), searchA.outcome);

const correctA = await client.correct({ spaceId: 'interop-demo', aboutRecordId: 'demo-a', content: '上个月和小陈一起看过电影。' });
check('correct A accepted', correctA.ok === true);
const searchA2 = await client.search({ spaceId: 'interop-demo', query: '小陈 电影' });
check('search returns corrected version', searchA2.records?.some((r) => r.content?.includes('小陈')), searchA2.outcome);
const searchA3 = await client.search({ spaceId: 'interop-demo', query: '小林' });
check('old 小林 version not active anymore', !searchA3.records?.some((r) => r.recordId === 'demo-a' && r.status === 'active'), searchA3.outcome);

const retractC = await client.retract({ spaceId: 'interop-demo', aboutRecordId: 'demo-c' });
check('retract C accepted', retractC.ok === true);
const searchC = await client.search({ spaceId: 'interop-demo', query: '打印机 墨盒' });
check('retracted C not returned as current fact', searchC.outcome === 'NO_MATCH', searchC.outcome);

/* 5. 双开保护 */
console.log('[5] second instance...');
const app2 = launch(['--data-dir', path.join(baseDir, '数据 副本')]);
const app2Exit = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('still-running'), 25000);
  app2.once('exit', (code) => { clearTimeout(t); resolve(code); });
});
check('second instance exits (single-instance lock)', app2Exit !== 'still-running', `exit=${app2Exit}`);
const endpointStill = JSON.parse(fs.readFileSync(path.join(dataMain, 'endpoint.json'), 'utf8'));
check('first instance service untouched by second launch', endpointStill.pid === endpoint.pid);
check('first instance still answering', (await client.health()).ok === true);

/* 6. 优雅关闭 */
console.log('[6] graceful close...');
const atlasChildPid = endpointStill.pid;
const kill = await execP('taskkill', ['/PID', String(app1Pid)], 20000);
check('WM_CLOSE delivered to app', !kill.error, kill.error ? String(kill.error).slice(0, 80) : 'taskkill exit 0');
check('endpoint.json removed after close', await endpointGone(dataMain));
await sleep(1500);
check('atlas child process exited (no orphan)', !(await tasklist(atlasChildPid)));
check('app process exited', !(await tasklist(app1Pid)));

/* 7. 安装目录零写入 */
console.log('[7] install dir pollution check...');
const dataLike = [];
walk(installDir, (p) => {
  if (/(\.sqlite|\.sqlite-|atlas-data|spaces|endpoint\.json|writer\.lock|config\.json|state\.json)/.test(p)) dataLike.push(p);
});
check('no user data written into install dir', dataLike.length === 0, dataLike.slice(0, 3).join('; '));

/* 8. 重启持久化 */
console.log('[8] restart persistence...');
const app3 = launch(['--data-dir', dataMain]);
const endpoint2 = await waitForEndpoint(dataMain, 90000);
check('restart: service back up', !!endpoint2, endpoint2 ? `${endpoint2.url} bootId=${endpoint2.bootId}` : 'timeout');
check('restart: new boot id (fresh service, same data)', endpoint2 && endpoint2.bootId !== endpoint.bootId);
if (endpoint2) {
  const client2 = new AtlasClient({ baseUrl: endpoint2.url, readToken: endpoint2.readToken, writeToken: endpoint2.writeToken, timeoutMs: 10000 });
  const after = await client2.search({ spaceId: 'interop-demo', query: '小陈 电影' });
  check('persistence: corrected memory survives restart', after.records?.some((r) => r.content?.includes('小陈')), after.outcome);
  const audit = await client2.search({ spaceId: 'interop-demo', query: '打印机', status: 'all' });
  check('persistence: retracted record still in audit history', audit.records?.some((r) => r.recordId === 'demo-c' && r.status === 'retracted'), audit.outcome);

  const atlasChild2 = endpoint2.pid;
  await execP('taskkill', ['/PID', String(app3.pid)], 20000);
  await endpointGone(dataMain);
  await sleep(1500);
  check('final close: no orphan atlas process', !(await tasklist(atlasChild2)));
} else {
  await execP('taskkill', ['/F', '/PID', String(app3.pid)], 20000);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
console.log(`install dir: ${installDir}`);
process.exit(failed.length ? 1 : 0);
