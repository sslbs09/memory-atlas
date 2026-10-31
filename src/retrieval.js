/**
 * retrieval.js - the seam between a derived index and the authoritative store.
 *
 * The wire contract is SEARCH-DTO-v1, the same document the WhiteMoon Runtime
 * Host speaks to its retrieval backend. One contract, two consumers: an index
 * written once can serve either service, and neither side gets to invent field
 * names the other tolerates silently.
 *
 * What the index owns: which records MIGHT answer, and in what order.
 * What it never owns: whether a record exists, is effective, belongs to this
 * space, matches the caller's kind/visibility/time filters, or what its content
 * is. Every candidate is re-checked against the authoritative document through
 * the same `shapedRecords`/`admits`/`servedRecord` functions the exhaustive scan
 * uses, so wiring an index cannot change any answer except its ranking.
 *
 * Failure vocabulary, because these are different statements:
 *   NOT_WIRED        no index is attached; the exhaustive scan answered
 *   NOT_APPLICABLE   an index is attached but cannot represent this question
 *                    (history view, a bare browse, an explicit order, id+keyword)
 *   INDEX_REBUILDING the index is busy rebuilding and answered nothing
 *   ADAPTER_FAILED   the index threw            } the scan answered, and the
 *   ADAPTER_REFUSED  the index rejected the shape} answer is still a real answer
 * A retrieval failure never degrades into "there is nothing here".
 */

import { admits, querySpace, searchableText, servedRecord, shapedRecords, spaceCounts } from './query.js';
import { isIdLike } from './model.js';

export const SEARCH_PATH_SCAN = 'atlas-authoritative-scan';
export const SEARCH_PATH_INDEX = 'atlas-candidates+authoritative';
export const INDEXING_NOT_REQUIRED = 'NOT_REQUIRED';
export const INDEXING_ASSISTED = 'DERIVED_INDEX_ASSISTED';

// Frozen by SEARCH-DTO-v1.
export const DTO_MAX_LIMIT = 200;
export const DTO_DEFAULT_LIMIT = 50;
export const DTO_CANDIDATE_INDEX_STATE = 'INDEXED';
export const RETRIEVAL_OVERFETCH = 4;
export const RETRIEVAL_MAX_WINDOWS = 4;
const MATCH_REASON_MAX_ENTRIES = 8;
const MATCH_REASON_MAX_LENGTH = 200;

function refusal(message, code = 'ATLAS_RETRIEVAL_INVALID') {
  return Object.assign(new Error(message), { code });
}

export function pageLimitOf(options) {
  const requested = options.limit === undefined ? DTO_DEFAULT_LIMIT : options.limit;
  return Math.max(0, Math.min(requested, DTO_MAX_LIMIT));
}

function windowLimitOf(options) {
  return Math.min(Math.max(pageLimitOf(options) * RETRIEVAL_OVERFETCH, 1), DTO_MAX_LIMIT);
}

/**
 * Which questions the index is asked, and which stay with the scan.
 *
 * `instanceId` is the DTO's memory-space key; a space's identity is carried here
 * and nowhere else, so a candidate from another space has no way to arrive.
 * `kinds` and `visibility` are deliberately not sent: the DTO's `types` is a
 * source-kind whitelist, not Atlas's record kind, and filtering on the wrong axis
 * would drop right answers while looking like a narrowing.
 */
export function buildRetrievalRequest(spaceId, options) {
  const status = options.status ?? 'active';
  if (status !== 'active') return { usable: false, reason: 'NON_ACTIVE_VIEW_NOT_INDEXED' };
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  if (query && options.recordId !== undefined) return { usable: false, reason: 'KEYWORD_AND_EXACT_ID' };
  if (!query && options.recordId === undefined && options.since === undefined && options.until === undefined) {
    return { usable: false, reason: 'NO_INDEXABLE_TERM' };
  }
  if (options.order !== undefined) return { usable: false, reason: 'ORDER_REQUESTED' };
  const request = { instanceId: spaceId, limit: windowLimitOf(options), offset: 0 };
  if (query) request.q = query;
  if (options.recordId !== undefined) request.recordId = options.recordId;
  if (options.since !== undefined) request.since = options.since;
  if (options.until !== undefined) request.until = options.until;
  return { usable: true, request };
}

