// B4 Search Adapter：Backend B 的对外接口（Host 内部受信组件）。
//
// 契约（与 Backend A 对齐，见 README）：
//   upsertRecords(records) / removeRecords(ids) / searchCandidates(query)
//   rebuildIndex() / getIndexStats() / verifyIndex()
//
// 候选返回至少包含：recordId, instanceId, indexRevision, score, matchReason,
// indexState, nextCursor（在响应对象上）。
//
// 边界（A5 / B4）：
//   - 候选默认不携带正文（includeText 默认 false）——正文由 Backend A 从正式
//     权威按权限与有效性取回；未经 A 校验的正文不会经本模块流向客户端。
//   - 正式效力不在检索层决定：本模块只信任调用方交付的 status，且默认只投影
//     active 记录；retrieval score 永远不覆盖 Core 的效力判定。
//   - 时间衰减只影响 score 排序，不影响任何记录的存在性。

import { IndexStore } from './store.mjs';
import { termsForQuery } from './tokenize.mjs';
import { findAssociations } from './association.mjs';
import { GraphProjection } from './graph.mjs';

const VALID_STATUS_INPUTS = new Set(['active', 'superseded', 'retracted', 'recorded']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function invalid(message, code = 'SEARCH_ADAPTER_INVALID') {
  return Object.assign(new Error(message), { code });
}

function normalizeRecord(input, index = 0) {
  const where = `records[${index}]`;
  if (!input || typeof input !== 'object') throw invalid(`${where} 必须是对象`);
  const { recordId, instanceId, revision, text, status } = input;
  if (typeof recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recordId)) {
    throw invalid(`${where}.recordId 必须是稳定记录 id 字符串`);
  }
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instanceId)) {
    throw invalid(`${where}.instanceId 必须是实例 id 字符串`);
  }
  if (!Number.isSafeInteger(Number(revision))) throw invalid(`${where}.revision 必须是安全整数`);
  if (typeof text !== 'string') throw invalid(`${where}.text 必须是字符串`);
  if (status !== undefined && !VALID_STATUS_INPUTS.has(status)) {
    throw invalid(`${where}.status 必须是 ${[...VALID_STATUS_INPUTS].join(' / ')}`);
  }
  return {
    recordId,
    instanceId,
    revision: Number(revision),
    text,
    status: status ?? 'active',
    sourceKind: typeof input.sourceKind === 'string' ? input.sourceKind : null,
    sourceId: typeof input.sourceId === 'string' ? input.sourceId : null,
    eventId: typeof input.eventId === 'string' ? input.eventId : null,
    subject: typeof input.subject === 'string' ? input.subject : null,
    sourceSession: typeof input.sourceSession === 'string' ? input.sourceSession : null,
    occurredAt: typeof input.occurredAt === 'string' ? input.occurredAt : null,
    acceptedAt: typeof input.acceptedAt === 'string' ? input.acceptedAt : null,
    // 图投影关系字段（全部由调用方交付；缺省即无边）。检索层从不推断这些字段。
    supersedes: typeof input.supersedes === 'string' ? input.supersedes : undefined,
    derivedFrom: typeof input.derivedFrom === 'string' ? input.derivedFrom : undefined,
    mentions: Array.isArray(input.mentions) ? input.mentions.filter((m) => typeof m === 'string') : undefined,
    relations: Array.isArray(input.relations) ? input.relations.filter((r) => r && typeof r.to === 'string') : undefined
  };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(parsed.o) || parsed.o < 0) throw new Error('bad offset');
    return parsed.o;
  } catch {
    throw invalid('cursor 无法解析', 'SEARCH_CURSOR_INVALID');
  }
}

function recencyFactor(isoAt, { now = Date.now(), windowDays = 120 } = {}) {
  if (!isoAt) return 0.8; // 无时间戳的记录给中性偏低权重，不隐藏也不偏爱
  const days = Math.max(0, (now - Date.parse(isoAt)) / 86_400_000);
  if (!Number.isFinite(days)) return 0.8;
  return 0.6 + 0.4 * Math.exp(-days / windowDays);
}

export class SearchAdapter {
  #store;
  #rebuilding = false;
  #recencyWindowDays;
  #onBeforeCommit = null;   // 测试钩子：索引重建提交前注入故障
  #onGraphPhase = null;     // 测试钩子：索引写入后、图写入前注入故障（验证同事务原子性）

