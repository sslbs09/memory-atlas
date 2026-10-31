/**
 * A real retrieval engine speaking SEARCH-DTO-v1, used to test the Atlas seam.
 *
 * It is deliberately not a stub that echoes what the coordinator wants: it owns
 * an inverted index (ASCII words plus CJK bigrams), intersects terms with AND,
 * scores by coverage x recency, pages with either offset or an opaque cursor, and
 * enforces the DTO's refusals by code. The point of the test suite is that two
 * independent implementations agree on the contract, so a seam that only works
 * against a mock written to match it is worth nothing.
 *
 * Bigrams come from adjacent character pairs only, which is what makes the DTO's
 * negative invariants hold: 「台灯」 is a term, and 「台球和灯笼」 does not
 * contain it.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function invalid(message, code = 'SEARCH_ADAPTER_INVALID') {
  return Object.assign(new Error(message), { code });
}

const isCJK = (character) => /[㐀-䶿一-鿿 -〿]/.test(character);

export function termsForQuery(text) {
  const terms = new Set();
  const lowered = String(text ?? '').toLowerCase();
  for (const match of lowered.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) terms.add({ term: match[0], kind: 'word' });
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 1) terms.add({ term: `${run[i]}${run[i + 1]}`, kind: 'cjk-2' });
    // A single isolated CJK character is still a term; it just cannot be a pair.
    if (run.length === 1) terms.add({ term: run[0], kind: 'cjk-1' });
    run = [];
  };
  for (const character of lowered) {
    if (isCJK(character)) run.push(character);
    else flush();
  }
  flush();
  return [...terms];
}

function tokenize(text) {
  return new Set(termsForQuery(text).map((entry) => entry.term));
}

function recencyFactor(isoAt, { now, windowDays = 120 }) {
  if (!isoAt) return 0.8;
  const parsed = Date.parse(isoAt);
  if (!Number.isFinite(parsed)) return 0.8;
  const days = Math.max(0, (now - parsed) / 86_400_000);
  return 0.6 + 0.4 * Math.exp(-days / windowDays);
}

function encodeCursor(offset) {
  return `o${offset}`;
}

function decodeCursor(cursor) {
  const match = /^o(\d+)$/.exec(String(cursor ?? ''));
  if (!match) throw invalid('cursor 无法解析', 'SEARCH_CURSOR_INVALID');
  return Number(match[1]);
}

function normalizeRecord(input, index = 0) {
  if (!input || typeof input !== 'object') throw invalid(`records[${index}] must be an object`);
  const { recordId, instanceId, revision, text } = input;
  if (typeof recordId !== 'string' || !recordId) throw invalid(`records[${index}].recordId must be a stable id`);
  if (typeof instanceId !== 'string' || !instanceId) throw invalid(`records[${index}].instanceId must be a space id`);
  if (!Number.isSafeInteger(revision)) throw invalid(`records[${index}].revision must be a safe integer`);
  if (typeof text !== 'string') throw invalid(`records[${index}].text must be a string`);
  if (!['active', 'superseded', 'retracted', 'recorded'].includes(input.status)) {
    throw invalid(`records[${index}].status must be active, superseded, retracted or recorded`);
  }
  return {
    recordId, instanceId, revision, text,
    status: input.status,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    subject: input.subject ?? null,
    occurredAt: input.occurredAt ?? null,
    acceptedAt: input.acceptedAt ?? null
  };
}

export class LexicalEngine {
  #postings = new Map();     // term -> Map(docKey -> recordId)
  #docs = new Map();         // docKey -> record
  #generation = 0;
  #rebuilding = false;
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.name = 'lexical-engine-test';
    this.#now = now;
  }

  get indexGeneration() { return this.#generation; }
  get isOpen() { return true; }
  get size() { return this.#docs.size; }

  setRebuilding(value) { this.#rebuilding = Boolean(value); }

  close() { /* in-memory: nothing to release, and no file to leak */ }

  #key(instanceId, recordId) { return `${instanceId}:${recordId}`; }

  upsertRecords(records) {
    if (!Array.isArray(records)) throw invalid('records must be an array');
    const normalized = records.map(normalizeRecord);
    for (const record of normalized) {
      const key = this.#key(record.instanceId, record.recordId);
      if (record.status !== 'active') {
        this.removeRecords([{ instanceId: record.instanceId, recordId: record.recordId }]);
        continue;
      }
      const previous = this.#docs.get(key);
      if (previous && previous.revision === record.revision) continue; // idempotent projection
      if (previous) {
        for (const term of tokenize(previous.text)) this.#postings.get(term)?.delete(key);
      }
      this.#docs.set(key, record);
      for (const term of tokenize(record.text)) {
        if (!this.#postings.has(term)) this.#postings.set(term, new Map());
        this.#postings.get(term).set(key, record.recordId);
      }
    }
    this.#generation += 1;
    return { upserted: normalized.length, generation: this.#generation };
  }

  removeRecords(ids) {
    if (!Array.isArray(ids)) throw invalid('ids must be an array');
    let removed = 0;
    for (const entry of ids) {
      const { instanceId, recordId } = typeof entry === 'string' ? { instanceId: null, recordId: entry } : entry;
      const keys = instanceId === null
        ? [...this.#docs.keys()].filter((key) => key.endsWith(`:${recordId}`))
        : [this.#key(instanceId, recordId)];
      for (const key of keys) {
        const doc = this.#docs.get(key);
        if (!doc) continue;
        this.#docs.delete(key);
        for (const term of tokenize(doc.text)) this.#postings.get(term)?.delete(key);
        removed += 1;
      }
    }
    this.#generation += 1;
    return { removed, generation: this.#generation };
  }

  /** Rebuild the whole projection from records handed back by the authority. */
  rebuild(records) {
    this.#rebuilding = true;
    try {
      this.#postings = new Map();
      this.#docs = new Map();
      this.#generation += 1;
      this.#rebuilding = false;
      return this.upsertRecords(records);
    } finally {
      this.#rebuilding = false;
    }
  }

  searchCandidates(params = {}) {
    let q = params.q ?? params.query;
    if (params.q !== undefined && params.query !== undefined && params.q !== params.query) {
      throw invalid('q and query given with different values; q is canonical');
    }
    const nz = (value) => (value === null || value === undefined ? undefined : value);
    const { recordId, instanceId, instanceIds, sourceKind, sourceId, subject, includeText = false } = params;
    const since = nz(params.since);
    const until = nz(params.until);
    q = nz(q);
    const cursor = nz(params.cursor);
    const offsetParam = nz(params.offset);
    const limit = nz(params.limit) ?? DEFAULT_LIMIT;

    if (this.#rebuilding) {
      return { indexState: 'REBUILDING', indexGeneration: this.#generation, outcome: 'NO_MATCH',
        totalCount: 0, limit, offset: 0, returned: 0, hasMore: false, nextCursor: null, candidates: [],
        note: 'rebuild in progress: refusing to answer instead of pretending nothing matched' };
    }

    const spaces = instanceIds ?? (instanceId ? [instanceId] : []);
    const hasFilter = recordId !== undefined || since !== undefined || until !== undefined
      || sourceKind !== undefined || sourceId !== undefined || subject !== undefined || spaces.length > 0;
    if (q === undefined && recordId === undefined && !hasFilter) {
      throw invalid('empty query refused: give q or at least one filter');
    }
    if (q !== undefined && recordId !== undefined) throw invalid('q and recordId are mutually exclusive');
    let offset = 0;
    if (cursor !== undefined && offsetParam !== undefined) throw invalid('cursor and offset are mutually exclusive');
    if (cursor !== undefined) offset = decodeCursor(cursor);
    else if (offsetParam !== undefined) {
      if (!Number.isSafeInteger(offsetParam) || offsetParam < 0) throw invalid('offset must be a non-negative integer');
      offset = offsetParam;
    }
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
      throw invalid(`limit must be an integer between 0 and ${MAX_LIMIT}`);
    }

    const inSpace = (doc) => spaces.length === 0 || spaces.includes(doc.instanceId);
    if (recordId !== undefined) {
      const hits = [...this.#docs.values()].filter((doc) => doc.recordId === recordId && inSpace(doc));
      return this.#page(hits.map((doc) => ({ doc, coverage: null, reasons: ['exact-record-id'], score: 1000 })), { limit, offset, includeText });
    }

    const terms = q !== undefined ? termsForQuery(q) : [];
    if (q !== undefined && terms.length === 0) throw invalid('q produces no indexable term', 'SEARCH_EMPTY_QUERY');

    let keys = null;
    const matchedTerms = [];
    for (const entry of terms) {
      const postings = this.#postings.get(entry.term);
      matchedTerms.push(entry);
      const current = new Set(postings ? postings.keys() : []);
      keys = keys === null ? current : new Set([...keys].filter((key) => current.has(key)));
      if (keys.size === 0) break;
    }
    let hits = [...(keys ?? new Set())].map((key) => this.#docs.get(key)).filter(Boolean).filter(inSpace);
    if (sourceKind !== undefined) hits = hits.filter((doc) => doc.sourceKind === sourceKind);
    if (sourceId !== undefined) hits = hits.filter((doc) => doc.sourceId === sourceId);
    if (subject !== undefined) hits = hits.filter((doc) => doc.subject === subject);
    if (since !== undefined || until !== undefined) {
      const from = since === undefined ? -Infinity : Date.parse(since);
      const to = until === undefined ? Infinity : Date.parse(until);
      hits = hits.filter((doc) => {
        const at = Date.parse(String(doc.occurredAt ?? doc.acceptedAt ?? ''));
        return Number.isFinite(at) && at >= from && at <= to;
      });
    }
    const coverageBase = Math.max(terms.length, 1);
    const scored = hits.map((doc) => {
      const coverage = terms.length > 0 ? Math.min(1, matchedTerms.filter((entry) => tokenize(doc.text).has(entry.term)).length / coverageBase) : 0;
      const reasons = terms.length > 0
        ? matchedTerms.map((entry) => `term:${entry.term}(${entry.kind})`)
        : ['filter-only'];
      const recency = recencyFactor(doc.occurredAt ?? doc.acceptedAt, { now: this.#now() });
      reasons.push(`recency:${recency.toFixed(3)}`);
      return { doc, coverage: terms.length > 0 ? Number(coverage.toFixed(4)) : null, reasons, score: Number(((1 + coverage) * recency).toFixed(4)) };
    }).sort((a, b) => b.score - a.score || (a.doc.recordId < b.doc.recordId ? -1 : 1));
    return this.#page(scored, { limit, offset, includeText });
  }

  #page(scored, { limit, offset, includeText }) {
    const slice = scored.slice(offset, offset + limit);
    const hasMore = offset + slice.length < scored.length;
    return {
      indexState: 'READY',
      indexGeneration: this.#generation,
      outcome: scored.length > 0 ? 'MATCHED' : 'NO_MATCH',
      totalCount: scored.length,
      limit,
      offset,
      returned: slice.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(offset + slice.length) : null,
      candidates: slice.map(({ doc, coverage, reasons, score }) => ({
        recordId: doc.recordId,
        instanceId: doc.instanceId,
        indexRevision: doc.revision,
        score,
        coverage,
        matchReason: reasons,
        indexState: 'INDEXED',
        status: doc.status,
        occurredAt: doc.occurredAt,
        acceptedAt: doc.acceptedAt,
        ...(includeText ? { text: doc.text } : {})
      }))
    };
  }
}

export function createRetrievalAdapter() {
  return new LexicalEngine();
}
