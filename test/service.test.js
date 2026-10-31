import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeAuthority, createMemoryService } from '../src/service.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function service(t, { spaces = ['mira'] } = {}) {
  const dir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: dir });
  for (const spaceId of spaces) await authority.createSpace({ spaceId });
  return { dir, authority, svc: createMemoryService({ authority }) };
}

test('A1 the service runs with no character runtime present', async (t) => {
  const { svc } = await service(t);
  const receipt = await svc.record('mira', {
    recordId: 'tea', kind: 'experience', content: '用户喜欢无糖桂花乌龙',
    source: { kind: 'chat', id: 'msg-0001' }
  });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.outcome, 'RECORDED');
  const found = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(found.outcome, 'MATCHED');
  assert.equal(found.appliedFilters.status, 'active', 'the answer says which validity filter ran');
  assert.equal(found.records[0].source.id, 'msg-0001', 'the original source travels with the record');
});

test('A2 memory spaces are isolated from each other', async (t) => {
  const { svc } = await service(t, { spaces: ['mira', 'other'] });
  await svc.record('mira', { recordId: 'm1', content: 'Mira 的桂花茶', source: { kind: 'chat', id: 'a-1' } });
  await svc.record('other', { recordId: 'o1', content: '另一个空间的桂花茶', source: { kind: 'chat', id: 'b-1' } });
  const mira = await svc.search({ spaceId: 'mira', query: '桂花' });
  const other = await svc.search({ spaceId: 'other', query: '桂花' });
  assert.deepEqual(mira.records.map((r) => r.recordId), ['m1']);
  assert.deepEqual(other.records.map((r) => r.recordId), ['o1']);
  // Asking another authority for a foreign id is a miss, not a leak.
  const cross = await svc.detail({ spaceId: 'mira', recordId: 'o1' });
  assert.equal(cross.outcome, 'NO_MATCH');
});

test('A3 a correction keeps the old text auditable but out of recall', async (t) => {
  const { svc } = await service(t);
  await svc.record('mira', { recordId: 'desk', content: '工位代号是铜雀-19', source: { kind: 'chat', id: 'a-2' } });
  const corrected = await svc.correct('mira', { aboutRecordId: 'desk', content: '工位代号是银杉-84' });
  assert.equal(corrected.accepted, true);

  const recall = await svc.search({ spaceId: 'mira', query: '工位代号' });
  assert.equal(recall.records.length, 1);
  assert.equal(recall.records[0].recordId, corrected.recordId, 'only the correction stands');
  assert.ok(!recall.records.some((r) => /铜雀-19/.test(r.content)));

  const audit = await svc.search({ spaceId: 'mira', query: '工位代号', status: 'all' });
  assert.equal(audit.records.length, 2);
  const old = audit.records.find((r) => r.recordId === 'desk');
  assert.equal(old.status, 'superseded');
  assert.match(old.content, /铜雀-19/, 'the original wording is preserved verbatim');
  assert.equal(old.changedBy, corrected.recordId);

  const detail = await svc.detail({ spaceId: 'mira', recordId: 'desk' });
  assert.equal(detail.record.about === undefined, true);
  assert.equal(detail.related[0].recordId, corrected.recordId, 'the correction chain is walkable both ways');
});

test('A4 a retraction removes a fact from recall without deleting its source', async (t) => {
  const { svc, authority } = await service(t);
  await svc.record('mira', { recordId: 'wrong', content: '用户讨厌香菜', source: { kind: 'chat', id: 'a-3' } });
  const before = fs.readFileSync(authority.store.spacePath('mira'), 'utf8');
  await svc.retract('mira', { aboutRecordId: 'wrong' });
  const recall = await svc.search({ spaceId: 'mira', query: '香菜' });
  assert.equal(recall.outcome, 'NO_MATCH');
  const audit = await svc.search({ spaceId: 'mira', query: '香菜', status: 'all' });
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0].status, 'retracted');
  const after = JSON.parse(fs.readFileSync(authority.store.spacePath('mira'), 'utf8'));
  assert.ok(after.records.some((r) => r.recordId === 'wrong'), 'nothing was deleted from the archive');
  assert.ok(before.includes('a-3') && JSON.stringify(after).includes('a-3'), 'the source reference survives');
});

