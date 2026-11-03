import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { createAtlasServer } from '../src/http.js';
import { AtlasClient } from '../src/client.js';
import { createFeedbackStore } from '../src/feedback.js';

const READ = 'read-token-synthetic-fb01';
const WRITE = 'write-token-synthetic-fb02';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function service(t, { spaces = ['mira'] } = {}) {
  const dir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: dir });
  for (const spaceId of spaces) await authority.createSpace({ spaceId });
  return { dir, authority, svc: createMemoryService({ authority }) };
}

async function seed(svc, spaceId = 'mira', recordId = 'dentist') {
  await svc.record(spaceId, { recordId, kind: 'experience', content: '周五下午四点半和牙医有预约', source: { kind: 'chat', id: 's-1' } });
}

test('F1 feedback is a report, not a verdict: status and search are untouched', async (t) => {
  const { svc } = await service(t);
  await seed(svc);
  const entry = await svc.feedback('mira', { recordId: 'dentist', signal: 'incorrect', note: '时间可能记错了', source: { kind: 'mcp', id: 'agent' } });
  assert.equal(entry.type, 'feedback');
  assert.ok(entry.feedbackId.startsWith('fb-'));
  assert.equal(entry.signal, 'incorrect');

  const detail = await svc.detail({ spaceId: 'mira', recordId: 'dentist' });
  assert.equal(detail.record.status, 'active', 'feedback must not change validity');
  const recall = await svc.search({ spaceId: 'mira', query: '牙医' });
  assert.equal(recall.records.length, 1, 'feedback must not enter or alter search');
  assert.equal(recall.records[0].recordId, 'dentist');

  const pending = svc.feedbackList('mira', { status: 'pending' });
  assert.equal(pending.feedback.length, 1);
  assert.equal(pending.feedback[0].resolution, null);
});

test('F2 flagging a ghost record is refused', async (t) => {
  const { svc } = await service(t);
  await seed(svc);
  await assert.rejects(() => svc.feedback('mira', { recordId: 'no-such', signal: 'incorrect' }),
    (e) => e.code === 'ATLAS_FEEDBACK_TARGET_MISSING');
});

test('F3 signal and note are validated', async (t) => {
  const { svc } = await service(t);
  await seed(svc);
  await assert.rejects(() => svc.feedback('mira', { recordId: 'dentist', signal: 'maybe' }),
    (e) => e.code === 'ATLAS_FEEDBACK_INVALID');
  await assert.rejects(() => svc.feedback('mira', { recordId: 'dentist', signal: 'useful', note: 'x'.repeat(1001) }),
    (e) => e.code === 'ATLAS_FEEDBACK_INVALID');
});

test('F4 resolution replays: pending -> dismissed / actioned', async (t) => {
  const { svc } = await service(t);
  await seed(svc);
  const a = await svc.feedback('mira', { recordId: 'dentist', signal: 'incorrect' });
  const b = await svc.feedback('mira', { recordId: 'dentist', signal: 'useful' });
  svc.resolveFeedback('mira', { feedbackId: a.feedbackId, resolution: 'dismissed', by: 'user' });
  svc.resolveFeedback('mira', { feedbackId: b.feedbackId, resolution: 'actioned', by: 'user' });

  assert.equal(svc.feedbackList('mira', { status: 'pending' }).feedback.length, 0);
  const all = svc.feedbackList('mira', { status: 'all' }).feedback;
  assert.equal(all.length, 2);
  const byId = Object.fromEntries(all.map((f) => [f.feedbackId, f]));
  assert.equal(byId[a.feedbackId].resolution, 'dismissed');
  assert.equal(byId[b.feedbackId].resolution, 'actioned');
  assert.equal(svc.feedbackList('mira', { status: 'dismissed' }).feedback.length, 1);
  assert.throws(() => svc.resolveFeedback('mira', { feedbackId: 'fb-ghost', resolution: 'dismissed' }),
    (e) => e.code === 'ATLAS_FEEDBACK_NOT_FOUND');
});

