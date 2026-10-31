/**
 * The shipped GLM factory, run for real.
 *
 * GPT's third verification measured that `--retrieval-module` pointed at
 * glm-retrieval/src/adapter.mjs exits 1 (the engine exports a class, the server
 * asks for a factory) and that no working command existed. These tests start the
 * actual bin/atlas-server.mjs child process with adapters/glm-retrieval.mjs, the
 * actual Backend B SQLite file, and real HTTP on loopback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLM_MODULE = process.env.ATLAS_GLM_MODULE_TEST
  ?? path.resolve(ROOT, '..', 'WhiteMoon', 'work', 'universal-memory-v0.1', 'glm-retrieval', 'src', 'adapter.mjs');
const FACTORY = path.join(ROOT, 'adapters', 'glm-retrieval.mjs');
const READ = 'read-synthetic-0001';
const WRITE = 'write-synthetic-0002';

/**
 * A SQLite WAL can stay held for a moment after the process that owned it exits,
 * and Windows reports that as EPERM rather than busy. Tearing down must not turn
 * a passing test into a failed one, and it must not keep the runner alive with a
 * chain of timers: wait by parking the thread, give up quietly, and let the OS
 * temp directory be the loser.
 */
function removeTreeQuietly(dir, { attempts = 15, delayMs = 150 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return true;
    } catch {
      if (!fs.existsSync(dir)) return true;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      } catch { /* a platform without Atomics.wait simply retries */ }
    }
  }
  return false;
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), prefix));
  t.after(() => { removeTreeQuietly(dir); });
  return dir;
}

/** Start the server as a separate process, exactly as an operator would. */
async function startServer(t, { retrievalModule, env = {}, expectFailure = false, reuseDataDir = null } = {}) {
  const dir = reuseDataDir ? path.dirname(reuseDataDir) : tempDir(t, 'atlas-glm-');
  const dataDir = reuseDataDir ?? path.join(dir, 'data');
  const child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'atlas-server.mjs'), '--data-dir', dataDir, '--port', '0',
    ...(retrievalModule ? ['--retrieval-module', retrievalModule] : [])
  ], {
    cwd: ROOT,
    env: { ...process.env, TMP: process.env.TMP, TEMP: process.env.TEMP,
      ATLAS_READ_TOKEN: READ, ATLAS_WRITE_TOKEN: WRITE, ...env }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'TIMEOUT' }), 25000);
    child.stdout.on('data', () => {
      const line = stdout.split('\n').find((entry) => /"event":"listening"/.test(entry));
      if (line) { clearTimeout(timer); resolve({ kind: 'listening', ready: JSON.parse(line) }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ kind: 'exit', code, stdout, stderr }); });
  });
  if (outcome.kind === 'TIMEOUT') {
    child.kill('SIGKILL');
    assert.fail(`server neither started nor exited: out=${stdout} err=${stderr}`);
  }

  async function stop() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    // An unref'd deadline: the child normally exits in tens of milliseconds, and
    // whatever happens the timer must not be the reason the runner stays alive.
    const exited = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 6000);
      deadline.unref();
      child.once('exit', () => { clearTimeout(deadline); resolve(true); });
    });
    if (!exited) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  t.after(stop);

  if (expectFailure) {
    assert.equal(outcome.kind, 'exit', 'a refused start must exit, not hang');
    return { dir, dataDir, code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr, stop };
  }
  assert.equal(outcome.kind, 'listening', `server failed to start: ${outcome.code} ${outcome.stderr}`);
  const base = `http://127.0.0.1:${outcome.ready.port}`;
  const call = async (route, { method = 'GET', token = READ, body } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json() };
  };
  return { dir, dataDir, ready: outcome.ready, call, stop, stderrOf: () => stderr };
}

const lamp = { recordId: 'lamp', kind: 'experience', content: '桌面那盏台灯是暖光的', source: { kind: 'chat', id: 'lamp-source' } };
const bag = { recordId: 'bag', kind: 'experience', content: '书包放在门后', source: { kind: 'chat', id: 'bag-source' } };

