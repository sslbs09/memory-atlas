// G1 · Lexical Evidence Tier —— 词元匹配质量等级（可解释、无数值阈值拟合）。
//
// 背景（diagnose-D03 结论）：真实 GLM AND 检索下 coverage 结构性恒为 1
// （adapter.mjs:233-239 + store.mjs collectCandidates 词元求交），
// 「coverage 相差 2:1 禁止反转」的 Coverage Gate 在正式路径上恒不触发，
// 已按任务书废弃。本模块用**有序类别**替代数值阈值：
//
//   T0 id-hit        查询词元命中 recordId —— 正式 adapter 对 record-id 精确查找
//                    走独立路径（adapter.mjs:205-215，score=1000），是最强证据。
//   T1 phrase        规范化查询（去空格）整体连续出现在规范化文本中。
//   T2 multi-bigram  ≥2 个不同的中文二元词元命中（跨语段证据，如 周末+在家）。
//   T3 bigram-plus   恰 1 个二元命中，且至少 1 个「残差有区分度一元」
//                    （残差 = 不属于任何命中二元组成字的一元；
//                     有区分度 = 该一元在查询 scope 内的文档频率 ≤ 50%）。
//   T4 weak          其余：仅散落一元，或单二元且无残差（如 gym 只有「周末」，
//                    其一元命中 周/末 全部是「周末」的组成字）。
//
// 设计边界：
//   - 全部证据来自已有文本与查询词元，无 NLP、无 LLM、无向量。
//   - 「无区分度」的判定用多数规则（df > 50% 的 scope 文档含该一元），
//     是定义而非拟合阈值；「≥2 个二元」是有序类别边界，不是可调参数。
//   - explicit AND 模式下所有候选命中同一词元集 → 天然同 tier：
//     闸门在正式 explicit 路径上结构性不介入（与 coverage gate 的「空洞」
//     不同——tier 的角色只在 ambient/重叠路径上区分候选质量）。
//   - gate 只约束**激活上移**（boosted 候选不得越过更高 tier）；
//     投递抑制（乘数 < 1）不受闸门限制 —— 「高激活不能跨越相关性等级」
//     约束的是激活，不是抑制。

import { termsForQuery, normalizeText, tokenizeForIndex } from '../../activation-01/src/tokenizer.mjs';

export const TIER_NAMES = Object.freeze({
  0: 'id-hit',
  1: 'phrase',
  2: 'multi-bigram',
  3: 'bigram-plus',
  4: 'weak'
});

// scope 内一元词元的文档频率表（active 记录），供「无区分度」判定。
export function documentFrequencies(docs) {
  const df = new Map();
  for (const terms of docs) {
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

// 单候选的词元质量等级。输入均为已算好的确定性中间量，便于测试与解释。
export function computeTier({
  record, queryTerms, docTerms, scopeDocCount, docFreq, collapsedQuery
}) {
  const unique = [...new Map(queryTerms.map((t) => [t.term, t])).values()];
  const matchedBigrams = [];
  const matchedUnigrams = [];
  for (const t of unique) {
    if (!docTerms.has(t.term)) continue;
    if (t.kind === 'cjk-2') matchedBigrams.push(t.term);
    else if (t.kind === 'cjk-1') matchedUnigrams.push(t.term);
  }
  const idHit = unique.some((t) => record.recordId.toLowerCase().includes(t.term));
  const collapsedText = normalizeText(record.text).replace(/\s+/g, '');
  const phraseHit = collapsedQuery.length >= 2 && collapsedText.includes(collapsedQuery);

  // 残差一元：未被任何命中二元「解释」的一元命中。
  const bigramChars = new Set(matchedBigrams.flatMap((b) => [...b]));
  const residual = matchedUnigrams.filter((u) => !bigramChars.has(u));
  // 有区分度：scope 内文档频率 ≤ 一半（多数文档都含的词元视为无区分度）。
  const discriminative = residual.filter((u) => {
    const df = docFreq.get(u) ?? 0;
    return scopeDocCount > 0 && df <= scopeDocCount / 2;
  });

  let tier;
  let label;
  if (idHit) { tier = 0; label = '查询词元命中 recordId（正式系统的精确 id 路径）'; }
  else if (phraseHit) { tier = 1; label = '完整短语连续命中'; }
  else if (matchedBigrams.length >= 2) { tier = 2; label = `≥2 个二元词元命中：${matchedBigrams.join('+')}`; }
  else if (matchedBigrams.length === 1 && discriminative.length >= 1) {
    tier = 3; label = `单二元 ${matchedBigrams[0]} + 残差有区分度一元 ${discriminative.join('/')}`;
  } else { tier = 4; label = '弱匹配（仅散落一元或单二元无残差）'; }

  return {
    tier,
    tierName: TIER_NAMES[tier],
    label,
    matchedBigrams,
    matchedUnigrams,
    residualUnigrams: residual,
    discriminativeResidual: discriminative,
    idHit,
    phraseHit
  };
}

// 便捷：从 pool + 查询一次性算 scope 的 df 表与 collapsed 查询。
export function prepareTierContext(pool, { spaceIds, queryOrSituation }) {
  const scope = pool.activeRecords(spaceIds);
  const docTermsById = new Map(scope.map((r) => [`${r.spaceId}::${r.recordId}`, pool.docTerms(r.spaceId, r.recordId)]));
  const docFreq = documentFrequencies([...docTermsById.values()]);
  const collapsedQuery = normalizeText(queryOrSituation).replace(/\s+/g, '');
  return { scopeDocCount: scope.length, docFreq, collapsedQuery, queryTerms: termsForQuery(queryOrSituation) };
}