// The DTO freezes matchReason as an array of strings. A bare string still ranks -
// dropping a reason over a shape difference would lose information the caller can
// use - but the drift is counted so it is visible instead of silent.
function normalizeMatchReason(value, counters) {
  if (typeof value === 'string') {
    counters.legacyMatchReasons += 1;
    return value.trim() ? [value.slice(0, MATCH_REASON_MAX_LENGTH)] : null;
  }
  if (!Array.isArray(value)) return null;
  const reasons = value
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .slice(0, MATCH_REASON_MAX_ENTRIES)
    .map((entry) => entry.slice(0, MATCH_REASON_MAX_LENGTH));
  return reasons.length > 0 ? reasons : null;
}

function normalizeCandidates(payload, counters) {
  const accepted = [];
  const rejected = [];
  const list = Array.isArray(payload && payload.candidates) ? payload.candidates : null;
  if (!list) {
    rejected.push({ reason: 'MALFORMED_RESPONSE', candidate: null });
    return { accepted, rejected };
  }
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object' || !isIdLike(candidate.recordId)) {
      rejected.push({ reason: 'MISSING_OR_INVALID_RECORD_ID', candidate: candidate ?? null });
      continue;
    }
    if (candidate.indexState !== DTO_CANDIDATE_INDEX_STATE) {
      rejected.push({ reason: 'CANDIDATE_NOT_INDEXED', recordId: candidate.recordId,
        indexState: String(candidate.indexState ?? 'absent') });
      continue;
    }
    accepted.push({
      recordId: candidate.recordId,
      score: Number.isFinite(candidate.score) ? candidate.score : null,
      matchReason: normalizeMatchReason(candidate.matchReason, counters),
      indexRevision: Number.isSafeInteger(candidate.indexRevision) ? candidate.indexRevision : null,
      indexState: candidate.indexState,
      coverage: Number.isFinite(candidate.coverage) ? candidate.coverage : null
    });
  }
  return { accepted, rejected };
}

/**
 * The projection one authoritative record hands to an index: identity, the text
 * to match against, the record's own sequence, and the fields the DTO filters on.
 * Nothing else crosses, and the record's standing is included precisely so an
 * index can be told to forget what is no longer effective.
 *
 * `text` is `searchableText` - the same string the authoritative scan matches -
 * not the content alone. Handing the index a narrower text than the scan reads is
 * how a query found a record in one path and reported NO_MATCH in the other; the
 * two paths cannot be reconciled later, because a miss produces no candidate to
 * re-read.
 */
export function projectRecord(record) {
  return {
    recordId: record.recordId,
    instanceId: record.spaceId,
    revision: record.sequence,
    text: searchableText(record),
    status: record.status,
    sourceKind: record.source?.kind ?? null,
    sourceId: record.source?.id ?? null,
    occurredAt: record.occurredAt ?? null,
    acceptedAt: record.recordedAt
  };
}

/**
 * The whole-space projection: active records upserted, everything else removed.
 * The index is a derived object rebuilt from the authoritative document, which is
 * why it is never a second memory: delete it and nothing is lost but speed.
 */
export function spaceProjection(spaceDoc, validity) {
  const shaped = shapedRecords(spaceDoc, validity);
  return {
    upserts: shaped.filter((record) => record.status === 'active').map(projectRecord),
    removals: shaped.filter((record) => record.status !== 'active')
      .map((record) => ({ instanceId: record.spaceId, recordId: record.recordId }))
  };
}

