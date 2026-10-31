import { createHash } from 'node:crypto';
/**
 * model.js - the generic memory record, its provenance, and how validity is
 * derived from an append-only history.
 *
 * This is the part worth extracting from a character runtime: a remembered
 * thing, where it came from, when it happened, when we were told about it, and
 * whether a later correction or retraction still lets it stand. None of it is
 * specific to any character, model or desktop pet.
 *
 * Three rules are structural here rather than advisory:
 *   - Nothing is overwritten. A correction appends a record; the earlier text
 *     stays readable and is marked superseded. An audit that cannot see what
 *     used to be believed cannot explain the present belief.
 *   - Duplication is decided by identity, never by text similarity. The same
 *     sentence said twice is two events, and 「喜欢」/「不喜欢」 are never merged:
 *     similarity de-duplication silently eats corrections.
 *   - A write answers with a receipt. The same operation id resolves onto the
 *     same record, so a lost response can be retried or looked up instead of
 *     guessed at.
 */

export const RECORD_KINDS = ['experience', 'observation', 'note', 'correction', 'retraction'];
export const VISIBILITY = ['private', 'space', 'shared'];
export const STATUSES = ['active', 'superseded', 'retracted', 'recorded'];
export const CONTROL_KINDS = new Set(['correction', 'retraction']);
export const MODEL_VERSION = 'atlas-record-v1';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw Object.assign(new Error(`Invalid ${label}: ${JSON.stringify(value)} (expected ${ID_PATTERN})`),
      { code: 'ATLAS_ID_INVALID' });
  }
  return value;
}

export function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'ATLAS_RECORD_INVALID' });
}

function isIso(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/**
 * A record is one remembered thing.
 *
 * @param {object} input
 * @param {string} input.recordId       stable identity; caller-supplied when the
 *                                       source event has one, so a replay lands
 *                                       on the same record
 * @param {string} input.kind           one of RECORD_KINDS
 * @param {string} input.content        what is remembered, as text
 * @param {string} [input.spaceId]      the memory space this record belongs to
 * @param {{kind:string,id:string,href?:string}} [input.source]  where it came from
 * @param {string} [input.visibility]   private | space | shared
 * @param {string} [input.occurredAt]   when it happened (ISO)
 * @param {string} [input.aboutRecordId] for correction/retraction: the record it acts on
 */
export function createRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A record must be an object.');
  const known = ['recordId', 'kind', 'content', 'spaceId', 'source', 'visibility', 'occurredAt', 'aboutRecordId', 'attributes'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) throw invalid(`Unknown record field "${key}".`);
  }
  const record = {
    recordId: assertId(input.recordId, 'recordId'),
    kind: typeof input.kind === 'string' && input.kind ? input.kind : 'experience'
  };
  if (!RECORD_KINDS.includes(record.kind)) throw invalid(`Unknown record kind "${record.kind}".`);
  if (typeof input.content !== 'string' || !input.content.trim()) throw invalid('A record needs non-empty content.');
  if (input.content.length > 32_000) throw invalid('Record content exceeds the 32000 character limit.');
  record.content = input.content;
  if (input.spaceId !== undefined) record.spaceId = assertId(input.spaceId, 'spaceId');
  if (input.visibility !== undefined) {
    if (!VISIBILITY.includes(input.visibility)) throw invalid(`Unknown visibility "${input.visibility}".`);
    record.visibility = input.visibility;
  } else {
    record.visibility = 'space';
  }
  if (input.occurredAt !== undefined) {
    if (!isIso(input.occurredAt)) throw invalid('occurredAt must be a canonical ISO date-time.');
    record.occurredAt = input.occurredAt;
  }
  if (input.source !== undefined) record.source = validateSource(input.source);
  if (input.attributes !== undefined) {
    if (!input.attributes || typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
      throw invalid('attributes must be a flat object of scalars when present.');
    }
    for (const [key, value] of Object.entries(input.attributes)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw invalid(`attribute "${key}" must be a scalar.`);
      }
    }
    record.attributes = { ...input.attributes };
  }
  if (CONTROL_KINDS.has(record.kind)) {
    record.aboutRecordId = assertId(input.aboutRecordId, 'aboutRecordId');
    if (record.kind === 'retraction' && input.content.trim().length > 0 && input.content !== DEFAULT_RETRACTION_TEXT) {
      // A retraction says "stop treating this as true"; it is not a place to
      // write a competing fact, because that would let a deletion smuggle in an
      // unreviewed assertion.
      throw invalid('A retraction carries no replacement content; use a correction for that.');
    }
  } else if (input.aboutRecordId !== undefined) {
    throw invalid('aboutRecordId only applies to correction and retraction records.');
  }
  return record;
}

