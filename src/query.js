/**
 * query.js - the read view over one memory space.
 *
 * Search is lexical and exhaustive over the space document: a Chinese two-
 * character term, a person's name or a stable record id all resolve without a
 * tokenizer, and a miss is a miss because everything was looked at. That is the
 * honest baseline an index is allowed to accelerate, not a substitute for it.
 *
 * The outcome vocabulary matters:
 *   MATCHED              something was found
 *   NO_MATCH             the source was read in full and nothing matched
 *   SOURCE_UNAVAILABLE   the source could not be read - never rendered as empty
 *   UNINDEXED            a derived index exists but does not cover this yet
 */

import { CONTROL_KINDS, isIdLike } from './model.js';

export const OUTCOMES = ['MATCHED', 'NO_MATCH', 'SOURCE_UNAVAILABLE', 'UNINDEXED'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function bad(message) {
  return Object.assign(new Error(message), { code: 'ATLAS_QUERY_INVALID' });
}

/**
 * THE searchable text of one record. There is exactly one of these on purpose:
 * the authoritative scan matches against it, and it is also the only text an
 * index is ever shown (see retrieval.js projectRecord). Two definitions would
 * drift the way the measured defect did - the scan read the source fields while
 * the index was handed only the content, so a query for a `source.id` was
 * MATCHED in one path and NO_MATCH in the other.
 *
 * Changing what this returns changes what is findable through every path, in
 * both directions: it widens recall for metadata and it widens what a derived
 * index copy contains.
 */
export function searchableText(record) {
  const parts = [record.recordId, record.kind, record.content, `visibility:${record.visibility}`];
  if (record.source) parts.push(`source:${record.source.kind}:${record.source.id ?? ''}:${record.source.href ?? ''}`);
  if (record.aboutRecordId) parts.push(`about:${record.aboutRecordId}`);
  if (record.attributes) {
    for (const [key, value] of Object.entries(record.attributes)) parts.push(`${key}:${value}`);
  }
  return normalize(parts.join(' '));
}

function assertOptions(options) {
  const allowed = ['query', 'recordId', 'kinds', 'status', 'visibility', 'limit', 'offset', 'order',
    'since', 'until', 'timeField', 'includeContent'];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw bad(`Unknown query option "${key}".`);
  }
  if (options.query !== undefined && typeof options.query !== 'string') throw bad('"query" must be a string.');
  if (options.recordId !== undefined && !isIdLike(options.recordId)) throw bad('"recordId" must be a stable record id.');
  if (options.kinds !== undefined && (!Array.isArray(options.kinds) || options.kinds.length > 16 ||
      options.kinds.some((k) => typeof k !== 'string' || !k))) throw bad('"kinds" must be up to 16 non-empty names.');
  if (options.status !== undefined && !['active', 'superseded', 'retracted', 'recorded', 'all'].includes(options.status)) {
    throw bad('"status" must be active, superseded, retracted, recorded or all.');
  }
  if (options.visibility !== undefined && !['private', 'space', 'shared', 'all'].includes(options.visibility)) {
    throw bad('"visibility" must be private, space, shared or all.');
  }
  if (options.order !== undefined && !['newest', 'oldest'].includes(options.order)) throw bad('"order" must be newest or oldest.');
  for (const key of ['limit', 'offset']) {
    if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < 0)) {
      throw bad(`"${key}" must be a non-negative integer.`);
    }
  }
  if (options.limit !== undefined && options.limit > MAX_LIMIT) throw bad(`"limit" must not exceed ${MAX_LIMIT}.`);
  const timeField = options.timeField ?? 'timestamp';
  if (options.since !== undefined || options.until !== undefined) {
    for (const [field, value] of [['since', options.since], ['until', options.until]]) {
      if (value === undefined) continue;
      if (!Number.isFinite(Date.parse(String(value)))) throw bad(`"${field}" must be a parseable date-time.`);
    }
    if (options.since !== undefined && options.until !== undefined &&
        Date.parse(options.since) > Date.parse(options.until)) throw bad('"since" must not be after "until".');
    if (!['timestamp', 'occurredAt', 'recordedAt'].includes(timeField)) {
      throw bad('"timeField" must be timestamp (event time), occurredAt or recordedAt.');
    }
  }
  return timeField;
}

/**
 * @param {object} spaceDoc the authoritative space document
 * @param {object} validity result of deriveValidity(spaceDoc.records)
 */
/**
 * The authoritative list-view shape of every record in a space. Both the
 * exhaustive scan and a retrieval-assisted answer read records through this and
 * through `admits`/`servedRecord` below, so wiring an index cannot change what a
 * record looks like, which filters apply, or what counts as effective.
 */
export function shapedRecords(spaceDoc, validity) {
  return spaceDoc.records.map((record) => ({
    recordId: record.recordId,
    spaceId: spaceDoc.spaceId,
    kind: record.kind,
    content: record.content,
    status: validity.statuses.get(record.recordId),
    visibility: record.visibility ?? 'space',
    source: record.source ?? null,
    aboutRecordId: record.aboutRecordId ?? null,
    attributes: record.attributes ?? null,
    occurredAt: record.occurredAt ?? null,
    recordedAt: record.recordedAt,
    // The clock a time filter defaults to. occurredAt is often absent, so the
    // default is the moment the record entered history; a caller who means
    // "when it happened" asks for occurredAt explicitly and gets an honest
    // empty answer when that is unknown, rather than a silent substitution.
    timestamp: record.recordedAt,
    sequence: record.sequence
  }));
}