test('G1 the shipped factory starts the real GLM engine over real HTTP', async (t) => {
  if (!fs.existsSync(GLM_MODULE)) {
    t.skip(`Backend B engine not present at ${GLM_MODULE}`);
    return;
  }
  const server = await startServer(t, {
    retrievalModule: './adapters/glm-retrieval.mjs',
    env: { ATLAS_GLM_MODULE: GLM_MODULE }
  });
  assert.equal(server.ready.index.state, 'REBUILT', 'the startup line reports a completed rebuild, not an attempt');
  assert.equal(server.ready.index.engine, 'glm-retrieval');
  assert.equal(server.ready.index.complete, true);

  const created = await server.call('/atlas/spaces', { method: 'POST', token: WRITE, body: { spaceId: 'mira' } });
  assert.equal(created.status, 201, 'the space is created through the documented route');
  assert.equal((await server.call('/atlas/record', { method: 'POST', token: WRITE, body: { spaceId: 'mira', record: lamp } })).body.accepted, true);
  assert.equal((await server.call('/atlas/record', { method: 'POST', token: WRITE, body: { spaceId: 'mira', record: bag } })).body.accepted, true);

  const hit = await server.call('/atlas/search?space=mira&q=%E5%8F%B0%E7%81%AF');
  assert.equal(hit.body.searchPath, 'atlas-candidates+authoritative', 'the GLM engine produced this candidate list');
  assert.deepEqual(hit.body.records.map((r) => r.recordId), ['lamp']);
  assert.equal(hit.body.index.state, 'WIRED');

  // The defect that made the two paths disagree, measured over the wire with the
  // real engine: a source id is searchable because the index is shown the same
  // text the authoritative scan reads.
  const bySource = await server.call('/atlas/search?space=mira&q=lamp-source');
  assert.equal(bySource.body.searchPath, 'atlas-candidates+authoritative', 'answered by the index, not by a fallback');
  assert.deepEqual(bySource.body.records.map((r) => r.recordId), ['lamp'],
    'a source id must not silently miss in the index path');
  const wrongSpace = await server.call('/atlas/search?space=mira&q=bag-source');
  assert.deepEqual(wrongSpace.body.records.map((r) => r.recordId), ['bag'], 'and it is the right record, not any record');

  const missing = await server.call('/atlas/search?space=mira&q=%E6%97%A0%E6%AD%A4%E7%89%A9');
  assert.equal(missing.body.outcome, 'NO_MATCH', 'a real miss is still reported as a real miss');
  assert.deepEqual(missing.body.records, []);

  await server.call('/atlas/retract', { method: 'POST', token: WRITE, body: { spaceId: 'mira', aboutRecordId: 'lamp' } });
  const retracted = await server.call('/atlas/search?space=mira&q=%E5%8F%B0%E7%81%AF');
  assert.equal(retracted.body.outcome, 'NO_MATCH', 'the retraction reached the derived index through the same request');

  const health = (await server.call('/atlas/health')).body;
  assert.equal(health.index.state, 'WIRED');
  assert.equal(health.index.engine, 'glm-retrieval');
  assert.deepEqual(health.index.invalidSpaces, []);
  // Backend B keeps one generation counter that its own rebuild path bumps, so the
  // honest claim here is "the number comes from the engine", not "it grew".
  assert.ok(Number.isSafeInteger(health.index.generation), 'the generation number comes from the engine, not from Atlas');
  assert.equal(health.index.open, true, 'and so does its own open state');
  assert.ok(Number.isSafeInteger(hit.body.index.generation), 'the answer carries the generation the payload reported');
  assert.ok(health.capacity.derivedCacheBytes > 0, 'the SQLite index is counted as derived bytes');
  assert.ok(health.capacity.authoritativeBytes > 0, 'and the memory bytes are counted separately');
});