export const DEFAULT_RETRACTION_TEXT = '该记录的有效性已被撤回';

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('source must be an object.');
  const keys = Object.keys(source);
  for (const key of keys) {
    if (!['kind', 'id', 'href'].includes(key)) throw invalid(`Unknown source field "${key}".`);
  }
  if (typeof source.kind !== 'string' || !source.kind) throw invalid('source.kind is required.');
  const validated = { kind: source.kind.slice(0, 80) };
  if (source.id !== undefined) validated.id = assertId(source.id, 'source.id');
  if (source.href !== undefined) {
    if (typeof source.href !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(source.href)) {
      throw invalid('source.href must be an absolute URI.');
    }
    validated.href = source.href.slice(0, 2000);
  }
  if (validated.id === undefined && validated.href === undefined) {
    throw invalid('source must identify where it came from via id or href.');
  }
  return validated;
}

/**
 * Derive the current standing of every record from the ordered history.
 *
 * There is no "current" field to write: validity is computed, so a correction
 * cannot be half-applied and a reload cannot disagree with a live view.
 */
export function deriveValidity(records) {
  const statuses = new Map();
  const changedBy = new Map();
  let revision = 0;
  for (const record of records) {
    if (statuses.has(record.recordId)) {
      throw Object.assign(new Error(`Duplicate recordId in history: ${record.recordId}`), { code: 'ATLAS_IDENTITY_COLLISION' });
    }
    if (!CONTROL_KINDS.has(record.kind)) {
      statuses.set(record.recordId, 'active');
      continue;
    }
    const target = record.aboutRecordId;
    if (!statuses.has(target)) throw Object.assign(new Error(`Control targets an unknown record: ${target}`), { code: 'ATLAS_CONTROL_TARGET_MISSING' });
    if (statuses.get(target) !== 'active') throw Object.assign(new Error(`Control targets a record that is no longer active: ${target}`), { code: 'ATLAS_CONTROL_TARGET_INACTIVE' });
    statuses.set(target, record.kind === 'correction' ? 'superseded' : 'retracted');
    changedBy.set(target, record.recordId);
    statuses.set(record.recordId, record.kind === 'correction' ? 'active' : 'recorded');
    revision = record.sequence ?? revision;
  }
  return {
    statuses,
    changedBy,
    revision,
    active: records.filter((record) => statuses.get(record.recordId) === 'active'),
    effective: records.filter((record) => statuses.get(record.recordId) === 'active' && !CONTROL_KINDS.has(record.kind))
  };
}

/**
 * The record id one caller-owned operation resolves onto.
 *
 * Derived, not stored: the history stays free of transport bookkeeping, and a
 * retry of the same operation lands on the same record by construction.
 */
export function operationRecordId(spaceId, operationId) {
  if (typeof operationId !== 'string' || operationId.trim().length < 8 || operationId.length > 200) {
    throw Object.assign(new Error('operationId must be a string of 8-200 characters.'), { code: 'ATLAS_OPERATION_INVALID' });
  }
  const digest = createHash('sha256')
    .update(`${MODEL_VERSION}:${spaceId}:${operationId.trim()}`)
    .digest('hex')
    .slice(0, 32);
  return `op-${digest}`;
}