  constructor({ path = null, recencyWindowDays = 120 } = {}) {
    this.#recencyWindowDays = recencyWindowDays;
    this.#store = new IndexStore({ path });
    this.#store.open();
    // Memory Atlas 图投影：与索引同库、同记录流驱动、可重建的派生物。
    this.graph = new GraphProjection(this.#store);
  }

  // 故障注入钩子（测试用）。
  setRebuildFaultHook(hook) { this.#onBeforeCommit = hook; }
  setGraphFaultHook(hook) { this.#onGraphPhase = hook; }

  get indexGeneration() { return this.#store.indexGeneration; }
  get isOpen() { return this.#store.isOpen; }
  close() { this.#store.close(); }

  upsertRecords(records) {
    if (!Array.isArray(records)) throw invalid('records 必须是数组');
    const normalized = records.map(normalizeRecord);
    // 索引投影与图投影在同一个事务内提交：GPT 验收修复轮第 3 项——
    // 禁止"索引已提交、图更新失败"的中间态存在。
    const results = this.#store.transaction(() => {
      const outcomes = this.#store.upsertMany(normalized);
      this.#onGraphPhase?.();
      for (let i = 0; i < normalized.length; i += 1) {
        const record = normalized[i];
        if (outcomes[i].outcome === 'PROJECTION_REMOVED') this.graph.removeRecord(record.instanceId, record.recordId);
        else this.graph.upsertRecord(record);
      }
      return outcomes;
    });
    return results.map((r, i) => ({
      recordId: normalized[i].recordId,
      instanceId: normalized[i].instanceId,
      ...r
    }));
  }

  removeRecords(ids) {
    if (!Array.isArray(ids)) throw invalid('ids 必须是数组（{instanceId, recordId} 或 recordId 字符串）');
    return this.#store.transaction(() => {
      const removed = this.#store.removeRecords(ids);
      for (const item of removed) this.graph.removeRecord(item.instanceId, item.recordId);
      return removed;
    });
  }

  // 查询候选。q 与至少一个过滤条件（recordId/since/until/sourceKind/sourceId/
  // subject/sourceSession）必须给其一——拒绝空查询，不做“假装全库”。
  searchCandidates(params = {}) {
    // ---- DTO 冻结（SEARCH-DTO-v1）参数归一 ----
    // q/query 别名：q 为规范名，query 为 Backend A Core 视图的同义别名；
    // 两者同时给出且不同值时拒绝（不许静默猜测）。
    let q = params.q ?? params.query;
    if (params.q !== undefined && params.query !== undefined && params.q !== params.query) {
      throw invalid('q 与 query 同时给出且值不同：统一 DTO 以 q 为规范名，请只传其一');
    }
    // null 与 undefined 同义（Host 传输层对缺席参数给 null）。
    const nz = (value) => (value === null || value === undefined ? undefined : value);
    const {
      recordId, instanceId, instanceIds,
      sourceKind, sourceId, sourceSession, subject, types,
      includeText = false, associate = false
    } = params;
    const since = nz(params.since);
    const until = nz(params.until);
    q = nz(q);
    const cursor = nz(params.cursor);
    const offsetParam = nz(params.offset);
    const limit = nz(params.limit) ?? DEFAULT_LIMIT;

    if (this.#rebuilding) {
      return { indexState: 'REBUILDING', indexGeneration: this.#store.indexGeneration,
        outcome: 'NO_MATCH', totalCount: 0, limit, offset: 0, returned: 0, hasMore: false,
        nextCursor: null, candidates: [],
        note: '索引重建进行中：拒绝返回结果而不是假装空命中' };
    }

    const resolvedInstances = instanceIds ?? (instanceId ? [instanceId] : []);
    const hasFilter = recordId !== undefined || since !== undefined || until !== undefined
      || sourceKind !== undefined || sourceId !== undefined || sourceSession !== undefined
      || subject !== undefined || types !== undefined || resolvedInstances.length > 0;
    if (q === undefined && recordId === undefined && !hasFilter) {
      throw invalid('拒绝空查询：必须提供 q（关键词）或至少一个过滤条件（recordId/since/until/sourceKind/sourceId/subject/sourceSession）');
    }
    if (q !== undefined && recordId !== undefined) {
      throw invalid('q 与 recordId 二选一（与 Backend A 的 /memory-search 语义一致）');
    }
    // 分页：cursor（不透明游标）与 offset（整数）二选一。
    let offset = 0;
    if (cursor !== undefined && offsetParam !== undefined) {
      throw invalid('cursor 与 offset 同时给出：统一 DTO 二者只传其一');
    }
    if (cursor !== undefined) offset = decodeCursor(cursor);
    else if (offsetParam !== undefined) {
      if (!Number.isSafeInteger(offsetParam) || offsetParam < 0) throw invalid('offset 必须是非负安全整数');
      offset = offsetParam;
    }
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
      throw invalid(`limit 必须是 0~${MAX_LIMIT} 的整数`);
    }

    const exactDocs = recordId !== undefined ? this.#store.getByRecordId(recordId) : null;
    if (recordId !== undefined) {
      const narrowed = resolvedInstances.length > 0
        ? exactDocs.filter((d) => resolvedInstances.includes(d.instance_id))
        : exactDocs;
      if (narrowed.length === 0) {
        return { indexState: 'READY', indexGeneration: this.#store.indexGeneration,
          outcome: 'NO_MATCH', totalCount: 0, limit, offset, returned: 0, hasMore: false,
          nextCursor: null, candidates: [] };
      }
      return {
        indexState: 'READY',
        indexGeneration: this.#store.indexGeneration,
        outcome: 'MATCHED',
        totalCount: narrowed.length,
        limit, offset: 0, returned: narrowed.length, hasMore: false,
        nextCursor: null,
        candidates: narrowed.map((doc) => ({
          recordId: doc.record_id, instanceId: doc.instance_id,
          indexRevision: doc.revision, score: 1000, coverage: null,
          matchReason: ['exact-record-id'], indexState: 'INDEXED',
          status: doc.status,
          ...(includeText ? { text: doc.text } : {})
        }))
      };
    }

    const terms = q !== undefined ? termsForQuery(q) : [];
    if (q !== undefined && terms.length === 0) {
      throw invalid('q 无法产生任何检索词元（全标点或空白）', 'SEARCH_EMPTY_QUERY');
    }
    const { rows, matchedTerms } = this.#store.collectCandidates({
      terms, instanceIds: resolvedInstances, since, until,
      sourceKind, sourceId, sourceSession, subject, types
    });