test('A5 a replayed operation resolves onto one record and stays queryable', async (t) => {
  const { svc } = await service(t);
  const operationId = 'op-atlas-000001';
  const { recordId } = await svc.correct('mira', {
    aboutRecordId: (await svc.record('mira', { recordId: 'target', content: '原记录' })).recordId,
    content: '更正后的内容', operationId
  });
  const replay = await svc.correct('mira', {
    aboutRecordId: 'target', content: '更正后的内容', operationId
  });
  assert.equal(replay.outcome, 'IDEMPOTENT_REPLAY');
  assert.equal(replay.recordId, recordId);
  const looked = await svc.operation('mira', operationId);
  assert.equal(looked.recorded, true);
  assert.equal(looked.recordId, recordId);
  assert.equal(looked.status, 'active');
  const unknown = await svc.operation('mira', 'op-never-used-01');
  assert.equal(unknown.recorded, false);
  assert.equal(unknown.outcome, 'NO_MATCH');
});

test('A6 identity, not text similarity, decides duplication', async (t) => {
  const { svc } = await service(t);
  await svc.record('mira', { recordId: 'said-1', content: '用户喜欢桂花乌龙' });
  await svc.record('mira', { recordId: 'said-2', content: '用户喜欢桂花乌龙' });
  await svc.record('mira', { recordId: 'said-3', content: '用户不喜欢桂花乌龙' });
  const all = await svc.search({ spaceId: 'mira', query: '桂花乌龙', status: 'all' });
  assert.equal(all.totalCount, 3, 'the same sentence said twice is two events');
  const negative = await svc.search({ spaceId: 'mira', query: '不喜欢' });
  assert.deepEqual(negative.records.map((r) => r.recordId), ['said-3']);
});

test('A7 an unreadable space is unavailable, never an empty memory', async (t) => {
  const { svc, authority } = await service(t);
  await svc.record('mira', { recordId: 'x', content: '桂花' });
  fs.writeFileSync(authority.store.spacePath('mira'), '{ truncated', 'utf8');
  const damaged = await svc.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(damaged.outcome, 'SOURCE_UNAVAILABLE');
  assert.equal(damaged.reason, 'DOCUMENT_UNREADABLE');
  assert.notEqual(damaged.outcome, 'NO_MATCH', 'damage must not be rendered as forgetting');

  // A history that parses but cannot be interpreted is a different failure, and
  // is named as such.
  fs.rmSync(authority.store.spacePath('mira'));
  authority.store.save({
    spaceId: 'mira', label: '', createdAt: new Date().toISOString(), nextSequence: 2,
    records: [{ recordId: 'orphan', kind: 'correction', content: '改一下', aboutRecordId: 'never-existed',
      visibility: 'space', recordedAt: new Date().toISOString(), sequence: 1 }]
  });
  const uninterpretable = await svc.search({ spaceId: 'mira', query: '改' });
  assert.equal(uninterpretable.outcome, 'SOURCE_UNAVAILABLE');
  assert.equal(uninterpretable.reason, 'VALIDITY_UNRESOLVABLE');

  const missing = await svc.search({ spaceId: 'no-such-space', query: '桂花' });
  assert.equal(missing.outcome, 'SOURCE_UNAVAILABLE');
  assert.equal(missing.reason, 'SPACE_NOT_FOUND');
});

test('A8 a rebuilt history yields the same view (derived state is reproducible)', async (t) => {
  const { svc, authority, dir } = await service(t);
  await svc.record('mira', { recordId: 'a', content: '桂花乌龙' });
  const correction = await svc.correct('mira', { aboutRecordId: 'a', content: '改成银杉茶' });
  const before = await svc.search({ spaceId: 'mira', status: 'all' });

  // Re-derive validity from the raw record list alone, as a rebuild would.
  const doc = authority.store.read('mira');
  const { deriveValidity } = await import('../src/model.js');
  const rebuilt = deriveValidity([...doc.records].sort((x, y) => x.sequence - y.sequence));
  assert.equal(rebuilt.statuses.get('a'), 'superseded');
  assert.equal(rebuilt.statuses.get(correction.recordId), 'active');

  // A fresh service over the same directory sees exactly the same thing.
  const restarted = createMemoryService({ authority: new NativeAuthority({ dataDir: dir }) });
  const after = await restarted.search({ spaceId: 'mira', status: 'all' });
  assert.deepEqual(after.records.map((r) => [r.recordId, r.status]), before.records.map((r) => [r.recordId, r.status]));
  assert.equal(after.revision, before.revision);
});

