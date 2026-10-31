// 归因策略（activation-04）—— A0 / L / R / LR / D 在同一真实候选集上的重排序。
//
// 目的：把 activation-03 的 G1G2 增益分解为
//   L  —— 词面质量判断（exact id / phrase / 连续二元词 → tier），不消费任何事件；
//   R  —— 动态激活（activation-02 的 G2 乘数，只来自真实 user_revisited），无闸门；
//   LR —— G1G2（activation-03 原样：base × G2 乘数 + tier 闸门）；
//   D  —— 原始排序 + RecentDelivery 抑制（= activation-03 的 G3 语义，逐字复用）。
//
// 复用纪律：
//   A0 / LR / D 分别 = activation-03 的 rankA0 / rankG1G2 / rankG3，import 复用，
//   不复制粘贴、不改动参数。新增只有 rankL 与 rankR 两个「单因子」策略：
//   rankL 用 activation-03 evidence.mjs 的 computeTierFromReal（同一 tier 判定，
//   不另造公式）；rankR 用 activation-02 的 g2Multiplier（同一乘数，不另造公式）。
//
// L 的精确定义：tier 升序为主键（T0 id-hit < T1 phrase < T2 multi-bigram <
// T3 bigram+residual < T4 weak），同 tier 内保持 A0 到达顺序（稳定排序）。
// L 不重算分数、不伪造数值 —— 同 tier 无差异时恒等于 A0 顺序。
//
// R 的精确定义：score = 原生 a0Score × g2Multiplier，降序 + recordId 字典序
// （与 rankG1G2 同一比较器，保证 LR 与 R 只差闸门）。路径 C（无原生分数）
// 拒用：没有 base 分数就无法诚实表达乘数 —— 显式 fallbackReason，不盲改。
//
// 不变量：所有策略只重排同一组 recordId（成员资格断言）；正式返回 = A0。

import { rankA0, rankG3, rankG1G2 } from '../../activation-03/src/shadow-strategies.mjs';
import { computeTierFromReal } from '../../activation-03/src/evidence.mjs';
import { g2Multiplier, DEFAULT_V2_PARAMS } from '../../activation-02/src/strategies.mjs';

export const STRATEGIES_V4 = Object.freeze(['A0', 'L', 'R', 'LR', 'D']);

export const FALLBACK_REASONS_V4 = Object.freeze({
  R_NO_BASE_SCORE: 'R_DISABLED: 路径 C（scan 回退）无原生分数，激活乘数没有可乘的 base —— 拒用，回退 A0 顺序'
});

function assertSameMembership({ input, ranked, strategy }) {
  const a = input.map((c) => c.recordId).sort();
  const b = ranked.map((c) => c.recordId).sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw Object.assign(new Error(`策略 ${strategy} 改变了候选集成员资格`), { code: 'ACT_V4_MEMBERSHIP_CHANGED' });
  }
}

function recordIdCompare(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

// —— L：仅词面质量。tier 升序稳定排序；不消费事件、不消费激活。 ——
export function rankL({ candidates, queryTerms, collapsedQuery, scopeDf, scopeDocCount }) {
  const t0 = performance.now();
  const tiers = new Map();
  for (const c of candidates) {
    tiers.set(c.recordId, computeTierFromReal({
      recordId: c.recordId, content: c.content, matchReason: c.matchReason, coverage: c.coverage,
      queryTerms, collapsedQuery, scopeDf, scopeDocCount
    }));
  }
  // 稳定排序（ES2019 Array.sort 稳定）：同 tier 内保持 A0 到达顺序。
  const ranked = candidates
    .map((c) => ({
      recordId: c.recordId,
      position: c.position,
      finalScore: null,
      tier: tiers.get(c.recordId).tier,
      tierName: tiers.get(c.recordId).tierName,
      tierLabel: tiers.get(c.recordId).label,
      idHit: tiers.get(c.recordId).idHit,
      phraseHit: tiers.get(c.recordId).phraseHit,
      matchedBigrams: tiers.get(c.recordId).matchedBigrams,
      order: 'tier-asc-stable'
    }))
    .sort((a, b) => a.tier - b.tier);
  assertSameMembership({ input: candidates, ranked, strategy: 'L' });
  const changed = ranked.some((r, i) => r.recordId !== candidates[i].recordId);
  const tierValues = [...tiers.values()].map((t) => t.tier);
  const notes = [
    `tier 分布：${ranked.map((r) => r.tierName).join(',')}`,
    tierValues.length > 0 && Math.min(...tierValues) !== Math.max(...tierValues)
      ? '候选间 tier 有差异：L 具有判别力'
      : '候选间 tier 同质：L 恒等于 A0 顺序'
  ];
  return { strategy: 'L', refused: false, ranked, changed, timingMs: performance.now() - t0, notes };
}

// —— R：仅动态激活。base × G2 乘数；无闸门；路径 C 拒用。 ——
export function rankR({ candidates, mode, state, now, params = DEFAULT_V2_PARAMS }) {
  const t0 = performance.now();
  const missingScore = candidates.filter((c) => typeof c.a0Score !== 'number');
  if (candidates.length > 0 && missingScore.length > 0) {
    return {
      strategy: 'R', refused: true,
      fallbackReason: FALLBACK_REASONS_V4.R_NO_BASE_SCORE,
      ranked: candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' })),
      changed: false, timingMs: performance.now() - t0,
      notes: ['R 拒用：无 base 分数（scan 回退）；激活乘数不能凭空排序']
    };
  }
  const scored = candidates.map((c) => {
    const act = state.get(`${c.spaceId}::${c.recordId}`);
    const reinforceTimesMs = act?.reinforceTimesMs ?? [];
    const g2 = g2Multiplier({ reinforceTimesMs, now, params });
    return {
      recordId: c.recordId, position: c.position,
      finalScore: Number((c.a0Score * g2.multiplier).toFixed(6)),
      boosted: g2.multiplier > 1 + 1e-9,
      g2: { multiplier: Number(g2.multiplier.toFixed(6)), clamped: g2.clamped, count: reinforceTimesMs.length },
      order: 'score-desc'
    };
  });
  scored.sort((x, y) => y.finalScore - x.finalScore || recordIdCompare(x.recordId, y.recordId));
  assertSameMembership({ input: candidates, ranked: scored, strategy: 'R' });
  const changed = scored.some((r, i) => r.recordId !== candidates[i].recordId);
  return {
    strategy: 'R', refused: false, ranked: scored, changed,
    timingMs: performance.now() - t0,
    notes: [
      `boosted：${scored.filter((s) => s.boosted).length}/${scored.length}`,
      'R = 原生 a0Score × g2Multiplier（activation-02 数学，无 tier 闸门）'
    ]
  };
}

// —— A0 / LR / D：activation-03 原样（语义与标签映射）——
// D = rankG3（RecentDelivery 抑制：ambient 生效、explicit 恒绕过、路径 C 稳定后移）。
export {
  rankA0 as rankA0V4,
  rankG1G2 as rankLR,
  rankG3 as rankD
};

export function tierFor(c, { queryTerms, collapsedQuery, scopeDf, scopeDocCount }) {
  return computeTierFromReal({
    recordId: c.recordId, content: c.content, matchReason: c.matchReason, coverage: c.coverage,
    queryTerms, collapsedQuery, scopeDf, scopeDocCount
  });
}