test('F5 acting on a flagged record closes its pending signals', async (t) => {
  const { svc } = await service(t);
  await seed(svc);
  await svc.feedback('mira', { recordId: 'dentist', signal: 'incorrect', note: '应为五点' });
  assert.equal(svc.feedbackList('mira', { status: 'pending' }).feedback.length, 1);
  await svc.correct('mira', { aboutRecordId: 'dentist', content: '周五下午五点和牙医有预约' });
  const pending = svc.feedbackList('mira', { status: 'pending' }).feedback;
  assert.equal(pending.length, 0, 'a human correction closes the review');
  assert.equal(svc.feedbackList('mira', { status: 'actioned' }).feedback.length, 1);
});

test('F6 feedback spaces are isolated', async (t) => {
  const { svc } = await service(t, { spaces: ['mira', 'other'] });
  await seed(svc, 'mira', 'm1');
  await seed(svc, 'other', 'o1');
  await svc.feedback('mira', { recordId: 'm1', signal: 'incorrect' });
  assert.equal(svc.feedbackList('mira', { status: 'pending' }).feedback.length, 1);
  assert.equal(svc.feedbackList('other', { status: 'pending' }).feedback.length, 0);
});

test('F7 the log is append-only and replays from disk', async (t) => {
  const dir = tempDir(t);
  const store = createFeedbackStore(dir);
  await store.submit({ spaceId: 'mira', recordId: 'r1', signal: 'incorrect' });
  const file = path.join(dir, 'feedback', 'mira.jsonl');
  const linesBefore = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  // A fresh store instance (new process) sees the same pending signal.
  const reopened = createFeedbackStore(dir);
  assert.equal(reopened.list('mira', { status: 'pending' }).feedback.length, 1);
  const entry = reopened.list('mira', { status: 'pending' }).feedback[0];
  reopened.resolve({ spaceId: 'mira', feedbackId: entry.feedbackId, resolution: 'dismissed' });
  const linesAfter = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  assert.equal(linesAfter, linesBefore + 1, 'resolution appends; it never rewrites the feedback line');
  assert.equal(reopened.list('mira', { status: 'pending' }).feedback.length, 0);
});

test('F8 HTTP surface: write needs the write token; read needs the read token', async (t) => {
  const dir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const svc = createMemoryService({ authority });
  await seed(svc);
  const server = createAtlasServer({ service: svc, readToken: READ, writeToken: WRITE });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = new AtlasClient({ baseUrl: `http://127.0.0.1:${port}`, readToken: READ, writeToken: WRITE });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

  const raw = async (route, { method = 'GET', token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  assert.equal((await raw('/atlas/feedback?space=mira')).status, 401, 'read needs a token');
  assert.equal((await raw('/atlas/feedback?space=mira', { token: WRITE })).status, 401, 'write token is not a read token');
  assert.equal((await raw('/atlas/feedback', { method: 'POST', token: READ, body: { spaceId: 'mira', recordId: 'dentist', signal: 'incorrect' } })).status, 401, 'read token cannot write feedback');

  const posted = await client.feedback({ spaceId: 'mira', recordId: 'dentist', signal: 'incorrect', note: 'via http', source: { kind: 'mcp', id: 'test' } });
  assert.equal(posted.ok, true);
  assert.ok(posted.feedbackId);

  const listed = await client.feedbackList({ spaceId: 'mira', status: 'pending' });
  assert.equal(listed.ok, true);
  assert.equal(listed.feedback.length, 1);

  const resolved = await client.resolveFeedback({ spaceId: 'mira', feedbackId: posted.feedbackId, resolution: 'dismissed', by: 'user' });
  assert.equal(resolved.ok, true);
  assert.equal((await client.feedbackList({ spaceId: 'mira', status: 'pending' })).feedback.length, 0);

  const missing = await raw('/atlas/feedback', { method: 'POST', token: WRITE, body: { spaceId: 'mira', recordId: 'ghost', signal: 'incorrect' } });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'ATLAS_FEEDBACK_TARGET_MISSING');
});