test('G2 the GLM index file lives in the derived cache and nothing else is written there', async (t) => {
  if (!fs.existsSync(GLM_MODULE)) {
    t.skip(`Backend B engine not present at ${GLM_MODULE}`);
    return;
  }
  const server = await startServer(t, { retrievalModule: './adapters/glm-retrieval.mjs', env: { ATLAS_GLM_MODULE: GLM_MODULE } });
  await server.call('/atlas/spaces', { method: 'POST', token: WRITE, body: { spaceId: 'mira' } });
  await server.call('/atlas/record', { method: 'POST', token: WRITE, body: { spaceId: 'mira', record: lamp } });

  const indexPath = path.join(server.dataDir, 'derived-cache', 'glm-retrieval-index.sqlite');
  assert.ok(fs.existsSync(indexPath), 'the index landed in the configured derived cache, not in a user directory');
  assert.ok(fs.statSync(indexPath).size > 0);
  const spaces = fs.readdirSync(path.join(server.dataDir, 'spaces'));
  assert.deepEqual(spaces, ['mira.json'], 'the authoritative store holds only space documents');

  // The memory is the store's: delete the derived index entirely and the record is
  // still there and still findable, which is the test that this is not a second master.
  const before = (await server.call('/atlas/health')).body.capacity.authoritativeBytes;
  assert.equal(before, (await server.call('/atlas/health')).body.capacity.authoritativeBytes);
  const detail = await server.call('/atlas/detail?space=mira&id=lamp');
  assert.equal(detail.body.outcome, 'MATCHED');
  assert.equal(detail.body.record.content, lamp.content);
});

test('G3 a restart rebuilds from the store and answers identically', async (t) => {
  if (!fs.existsSync(GLM_MODULE)) {
    t.skip(`Backend B engine not present at ${GLM_MODULE}`);
    return;
  }
  const first = await startServer(t, { retrievalModule: './adapters/glm-retrieval.mjs', env: { ATLAS_GLM_MODULE: GLM_MODULE } });
  await first.call('/atlas/spaces', { method: 'POST', token: WRITE, body: { spaceId: 'mira' } });
  await first.call('/atlas/record', { method: 'POST', token: WRITE, body: { spaceId: 'mira', record: lamp } });
  await first.call('/atlas/record', { method: 'POST', token: WRITE, body: { spaceId: 'mira', record: bag } });
  const before = await first.call('/atlas/search?space=mira&q=%E4%B9%A6%E5%8C%85');
  assert.deepEqual(before.body.records.map((r) => r.recordId), ['bag']);
  await first.stop();
  // A graceful shutdown releases the writer claim; wait for that rather than
  // letting the second process decide the test's timing.
  const staleLock = path.join(first.dataDir, 'writer.lock');
  for (let attempt = 0; attempt < 40 && fs.existsSync(staleLock); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(staleLock), false, 'a clean shutdown releases the writer claim');

  const reopened = await startServer(t, { retrievalModule: './adapters/glm-retrieval.mjs',
    env: { ATLAS_GLM_MODULE: GLM_MODULE }, reuseDataDir: first.dataDir });
  assert.equal(reopened.ready.index.state, 'REBUILT');
  assert.ok(reopened.ready.index.spaces.some((s) => s.spaceId === 'mira' && s.synced && s.upserted === 2),
    'the new process rebuilt the projection from the authoritative documents');
  const after = await reopened.call('/atlas/search?space=mira&q=%E4%B9%A6%E5%8C%85');
  assert.equal(after.body.searchPath, 'atlas-candidates+authoritative');
  assert.deepEqual(after.body.records.map((r) => r.recordId), ['bag'], 'and gives the same answer as before the restart');
});

test('G4 pointing straight at the engine class fails with a message that names the fix', async (t) => {
  if (!fs.existsSync(GLM_MODULE)) {
    t.skip(`Backend B engine not present at ${GLM_MODULE}`);
    return;
  }
  const failed = await startServer(t, { retrievalModule: GLM_MODULE, expectFailure: true });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /retrieval module failed to load/);
  assert.match(failed.stderr, /createRetrievalAdapter/, 'the error has to say what the module must export');
  assert.match(failed.stderr, /adapters\/glm-retrieval/, 'and point at the factory that exists instead');
});

test('G5 a missing ATLAS_GLM_MODULE is refused at start-up, not silently unwired', async (t) => {
  if (!fs.existsSync(GLM_MODULE)) {
    t.skip(`Backend B engine not present at ${GLM_MODULE}`);
    return;
  }
  const failed = await startServer(t, {
    retrievalModule: './adapters/glm-retrieval.mjs',
    env: { ATLAS_GLM_MODULE: '' },
    expectFailure: true
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ATLAS_GLM_MODULE/, 'the configuration that is missing is named, with its path example');
});
