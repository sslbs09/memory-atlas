import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeAuthority } from '../src/service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'test', 'helpers', 'writer-loop.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, tag, count = 60) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, dir, tag, String(count)], {
      cwd: ROOT, env: { ...process.env, TMP: process.env.TMP, TEMP: process.env.TEMP }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { parsed = null; }
      resolve({ code, result: parsed, stderr: err });
    });
  });
}

test('L1 a second process writing the same data directory is refused, not double-acknowledged', async (t) => {
  const dir = tempDir(t);
  const [a, b] = await Promise.all([run(dir, 'A'), run(dir, 'B')]);
  const results = [a.result, b.result].filter(Boolean);
  assert.equal(results.length, 2, `both processes must report: ${a.stderr.slice(0, 200)}${b.stderr.slice(0, 200)}`);

  const refused = results.filter((r) => r.lockRefused);
  const writer = results.find((r) => !r.lockRefused);
  assert.equal(refused.length, 1, 'exactly one process may own the directory: ' + JSON.stringify(results));
  assert.ok(writer, 'the other one must have written');
  assert.equal(refused[0].lockCode, 'ATLAS_WRITE_LOCK_HELD');
  assert.equal(refused[0].acknowledged, 0, 'a refused writer acknowledges nothing it did not store');

  // The headline property: no acknowledged write is missing from disk.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'race.json'), 'utf8'));
  assert.equal(doc.records.length, writer.acknowledged,
    `${writer.acknowledged} receipts were handed out but ${doc.records.length} records are on disk`);
  assert.ok(writer.acknowledged > 0);
});

test('L2 a stale lock from a killed writer is reclaimed and the reclaim is announced', async (t) => {
  const dir = tempDir(t);
  const holder = spawn(process.execPath, [HELPER, dir, 'HOLD', '400'], {
    cwd: ROOT, env: { ...process.env, TEMP: process.env.TEMP, TMP: process.env.TMP }
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    holder.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('exit', resolve));
  assert.ok(fs.existsSync(path.join(dir, 'writer.lock')), 'a killed process cannot release its lock');

  const second = spawn(process.execPath, [HELPER, dir, 'RECLAIM', '5'], {
    cwd: ROOT, env: { ...process.env, TEMP: process.env.TEMP, TMP: process.env.TMP }
  });
  let out = '';
  let err = '';
  second.stdout.on('data', (chunk) => { out += chunk; });
  second.stderr.on('data', (chunk) => { err += chunk; });
  await new Promise((resolve) => second.on('exit', resolve));
  const parsed = JSON.parse(out.trim().split('\n').pop());
  assert.equal(parsed.lockRefused, false, 'a crashed predecessor must not wedge the directory forever');
  assert.ok(parsed.acknowledged > 0);
  assert.match(err, /reclaimed a stale writer lock/, 'the takeover has to be visible, not silent');
});

test('L3 two stores in one process share the write queue instead of racing', async (t) => {
  const dir = tempDir(t);
  const first = new NativeAuthority({ dataDir: dir });
  await first.createSpace({ spaceId: 'shared' });
  const second = new NativeAuthority({ dataDir: dir });
  const writes = [];
  for (let i = 0; i < 10; i += 1) {
    writes.push(first.append('shared', { recordId: `f-${i}`, content: `甲 ${i}` }));
    writes.push(second.append('shared', { recordId: `s-${i}`, content: `乙 ${i}` }));
  }
  const receipts = await Promise.all(writes);
  const doc = second.store.read('shared');
  assert.equal(receipts.filter((r) => r.accepted).length, 20);
  assert.equal(doc.records.length, 20, 'two authorities in one process must not lose each other either');
  second.close();
  assert.equal(second.close(), false, 'close is idempotent');
  const third = new NativeAuthority({ dataDir: dir });
  assert.equal(third.store.read('shared').records.length, 20);
  third.close();
  first.close();
});

test('L4 the lock file names its owner so an operator can see who holds it', async (t) => {
  const dir = tempDir(t);
  const authority = new NativeAuthority({ dataDir: dir });
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'writer.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(lock.startedAt)));
  authority.close();
  assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), false, 'close releases the claim');
});

test('L5 another spelling of the same directory is the same writer, not a second one', async (t) => {
  const dir = tempDir(t);
  const linkRoot = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-alias-'));
  t.after(() => fs.rmSync(linkRoot, { recursive: true, force: true }));
  const viaJunction = path.join(linkRoot, 'via-junction');
  try {
    fs.symlinkSync(dir, viaJunction, 'junction');
  } catch (error) {
    t.skip(`junction aliases are unavailable here (${error.code})`);
    return;
  }

  const first = new NativeAuthority({ dataDir: dir });
  await first.createSpace({ spaceId: 'alias' });
  const second = new NativeAuthority({ dataDir: viaJunction });
  assert.equal(second.store.writerLock, first.store.writerLock,
    'a junction over the data directory must reuse the claim instead of starting a competing writer');

  // The realistic defect: one store per spelling, both believing they own it.
  const writes = [];
  for (let i = 0; i < 10; i += 1) {
    writes.push(first.append('alias', { recordId: `p-${i}`, content: `拼写 ${i}` }));
    writes.push(second.append('alias', { recordId: `q-${i}`, content: `别名 ${i}` }));
  }
  const receipts = await Promise.all(writes);
  assert.equal(receipts.filter((r) => r.accepted).length, 20);
  assert.equal(first.store.read('alias').records.length, 20,
    'two spellings must not lose each other writes');

  second.close();
  assert.equal(first.store.writerLock.references, 1);
  assert.ok(fs.existsSync(path.join(dir, 'writer.lock')), 'closing one alias keeps the live owner');
  first.close();
});
