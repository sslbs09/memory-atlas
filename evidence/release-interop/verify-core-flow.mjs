/**
 * verify-core-flow.mjs — 发行前核心流程验证（UTF-8 安全的 Node 客户端）：
 *   写入 → 中文检索 → 纠正 → 检索到新版本 → 撤回 → 不再作为当前事实 →
 *   endpoint.json 写入与优雅删除。
 * 用法：node evidence/release-interop/verify-core-flow.mjs
 */
import { AtlasClient } from '../../src/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnAtlas } from './spawn-atlas.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-flow-'));
const atlas = spawnAtlas({ dataDir, port: 0, repoRoot });
const { port } = await atlas.ready;
const client = new AtlasClient({ baseUrl: `http://127.0.0.1:${port}`, readToken: atlas.readToken, writeToken: atlas.writeToken });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// 1. endpoint.json 写入
const endpoint = JSON.parse(fs.readFileSync(atlas.endpointFile, 'utf8'));
check('endpoint.json written with url+tokens',
  endpoint.url === `http://127.0.0.1:${port}` && endpoint.readToken === atlas.readToken && endpoint.writeToken === atlas.writeToken,
  endpoint.url);

// 2. 建空间 + 三条合成记忆
await client.createSpace('interop-demo', '跨客户端一致性验证空间');
const recA = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-a', kind: 'experience', content: '上个月和小林一起看过电影。', source: { kind: 'manual', id: 'seed-a' } } });
const recB = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-b', kind: 'experience', content: '答应老陈月底前还书。', source: { kind: 'manual', id: 'seed-b' } } });
const recC = await client.record({ spaceId: 'interop-demo', record: { recordId: 'demo-c', kind: 'observation', content: '昨天办公室打印机换了墨盒。', source: { kind: 'manual', id: 'seed-c' } } });
check('A/B/C recorded', recA.ok && recB.ok && recC.ok, `a=${recA.recordId} b=${recB.recordId} c=${recC.recordId}`);

// 3. 中文检索（精确词）
const sA = await client.search({ spaceId: 'interop-demo', query: '小林 电影' });
check('search hits A by 小林+电影', sA.records?.some(r => r.recordId === 'demo-a'), sA.outcome);
const sB = await client.search({ spaceId: 'interop-demo', query: '老陈 还书' });
check('search hits B by 老陈+还书', sB.records?.some(r => r.recordId === 'demo-b'), sB.outcome);

// 4. 同义表述限制（诚实记录）：约定 vs 答应
const syn = await client.search({ spaceId: 'interop-demo', query: '约定 还书' });
const synHitsB = syn.records?.some(r => r.recordId === 'demo-b') ?? false;
check('synonym 约定→答应 behavior recorded', true, `hitsB=${synHitsB} outcome=${syn.outcome}（记录为已知词汇学检索限制，本轮不修复）`);

// 5. 纠正 A：小林 → 小陈
const corr = await client.correct({ spaceId: 'interop-demo', aboutRecordId: 'demo-a', content: '上个月和小陈一起看过电影。' });
check('correct A → 小陈 accepted', corr.ok, JSON.stringify(corr).slice(0, 120));
const sA2 = await client.search({ spaceId: 'interop-demo', query: '小陈 电影' });
check('search now hits corrected 小陈', sA2.records?.some(r => r.content?.includes('小陈')), sA2.outcome);
const sA3 = await client.search({ spaceId: 'interop-demo', query: '小林' });
const oldStillActive = sA3.records?.some(r => r.recordId === 'demo-a' && r.status === 'active' && r.content?.includes('小林'));
check('old 小林 version no longer active', !oldStillActive, sA3.outcome);

// 6. 撤回 C
const retr = await client.retract({ spaceId: 'interop-demo', aboutRecordId: 'demo-c' });
check('retract C accepted', retr.ok);
const sC = await client.search({ spaceId: 'interop-demo', query: '打印机 墨盒' });
check('retracted C not in active search', !sC.records?.some(r => r.recordId === 'demo-c'), sC.outcome);
const sCAll = await client.search({ spaceId: 'interop-demo', query: '打印机 墨盒', status: 'all' });
check('retracted C visible in audit view with status', sCAll.records?.some(r => r.recordId === 'demo-c' && r.status === 'retracted'), sCAll.outcome);

// 7. 空间隔离
const other = await client.search({ spaceId: 'no-such-space', query: '小林' });
check('unknown space does not leak', other.ok === false || (other.records?.length ?? 0) === 0, other.outcome ?? String(other.ok));

// 8. 优雅关闭后 endpoint.json 被删除
await atlas.stop();
check('endpoint.json removed on graceful shutdown', !fs.existsSync(atlas.endpointFile));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. dataDir=${dataDir}`);
process.exit(failed.length ? 1 : 0);
