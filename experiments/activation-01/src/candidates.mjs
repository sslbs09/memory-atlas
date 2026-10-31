// 候选池：合成数据库中的记录投影，语义对齐 glm-retrieval adapter.mjs @ 4f112f2。
//
// 边界（与真实系统一致）：
//   - 只有 status='active' 的记录进入候选投影；retracted / superseded 永远不可达
//     （负向不变量：已撤回投影在任何关键词下不可达）。
//   - 检索层不做效力裁决：本实验同样信任语料中交付的 status。
//   - 记忆空间（spaceId ≙ 真实系统的 instanceId）是硬边界：任何查询只在自己
//     的空间范围内产生候选，跨空间 recordId 不串联。

import { tokenizeForIndex, termsForQuery } from './tokenizer.mjs';

const VALID_STATUS = new Set(['active', 'superseded', 'retracted', 'recorded']);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'ACT_EVAL_CANDIDATE_INVALID' });
}

function normalizeRecord(input, index = 0) {
  const where = `records[${index}]`;
  if (!input || typeof input !== 'object') throw invalid(`${where} 必须是对象`);
  const { recordId, spaceId, revision, text, status } = input;
  if (typeof recordId !== 'string' || !recordId) throw invalid(`${where}.recordId 必须是非空字符串`);
  if (typeof spaceId !== 'string' || !spaceId) throw invalid(`${where}.spaceId 必须是非空字符串`);
  if (!Number.isSafeInteger(Number(revision))) throw invalid(`${where}.revision 必须是安全整数`);
  if (typeof text !== 'string') throw invalid(`${where}.text 必须是字符串`);
  if (status !== undefined && !VALID_STATUS.has(status)) throw invalid(`${where}.status 非法`);
  return {
    recordId,
    spaceId,
    revision: Number(revision),
    text,
    status: status ?? 'active',
    occurredAt: typeof input.occurredAt === 'string' ? input.occurredAt : null,
    acceptedAt: typeof input.acceptedAt === 'string' ? input.acceptedAt : null,
    // —— 以下为 v0.2 信号模型的静态属性；激活引擎只读，永不写回 ——
    importance: input.importance ?? 'normal',          // 静态重要度：不由回忆频率增长
    sourceKind: typeof input.sourceKind === 'string' ? input.sourceKind : null,
    sourceId: typeof input.sourceId === 'string' ? input.sourceId : null,
    subject: typeof input.subject === 'string' ? input.subject : null
  };
}

// A0 基线的 recency 因子：与 adapter.mjs:79-84 逐字一致。
export function recencyFactor(isoAt, { now, windowDays = 120 } = {}) {
  if (!isoAt) return 0.8; // 无时间戳的记录给中性偏低权重，不隐藏也不偏爱
  const days = Math.max(0, (now - Date.parse(isoAt)) / 86_400_000);
  if (!Number.isFinite(days)) return 0.8;
  return 0.6 + 0.4 * Math.exp(-days / windowDays);
}

export class CandidatePool {
  // 合成语料：正式记录全集（含 retracted/superseded，用于验证不可达）。
  constructor(records) {
    this.#records = (records ?? []).map(normalizeRecord);
    this.#bySpace = new Map();
    for (const rec of this.#records) {
      let list = this.#bySpace.get(rec.spaceId);
      if (!list) { list = []; this.#bySpace.set(rec.spaceId, list); }
      list.push(rec);
    }
    this.#terms = new Map(); // `${spaceId}::${recordId}` -> Set(term)
    for (const rec of this.#records) this.#terms.set(keyOf(rec), tokenizeForIndex(rec.text));
  }

  #records;
  #bySpace;
  #terms;

  get recordCount() { return this.#records.length; }

  getRecord(spaceId, recordId) {
    return this.#records.find((r) => r.spaceId === spaceId && r.recordId === recordId) ?? null;
  }

  // 全部记录（含非 active），供诊断/测试使用；rankCandidates 永不直接消费。
  allRecords() { return this.#records.slice(); }

  activeRecords(spaceIds) {
    const scope = resolveScope(this.#bySpace, spaceIds);
    return scope.filter((r) => r.status === 'active');
  }

  // 显式查询：与真实 adapter 相同的 AND 语义——命中全部查询词元的 active 记录才是候选。
  // coverage 与 adapter.mjs:236 一致（AND 求交后恒为 matchedTerms/terms.length），
  // id 命中加成同 adapter.mjs:238-239。
  explicitCandidates({ q, spaceIds }) {
    const terms = termsForQuery(q);
    if (terms.length === 0) {
      throw invalid('q 无法产生任何检索词元（全标点或空白）', 'ACT_EVAL_EMPTY_QUERY');
    }
    const scope = resolveScope(this.#bySpace, spaceIds).filter((r) => r.status === 'active');
    const out = [];
    for (const rec of scope) {
      const docTerms = this.#terms.get(keyOf(rec));
      let all = true;
      const matched = [];
      for (const t of terms) {
        if (docTerms.has(t.term)) matched.push(t);
        else { all = false; break; }
      }
      if (!all) continue;
      let coverage = matched.length / Math.max(terms.length, 1);
      const idHit = terms.find((t) => rec.recordId.toLowerCase().includes(t.term));
      if (idHit) coverage = Math.min(1, coverage + 0.5);
      out.push({ record: rec, coverage, matchedTerms: matched, mode: 'explicit' });
    }
    return out;
  }

  // 情境联想（ambient）：无明确查询词。用情境词元与记录词元的交集占比作为
  // 词面相关性代理（|situation ∩ doc| / |situation|）。这是 Generative Agents
  // relevance 的确定性词法替代，不引入向量。coverage<=0 的记录不是候选。
  ambientCandidates({ situation, spaceIds }) {
    const terms = termsForQuery(situation);
    if (terms.length === 0) throw invalid('situation 无法产生任何词元');
    const scope = resolveScope(this.#bySpace, spaceIds).filter((r) => r.status === 'active');
    const unique = new Map(terms.map((t) => [t.term, t]));
    const out = [];
    for (const rec of scope) {
      const docTerms = this.#terms.get(keyOf(rec));
      const matched = [...unique.values()].filter((t) => docTerms.has(t.term));
      const coverage = matched.length / Math.max(unique.size, 1);
      if (coverage <= 0) continue;
      out.push({ record: rec, coverage, matchedTerms: matched, mode: 'ambient' });
    }
    return out;
  }

  docTerms(spaceId, recordId) {
    return this.#terms.get(`${spaceId}::${recordId}`) ?? new Set();
  }
}

function keyOf(rec) { return `${rec.spaceId}::${rec.recordId}`; }

function resolveScope(bySpace, spaceIds) {
  if (spaceIds === undefined || spaceIds === null) {
    return [...bySpace.values()].flat();
  }
  const list = Array.isArray(spaceIds) ? spaceIds : [spaceIds];
  const out = [];
  for (const id of list) {
    const bucket = bySpace.get(id);
    if (bucket) out.push(...bucket);
  }
  return out;
}
