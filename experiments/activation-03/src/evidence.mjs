// 词元证据提取与 G1 tier 判定 —— 仅消费真实路径上的原生/合法证据。
//
// activation-02 的 computeTier 输入是实验池自算的 docTerms（activation-01
// tokenizer），这在真实路径上不存在。本模块的证据来源严格分两类：
//
//   native        matchReason / coverage —— 真 SearchAdapter 的 DTO 原生输出，
//                 一字不改地解析（`term:<t>(<kind>)`、`filter-only`、
//                 `association:*`、`anchor:*`、`recency:*`）。
//                 注意真实 adapter 的 matchReason 有 8 条截断上限
//                 （retrieval.js MATCH_REASON_MAX_ENTRIES=8），长查询尾部词元
//                 不出现——这本身就是「词元证据在真实链路是不完整」的实证。
//   authoritative recordId 命中判定（与 adapter.mjs:238 的 idHit 规则逐字一致：
//                 term 是 recordId 小写子串）与 phrase 命中（规范化后整串连续
//                 出现在权威 content 中）。reranker 在权威记录之后运行，读
//                 content 是它的合法输入；但这是**影子侧重算**，不是索引原生
//                 输出 —— 每个候选都携带 evidenceSource 标注。
//
// 禁止：给结构共现候选（路径 B）编造任何词元证据；给 scan 回退（路径 C，
// 无 matchReason）编造词元证据。这两类路径 evidenceTier = 'none'。

import { normalizeText } from '../../activation-01/src/tokenizer.mjs';

export const TIER_NAMES = Object.freeze({
  0: 'id-hit',
  1: 'phrase',
  2: 'multi-bigram',
  3: 'bigram-plus',
  4: 'weak'
});

export function parseMatchReason(entries) {
  const terms = [];
  const idTerms = [];
  const associationReasons = [];
  let sawRecency = false;
  for (const raw of entries ?? []) {
    const entry = String(raw);
    if (entry.startsWith('term:')) {
      const m = entry.match(/^term:(.*)\((cjk-1|cjk-2|ascii)\)$/);
      if (m) terms.push({ term: m[1], kind: m[2] });
    } else if (entry.startsWith('id-term:')) {
      idTerms.push(entry.slice('id-term:'.length));
    } else if (entry.startsWith('association:') || entry.startsWith('anchor:')) {
      associationReasons.push(entry);
    } else if (entry.startsWith('recency:')) {
      sawRecency = true;
    }
  }
  return { terms, idTerms, associationReasons, sawRecency };
}

export function classifyEvidencePath({ matchReason, coverage }) {
  const parsed = parseMatchReason(matchReason);
  if (parsed.associationReasons.length > 0) return 'structural-association';
  if (parsed.terms.length > 0 || parsed.idTerms.length > 0) return 'lexical';
  if (matchReason !== null && matchReason.some((m) => String(m) === 'filter-only')) return 'filter-only';
  if (coverage !== null && coverage !== undefined) return 'lexical';
  return 'none';
}

// 单候选 tier（输入 = 影子侧合法证据）。scopeDf/scopeDocCount 来自权威投影
// （coordinator inspect 可见的同一信息范围）。
export function computeTierFromReal({
  recordId, content, matchReason, coverage, queryTerms, collapsedQuery, scopeDf, scopeDocCount
}) {
  const parsed = parseMatchReason(matchReason);
  const evidenceClass = classifyEvidencePath({ matchReason, coverage });

  if (evidenceClass === 'structural-association' || evidenceClass === 'none') {
    return {
      tier: 4, tierName: TIER_NAMES[4],
      label: evidenceClass === 'structural-association'
        ? '结构共现候选：无任何词元证据（G1 不适用）'
        : '无词元证据（scan 回退 / filter-only）',
      matchedBigrams: [], matchedUnigrams: [], residualUnigrams: [], discriminativeResidual: [],
      idHit: false, phraseHit: false, evidenceClass, evidenceSource: 'none'
    };
  }

  // 词元集合以原生 matchReason 为准；8 条截断导致长查询尾部缺失 —— 如实使用
  // 截断后的集合（这正是真实链路上 reranker 能拿到的东西）。
  const unique = [...new Map(queryTerms.map((t) => [t.term, t])).values()];
  const nativeTerms = new Map(parsed.terms.map((t) => [t.term, t]));
  const matchedBigrams = [];
  const matchedUnigrams = [];
  for (const t of unique) {
    if (!nativeTerms.has(t.term)) continue;
    if (t.kind === 'cjk-2') matchedBigrams.push(t.term);
    else if (t.kind === 'cjk-1') matchedUnigrams.push(t.term);
  }
  // idHit：与 adapter.mjs:238 完全相同的判定（term ∈ recordId 小写子串）。
  const idHit = unique.some((t) => recordId.toLowerCase().includes(t.term));
  // phraseHit：规范化权威 content 连续包含规范化查询（影子侧重算，非索引输出）。
  const collapsedText = normalizeText(content ?? '').replace(/\s+/g, '');
  const phraseHit = collapsedQuery.length >= 2 && collapsedText.includes(collapsedQuery);

  const bigramChars = new Set(matchedBigrams.flatMap((b) => [...b]));
  const residual = matchedUnigrams.filter((u) => !bigramChars.has(u));
  const discriminative = residual.filter((u) => {
    const df = scopeDf?.get(u) ?? 0;
    return scopeDocCount > 0 && df <= scopeDocCount / 2;
  });

  let tier;
  let label;
  if (idHit) { tier = 0; label = '查询词元命中 recordId'; }
  else if (phraseHit) { tier = 1; label = '完整短语连续命中（权威 content 影子重算）'; }
  else if (matchedBigrams.length >= 2) { tier = 2; label = `≥2 个二元词元命中（原生 matchReason）：${matchedBigrams.join('+')}`; }
  else if (matchedBigrams.length === 1 && discriminative.length >= 1) {
    tier = 3; label = `单二元 ${matchedBigrams[0]} + 残差有区分度一元 ${discriminative.join('/')}`;
  } else { tier = 4; label = '弱匹配'; }

  const evidenceSource = idHit || matchedBigrams.length > 0 || matchedUnigrams.length > 0
    ? 'native-matchReason(+authoritative idHit/phrase 重算)'
    : 'native-matchReason';
  return {
    tier, tierName: TIER_NAMES[tier], label,
    matchedBigrams, matchedUnigrams, residualUnigrams: residual, discriminativeResidual: discriminative,
    idHit, phraseHit, evidenceClass, evidenceSource
  };
}

// scope 文档频率表：从权威投影的 content 词元化（与 activation-01 tokenizer 一致，
// 供「残差一元是否有区分度」的多数规则）。真实路径上 reranker 可通过 inspect
// 获得同一范围的信息，不越权。
export async function buildScopeTermTable({ records, tokenize }) {
  const df = new Map();
  let count = 0;
  for (const rec of records) {
    count += 1;
    const terms = new Set(tokenize(rec.content ?? ''));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, scopeDocCount: count };
}
