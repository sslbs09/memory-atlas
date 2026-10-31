/**
 * Retrieval seam tests: an index attached to Atlas may rank, never admit.
 *
 * The engine used here is a real one (inverted index, AND over terms, coverage x
 * recency scoring, DTO refusals by code) living outside src/, so the seam is
 * proven against an independent implementation of SEARCH-DTO-v1 rather than
 * against a mock written to agree with whatever the coordinator sends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { buildRetrievalRequest, createRetrievalCoordinator, spaceProjection } from '../src/retrieval.js';
import { LexicalEngine } from './helpers/lexical-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLM_DIR = process.env.ATLAS_GLM_RETRIEVAL_DIR
  ?? path.resolve(ROOT, '..', 'WhiteMoon', 'work', 'universal-memory-v0.1', 'glm-retrieval');

function tempDir(t, prefix = 'atlas-retrieval-') {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function wired(t, { records = [], engine = new LexicalEngine(), spaces = ['mira'] } = {}) {
  const dir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: dir });
  for (const spaceId of spaces) await authority.createSpace({ spaceId });
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: path.join(dir, 'derived-cache') });
  for (const record of records) await svc.record(record.spaceId ?? 'mira', record);
  return { dir, authority, svc, engine };
}

const lamp = { recordId: 'lamp', kind: 'experience', content: '桌面那盏台灯是暖光的', source: { kind: 'chat', id: 'msg-1' } };
const bag = { recordId: 'bag', kind: 'experience', content: '书包挂在门后', source: { kind: 'chat', id: 'msg-2' } };
const like = { recordId: 'like', kind: 'experience', content: '用户喜欢无糖乌龙', source: { kind: 'chat', id: 'msg-3' } };
const dislike = { recordId: 'dislike', kind: 'experience', content: '用户不喜欢无糖乌龙', source: { kind: 'chat', id: 'msg-4' } };

test('E1 an unwired service answers from the store and says the index is not wired', async (t) => {
  const { svc } = await wired(t, { records: [lamp, bag], engine: null });
  const found = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(found.searchPath, 'atlas-authoritative-scan');
  assert.equal(found.index.state, 'NOT_WIRED');
  assert.deepEqual(found.records.map((r) => r.recordId), ['lamp']);
  assert.equal(svc.indexStatus().wired, false);
  assert.equal(svc.health().index.state, 'NOT_WIRED');
  assert.equal(svc.health().index.reason, 'NO_ADAPTER_ATTACHED');
});

test('E2 a wired index ranks the records the store admits, and nothing else', async (t) => {
  const { svc } = await wired(t, { records: [lamp, bag] });
  assert.equal(svc.retrieval.size, 2, 'the accepted write was projected into the derived index');
  const assisted = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(assisted.searchPath, 'atlas-candidates+authoritative');
  assert.equal(assisted.index.state, 'WIRED');
  assert.deepEqual(assisted.records.map((r) => r.recordId), ['lamp']);
  assert.equal(assisted.records[0].content, lamp.content, 'content is served from the store, not the index');
  assert.ok(Array.isArray(assisted.records[0].matchReason), 'matchReason is the frozen array shape');
  // The two answers must agree on membership even when the ranking differs; the
  // repeatable property is the set, so it is compared over the whole result.
  const scanned = await createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => null
  }).search({ spaceId: 'mira', options: { query: '台灯' } });
  assert.deepEqual(assisted.records.map((r) => r.recordId).sort(), scanned.records.map((r) => r.recordId).sort(),
    'wiring an index changed the order it answers in, not what it is allowed to answer with');
});

test('E3 「台灯」 does not reach a record that only says 「书包」, and neither path invents it', async (t) => {
  const { svc } = await wired(t, { records: [lamp, bag, like, dislike] });
  const assisted = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(assisted.searchPath, 'atlas-candidates+authoritative', 'the negative is proven through the index');
  assert.deepEqual(assisted.records.map((r) => r.recordId), ['lamp']);
  assert.equal(assisted.outcome, 'MATCHED');
  const empty = await svc.search({ spaceId: 'mira', query: '书包台灯' });
  assert.equal(empty.outcome, 'NO_MATCH', 'AND across terms is not OR wearing a different name');
  assert.deepEqual(empty.records, []);

  const negative = await svc.search({ spaceId: 'mira', query: '不喜欢' });
  assert.deepEqual(negative.records.map((r) => r.recordId), ['dislike'],
    '极性 is preserved: 「不喜欢」 never resolves onto 「喜欢」');

  // The same negatives without any index, so the property belongs to the product
  // and not to one code path.
  const bareDir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: bareDir });
  await authority.createSpace({ spaceId: 'mira' });
  const plain = createMemoryService({ authority });
  for (const record of [lamp, bag, like, dislike]) await plain.record('mira', record);
  for (const [query, expected] of [['台灯', ['lamp']], ['书包', ['bag']], ['不喜欢', ['dislike']]]) {
    const scan = await plain.search({ spaceId: 'mira', query });
    assert.deepEqual(scan.records.map((r) => r.recordId), expected, `scan path: ${query}`);
  }
});

test('E4 a candidate the store does not have is named, never served', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp], spaces: ['mira', 'other'] });
  // A record that exists - just not in the space being asked about.
  await svc.record('other', { ...bag, recordId: 'other-bag' });
  const calls = [];
  // A lying or drifted index: it offers an id that exists nowhere and an id that
  // belongs to another space, and hides the one real hit.
  const lying = {
    name: 'lying',
    searchCandidates: async (params) => {
      calls.push(params);
      const mine = await engine.searchCandidates(params);
      return {
        ...mine,
        totalCount: 2,
        returned: 2,
        hasMore: false,
        candidates: [
          { recordId: 'ghost', indexState: 'INDEXED', score: 999, matchReason: ['invented'], indexRevision: 4 },
          { recordId: 'other-bag', indexState: 'INDEXED', score: 998, matchReason: ['another space'], indexRevision: 1 }
        ]
      };
    }
  };
  const coordinator = createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => lying
  });
  const result = await coordinator.search({ spaceId: 'mira', options: { query: '台灯' } });
  assert.equal(calls[0].instanceId, 'mira', 'the space is named in every request, so a well-behaved index cannot be asked across spaces');
  assert.equal(result.outcome, 'NO_MATCH', 'an id the authoritative space does not contain yields nothing');
  assert.deepEqual(result.records, []);
  const reasons = Object.fromEntries(result.index.residue.map((r) => [r.recordId, r.reason]));
  assert.equal(reasons.ghost, 'NOT_IN_FORMAL_HISTORY');
  assert.equal(reasons['other-bag'], 'NOT_IN_FORMAL_HISTORY', 'another space is not readable through this one');

  // The same adapter telling the truth about one id: the refusal above is about
  // the store, not about suspicion - a candidate Core holds is served with its
  // content, however dishonest the rest of the payload was.
  lying.searchCandidates = async (params) => ({
    indexState: 'READY', indexGeneration: 1, outcome: 'MATCHED', totalCount: 1, limit: 200, offset: 0,
    returned: 1, hasMore: false, nextCursor: null,
    candidates: [{ recordId: 'lamp', indexState: 'INDEXED', score: 1, matchReason: ['truth at last'], indexRevision: 1 }]
  });
  const honest = await coordinator.search({ spaceId: 'mira', options: { query: '台灯' } });
  assert.deepEqual(honest.records.map((r) => r.recordId), ['lamp']);
  assert.equal(honest.records[0].content, lamp.content);
});

test('E5 a retraction removes the fact from recall even while the index still lists it', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp, bag] });
  const before = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.deepEqual(before.records.map((r) => r.recordId), ['lamp']);

  await svc.retract('mira', { aboutRecordId: 'lamp' });
  assert.equal(engine.size, 1, 'the derived projection dropped the retracted record');
  const after = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(after.outcome, 'NO_MATCH');
  assert.equal(after.searchPath, 'atlas-candidates+authoritative', 'the index was still consulted, and still did not win');

  // Now the harsher case: an index that never got the message.
  engine.upsertRecords([{ recordId: 'lamp', instanceId: 'mira', revision: 1, text: '桌面那盏台灯是暖光的', status: 'active' }]);
  const stale = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.deepEqual(stale.records, [], 'a projection that still says active cannot recall a retracted memory');
  assert.equal(stale.index.residue[0].reason, 'NOT_EFFECTIVE');
  const audit = await svc.search({ spaceId: 'mira', query: '台灯', status: 'all' });
  assert.ok(audit.records.some((r) => r.recordId === 'lamp'), 'and the original text stays auditable');
});

test('E6 a correction reaches the index, and an unupdated projection is reported as stale', async (t) => {
  const { svc, engine } = await wired(t, { records: [{ ...lamp, recordId: 'code', content: '工位代号是铜雀-19' }] });
  const write = await svc.correct('mira', { aboutRecordId: 'code', content: '工位代号是银杉-84' });
  const recall = await svc.search({ spaceId: 'mira', query: '工位代号' });
  assert.deepEqual(recall.records.map((r) => r.recordId), [write.recordId], 'only the correction stands');
  assert.ok(recall.records[0].content.includes('银杉-84'));
  assert.equal(engine.size, 1, 'the superseded text left the derived projection');

  const projection = spaceProjection(svc.authority.inspect('mira').spaceDoc, svc.authority.inspect('mira').validity);
  const revisionOfCorrection = projection.upserts.find((row) => row.recordId === write.recordId).revision;
  const staleEngine = new LexicalEngine();
  staleEngine.upsertRecords([{ ...projection.upserts[0], revision: revisionOfCorrection - 3 }]);
  const staleResult = await createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => staleEngine
  }).search({ spaceId: 'mira', options: { query: '工位代号' } });
  assert.equal(staleResult.records[0].indexStale, true, 'staleness is judged against the record\'s own sequence');
  assert.equal(staleResult.index.staleCandidates, 1);
});

test('E7 a rebuilding or failing index never becomes "there is nothing here"', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp, bag] });
  engine.setRebuilding(true);
  const rebuilding = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(rebuilding.searchPath, 'atlas-authoritative-scan');
  assert.equal(rebuilding.index.state, 'INDEX_REBUILDING');
  assert.deepEqual(rebuilding.records.map((r) => r.recordId), ['lamp'], 'the store answered while the index could not');
  engine.setRebuilding(false);

  const throwing = { name: 'throwing', searchCandidates: async () => { throw new Error('sqlite is gone'); } };
  const failed = await createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => throwing
  }).search({ spaceId: 'mira', options: { query: '台灯' } });
  assert.equal(failed.index.state, 'ADAPTER_FAILED');
  assert.equal(failed.index.fellBack, true);
  assert.deepEqual(failed.records.map((r) => r.recordId), ['lamp']);

  // A refusal about the request shape is a different diagnosis from a broken index.
  const refusing = {
    name: 'refusing',
    searchCandidates: async () => { throw Object.assign(new Error('no terms'), { code: 'SEARCH_EMPTY_QUERY' }); }
  };
  const refused = await createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => refusing
  }).search({ spaceId: 'mira', options: { query: '。' } });
  assert.equal(refused.index.state, 'ADAPTER_REFUSED');
  assert.equal(refused.index.fault.code, 'SEARCH_EMPTY_QUERY');
});

test('E8 the request the index receives is exactly the frozen DTO vocabulary', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp, bag] });
  const calls = [];
  const spy = {
    name: 'spy',
    searchCandidates: async (params) => { calls.push(params); return engine.searchCandidates(params); }
  };
  const coordinator = createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => spy
  });
  await coordinator.search({ spaceId: 'mira', options: { query: '台灯', since: '2020-01-01T00:00:00.000Z', limit: 7, kinds: ['experience'], visibility: 'space' } });
  const request = calls[0];
  assert.equal(request.instanceId, 'mira', 'the DTO space key carries the space identity');
  assert.equal(request.q, '台灯', 'q is canonical');
  assert.equal(request.query, undefined, "Core's synonym is never sent alongside it");
  assert.equal(request.status, undefined, 'validity is the store\'s filter, not the index\'s');
  assert.equal(request.kinds, undefined, 'the DTO has no record-kind axis');
  assert.equal(request.types, undefined, 'types is a source-kind whitelist, not a record kind');
  assert.equal(request.visibility, undefined, 'visibility is enforced authoritatively');
  assert.equal(request.cursor, undefined, 'offset and cursor are mutually exclusive; Atlas pages with offset');
  assert.equal(request.offset, 0);
  assert.equal(request.limit, 28, 'overfetch by four, because validity will drop candidates');
  assert.equal(request.includeText, undefined, 'candidates never carry content');

  await coordinator.search({ spaceId: 'mira', options: { query: '台灯', limit: 200 } });
  assert.equal(calls[1].limit, 200, 'the DTO ceiling is 200: the overfetch is clamped, not forwarded');

  const planned = buildRetrievalRequest('mira', { status: 'all' });
  assert.equal(planned.usable, false);
  assert.equal(planned.reason, 'NON_ACTIVE_VIEW_NOT_INDEXED');
});

test('E9 a view the index cannot represent is answered by the store, and says which', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp, bag] });
  const spy = { searchCandidates: async (params) => { spy.calls = (spy.calls ?? 0) + 1; return engine.searchCandidates(params); } };
  const coordinator = createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => spy
  });
  for (const [options, reason] of [
    [{ status: 'all' }, 'NON_ACTIVE_VIEW_NOT_INDEXED'],
    [{}, 'NO_INDEXABLE_TERM'],
    [{ order: 'oldest', query: '台灯' }, 'ORDER_REQUESTED'],
    [{ query: '台灯', recordId: 'lamp' }, 'KEYWORD_AND_EXACT_ID']
  ]) {
    const view = await coordinator.search({ spaceId: 'mira', options });
    assert.equal(view.index.state, 'NOT_APPLICABLE', `${reason} goes to the store`);
    assert.equal(view.index.reason, reason);
    assert.equal(view.searchPath, 'atlas-authoritative-scan');
  }
  assert.equal(spy.calls, undefined, 'none of them reached the index');

  const exact = await coordinator.search({ spaceId: 'mira', options: { recordId: 'lamp' } });
  assert.equal(exact.searchPath, 'atlas-candidates+authoritative');
  assert.equal(exact.records[0].recordId, 'lamp', 'an exact id is a question the index does answer');
});

test('E10 a deep page walks index windows and stays consistent with its neighbours', async (t) => {
  const records = [];
  for (let i = 0; i < 12; i += 1) {
    records.push({ recordId: `lamp-${i}`, kind: 'experience', content: `台灯 第 ${i} 盏`, source: { kind: 'chat', id: `m-${i}` } });
  }
  const { svc } = await wired(t, { records });
  const inspected = svc.authority.inspect('mira');
  const windowed = new LexicalEngine();
  windowed.upsertRecords(spaceProjection(inspected.spaceDoc, inspected.validity).upserts);
  const WINDOW = 2;
  // An index that only ever answers two rows at a time, so the walk is forced.
  const tiny = {
    calls: [],
    searchCandidates: async (params) => {
      tiny.calls.push(params.offset);
      return windowed.searchCandidates({ ...params, limit: WINDOW });
    }
  };
  const coordinator = createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => tiny
  });

  const first = await coordinator.search({ spaceId: 'mira', options: { query: '台灯', limit: 2, offset: 0 } });
  const second = await coordinator.search({ spaceId: 'mira', options: { query: '台灯', limit: 2, offset: 2 } });
  tiny.calls = [];
  const third = await coordinator.search({ spaceId: 'mira', options: { query: '台灯', limit: 2, offset: 4 } });
  assert.equal(third.index.windows, 3, 'the page was reached by walking successive windows');
  assert.equal(third.index.windowCapReached, false);
  assert.deepEqual(tiny.calls, [0, 2, 4], 'each walk advances by what the index actually returned');

  const paged = [...first.records, ...second.records, ...third.records].map((r) => r.recordId);
  assert.equal(new Set(paged).size, 6, 'three pages of two are six memories - no page repeats or skips');
  const storeIds = new Set(inspected.spaceDoc.records.map((r) => r.recordId));
  for (const id of paged) assert.ok(storeIds.has(id), 'every paged id is an authoritative record');
  assert.deepEqual(paged, windowed.searchCandidates({ instanceId: 'mira', q: '台灯', limit: 6 })
    .candidates.map((candidate) => candidate.recordId), 'and in the order the index itself gives');

  const beyond = await coordinator.search({ spaceId: 'mira', options: { query: '台灯', limit: 1, offset: 11 } });
  assert.equal(beyond.index.windows, 4, 'the walk stops at its documented bound');
  assert.equal(beyond.index.windowCapReached, true);
  assert.equal(beyond.hasMore, true, 'a bounded walk never claims the listing is complete');
});

test('E11 the derived index is counted as derived, and the store stays the only master', async (t) => {
  const { svc, dir } = await wired(t, { records: [lamp, bag] });
  const before = svc.health();
  assert.equal(before.index.state, 'WIRED');
  assert.equal(before.index.engine, 'lexical-engine-test');
  assert.equal(before.index.acceptsProjections, true);
  assert.ok(Number.isSafeInteger(before.index.generation));

  fs.mkdirSync(before.derivedCache.path, { recursive: true });
  fs.writeFileSync(path.join(before.derivedCache.path, 'index-artifact.bin'), Buffer.alloc(4096, 7));
  const after = svc.health();
  assert.ok(after.capacity.derivedCacheBytes >= 4096, 'the derived cache reports its own footprint');
  assert.equal(after.capacity.authoritativeBytes, before.capacity.authoritativeBytes,
    'indexing a memory never changes the size of the memory');
  assert.equal(after.capacity.policy.autoDiscardOriginals, false);
  assert.ok(after.capacity.authoritativeBytes > 0, 'and the authoritative bytes are still counted, not zeroed');

  // Deleting the derived index must lose nothing but speed.
  svc.retrieval.close();
  const rebuiltEngine = new LexicalEngine();
  const rebuilt = createMemoryService({ authority: svc.authority, retrieval: rebuiltEngine, derivedCacheDir: path.join(dir, 'derived-cache') });
  const reindexed = await rebuilt.reindex();
  assert.equal(reindexed.spaces.length, 1);
  assert.equal(reindexed.spaces[0].synced, true, 'the projection is rebuildable from the authoritative store alone');
  const found = await rebuilt.search({ spaceId: 'mira', query: '台灯' });
  assert.deepEqual(found.records.map((r) => r.recordId), ['lamp'], 'and the answers survive the rebuild');
});

test('E12 over HTTP: a real server rebuilds its index from the store and answers from it', async (t) => {
  const dir = tempDir(t, 'atlas-http-index-');
  const modulePath = path.join(dir, 'engine-module.mjs');
  fs.writeFileSync(modulePath, [
    `import { LexicalEngine } from '${pathToFileURL(path.join(ROOT, 'test', 'helpers', 'lexical-engine.mjs')).href}';`,
    'export function createRetrievalAdapter() { return new LexicalEngine(); }',
    ''
  ].join('\n'));

  // An existing store, written before the server exists: this is what a restart
  // has to recover, and it is also what proves the writer claim was released.
  const dataDir = path.join(dir, 'data');
  const seeding = new NativeAuthority({ dataDir });
  await seeding.createSpace({ spaceId: 'mira' });
  const seedService = createMemoryService({ authority: seeding });
  await seedService.record('mira', lamp);
  await seedService.record('mira', bag);
  seeding.close();

  const child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'atlas-server.mjs'), '--data-dir', dataDir, '--port', '0',
    '--retrieval-module', modulePath
  ], { cwd: ROOT, env: { ...process.env, ATLAS_READ_TOKEN: 'read-synthetic-0001', ATLAS_WRITE_TOKEN: 'write-synthetic-0002' } });
  let stdout = '';
  const announced = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never reported listening: ${stdout}`)), 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((entry) => /"event":"listening"/.test(entry));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.stderr.on('data', (chunk) => { stdout += chunk; });
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`server exited ${code}: ${stdout}`)); });
  });
  t.after(() => { child.stdin.end(); child.kill('SIGKILL'); });
  const ready = await announced;
  assert.equal(ready.index.state, 'REBUILT', 'the startup line proves the index was rebuilt from the store');
  assert.deepEqual(ready.index.spaces, [{ spaceId: 'mira', synced: true, upserted: 2, removed: 0 }]);

  const base = `http://127.0.0.1:${ready.port}`;
  const write = (route, body) => fetch(base + route, {
    method: 'POST', headers: { Authorization: 'Bearer write-synthetic-0002', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const read = (route) => fetch(base + route, { headers: { Authorization: 'Bearer read-synthetic-0001' } })
    .then(async (res) => ({ status: res.status, body: await res.json() }));

  const search = (await read('/atlas/search?space=mira&q=%E5%8F%B0%E7%81%AF')).body;
  assert.equal(search.searchPath, 'atlas-candidates+authoritative', 'the wired path answered over the wire');
  assert.deepEqual(search.records.map((r) => r.recordId), ['lamp']);
  assert.equal(search.index.state, 'WIRED');
  const health = (await read('/atlas/health')).body;
  assert.equal(health.index.state, 'WIRED');
  assert.equal(health.index.engine, 'lexical-engine-test');

  await write('/atlas/retract', { spaceId: 'mira', aboutRecordId: 'lamp' });
  const retracted = (await read('/atlas/search?space=mira&q=%E5%8F%B0%E7%81%AF')).body;
  assert.equal(retracted.outcome, 'NO_MATCH', 'a retraction lands in the derived index in the same request');
});

test('E12b a retrieval module that cannot load stops the server rather than being ignored', async (t) => {
  const dir = tempDir(t, 'atlas-bad-module-');
  const child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'atlas-server.mjs'), '--data-dir', path.join(dir, 'data'), '--port', '0',
    '--retrieval-module', path.join(dir, 'no-such-engine.mjs')
  ], { cwd: ROOT, env: { ...process.env, ATLAS_READ_TOKEN: 'read-synthetic-0001', ATLAS_WRITE_TOKEN: 'write-synthetic-0002' } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => { child.kill('SIGKILL'); resolve('TIMEOUT'); }, 20000);
  });
  assert.equal(code, 1, 'a configured index that failed to attach is a startup failure, not a silent downgrade');
  assert.match(output, /retrieval module failed to load/);
});

test('E13 the same DTO drives the WhiteMoon retrieval engine, when it is on this machine', async (t) => {
  const adapterPath = path.join(GLM_DIR, 'src', 'adapter.mjs');
  if (!fs.existsSync(adapterPath)) {
    t.skip(`WhiteMoon retrieval engine not present at ${GLM_DIR}`);
    return;
  }
  const { SearchAdapter } = await import(pathToFileURL(adapterPath).href);
  // A SQLite-backed projection is a file, so the handle has to go before the
  // directory does - in that order, in one hook. Windows also holds a deleted
  // file briefly, hence the retry budget rather than a bare rmSync.
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-glm-'));
  const cacheDir = path.join(dir, 'derived-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const engine = new SearchAdapter({ path: path.join(cacheDir, 'retrieval-index.sqlite') });
  t.after(() => {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const authority = new NativeAuthority({ dataDir: path.join(dir, 'data') });
  await authority.createSpace({ spaceId: 'mira' });
  const svc = createMemoryService({ authority, retrieval: engine, derivedCacheDir: cacheDir });
  for (const record of [lamp, bag, dislike]) await svc.record('mira', record);

  const assisted = await svc.search({ spaceId: 'mira', query: '台灯' });
  assert.equal(assisted.searchPath, 'atlas-candidates+authoritative');
  assert.deepEqual(assisted.records.map((r) => r.recordId), ['lamp'],
    'the WhiteMoon engine answers the same negative: 台灯 is not 书包');
  assert.equal(assisted.records[0].indexStale, false, 'its revision projection is the record sequence, as frozen');
  const negative = await svc.search({ spaceId: 'mira', query: '不喜欢' });
  assert.deepEqual(negative.records.map((r) => r.recordId), ['dislike']);

  const health = svc.health();
  assert.equal(health.index.state, 'WIRED');
  assert.ok(health.capacity.derivedCacheBytes > 0, 'a file-backed index is measured as derived, not as memory');
  assert.equal(health.capacity.authoritativeBytes,
    createMemoryService({ authority, derivedCacheDir: cacheDir }).health().capacity.authoritativeBytes,
    'and the authoritative bytes do not move when an index is attached');
});

test('E14 the retrieval module never becomes a way to smuggle content past the store', async (t) => {
  const { svc, engine } = await wired(t, { records: [lamp] });
  const leaking = {
    name: 'leaking',
    searchCandidates: async (params) => {
      const payload = await engine.searchCandidates(params);
      return {
        ...payload,
        candidates: payload.candidates.map((candidate) => ({ ...candidate, text: '索引里的正文不应出现', internal: { raw: 'doc' } })),
        coverage: 'ALL_OF_IT'
      };
    }
  };
  const coordinator = createRetrievalCoordinator({
    inspect: (spaceId) => svc.authority.inspect(spaceId), getAdapter: () => leaking
  });
  const result = await coordinator.search({ spaceId: 'mira', options: { query: '台灯' } });
  assert.equal(result.records.length, 1);
  assert.ok(!JSON.stringify(result).includes('索引里的正文不应出现'), 'candidate text is never served');
  assert.ok(!JSON.stringify(result).includes('"internal"'), 'nor are adapter internals');
  assert.ok(!JSON.stringify(result).includes('ALL_OF_IT'), 'an invented response-level coverage claim is not repeated as fact');
  assert.equal(result.records[0].content, lamp.content, 'the content is the store\'s own');
});