function faultOf(error) {
  return {
    code: error && error.code ? error.code : 'SEARCH_ADAPTER_FAILED',
    message: error && error.message ? String(error.message).slice(0, 200) : 'unknown retrieval failure'
  };
}

function refusalReason(record, options, timeField) {
  if (options.kinds && !options.kinds.includes(record.kind)) return 'KIND_FILTERED';
  const status = options.status ?? 'active';
  if (status !== 'all' && record.status !== status) return 'NOT_EFFECTIVE';
  if (options.visibility && options.visibility !== 'all' && record.visibility !== options.visibility) {
    return 'VISIBILITY_FILTERED';
  }
  return 'TIME_FILTERED';
}

/**
 * The answer when the authoritative store is what actually answered - whether no
 * index is attached, the index cannot represent the question, or the index has
 * been taken out of service. Exported so the service can produce exactly this
 * shape itself instead of assembling a second, subtly different scan response.
 */
export function authoritativeScan(spaceDoc, validity, options, index) {
  return {
    ...querySpace(spaceDoc, validity, options),
    searchPath: SEARCH_PATH_SCAN,
    indexing: INDEXING_NOT_REQUIRED,
    index
  };
}

/**
 * @param {object} input
 * @param {(spaceId: string) => object} input.inspect reads the authoritative space
 * @param {(() => object|null)} [input.getAdapter] the wired index, if any
 */
