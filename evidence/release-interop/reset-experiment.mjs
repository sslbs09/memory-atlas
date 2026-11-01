/**
 * reset-experiment.mjs — 把三客户端实验环境恢复到初始状态：
 * 关闭桌面程序 → 清空 interop-data → 重新启动 → 播种 A/B/C。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasClient } from '../../src/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RELEASE_DIR = path.join(ROOT, 'release', 'out', 'MemoryAtlas-v0.1.0-alpha.1-win-x64');
const DATA_DIR = path.join(HERE, 'interop-data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => execFile('taskkill', ['/IM', 'MemoryAtlas.exe'], { timeout: 20000 }, () => r()));
await sleep(4000);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const app = spawn(path.join(RELEASE_DIR, 'MemoryAtlas.exe'), ['--data-dir', DATA_DIR], { cwd: RELEASE_DIR, detached: true, stdio: 'ignore' });
app.unref();
const endpoint = await new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    try { return resolve(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'endpoint.json'), 'utf8'))); }
    catch { if (Date.now() - started > 90000) return resolve(null); setTimeout(tick, 500); }
  };
  setTimeout(tick, 5000);
});
if (!endpoint) { console.error('service did not come up'); process.exit(1); }
const c = new AtlasClient({ baseUrl: endpoint.url, readToken: endpoint.readToken, writeToken: endpoint.writeToken });
await c.createSpace('interop-demo', '跨客户端共享记忆空间');
await c.record({ spaceId: 'interop-demo', record: { recordId: 'demo-a', kind: 'experience', content: '上个月和小林一起看过电影。', source: { kind: 'manual', id: 'seed-a' } } });
await c.record({ spaceId: 'interop-demo', record: { recordId: 'demo-b', kind: 'experience', content: '答应老陈月底前还书。', source: { kind: 'manual', id: 'seed-b' } } });
await c.record({ spaceId: 'interop-demo', record: { recordId: 'demo-c', kind: 'observation', content: '昨天办公室打印机换了墨盒。', source: { kind: 'manual', id: 'seed-c' } } });
await c.createSpace('unrelated-space', '隔离检查空间');
await c.record({ spaceId: 'unrelated-space', record: { recordId: 'secret-9', kind: 'note', content: '别的空间的小陈秘密。', source: { kind: 'manual', id: 'seed-x' } } });
const s = await c.search({ spaceId: 'interop-demo', query: '小林' });
console.log(`reset done. endpoint=${endpoint.url} bootId=${endpoint.bootId} seedSearch=${s.outcome}`);
app.unref();