test('A9 capacity separates authoritative bytes from derived cache', async (t) => {
  const { svc, dir } = await service(t);
  await svc.record('mira', { recordId: 'a', content: '桂花' });
  const cacheDir = path.join(dir, 'derived-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'index.bin'), 'x'.repeat(50_000), 'utf8');
  const withCache = createMemoryService({ authority: svc.authority, capacityTargetBytes: 20_000_000_000, derivedCacheDir: cacheDir });
  const health = withCache.health();
  assert.ok(health.capacity.authoritativeBytes < 50_000, 'cache bytes must not be counted as memory');
  assert.equal(health.capacity.derivedCacheBytes, 50_000);
  assert.equal(health.capacity.capacityTargetBytes, 20_000_000_000);
  assert.equal(health.capacity.policy.autoDiscardOriginals, false);
  assert.equal(health.capacity.policy.enforceLimit, false);
  assert.equal(health.derivedCache.path, cacheDir);
  assert.equal(health.index.state, 'NOT_WIRED', 'no index is claimed when none is wired');
});

test('A10 a time window is evaluated over the whole history, on a named clock', async (t) => {
  const { svc } = await service(t);
  for (let day = 1; day <= 20; day += 1) {
    await svc.record('mira', {
      recordId: `d-${day}`, content: `第 ${day} 天的桂花记录`,
      occurredAt: new Date(Date.UTC(2026, 0, day, 8)).toISOString()
    });
  }
  const window = await svc.search({
    spaceId: 'mira', query: '桂花', status: 'all',
    since: '2026-01-05T00:00:00.000Z', until: '2026-01-09T23:59:59.000Z', timeField: 'occurredAt', limit: 100
  });
  assert.equal(window.timeField, 'occurredAt');
  assert.equal(window.totalCount, 5);
  assert.deepEqual(window.records.map((r) => r.recordId).sort(), ['d-5', 'd-6', 'd-7', 'd-8', 'd-9']);
  const unwindowed = await svc.search({ spaceId: 'mira', query: '桂花', status: 'all', limit: 100 });
  assert.equal(unwindowed.totalCount, 20);
  await assert.rejects(svc.search({ spaceId: 'mira', since: 'nonsense' }), /parseable date-time/);
  await assert.rejects(svc.search({ spaceId: 'mira', since: '2026-02-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }), /must not be after/);
});

test('A11 pagination reports real boundaries and content can be withheld', async (t) => {
  const { svc } = await service(t);
  for (let i = 0; i < 12; i += 1) await svc.record('mira', { recordId: `p-${i}`, content: `分页 ${i} 号 桂花` });
  const first = await svc.search({ spaceId: 'mira', query: '桂花', limit: 5, offset: 0 });
  assert.equal(first.totalCount, 12);
  assert.equal(first.returned, 5);
  assert.equal(first.hasMore, true);
  const last = await svc.search({ spaceId: 'mira', query: '桂花', limit: 5, offset: 10 });
  assert.equal(last.returned, 2);
  assert.equal(last.hasMore, false);
  const quiet = await svc.search({ spaceId: 'mira', query: '桂花', limit: 3, includeContent: false });
  assert.ok(quiet.records.every((r) => r.content === undefined && r.contentLength > 0));
});

test('A12 a malformed record is refused by name and writes nothing', async (t) => {
  const { svc, authority } = await service(t);
  const before = fs.readFileSync(authority.store.spacePath('mira'), 'utf8');
  await assert.rejects(svc.record('mira', { recordId: 'bad', content: '  ' }), /non-empty content/);
  await assert.rejects(svc.record('mira', { recordId: 'bad', content: 'x', kind: 'not-a-kind' }), /Unknown record kind/);
  await assert.rejects(svc.record('mira', { recordId: 'bad', content: 'x', visibility: 'public' }), /Unknown visibility/);
  await assert.rejects(svc.record('mira', { recordId: 'bad', content: 'x', source: { kind: 'chat' } }), /id or href/);
  await assert.rejects(svc.record('mira', { recordId: 'bad', content: 'x', unknownField: 1 }), /Unknown record field/);
  await assert.rejects(svc.retract('mira', { aboutRecordId: 'ghost' }), /unknown record/);
  assert.equal(fs.readFileSync(authority.store.spacePath('mira'), 'utf8'), before,
    'a refused control must leave the archive untouched');

  // A second control against an already-changed record is refused too, so no
  // history can end up with two competing "current" answers.
  await svc.record('mira', { recordId: 'real', content: '真实记录' });
  await svc.correct('mira', { aboutRecordId: 'real', content: '第一次更正' });
  await assert.rejects(svc.correct('mira', { aboutRecordId: 'real', content: '第二次更正' }), /no longer active/);
  const audit = await svc.search({ spaceId: 'mira', status: 'all' });
  assert.equal(audit.records.filter((r) => r.kind === 'correction').length, 1);
});

test('A13 reusing an identity for a different claim is a conflict, not a duplicate receipt', async (t) => {
  const { svc, authority } = await service(t);
  const first = await svc.record('mira', {
    recordId: 'lamp', kind: 'experience', content: '书桌上有一盏台灯', source: { kind: 'chat', id: 'msg-1' }
  });
  assert.equal(first.outcome, 'RECORDED');

  const changedContent = await svc.record('mira', {
    recordId: 'lamp', kind: 'experience', content: '书桌上有一个书包', source: { kind: 'chat', id: 'msg-1' }
  }).catch((error) => error);
  assert.equal(changedContent.code, 'ATLAS_IDENTITY_CONFLICT');
  assert.deepEqual(changedContent.differingFields, ['content']);
  assert.equal(changedContent.duplicateOf.recordId, 'lamp');

  const changedSource = await svc.record('mira', {
    recordId: 'lamp', kind: 'experience', content: '书桌上有一盏台灯', source: { kind: 'photo', id: 'msg-9' }
  }).catch((error) => error);
  assert.equal(changedSource.code, 'ATLAS_IDENTITY_CONFLICT');
  assert.deepEqual(changedSource.differingFields, ['source']);

  const changedKind = await svc.record('mira', {
    recordId: 'lamp', kind: 'note', content: '书桌上有一盏台灯', source: { kind: 'chat', id: 'msg-1' }
  }).catch((error) => error);
  assert.deepEqual(changedKind.differingFields, ['kind']);

  const doc = authority.store.read('mira');
  assert.equal(doc.records.length, 1, 'a refused reuse must store nothing at all');
  assert.equal(doc.records[0].content, '书桌上有一盏台灯');

  // The same claim submitted again is still a true duplicate: same receipt, no row.
  const retry = await svc.record('mira', {
    recordId: 'lamp', kind: 'experience', content: '书桌上有一盏台灯', source: { kind: 'chat', id: 'msg-1' }
  });
  assert.equal(retry.outcome, 'IDEMPOTENT_DUPLICATE');
  assert.equal(retry.accepted, true);
  assert.equal(authority.store.read('mira').records.length, 1);
});

test('A14 one operation id cannot carry two different operations', async (t) => {
  const { svc, authority } = await service(t);
  await svc.record('mira', { recordId: 'target', content: '工位代号是铜雀-19' });
  const operationId = 'op-single-00001';
  const correction = await svc.correct('mira', { aboutRecordId: 'target', content: '改成银杉-84', operationId });
  assert.equal(correction.outcome, 'RECORDED');

  const differentAction = await svc.retract('mira', { aboutRecordId: 'target', operationId }).catch((error) => error);
  assert.equal(differentAction.code, 'ATLAS_OPERATION_CONFLICT',
    'a retraction reusing a correction operation id must not be answered with that correction');
  assert.ok(differentAction.differingFields.includes('kind'));

  const differentTarget = await svc.correct('mira', { aboutRecordId: 'lamp', content: '改成银杉-84', operationId })
    .catch((error) => error);
  assert.equal(differentTarget.code, 'ATLAS_OPERATION_CONFLICT');
  assert.ok(differentTarget.differingFields.includes('aboutRecordId'));

  const differentText = await svc.correct('mira', { aboutRecordId: 'target', content: '改成别的', operationId })
    .catch((error) => error);
  assert.ok(differentText.differingFields.includes('content'));

  const sameAgain = await svc.correct('mira', { aboutRecordId: 'target', content: '改成银杉-84', operationId });
  assert.equal(sameAgain.outcome, 'IDEMPOTENT_REPLAY');
  assert.equal(sameAgain.recordId, correction.recordId);
  assert.equal(sameAgain.status, 'active');

  const doc = authority.store.read('mira');
  assert.equal(doc.records.filter((r) => r.kind === 'correction').length, 1);
  assert.equal(doc.records.length, 2, 'the target and one correction; the refused attempts added nothing');
});
