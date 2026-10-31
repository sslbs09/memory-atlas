// 排名解释输出：机器可读 JSON + 人类可读摘要，供后续 Memory Universe 消费。
// 本阶段不修改任何视觉产品代码；只产出数据。

import { rankCandidates, explainRanking } from './ranking.mjs';

export { rankCandidates, explainRanking };

// 把一次 ranking 的候选分解压成紧凑 JSON（评分分解逐字段输出）。
export function explainResultJson(result) {
  return {
    strategy: result.strategy,
    mode: result.mode,
    query: result.query,
    now: new Date(result.now).toISOString(),
    totalCount: result.totalCount,
    timingMs: Number(result.timingMs.toFixed(4)),
    candidates: result.candidates.map((c, i) => ({
      rank: i + 1,
      recordId: c.recordId,
      spaceId: c.spaceId,
      finalScore: c.finalScore,
      eligibility: c.eligibility.reason,
      coverage: c.relevance.coverage,
      matchedTerms: c.relevance.matchedTerms,
      recency: c.recency.factor,
      activationMultiplier: c.activation.multiplier,
      activationClamped: c.activation.clamped,
      reinforcementCount: c.activation.reinforcementCount,
      recentDeliveryMultiplier: c.recentDelivery.multiplier,
      importance: c.importance.level,
      components: c.components,
      reasons: c.reasons
    }))
  };
}

// "为什么 A 排在 B 前面"的一句话解释（含分量差）。
export function explainPairMarkdown(result, recordIdA, recordIdB, opts = {}) {
  const x = explainRanking({ result, recordIdA, recordIdB, ...opts });
  const a = x.a.breakdown;
  const b = x.b.breakdown;
  const lines = [
    `- ${x.verdict}`,
    `  - relevance 项：A=${a.components.relevanceTerm}，B=${b.components.relevanceTerm}（差 ${x.componentDiff.relevanceTerm}）`,
    `  - activation 项：A=${a.components.activationTerm}，B=${b.components.activationTerm}（差 ${x.componentDiff.activationTerm}）`,
    `  - delivery 项：A=${a.components.deliveryTerm}，B=${b.components.deliveryTerm}（差 ${x.componentDiff.deliveryTerm}）`,
    `  - A 原因：${a.reasons.join('；') || '无'}`,
    `  - B 原因：${b.reasons.join('；') || '无'}`
  ];
  return lines.join('\n');
}
