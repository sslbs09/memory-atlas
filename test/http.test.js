import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { createAtlasServer } from '../src/http.js';
import { AtlasClient } from '../src/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ = 'read-token-synthetic-0001';
const WRITE = 'write-token-synthetic-0002';

async function started(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authority = new NativeAuthority({ dataDir: dir });
  await authority.createSpace({ spaceId: 'mira' });
  const service = createMemoryService({ authority });
  const server = createAtlasServer({ service, readToken: READ, writeToken: WRITE });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AtlasClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, readToken: READ, writeToken: WRITE });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { dir, authority, service, server, client, port: server.address().port };
}

async function raw(port, { path: route, method = 'GET', token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('H1 liveness needs no token; every other surface does', async (t) => {
  const { client, port } = await started(t);
  const live = await client.liveness();
  assert.equal(live.ok, true);
  assert.equal(live.service, 'memory-atlas');

  assert.equal((await raw(port, { path: '/atlas/health' })).status, 401);
  assert.equal((await raw(port, { path: '/atlas/health', token: WRITE })).status, 401, 'the write token is not a read token');
  assert.equal((await raw(port, { path: '/atlas/health', token: READ })).status, 200);
  assert.equal((await raw(port, { path: '/atlas/spaces', token: READ })).status, 200);
  // A read token must not be able to write: the capability split is real.
  const refused = await raw(port, { path: '/atlas/record', method: 'POST', token: READ, body: { spaceId: 'mira', record: { recordId: 'x', content: '桂花' } } });
  assert.equal(refused.status, 401);
  assert.equal((await client.search({ spaceId: 'mira', query: '桂花' })).outcome, 'NO_MATCH');
});

test('H2 the loopback API answers a full write / recall / correct / audit cycle', async (t) => {
  const { client } = await started(t);
  const receipt = await client.record({
    spaceId: 'mira',
    record: { recordId: 'tea', kind: 'experience', content: '用户喜欢无糖桂花乌龙茶', source: { kind: 'chat', id: 'msg-1' } }
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, 'RECORDED');

  const recall = await client.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(recall.records[0].source.id, 'msg-1');
  assert.equal(recall.records[0].status, 'active');

  const corrected = await client.correct({ spaceId: 'mira', aboutRecordId: 'tea', content: '改喝银杉茶', operationId: 'http-op-000001' });
  assert.equal(corrected.ok, true);
  const effective = await client.search({ spaceId: 'mira', query: '茶' });
  assert.deepEqual(effective.records.map((r) => r.recordId), [corrected.recordId]);
  const audit = await client.search({ spaceId: 'mira', query: '茶', status: 'all' });
  assert.equal(audit.records.length, 2);
  const replay = await client.correct({ spaceId: 'mira', aboutRecordId: 'tea', content: '改喝银杉茶', operationId: 'http-op-000001' });
  assert.equal(replay.outcome, 'IDEMPOTENT_REPLAY');
  assert.equal(replay.recordId, corrected.recordId);
  const looked = await client.operation({ spaceId: 'mira', operationId: 'http-op-000001' });
  assert.equal(looked.recorded, true);
  assert.equal(looked.status, 'active');
});

test('H3 an unknown parameter is refused by name and never ignored', async (t) => {
  const { port } = await started(t);
  const bad = await raw(port, { path: '/atlas/search?space=mira&queryy=桂花', token: READ });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'ATLAS_QUERY_INVALID');
  assert.match(bad.body.error, /queryy/);
});

test('H4 an unreadable space is a 503 with a reason, not a 200 with an empty list', async (t) => {
  const { client, authority, port } = await started(t);
  await client.record({ spaceId: 'mira', record: { recordId: 'x', content: '桂花' } });
  fs.writeFileSync(authority.store.spacePath('mira'), '{ broken', 'utf8');
  const result = await client.search({ spaceId: 'mira', query: '桂花' });
  assert.equal(result.httpStatus, 503);
  assert.equal(result.outcome, 'SOURCE_UNAVAILABLE');
  assert.equal(result.records.length, 0, 'no records are served, and the reason is stated');
  assert.equal((await raw(port, { path: '/atlas/detail?space=mira&id=x', token: READ })).status, 503);
});

test('H5 health separates authoritative bytes from derived cache and states the policy', async (t) => {
  const { client, dir } = await started(t);
  await client.record({ spaceId: 'mira', record: { recordId: 'x', content: '桂花' } });
  const cache = path.join(dir, 'derived-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'index.bin'), 'y'.repeat(40_000), 'utf8');
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.capacity.capacityTargetBytes, 20_000_000_000);
  assert.equal(health.capacity.policy.autoDiscardOriginals, false);
  assert.equal(health.capacity.policy.enforceLimit, false);
  assert.ok(health.capacity.authoritativeBytes < 40_000, 'cache bytes are not counted as memory');
  assert.equal(health.index.state, 'NOT_WIRED');
});

test('H6 the server starts and stops as its own process, driven only by the client', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['bin/atlas-server.mjs', '--data-dir', dir, '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, ATLAS_READ_TOKEN: READ, ATLAS_WRITE_TOKEN: WRITE, TMP: process.env.TMP, TEMP: process.env.TEMP }
  });
  let stderr = '';
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`no listening line within 20s; stderr: ${stderr}`)), 20000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'listening') { clearTimeout(timer); resolve(event.port); }
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (code ${code}); stderr: ${stderr}`)); });
  });

  const client = new AtlasClient({ baseUrl: `http://127.0.0.1:${port}`, readToken: READ, writeToken: WRITE });
  assert.equal((await client.liveness()).ok, true);
  assert.equal((await client.createSpace('persisted')).ok, true);
  await client.record({ spaceId: 'persisted', record: { recordId: 'p1', content: '跨进程存活的桂花茶', source: { kind: 'demo', id: 'd-1' } } });
  await client.correct({ spaceId: 'persisted', aboutRecordId: 'p1', content: '改成银杉茶', operationId: 'proc-op-000001' });
  const before = await client.search({ spaceId: 'persisted', query: '茶', status: 'all' });
  assert.equal(before.totalCount, 2);

  // Graceful stop over stdin, then a brand new process over the same directory.
  child.stdin.end();
  await new Promise((resolve) => {
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 6000);
    child.on('exit', () => { clearTimeout(kill); resolve(); });
  });

  const second = spawn(process.execPath, ['bin/atlas-server.mjs', '--data-dir', dir, '--port', '0'], {
    cwd: ROOT, env: { ...process.env, ATLAS_READ_TOKEN: READ, ATLAS_WRITE_TOKEN: WRITE }
  });
  t.after(() => { try { second.kill('SIGKILL'); } catch { /* already gone */ } });
  const port2 = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('second server never reported a port')), 20000);
    second.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'listening') { clearTimeout(timer); resolve(event.port); }
      }
    });
  });
  const client2 = new AtlasClient({ baseUrl: `http://127.0.0.1:${port2}`, readToken: READ, writeToken: WRITE });
  const after = await client2.search({ spaceId: 'persisted', query: '茶', status: 'all' });
  assert.equal(after.totalCount, 2, 'the archive survived a full process restart');
  const effective = await client2.search({ spaceId: 'persisted', query: '茶' });
  assert.deepEqual(effective.records.map((r) => r.content), ['改成银杉茶'], 'and so did the correction: only the new text stands');
  const replayed = await client2.correct({ spaceId: 'persisted', aboutRecordId: 'p1', content: '改成银杉茶', operationId: 'proc-op-000001' });
  assert.equal(replayed.outcome, 'IDEMPOTENT_REPLAY', 'operation identity survives the restart too');
  second.stdin.end();
  await new Promise((resolve) => {
    const kill = setTimeout(() => { try { second.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 6000);
    second.on('exit', () => { clearTimeout(kill); resolve(); });
  });
});

