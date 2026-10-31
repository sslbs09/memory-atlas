/**
 * Final-closure regressions: the two defects GPT's second verification measured.
 *
 * T-series: an index whose projection failed must not be allowed to answer
 *           "nothing matched" for a memory that is on disk.
 * S-series: the index and the authoritative scan must search ONE text. The
 *           scan reads record id, kind, visibility, source and attributes; the
 *           projection used to hand the index only the content, so a
 *           `source.id` query hit in one path and missed in the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { LexicalEngine } from './helpers/lexical-engine.mjs';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lamp = { recordId: 'tea', kind: 'experience', content: '用户喜欢无糖桂花乌龙', source: { kind: 'chat', id: 'lamp-source' } };

test('T1 a projection that threw is never allowed to answer NO_MATCH for a stored memory', async (t) => {
  const dir = tempDir(t, 'atlas-trust-');
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  // Fails exactly where GLM's own fault hook fails: after the index rows are in,
  // while the graph stage is still part of the same write.
  const engine = new LexicalEngine();
  const realUpsert = engine.upsertRecords.bind(engine);
  let armed = false;
  engine.upsertRecords = (records) => {
    if (armed) throw Object.assign(new Error('graph stage failed'), { code: 'GRAPH_PHASE_FAILED' });
    return realUpsert(records);
  };
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });

  armed = true;
  const receipt = await svc.record('mira', lamp);
  armed = false;
  assert.equal(receipt.accepted, true, 'the memory itself is stored and must stay stored');
  assert.equal(receipt.outcome, 'RECORDED');

  const found = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(found.searchPath, 'atlas-authoritative-scan', 'the space stopped trusting its index at the moment the sync failed');
  assert.equal(found.outcome, 'MATCHED', 'a projection that never landed is not a missing memory');
  assert.deepEqual(found.records.map((r) => r.recordId), ['tea']);
  assert.equal(found.index.state, 'INDEX_INVALID');
  assert.equal(found.index.reason, 'GRAPH_PHASE_FAILED', 'the answer names the failure that took the index out of service');
  assert.equal(found.index.recovery, 'reindex');

  // An id lookup through the index would also be answered by the store now.
  const exact = await svc.search({ spaceId: 'mira', recordId: 'tea' });
  assert.equal(exact.outcome, 'MATCHED');
  assert.equal(exact.index.state, 'INDEX_INVALID');

  // A successful later write does NOT restore trust: the records that missed the
  // projection are still absent from the index.
  const receipt2 = await svc.record('mira', { recordId: 'bag', content: '书包放在门后', source: { kind: 'chat', id: 'msg-2' } });
  assert.equal(receipt2.accepted, true);
  const stillDistrusted = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(stillDistrusted.index.state, 'INDEX_INVALID', 'only a complete reindex restores index queries');

  const restored = await svc.reindex('mira');
  assert.equal(restored.spaces[0].synced, true);
  const after = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(after.searchPath, 'atlas-candidates+authoritative', 'a complete rebuild brings the index back');
  assert.equal(after.index.state, 'WIRED');
  assert.deepEqual(after.records.map((r) => r.recordId), ['tea']);

  const health = svc.health();
  assert.equal(health.index.state, 'WIRED');
  assert.deepEqual(health.index.invalidSpaces, []);
});

test('T3 a rejection from an asynchronous sync lands in the trust ledger, not in unhandledRejection', async (t) => {
  // The real GLM engine syncs synchronously today, but the DTO does not promise
  // that. A promise that rejects on the write path and is not awaited used to be
  // an unhandled rejection: the process that had just stored the memory died,
  // taking the per-space trust ledger with it. node:test fails a run on an
  // unhandled rejection, so this test going green IS the proof the write path
  // waits for the sync and catches what it throws.
  const dir = tempDir(t, 'atlas-trust-async-');
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const engine = new LexicalEngine();
  const realUpsert = engine.upsertRecords.bind(engine);
  let armed = false;
  engine.upsertRecords = async (records) => {
    if (armed) throw Object.assign(new Error('async graph stage failed'), { code: 'ASYNC_GRAPH_PHASE_FAILED' });
    return realUpsert(records);
  };
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });

  await svc.record('mira', { recordId: 'lamp', content: '桌面那盏台灯是暖光的' });
  armed = true;
  const receipt = await svc.record('mira', lamp);
  assert.equal(receipt.accepted, true, 'the memory itself is stored and the receipt is returned');
  assert.equal(receipt.outcome, 'RECORDED');

  const found = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(found.searchPath, 'atlas-authoritative-scan', 'the async failure also takes the index out of service');
  assert.equal(found.outcome, 'MATCHED');
  assert.equal(found.index.state, 'INDEX_INVALID');
  assert.equal(found.index.reason, 'ASYNC_GRAPH_PHASE_FAILED');

  armed = false;
  const restored = await svc.reindex('mira');
  assert.equal(restored.complete, true, 'a reindex that awaits the async adapter completes');
  assert.equal((await svc.search({ spaceId: 'mira', query: '桂花' })).searchPath, 'atlas-candidates+authoritative');
});

test('T2 a rebuild that fails leaves the index out of service instead of half-used', async (t) => {  const dir = tempDir(t, 'atlas-trust-rebuild-');
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const svcPlain = createMemoryService({ authority });
  await svcPlain.record('mira', lamp);
  await svcPlain.record('mira', { recordId: 'bag', content: '书包放在门后', source: { kind: 'chat', id: 'msg-2' } });

  const engine = new LexicalEngine();
  engine.upsertRecords = () => { throw Object.assign(new Error('index is read-only'), { code: 'INDEX_READONLY' }); };
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });

  const report = await svc.reindex();
  assert.equal(report.spaces[0].synced, false, 'the rebuild says plainly that it did not complete');
  const found = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(found.index.state, 'INDEX_INVALID');
  assert.equal(found.index.reason, 'INDEX_READONLY');
  assert.equal(found.outcome, 'MATCHED', 'and the answer still comes from the store');

  const healthy = new LexicalEngine();
  const svc2 = createMemoryService({ authority, retrieval: healthy, derivedCacheDir: path.join(dir, 'derived-cache') });
  const rebuilt = await svc2.reindex();
  assert.equal(rebuilt.spaces[0].synced, true);
  assert.equal((await svc2.search({ spaceId: 'mira', query: '桂花' })).index.state, 'WIRED');
});

test('S1 one searchable text: a source id query answers the same in both paths', async (t) => {
  const dir = tempDir(t, 'atlas-searchtext-');
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const engine = new LexicalEngine();
  const wired = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });
  await wired.record('mira', { recordId: 'bag', kind: 'experience', content: '书包放在门后', source: { kind: 'chat', id: 'lamp-source' } });

  const indexed = await wired.search({ spaceId: 'mira', query: 'lamp-source' });
  assert.equal(indexed.searchPath, 'atlas-candidates+authoritative', 'this answer came from the index path, not a fallback');
  const scan = await createMemoryService({ authority }).search({ spaceId: 'mira', query: 'lamp-source' });
  assert.equal(scan.outcome, 'MATCHED', 'the authoritative scan sees the source field');
  assert.deepEqual(scan.records.map((r) => r.recordId), ['bag']);
  assert.deepEqual(indexed.records.map((r) => r.recordId), ['bag'],
    'the index must be shown exactly what the scan reads; a silent miss between the two is the defect');
});

test('S2 the shared searchable text still keeps the negatives negative', async (t) => {
  const dir = tempDir(t, 'atlas-searchtext-neg-');
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const engine = new LexicalEngine();
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });
  await svc.record('mira', { recordId: 'lamp', kind: 'experience', content: '桌面那盏台灯是暖光的', source: { kind: 'chat', id: 'msg-1' } });
  await svc.record('mira', { recordId: 'bag', kind: 'experience', content: '书包放在门后', source: { kind: 'chat', id: 'msg-2' } });

  const cases = [
    ['台灯', ['lamp']], ['书包', ['bag']], ['lamp-source', []], ['visibility:private', []],
    ['桂花', []], ['experience', ['bag', 'lamp']]
  ];
  for (const [query, expected] of cases) {
    const indexed = await svc.search({ spaceId: 'mira', query });
    const plain = createMemoryService({ authority });
    const scan = await plain.search({ spaceId: 'mira', query });
    assert.deepEqual(scan.records.map((r) => r.recordId).sort(), expected, `scan: ${query}`);
    assert.deepEqual(indexed.records.map((r) => r.recordId).sort(), scan.records.map((r) => r.recordId).sort(),
      `${query}: the index path and the scan must agree`);
  }
});