export function createRetrievalCoordinator({ inspect, getAdapter }) {
  if (typeof inspect !== 'function') throw refusal('createRetrievalCoordinator requires inspect(spaceId).');

  function scan(spaceDoc, validity, options, index) {
    return Promise.resolve(authoritativeScan(spaceDoc, validity, options, index));
  }

  async function search({ spaceId, options = {} }) {
    const inspected = inspect(spaceId);
    if (!inspected.available) {
      throw Object.assign(new Error(`Space "${spaceId}" is unavailable.`), { code: 'ATLAS_SPACE_UNAVAILABLE' });
    }
    const { spaceDoc, validity } = inspected;
    const adapter = typeof getAdapter === 'function' ? getAdapter() : null;
    const planned = buildRetrievalRequest(spaceId, options);
    if (!adapter || typeof adapter.searchCandidates !== 'function') {
      return scan(spaceDoc, validity, options, { state: 'NOT_WIRED', reason: planned.usable ? null : planned.reason });
    }
    if (!planned.usable) {
      return scan(spaceDoc, validity, options, { state: 'NOT_APPLICABLE', reason: planned.reason });
    }

    const timeField = options.timeField ?? 'timestamp';
    const all = shapedRecords(spaceDoc, validity);
    const byId = new Map(all.map((record) => [record.recordId, record]));

    const counters = { legacyMatchReasons: 0 };
    const acceptedCount = { value: 0 };
    const rejected = [];
    const residue = [];
    const survivors = [];
    const seen = new Set();
    let windows = 0;
    let windowOffset = 0;
    let windowCapReached = false;
    let adapterState = null;
    let adapterTotalCount = null;
    let adapterHasMore = false;
    let generation = null;
    let note = null;

    const wanted = (options.offset ?? 0) + pageLimitOf(options);
    for (;;) {
      let payload;
      try {
        payload = await adapter.searchCandidates({ ...planned.request, offset: windowOffset });
      } catch (error) {
        const fault = faultOf(error);
        const refused = ['SEARCH_ADAPTER_INVALID', 'SEARCH_EMPTY_QUERY', 'SEARCH_CURSOR_INVALID'].includes(fault.code);
        return scan(spaceDoc, validity, options, {
          state: refused ? 'ADAPTER_REFUSED' : 'ADAPTER_FAILED', fault, fellBack: true, windows
        });
      }
      windows += 1;
      adapterState = typeof payload?.indexState === 'string' ? payload.indexState : null;
      note = typeof payload?.note === 'string' ? payload.note.slice(0, 200) : null;
      if (Number.isSafeInteger(payload?.indexGeneration)) generation = payload.indexGeneration;
      if (adapterState !== 'READY') {
        return scan(spaceDoc, validity, options, {
          state: adapterState === null ? 'ADAPTER_STATE_UNKNOWN' : 'INDEX_REBUILDING',
          adapterState, note, fellBack: true, windows
        });
      }
      const batch = normalizeCandidates(payload, counters);
      acceptedCount.value += batch.accepted.length;
      rejected.push(...batch.rejected);
      adapterTotalCount = Number.isSafeInteger(payload?.totalCount) ? payload.totalCount : adapterTotalCount;
      adapterHasMore = payload?.hasMore === true;

      for (const candidate of batch.accepted) {
        if (seen.has(candidate.recordId)) continue;
        seen.add(candidate.recordId);
        const record = byId.get(candidate.recordId);
        if (!record) {
          // The index lists something the authoritative document does not have.
          // Reported, never served and never quietly dropped.
          residue.push({ recordId: candidate.recordId, reason: 'NOT_IN_FORMAL_HISTORY' });
          continue;
        }
        if (!admits(record, options, timeField)) {
          residue.push({ recordId: candidate.recordId, reason: refusalReason(record, options, timeField) });
          continue;
        }
        const stale = candidate.indexRevision !== null && candidate.indexRevision !== record.sequence;
        survivors.push({
          ...record,
          score: candidate.score,
          matchReason: candidate.matchReason,
          coverage: candidate.coverage,
          indexRevision: candidate.indexRevision,
          indexState: candidate.indexState,
          indexStale: stale
        });
        if (stale) {
          residue.push({ recordId: candidate.recordId, reason: 'STALE_PROJECTION',
            indexRevision: candidate.indexRevision, sequence: record.sequence });
        }
      }
      const returned = Number.isSafeInteger(payload?.returned) ? payload.returned : batch.accepted.length;
      windowOffset += returned;
      const exhausted = returned === 0 || adapterHasMore === false ||
        (adapterTotalCount !== null && windowOffset >= adapterTotalCount);
      if (survivors.length >= wanted || exhausted) break;
      if (windows >= RETRIEVAL_MAX_WINDOWS) {
        windowCapReached = true;
        break;
      }
    }

    // The candidate order IS the ranking: an index returns its whole matched set
    // sorted, then pages it, so accumulating in arrival order gives a stable
    // global sequence that offset can slice. Re-sorting here on a different
    // tie-break (say, newest record first) reshuffles the prefix between requests
    // and makes successive pages overlap or skip records - measured, not
    // theorised. Membership is the store's decision; ordering is the index's.
    const limit = pageLimitOf(options);
    const offset = options.offset ?? 0;
    const page = survivors.slice(offset, offset + limit)
      .map((record) => servedRecord(record, { byId, validity, includeContent: options.includeContent }));

    return {
      outcome: survivors.length > 0 ? 'MATCHED' : 'NO_MATCH',
      spaceId,
      revision: validity.revision,
      timeField: options.since === undefined && options.until === undefined ? null : timeField,
      totalCount: survivors.length,
      limit,
      offset,
      returned: page.length,
      hasMore: windowCapReached || offset + page.length < survivors.length,
      records: page,
      counts: spaceCounts(spaceDoc, validity),
      searchPath: SEARCH_PATH_INDEX,
      indexing: INDEXING_ASSISTED,
      index: {
        state: 'WIRED',
        adapterState,
        generation,
        windows,
        windowLimit: planned.request.limit,
        windowCapReached,
        candidates: acceptedCount.value + rejected.length,
        adapterTotalCount,
        adapterHasMore,
        rejectedCandidates: rejected,
        residue,
        staleCandidates: survivors.filter((record) => record.indexStale).length,
        legacyMatchReasons: counters.legacyMatchReasons,
        authoritativeRevision: validity.revision
      }
    };
  }

  return { search };
}