    const scored = rows.map((doc) => {
      const matchReason = [];
      let coverage = 0;
      if (terms.length > 0) {
        // collectCandidates 已按词元求交：到达这里的文档命中了全部词元。
        coverage = matchedTerms.length / Math.max(terms.length, 1);
        for (const m of matchedTerms) matchReason.push(`term:${m.term}(${m.kind})`);
        const idHit = terms.find((t) => doc.record_id.toLowerCase().includes(t.term));
        if (idHit) { matchReason.push(`id-term:${idHit.term}`); coverage = Math.min(1, coverage + 0.5); }
      } else {
        matchReason.push('filter-only');
      }
      const recency = recencyFactor(doc.occurred_at ?? doc.accepted_at, { windowDays: this.#recencyWindowDays });
      matchReason.push(`recency:${recency.toFixed(3)}`);
      const score = Number(((1 + coverage) * recency).toFixed(4));
      return {
        recordId: doc.record_id,
        instanceId: doc.instance_id,
        indexRevision: doc.revision,
        score,
        coverage: terms.length > 0 ? Number(coverage.toFixed(4)) : null,
        matchReason,
        indexState: 'INDEXED',
        status: doc.status,
        occurredAt: doc.occurred_at,
        acceptedAt: doc.accepted_at,
        ...(includeText ? { text: doc.text } : {}),
        _doc: doc
      };
    }).sort((a, b) => b.score - a.score || (a.recordId < b.recordId ? -1 : 1));

    if (associate) {
      const base = scored.slice(0, 3);
      const extra = findAssociations(this.#store, base.map((c) => c._doc), { excludeKeys: new Set(scored.map((c) => `${c.instanceId}:${c.recordId}`)) });
      for (const assoc of extra) {
        scored.push({
          recordId: assoc.doc.record_id,
          instanceId: assoc.doc.instance_id,
          indexRevision: assoc.doc.revision,
          score: Number((scored.length ? scored[scored.length - 1].score * 0.99 : 0.5).toFixed(4)),
          coverage: null,
          matchReason: [assoc.reason, `anchor:${assoc.anchorRecordId}`],
          indexState: 'INDEXED',
          status: assoc.doc.status,
          occurredAt: assoc.doc.occurred_at,
          acceptedAt: assoc.doc.accepted_at,
          ...(includeText ? { text: assoc.doc.text } : {}),
          _doc: assoc.doc
        });
      }
    }

    const page = scored.slice(offset, offset + limit);
    const nextCursor = offset + page.length < scored.length ? encodeCursor(offset + page.length) : null;
    const publicPage = page.map(({ _doc, ...rest }) => rest);
    return {
      indexState: 'READY',
      indexGeneration: this.#store.indexGeneration,
      outcome: publicPage.length > 0 ? 'MATCHED' : 'NO_MATCH',
      totalCount: scored.length,
      limit,
      offset,
      returned: publicPage.length,
      hasMore: offset + page.length < scored.length,
      nextCursor,
      candidates: publicPage
    };
  }

  // 全量重建：代际 +1，原子提交。中断（含故障注入）→ 回滚，旧代际完好。
  rebuildIndex(records) {
    if (!Array.isArray(records)) throw invalid('records 必须是数组');
    const normalized = records.map(normalizeRecord);
    this.#rebuilding = true;
    try {
      // 索引与图在同一事务内重建：任一阶段失败（含图阶段故障注入）整体回滚，
      // 代际保持一致——不存在"索引新代际 + 图旧代际"的可观测中间态。
      // 代际在本事务内一次计算、显式传入两侧，避免中途读取旧内存值。
      const { index, graph } = this.#store.transaction(() => {
        const generation = this.#store.peekNextGeneration();
        const indexResults = this.#store.rebuildWithin(normalized, { onBeforeCommit: this.#onBeforeCommit, generation });
        this.#onGraphPhase?.();
        const graphResult = this.graph.rebuildWithin(normalized, { generation });
        return { index: indexResults, graph: graphResult };
      });
      return {
        indexGeneration: this.#store.indexGeneration,
        graphGeneration: graph.graphGeneration,
        indexed: index.filter((r) => r.outcome === 'INDEXED').length,
        removed: index.filter((r) => r.outcome === 'PROJECTION_REMOVED').length
      };
    } finally {
      this.#rebuilding = false;
    }
  }

