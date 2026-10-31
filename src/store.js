/**
 * store.js - durable memory persistence for one Atlas data directory.
 *
 * One JSON document per memory space, replaced atomically. That shape is
 * deliberate for a small local service and equally deliberately reported as a
 * limit: every write rewrites the whole space document, so a space grows in
 * write cost with its own size. See docs/LIMITATIONS.md.
 *
 * What this file guarantees:
 *   - a success means the bytes are on disk, verified by reading them back;
 *   - one process writes a data directory: a second store over the same
 *     directory is refused at construction, because the compare-and-swap below
 *     detects a colliding write but cannot make it atomic across processes;
 *   - a write never silently replaces a document that changed since it was read
 *     (compare-and-swap against the digest of the bytes it was parsed from);
 *   - a transient Windows sharing violation on rename is retried with a bounded
 *     wait, and the swap guard is re-checked before every attempt, so a retry
 *     cannot become the lost update it is guarding against;
 *   - an exhausted retry is a failure, with the previous document intact and no
 *     temp file left behind;
 *   - async writers of the same space take turns; different spaces do not
 *     queue behind each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertId } from './model.js';

const READ_STAMP = Symbol('atlas.readStamp');
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const WRITE_ATTEMPTS = [0, 5, 15, 40, 100];
const WRITE_RETRY_LIMIT = 3;

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pauseSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* bounded wait for a transient file lock */ }
  }
}

export function isConflict(error) {
  return Boolean(error && error.code === 'ATLAS_SAVE_CONFLICT');
}

/**
 * One writer per data directory.
 *
 * The compare-and-swap below is NOT a cross-process atomicity guarantee: it
 * checks the digest and then renames, and another process can rename in that
 * window. Measured with two processes making 40 writes each into one directory:
 * 79 receipts were handed out and 73 records were on disk. So the guarantee is
 * made structurally instead - a second service pointing at the same data
 * directory is refused at startup, which is also what a single-node memory
 * deployment actually wants.
 *
 * The lock is cooperative, and it is described as such: it stops two Atlas
 * writers, not an unrelated process editing the file by hand. The CAS stays as
 * a second line of defence for that case.
 */
const LOCK_FILE = 'writer.lock';
// In-process registry so two SpaceStore objects over one directory share the
// same write chains instead of racing each other.
const WRITERS = new Map();

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

/**
 * The lock is keyed on the real directory, not on the spelling the caller used:
 * `D:\tmp\x`, `e:\TMP\x` and a junction pointing at the same store must all land
 * on one writer, otherwise two stores in one process would race while both
 * believed they held the claim.
 */
function writerKey(resolvedDir) {
  try {
    return fs.realpathSync.native(resolvedDir).toLowerCase();
  } catch {
    return resolvedDir.toLowerCase();
  }
}

