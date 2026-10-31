/**
 * service.js - the Memory Service: what an Atlas client can ask for, and the
 * authority that answers.
 *
 * An authority is pluggable, and the difference between the two implementations
 * is the whole point of extracting this:
 *
 *   NativeAuthority      Atlas owns the records. Runs with no character runtime
 *                        present at all. This is what makes Memory Atlas an
 *                        independent system rather than a skin on WhiteMoon.
 *   A delegated authority (see adapters/) answers from someone else's store -
 *                        e.g. a WhiteMoon Core instance, which keeps its own
 *                        adjudication of Identity, Experience, State and
 *                        Relationship. Atlas then reads and controls through
 *                        that authority and never copies its facts into a second
 *                        database.
 *
 * What stays fixed regardless of authority:
 *   - recall returns effective records only, unless a caller deliberately asks
 *     for the audit view;
 *   - a write answers with a receipt, and the same operation id resolves onto
 *     the same record;
 *   - an unreadable source is reported as unavailable, never as an empty memory;
 *   - a retrieval index may rank candidates but may not admit them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpaceStore } from './store.js';
import { assertId, createRecord, deriveValidity, isIdLike, operationRecordId, sameRecordSemantics, DEFAULT_RETRACTION_TEXT } from './model.js';
import { detailSpace } from './query.js';
import { createRetrievalCoordinator, spaceProjection } from './retrieval.js';

export const SERVICE_VERSION = 'memory-atlas-v0.1';

function unavailable(spaceId, reason) {
  return {
    outcome: 'SOURCE_UNAVAILABLE',
    spaceId,
    reason,
    records: [],
    totalCount: 0,
    revision: null,
    returned: 0,
    hasMore: false
  };
}

export class NativeAuthority {
  constructor({ dataDir }) {
    this.name = 'native';
    this.store = new SpaceStore(dataDir);
    this.dataDir = this.store.dataDir;
  }

  capabilities() {
    return { write: true, correct: true, retract: true, spaces: true, visibility: true };
  }

  async createSpace({ spaceId, label = '', createdAt = new Date().toISOString() }) {
    assertId(spaceId, 'spaceId');
    if (this.store.exists(spaceId)) {
      throw Object.assign(new Error(`Space already exists: ${spaceId}`), { code: 'ATLAS_SPACE_EXISTS' });
    }
    this.store.create({ spaceId, label, createdAt, records: [], nextSequence: 1 });
    return { spaceId, createdAt };
  }

  /** Release this service's claim on its data directory (see SpaceStore). */
  close() {
    return this.store.close();
  }

  listSpaces() {
    const ids = this.store.listSpaces();
    if (ids === null) return { available: false, spaceIds: [] };
    return { available: true, spaceIds: ids };
  }

  /** The authoritative read of one space, or an honest unavailability. */
  inspect(spaceId) {
    let doc;
    try {
      doc = this.store.read(spaceId);
    } catch {
      return { available: false, reason: 'DOCUMENT_UNREADABLE' };
    }
    if (!doc) return { available: false, reason: 'SPACE_NOT_FOUND' };
    try {
      return { available: true, spaceDoc: doc, validity: deriveValidity(doc.records) };
    } catch {
      // A history that cannot be interpreted is not an empty history: reporting
      // it as "no records" would let damage read as forgetting.
      return { available: false, reason: 'VALIDITY_UNRESOLVABLE' };
    }
  }

  async append(spaceId, recordInput, { operationId } = {}) {
    assertId(spaceId, 'spaceId');
    const record = createRecord({ ...recordInput, spaceId });
    const derivedId = operationId === undefined ? null : operationRecordId(spaceId, operationId);
    if (derivedId && record.recordId !== derivedId) {
      throw Object.assign(new Error('An operation id must be submitted with the record id it derives.'),
        { code: 'ATLAS_OPERATION_MISMATCH' });
    }
    return this.store.withWrite(spaceId, () => this.#appendNow(spaceId, record, operationId));
  }

  async #appendNow(spaceId, record, operationId) {
    const inspected = this.inspect(spaceId);
    if (!inspected.available) {
      throw Object.assign(new Error(`Cannot write to space "${spaceId}": ${inspected.reason}`),
        { code: 'ATLAS_SPACE_UNAVAILABLE' });
    }
    const { spaceDoc } = inspected;
    const existing = spaceDoc.records.find((e) => e.recordId === record.recordId);
    if (existing) {
      const { identical, differences } = sameRecordSemantics(existing, record);
      const revision = deriveValidity(spaceDoc.records).revision;
      if (!identical) {
        // The same identity carrying different content, source, target or action
        // is not a retry - it is a different claim wearing a name already in use. Serving
        // it as a duplicate receipt would silently discard the new claim and
        // tell the caller it was stored.
        throw Object.assign(
          new Error(`Record "${record.recordId}" already exists in space "${spaceId}" with different ` +
            `content (${differences.join(', ')}). Use a new identity, or correct the existing record.`),
          {
            code: operationId === undefined ? 'ATLAS_IDENTITY_CONFLICT' : 'ATLAS_OPERATION_CONFLICT',
            existingRecordId: existing.recordId,
            differingFields: differences,
            duplicateOf: { recordId: existing.recordId, sequence: existing.sequence, recordedAt: existing.recordedAt }
          }
        );
      }
      // A genuine retry of something already on record: the same receipt, and
      // still no second row in the archive.
      return {
        accepted: true,
        outcome: operationId === undefined ? 'IDEMPOTENT_DUPLICATE' : 'IDEMPOTENT_REPLAY',
        spaceId,
        recordId: existing.recordId,
        duplicateOf: { recordId: existing.recordId, kind: existing.kind, sequence: existing.sequence,
          recordedAt: existing.recordedAt, aboutRecordId: existing.aboutRecordId ?? null },
        revision
      };
    }
    const stored = {
      ...record,
      recordedAt: new Date().toISOString(),
      sequence: spaceDoc.nextSequence
    };
    // A control record is validated against the history it is about to join,
    // before anything is written. Otherwise a correction aimed at a record that
    // does not exist would be accepted - and then make the whole space
    // uninterpretable at read time, which is far worse than refusing the write.
    try {
      deriveValidity([...spaceDoc.records, stored]);
    } catch (error) {
      if (error.code === 'ATLAS_CONTROL_TARGET_MISSING' || error.code === 'ATLAS_CONTROL_TARGET_INACTIVE') {
        throw Object.assign(new Error(`Control rejected: ${error.message}`), { code: error.code });
      }
      throw error;
    }
    spaceDoc.records.push(stored);
    spaceDoc.nextSequence += 1;
    this.store.save(spaceDoc);
    const onDisk = this.store.read(spaceId);
    if (!onDisk?.records?.some((r) => r.recordId === stored.recordId)) {
      // Success must correspond to bytes on disk. If it does not, this is a
      // failure and is reported as one.
      throw Object.assign(new Error('The write was not observable after commit.'), { code: 'ATLAS_PERSIST_UNVERIFIED' });
    }
    return {
      accepted: true,
      outcome: 'RECORDED',
      spaceId,
      recordId: stored.recordId,
      sequence: stored.sequence,
      recordedAt: stored.recordedAt,
      revision: deriveValidity(spaceDoc.records).revision
    };
  }

  async control(spaceId, { aboutRecordId, action, content, operationId }) {
    if (!isIdLike(aboutRecordId)) throw Object.assign(new Error('"aboutRecordId" must be a stable record id.'), { code: 'ATLAS_ID_INVALID' });
    if (!['correct', 'retract'].includes(action)) {
      throw Object.assign(new Error('action must be correct or retract.'), { code: 'ATLAS_CONTROL_INVALID' });
    }
    if (action === 'correct' && (typeof content !== 'string' || !content.trim())) {
      throw Object.assign(new Error('A correction needs replacement content.'), { code: 'ATLAS_CONTROL_INVALID' });
    }
    const recordId = operationId === undefined ? `ctl-${randomUUID()}` : operationRecordId(spaceId, operationId);
    const receipt = await this.append(spaceId, {
      recordId,
      kind: action === 'correct' ? 'correction' : 'retraction',
      content: action === 'correct' ? content.trim() : DEFAULT_RETRACTION_TEXT,
      aboutRecordId
    }, { operationId });
    if (receipt.outcome === 'IDEMPOTENT_REPLAY' || receipt.outcome === 'IDEMPOTENT_DUPLICATE') {
      const inspected = this.inspect(spaceId);
      return {
        ...receipt,
        outcome: 'IDEMPOTENT_REPLAY',
        status: inspected.available ? inspected.validity.statuses.get(receipt.recordId) : null
      };
    }
    return { ...receipt, operationId };
  }

  async resolveOperation(spaceId, operationId) {
    const derivedId = operationRecordId(spaceId, operationId);
    const inspected = this.inspect(spaceId);
    if (!inspected.available) return { outcome: 'SOURCE_UNAVAILABLE', reason: inspected.reason, recorded: false, recordId: derivedId };
    const found = inspected.spaceDoc.records.find((record) => record.recordId === derivedId);
    if (!found) return { outcome: 'NO_MATCH', recorded: false, recordId: derivedId, revision: inspected.validity.revision };
    return {
      outcome: 'MATCHED',
      recorded: true,
      recordId: derivedId,
      status: inspected.validity.statuses.get(derivedId),
      sequence: found.sequence,
      recordedAt: found.recordedAt,
      revision: inspected.validity.revision
    };
  }

  /** Raw footprint, kept separate from any derived cache by the caller. */
  usage() {
    const ids = this.store.listSpaces();
    if (ids === null) return { available: false, reason: 'STORE_UNREADABLE', spaces: [], totalBytes: 0 };
    const spaces = ids.map((spaceId) => {
      const file = this.store.spacePath(spaceId);
      let bytes = null;
      let records = null;
      try {
        bytes = fs.statSync(file).size;
        records = JSON.parse(fs.readFileSync(file, 'utf8')).records?.length ?? null;
      } catch { /* an unreadable space reports null, never a fabricated zero */ }
      return { spaceId, bytes, records, readable: bytes !== null && records !== null };
    });
    return { available: true, spaces, totalBytes: spaces.reduce((sum, s) => sum + (s.bytes ?? 0), 0) };
  }
}