  // 图投影自动恢复（GPT 修复轮第 3 项的可自动恢复代际状态）：
  // documents 表在 v2 schema 中持久化了全部关系字段，因此图可以从索引自身
  // 完整重建。当 verifyIndex 发现图与索引计数漂移（如历史版本的两段式提交
  // 造成的 NODE_DOCUMENT_COUNT_MISMATCH），调用本方法即恢复一致，无需回到
  // 正式来源。
  recoverGraph() {
    const docs = this.#store.allDocuments();
    const records = docs.map((doc) => normalizeRecord({
      recordId: doc.record_id,
      instanceId: doc.instance_id,
      revision: doc.revision,
      text: doc.text,
      status: doc.status,
      sourceKind: doc.source_kind ?? undefined,
      sourceId: doc.source_id ?? undefined,
      eventId: doc.event_id ?? undefined,
      subject: doc.subject ?? undefined,
      sourceSession: doc.source_session ?? undefined,
      occurredAt: doc.occurred_at ?? undefined,
      acceptedAt: doc.accepted_at ?? undefined,
      supersedes: doc.supersedes_target ?? undefined,
      derivedFrom: doc.derived_from ?? undefined,
      mentions: doc.mentions_json ? JSON.parse(doc.mentions_json) : undefined,
      relations: doc.relations_json ? JSON.parse(doc.relations_json) : undefined
    }));
    const outcome = this.#store.transaction(() => this.graph.rebuildWithin(records));
    return { ...outcome, rebuiltFrom: 'index-documents', records: records.length };
  }

  // 从全量记录同步（增量）：调用方自行保证 status 来自正式权威。
  getIndexStats() {
    return { indexState: this.#rebuilding ? 'REBUILDING' : 'READY', ...this.#store.stats() };
  }

  // 索引 + 图自检：SQLite 完整性、倒排互证、图边端点存在性、
  // memory/correction 节点数与文档投影数一致。
  verifyIndex() {
    const verdict = this.#store.verify();
    const graphVerdict = this.graph.verify({ documentCount: this.#store.stats().documents });
    return {
      indexState: this.#rebuilding ? 'REBUILDING' : 'READY',
      indexGeneration: this.#store.indexGeneration,
      ok: verdict.ok && graphVerdict.ok,
      index: verdict,
      graph: graphVerdict
    };
  }

  // 后端 A 的最终过滤所需的最小事实：候选永远是 active 投影；本方法仅供
  // 内部诊断（验证“没有撤回残留”）。
  _removedLedgerCount() { return this.#store.stats().removedLedger; }
}