/**
 * Does this record pass the caller's filters? Nothing here is index-derived:
 * kinds, status, visibility and the time window are judged on the authoritative
 * record. A retrieval candidate that fails is refused, however well it scored.
 */
export function admits(record, options, timeField) {
  if (options.kinds && !options.kinds.includes(record.kind)) return false;
  if (options.status && options.status !== 'all' && record.status !== options.status) return false;
  if (options.visibility && options.visibility !== 'all' && record.visibility !== options.visibility) return false;
  if (options.since !== undefined || options.until !== undefined) {
    const from = options.since === undefined ? -Infinity : Date.parse(options.since);
    const to = options.until === undefined ? Infinity : Date.parse(options.until);
    const at = Date.parse(String(record[timeField] ?? ''));
    if (!Number.isFinite(at)) return false;
    if (at < from || at > to) return false;
  }
  return true;
}

/** One surviving record as it is served: correction neighbourhood in, content on request. */
export function servedRecord(record, { byId, validity, includeContent }) {
  const changedBy = validity.changedBy.get(record.recordId);
  const shaped = {
    ...record,
    ...(changedBy ? { changedBy } : {}),
    ...(CONTROL_KINDS.has(record.kind) && byId.has(record.aboutRecordId)
      ? { about: { recordId: record.aboutRecordId, status: byId.get(record.aboutRecordId).status } }
      : {})
  };
  return includeContent === false ? (({ content, ...rest }) => ({ ...rest, contentLength: content.length }))(shaped) : shaped;
}

export function querySpace(spaceDoc, validity, options = {}) {
  const timeField = assertOptions(options);
  const all = shapedRecords(spaceDoc, validity);
  const byId = new Map(all.map((record) => [record.recordId, record]));

  let matched = all;
  let outcome = 'MATCHED';
  if (options.recordId !== undefined) {
    const found = byId.get(options.recordId);
    matched = found ? [found] : [];
    outcome = found ? 'MATCHED' : 'NO_MATCH';
  } else {
    const terms = normalize(options.query).split(' ').filter(Boolean);
    if (terms.length > 0) {
      const texts = new Map(spaceDoc.records.map((record) => [record.recordId, searchableText(record)]));
      matched = matched.filter((record) => {
        const text = texts.get(record.recordId);
        return terms.every((term) => text.includes(term));
      });
    }
  }
  matched = matched.filter((record) => admits(record, options, timeField));
  if (outcome !== 'NO_MATCH') {
    matched.sort((a, b) => (options.order === 'oldest' ? a.sequence - b.sequence : b.sequence - a.sequence));
    outcome = matched.length > 0 ? 'MATCHED' : 'NO_MATCH';
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  const page = matched.slice(offset, offset + limit)
    .map((record) => servedRecord(record, { byId, validity, includeContent: options.includeContent }));

  return {
    outcome,
    spaceId: spaceDoc.spaceId,
    revision: validity.revision,
    timeField: options.since === undefined && options.until === undefined ? null : timeField,
    totalCount: matched.length,
    limit,
    offset,
    returned: page.length,
    hasMore: offset + page.length < matched.length,
    records: page,
    counts: spaceCounts(spaceDoc, validity)
  };
}

/**
 * How large the space is, independent of the question asked of it. Both answers -
 * scanned and index-assisted - carry the same counters, because the size of the
 * archive is not something an index gets to redefine.
 */
export function spaceCounts(spaceDoc, validity) {
  return {
    total: spaceDoc.records.length,
    active: spaceDoc.records.filter((r) => validity.statuses.get(r.recordId) === 'active').length,
    effective: validity.effective.length,
    superseded: spaceDoc.records.filter((r) => validity.statuses.get(r.recordId) === 'superseded').length,
    retracted: spaceDoc.records.filter((r) => validity.statuses.get(r.recordId) === 'retracted').length
  };
}

export function detailSpace(spaceDoc, validity, recordId) {
  if (!isIdLike(recordId)) throw bad('"recordId" must be a stable record id.');
  const all = spaceDoc.records.map((record) => ({
    ...record,
    spaceId: spaceDoc.spaceId,
    status: validity.statuses.get(record.recordId),
    ...(validity.changedBy.has(record.recordId) ? { changedBy: validity.changedBy.get(record.recordId) } : {})
  }));
  const byId = new Map(all.map((record) => [record.recordId, record]));
  const record = byId.get(recordId);
  if (!record) return { outcome: 'NO_MATCH', spaceId: spaceDoc.spaceId, revision: validity.revision, record: null, related: [] };
  const related = all.filter((candidate) => candidate.recordId !== recordId &&
    (candidate.aboutRecordId === recordId || candidate.changedBy === recordId ||
      (record.changedBy !== undefined && candidate.recordId === record.changedBy)));
  return {
    outcome: 'MATCHED',
    spaceId: spaceDoc.spaceId,
    revision: validity.revision,
    record: { ...record, ...(record.aboutRecordId && byId.has(record.aboutRecordId) ? { about: byId.get(record.aboutRecordId) } : {}) },
    related: related.map((item) => ({ ...item, ...(item.aboutRecordId && byId.has(item.aboutRecordId) ? { about: byId.get(item.aboutRecordId) } : {}) }))
  };
}
