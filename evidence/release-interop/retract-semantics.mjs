// retract-semantics.mjs — 验证控制语义：纠正后再撤回原记录会发生什么。
import { spawnAtlas } from './spawn-atlas.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sem-'));
const atlas = spawnAtlas({ dataDir, port: 0, repoRoot: root });
const ready = await atlas.ready;
import { AtlasClient } from '../../src/client.js';
const c = new AtlasClient({ baseUrl: `http://127.0.0.1:${ready.port}`, readToken: atlas.readToken, writeToken: atlas.writeToken });
await c.createSpace('s', 'sem');
await c.record({ spaceId: 's', record: { recordId: 'r1', kind: 'experience', content: '答应老陈月底前还书。', source: { kind: 'manual', id: 't' } } });
await c.correct({ spaceId: 's', aboutRecordId: 'r1', content: '答应老陈下月三号前还书。' });
const retr = await c.retract({ spaceId: 's', aboutRecordId: 'r1' });
console.log('retract superseded original:', JSON.stringify(retr).slice(0, 300));
const s = await c.search({ spaceId: 's', query: '还书' });
console.log('search after retract:', s.outcome, (s.records ?? []).map((r) => [r.recordId, r.status, r.content]));
const detail = await c.detail({ spaceId: 's', recordId: 'r1' });
console.log('chain:', JSON.stringify(detail.chain ?? detail.history ?? detail).slice(0, 500));
await atlas.stop();