/**
 * The service is the part a client talks to. It owns the policy that recall is
 * effective-only and that a retrieval candidate is only a suggestion.
 *
 * `retrieval` is an optional derived index speaking SEARCH-DTO-v1 (see
 * retrieval.js). Attaching one changes the ranking and the cost of an answer,
 * never its membership: the authoritative document still decides what exists.
 */
export function createMemoryService({ authority, capacityTargetBytes = 20_000_000_000,
  derivedCacheDir = null, retrieval = null } = {}) {
  if (!authority || typeof authority.inspect !== 'function') {
    throw new Error('createMemoryService requires an authority exposing inspect(spaceId).');
  }
  if (retrieval !== null && retrieval !== undefined && typeof retrieval.searchCandidates !== 'function') {
    throw new Error('A retrieval adapter must provide searchCandidates(params) per SEARCH-DTO-v1.');
  }
  const index = retrieval && typeof retrieval.searchCandidates === 'function' ? retrieval : null;
  const cacheDir = derivedCacheDir ?? path.join(authority.dataDir ?? process.cwd(), 'derived-cache');

  // A space whose history is empty and a space that cannot be read are
  // different statements: only the first may be rendered as "nothing found".
  function read(spaceId) {
    return authority.inspect(spaceId);
  }

  const retrievalSearch = createRetrievalCoordinator({ inspect: read, getAdapter: () => index });

  async function search({ spaceId, ...options } = {}) {
    assertId(spaceId, 'spaceId');
    const inspected = read(spaceId);
    if (!inspected.available) return unavailable(spaceId, inspected.reason);
    // Recall defaults to what currently stands. An audit view is explicit.
    const merged = { status: 'active', ...options };
    const view = await retrievalSearch.search({ spaceId, options: merged });
    // Echo the filter that actually ran: a page of effective records and a
    // page of the whole history look identical unless the answer says which.
    return { ...view, appliedFilters: { status: merged.status, visibility: merged.visibility ?? 'all' } };
  }

  /**
   * Push one space's authoritative state into the derived index. Upserting the
   * effective records and removing the rest is the whole rule, which is why the
   * same call rebuilds from nothing and reconciles after a crash.
   *
   * A write that landed is never undone by an index that refused it: the failure
   * is announced, the memory stays, and the next sync or reindex repairs the
   * derived copy.
   */
  function syncIndex(spaceId) {
    if (!index) return { synced: false, reason: 'NO_RETRIEVAL_ADAPTER' };
    if (typeof index.upsertRecords !== 'function' && typeof index.removeRecords !== 'function') {
      return { synced: false, reason: 'ADAPTER_IS_READ_ONLY' };
    }
    const inspected = read(spaceId);
    if (!inspected.available) return { synced: false, reason: inspected.reason };
    const projection = spaceProjection(inspected.spaceDoc, inspected.validity);
    if (projection.upserts.length && typeof index.upsertRecords === 'function') index.upsertRecords(projection.upserts);
    if (projection.removals.length && typeof index.removeRecords === 'function') index.removeRecords(projection.removals);
    return { synced: true, upserted: projection.upserts.length, removed: projection.removals.length };
  }

  function syncAfterWrite(spaceId) {
    try {
      const result = syncIndex(spaceId);
      if (result.synced) return result;
      // A read-only adapter is a legitimate choice, not a fault to shout about.
      if (result.reason !== 'ADAPTER_IS_READ_ONLY' && result.reason !== 'NO_RETRIEVAL_ADAPTER') {
        process.stderr.write(`[atlas] derived index not synced for "${spaceId}": ${result.reason}\n`);
      }
      return result;
    } catch (error) {
      process.stderr.write(`[atlas] derived index rejected the sync for "${spaceId}": ${error.message} ` +
        'The memory itself is stored; run reindex() after fixing the index.\n');
      return { synced: false, reason: 'ADAPTER_SYNC_FAILED' };
    }
  }

  async function reindex(spaceId) {
    const ids = spaceId === undefined ? authority.listSpaces().spaceIds : [spaceId];
    const spaces = [];
    for (const id of ids) {
      if (!index) throw new Error('reindex() requires a retrieval adapter that accepts projections.');
      spaces.push({ spaceId: id, ...syncIndex(id) });
    }
    return { engine: index.name ?? null, spaces };
  }

  async function detail({ spaceId, recordId }) {
    assertId(spaceId, 'spaceId');
    const inspected = read(spaceId);
    if (!inspected.available) return { ...unavailable(spaceId, inspected.reason), record: null, related: [] };
    return detailSpace(inspected.spaceDoc, inspected.validity, recordId);
  }

  async function record(spaceId, input, options) {
    const receipt = await authority.append(spaceId, input, options);
    if (receipt.accepted) syncAfterWrite(spaceId);
    return receipt;
  }

  async function control(spaceId, input, action) {
    const receipt = await authority.control(spaceId, { ...input, action });
    // A correction changes what is effective and a retraction ends a record's
    // standing; both have to reach the derived index or the next search answers
    // from a projection of a memory that no longer stands.
    if (receipt.accepted) syncAfterWrite(spaceId);
    return receipt;
  }

  return {
    version: SERVICE_VERSION,
    authority,
    search,
    detail,
    record,
    correct: (spaceId, input) => control(spaceId, input, 'correct'),
    retract: (spaceId, input) => control(spaceId, input, 'retract'),
    reindex,
    retrieval,
    indexStatus: () => ({
      wired: Boolean(index),
      engine: index ? (index.name ?? null) : null,
      acceptsProjections: Boolean(index && typeof index.upsertRecords === 'function')
    }),
    operation: (spaceId, operationId) => authority.resolveOperation(spaceId, operationId),
    spaces: () => authority.listSpaces(),
    createSpace: (input) => authority.createSpace(input),
    capabilities: () => (typeof authority.capabilities === 'function' ? authority.capabilities() : {}),
    health() {
      const usage = typeof authority.usage === 'function' ? authority.usage() : { available: false, reason: 'AUTHORITY_REPORTS_NO_USAGE' };
      let cache = { path: cacheDir, exists: false, bytes: 0, files: 0 };
      try {
        const entries = fs.readdirSync(cacheDir);
        let bytes = 0;
        for (const name of entries) {
          try { bytes += fs.statSync(path.join(cacheDir, name)).size; } catch { /* a vanished cache entry is not a memory loss */ }
        }
        cache = { path: cacheDir, exists: true, bytes, files: entries.length };
      } catch { /* no derived cache yet: that is the normal case, not a failure */ }
      return {
        ok: true,
        version: SERVICE_VERSION,
        authority: authority.name,
        capabilities: typeof authority.capabilities === 'function' ? authority.capabilities() : {},
        spaces: usage.available ? usage.spaces.map((s) => ({ spaceId: s.spaceId, records: s.records, bytes: s.bytes })) : null,
        spacesAvailable: usage.available,
        capacity: {
          authoritativeBytes: usage.available ? usage.totalBytes : null,
          derivedCacheBytes: cache.bytes,
          capacityTargetBytes,
          policy: { enforceLimit: false, autoDiscardOriginals: false },
          note: 'The target is an observation budget. Reaching it never discards, truncates or refuses a record.'
        },
        derivedCache: cache,
        index: index
          ? {
            state: 'WIRED',
            engine: index.name ?? null,
            // Read from the adapter, not asserted because an object was passed
            // in: "wired" and "ready" are two different claims.
            generation: Number.isSafeInteger(index.indexGeneration) ? index.indexGeneration : null,
            open: typeof index.isOpen === 'boolean' ? index.isOpen : null,
            acceptsProjections: typeof index.upsertRecords === 'function',
            rebuildableFrom: 'authoritative records'
          }
          : { state: 'NOT_WIRED', reason: 'NO_ADAPTER_ATTACHED', rebuildableFrom: 'authoritative records' }
      };
    }
  };
}