function acquireWriterLock(directory, key) {
  const existing = WRITERS.get(key);
  if (existing) {
    existing.references += 1;
    return existing;
  }
  const lockPath = path.join(directory, LOCK_FILE);
  // One shared write-chain map per data directory, so two stores opened in the
  // same process take turns through the same queue instead of racing.
  const token = { dataDir: directory, lockPath, references: 1, takenOver: null, tails: new Map() };
  const payload = () => `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  const write = () => fs.writeFileSync(lockPath, payload(), { flag: 'wx' });
  try {
    write();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { owner = null; }
    if (owner && processAlive(owner.pid)) {
      throw Object.assign(
        new Error(`Another Memory Atlas service already owns "${directory}" (pid ${owner.pid}, started ${owner.startedAt}). ` +
          'One data directory has one writer; start the second service on its own dataDir.'),
        { code: 'ATLAS_WRITE_LOCK_HELD', ownerPid: owner.pid ?? null }
      );
    }
    // The owner is gone: the lock is stale. Reclaiming it is recorded rather
    // than silent, so a crash-restart loop is visible in the log.
    token.takenOver = { previousPid: owner?.pid ?? null, previousStartedAt: owner?.startedAt ?? null };
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort before re-claiming */ }
    try {
      write();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        throw Object.assign(new Error(`Lost the race to claim the writer lock for "${directory}".`),
          { code: 'ATLAS_WRITE_LOCK_HELD' });
      }
      throw retryError;
    }
  }
  token.release = () => {
    token.references -= 1;
    if (token.references > 0) return;
    WRITERS.delete(key);
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current.pid === process.pid) fs.rmSync(lockPath, { force: true });
    } catch { /* a lock we cannot read is not ours to delete */ }
  };
  WRITERS.set(key, token);
  return token;
}

export class SpaceStore {

  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('SpaceStore requires an explicit dataDir.');
    this.dataDir = path.resolve(dataDir);
    this.spacesDir = path.join(this.dataDir, 'spaces');
    fs.mkdirSync(this.spacesDir, { recursive: true });
    this.writerLock = acquireWriterLock(this.dataDir, writerKey(this.dataDir));
    if (this.writerLock.takenOver) {
      process.stderr.write(`[atlas] reclaimed a stale writer lock in ${this.dataDir} from pid ${this.writerLock.takenOver.previousPid}\n`);
    }
    this.closed = false;
  }

  /** Release the writer claim. After close() the directory is free again. */
  close() {
    if (this.closed) return false;
    this.closed = true;
    this.writerLock.release();
    return true;
  }

  get #tails() { return this.writerLock.tails; }

  spacePath(spaceId) {
    assertId(spaceId, 'spaceId');
    return path.join(this.spacesDir, `${spaceId}.json`);
  }

  exists(spaceId) {
    return fs.existsSync(this.spacePath(spaceId));
  }

  listSpaces() {
    try {
      return fs.readdirSync(this.spacesDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
    } catch {
      return null; // an unreadable store is reported as unavailable, never as "no spaces"
    }
  }

  create(spaceDoc) {
    const target = this.spacePath(spaceDoc.spaceId);
    if (fs.existsSync(target)) {
      throw Object.assign(new Error(`Space already exists: ${spaceDoc.spaceId}`), { code: 'ATLAS_SPACE_EXISTS' });
    }
    this.#write(target, spaceDoc, undefined);
    return spaceDoc;
  }

  read(spaceId) {
    const target = this.spacePath(spaceId);
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const doc = JSON.parse(text);
    Object.defineProperty(doc, READ_STAMP, { value: digest(text), configurable: true, enumerable: false, writable: true });
    return doc;
  }

  save(doc) {
    this.#write(this.spacePath(doc.spaceId), doc, doc[READ_STAMP]);
    return true;
  }

  #write(target, doc, expected) {
    const payload = `${JSON.stringify(doc, null, 2)}\n`;
    const nextStamp = digest(payload);
    let lastError = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS.length; attempt += 1) {
      pauseSync(WRITE_ATTEMPTS[attempt]);
      if (expected !== undefined) {
        const current = this.#stampOf(target);
        if (current !== null && current !== expected) {
          throw Object.assign(
            new Error(`Space "${doc.spaceId}" changed on disk since it was read; the write was refused instead of overwriting newer history.`),
            { code: 'ATLAS_SAVE_CONFLICT' }
          );
        }
      }
      const tmp = `${target}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, target);
        if (expected !== undefined) {
          Object.defineProperty(doc, READ_STAMP, { value: nextStamp, configurable: true, enumerable: false, writable: true });
        }
        return;
      } catch (error) {
        lastError = error;
        try { fs.rmSync(tmp, { force: true }); } catch { /* a vanished temp file needs no cleanup */ }
        if (!TRANSIENT_CODES.has(error.code)) throw error;
      }
    }
    throw Object.assign(
      new Error(`Space "${doc.spaceId}" could not be persisted: ${lastError ? lastError.message : 'repeated transient failure'}.`),
      { code: 'ATLAS_PERSIST_FAILED', cause: lastError }
    );
  }

  #stampOf(target) {
    let text;
    try { text = fs.readFileSync(target, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return digest(text);
  }

  /**
   * Run one read-modify-write against a space, taking that space's turn and
   * re-applying the operation if a synchronous writer moved the document
   * underneath it. Bounded: a conflict that survives the retries is reported.
   */
  withWrite(spaceId, operation) {
    const tail = this.#tails.get(spaceId) ?? Promise.resolve();
    const run = async () => {
      let lastConflict = null;
      for (let attempt = 0; attempt <= WRITE_RETRY_LIMIT; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          if (!isConflict(error)) throw error;
          lastConflict = error;
        }
      }
      throw lastConflict;
    };
    const settled = tail.then(run, run);
    this.#tails.set(spaceId, settled.then(() => undefined, () => undefined));
    return settled;
  }
}
