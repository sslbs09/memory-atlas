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

export class SpaceStore {
  #tails = new Map();

  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('SpaceStore requires an explicit dataDir.');
    this.dataDir = path.resolve(dataDir);
    this.spacesDir = path.join(this.dataDir, 'spaces');
    fs.mkdirSync(this.spacesDir, { recursive: true });
  }

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