test('H8 an identity reused for different content is a 409 that names the fields', async (t) => {
  const { client, port } = await started(t);
  await client.record({ spaceId: 'mira', record: { recordId: 'lamp', content: '台灯', source: { kind: 'chat', id: 'm-1' } } });
  const clash = await raw(port, {
    path: '/atlas/record', method: 'POST', token: WRITE,
    body: { spaceId: 'mira', record: { recordId: 'lamp', content: '书包', source: { kind: 'chat', id: 'm-1' } } }
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'ATLAS_IDENTITY_CONFLICT');
  assert.deepEqual(clash.body.differingFields, ['content']);
  assert.equal(clash.body.duplicateOf.recordId, 'lamp');
  const view = await client.search({ spaceId: 'mira', query: '台灯', status: 'all' });
  assert.equal(view.records.length, 1);
  assert.equal(view.records[0].content, '台灯', 'the refused write stored nothing');
});

test('H7 a malformed request is refused with a code and writes nothing', async (t) => {
  const { port, authority } = await started(t);
  const before = fs.readFileSync(authority.store.spacePath('mira'), 'utf8');
  const cases = [
    { spaceId: 'mira', record: { recordId: 'bad', content: '   ' } },
    { spaceId: 'mira', record: { recordId: 'bad', content: 'x', kind: 'nope' } },
    { spaceId: 'mira', record: { recordId: 'bad', content: 'x', source: { kind: 'chat' } } },
    { spaceId: 'no-such-space', record: { recordId: 'bad', content: 'x' } },
    { spaceId: 'mira', aboutRecordId: 'ghost', content: '更正', }
  ];
  for (const body of cases) {
    const route = body.aboutRecordId ? '/atlas/correct' : '/atlas/record';
    const result = await raw(port, { path: route, method: 'POST', token: WRITE, body });
    assert.ok(result.status >= 400, `expected refusal for ${JSON.stringify(body)}, got ${result.status}`);
    assert.ok(result.body.code, `a refusal must name its code: ${JSON.stringify(result.body)}`);
  }
  assert.equal(fs.readFileSync(authority.store.spacePath('mira'), 'utf8'), before);
});
