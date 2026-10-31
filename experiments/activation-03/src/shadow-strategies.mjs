// 影子策略 —— A0 / G3 / G1G2 在真实候选集上的重排序（activation-03）。
//
// 与 activation-02 strategies.mjs 的关系：
//   - G2 乘数、G3 抑制、tier 闸门 fixup 的数学形式逐字继承（import 复用，
//     不复制粘贴、不改动参数）；
//   - 差异只在输入：候选来自真实 coordinator / 真 SearchAdapter（一次取齐），
//     证据来自 evidence.mjs 的原生 matchReason 解析 + 权威 content 合法重算；
//   - 新增**诚实降级**：路径 B（结构共现）与路径 C（scan 回退）没有词元证据
//     → G1 不得启用 → G1G2 整体拒用（G2 单独已被 activation-02 否决，
//     「G1G2 减去 G1」不是合法的降级产物），fallbackReason 显式记录。
//
// 不变量：
//   - 候选成员资格零改动：三条策略都只能重排 shadow 输入里的同一组 recordId；
//   - 正式返回 = A0 顺序（coordinator 原样），影子结果只进影子记录；
//   - A0 在路径 A/B 上 = 候选到达顺序（生产排序原样），在路径 C 上 = sequence
//     降序（querySpace 原样）—— 本模块对 A0 恒为恒等映射，绝不重新打分。

import { recencyFactor } from '../../activation-01/src/candidates.mjs';
import { deliveryMultiplier, DEFAULT_PARAMS } from '../../activation-01/src/activation.mjs';
// G2 乘数 / tier 闸门 fixup / 参数：activation-02 实现逐字复用（不复制、不改动）。
import { g2Multiplier, applyTierGate, DEFAULT_V2_PARAMS } from '../../activation-02/src/strategies.mjs';
import { computeTierFromReal } from './evidence.mjs';

const DAY_MS = 86_400_000;

export const STRATEGIES_V3 = Object.freeze(['A0', 'G3', 'G1G2']);

export const FALLBACK_REASONS = Object.freeze({
  NO_LEXICAL_EVIDENCE_ASSOCIATION: 'G1_DISABLED: 结构共现候选（association）无词元证据，G1 不适用；G2 单独已被 activation-02 否决 → G1G2 整体拒用，回退 A0 顺序',
  NO_LEXICAL_EVIDENCE_SCAN: 'G1_DISABLED: 权威扫描回退不产生 matchReason/coverage，G1 不适用；G2 单独已被 activation-02 否决 → G1G2 整体拒用，回退 A0 顺序',
  SINGLE_CANDIDATE: '单候选集：无重排空间，三策略必然同序'
});

function assertSameMembership({ input, ranked, strategy }) {
  const a = input.map((c) => c.recordId).sort();
  const b = ranked.map((c) => c.recordId).sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw Object.assign(new Error(`策略 ${strategy} 改变了候选集成员资格`), { code: 'ACT_V3_MEMBERSHIP_CHANGED' });
  }
}

// A0：恒等。返回顺序 = shadow 输入顺序（即 coordinator / engine 的原生顺序）。
export function rankA0({ candidates }) {
  const t0 = performance.now();
  const ranked = candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' }));
  return { strategy: 'A0', ranked, changed: false, timingMs: performance.now() - t0, notes: ['A0 = 候选到达顺序（生产排序原样，恒等映射）'] };
}

// G3：A0 + 最近投递抑制。ambient 模式才有抑制；explicit 恒不抑制。
// 路径 A/B：final = 原生 a0Score × deliveryMultiplier（重排可能）。
// 路径 C：无分数 → 抑制表达为「被抑制者稳定后移到首个未抑制者之后」。
export function rankG3({ candidates, mode, state, now, params = DEFAULT_V2_PARAMS }) {
  const t0 = performance.now();
  const notes = [];
  if (mode === 'explicit') {
    const ranked = candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' }));
    notes.push('explicit 追问恒不抑制（与 activation-01/02 语义一致）');
    return { strategy: 'G3', ranked, changed: false, timingMs: performance.now() - t0, notes };
  }
  const suppressed = new Map();
  for (const c of candidates) {
    const act = state.get(`${c.spaceId}::${c.recordId}`);
    const lastDeliveryMs = act?.lastDeliveryMs ?? null;
    const mult = deliveryMultiplier({ lastDeliveryMs, now, mode, params });
    if (mult !== 1) suppressed.set(c.recordId, { mult, lastDeliveryMs });
  }
  let ranked;
  if (suppressed.size === 0) {
    ranked = candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' }));
  } else if (candidates.every((c) => typeof c.a0Score === 'number')) {
    const scored = candidates.map((c) => {
      const s = suppressed.get(c.recordId);
      return {
        recordId: c.recordId, position: c.position,
        finalScore: s ? Number((c.a0Score * s.mult).toFixed(6)) : c.a0Score,
        suppressed: Boolean(s)
      };
    });
    scored.sort((x, y) => y.finalScore - x.finalScore || (x.recordId < y.recordId ? -1 : x.recordId > y.recordId ? 1 : 0));
    ranked = scored;
    notes.push('路径 A/B：final = 原生 a0Score × deliveryMultiplier');
  } else {
    const head = [];
    const tail = [];
    for (const c of candidates) (suppressed.has(c.recordId) ? tail : head).push(c);
    ranked = [...head, ...tail].map((c) => ({
      recordId: c.recordId, position: c.position, finalScore: null,
      suppressed: suppressed.has(c.recordId), order: 'a0-demotion'
    }));
    notes.push('路径 C：无原生分数，抑制 = 稳定后移（不伪造分数）');
  }
  assertSameMembership({ input: candidates, ranked, strategy: 'G3' });
  return { strategy: 'G3', ranked, changed: suppressed.size > 0, timingMs: performance.now() - t0, notes };
}

// G1G2：G2 激活乘数 + tier 闸门。仅词元证据路径（A）可用；B/C 诚实拒用。
export function rankG1G2({
  candidates, mode, state, now, queryTerms, collapsedQuery,
  scopeDf, scopeDocCount, params = DEFAULT_V2_PARAMS
}) {
  const t0 = performance.now();
  const evidenceClasses = new Set(candidates.map((c) => c.evidenceClass));
  if (evidenceClasses.has('structural-association')) {
    return {
      strategy: 'G1G2', refused: true,
      fallbackReason: FALLBACK_REASONS.NO_LEXICAL_EVIDENCE_ASSOCIATION,
      ranked: candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' })),
      changed: false, timingMs: performance.now() - t0,
      notes: ['G1 拒用：结构共现无词元证据；G2 单独=已否决路线；整体回退 A0']
    };
  }
  if (evidenceClasses.has('none') && candidates.length > 0) {
    return {
      strategy: 'G1G2', refused: true,
      fallbackReason: FALLBACK_REASONS.NO_LEXICAL_EVIDENCE_SCAN,
      ranked: candidates.map((c) => ({ recordId: c.recordId, position: c.position, finalScore: c.a0Score, order: 'a0-native' })),
      changed: false, timingMs: performance.now() - t0,
      notes: ['G1 拒用：scan 回退无 matchReason；G2 单独=已否决路线；整体回退 A0']
    };
  }

  const tiers = new Map();
  for (const c of candidates) {
    tiers.set(c.recordId, computeTierFromReal({
      recordId: c.recordId, content: c.content, matchReason: c.matchReason, coverage: c.coverage,
      queryTerms, collapsedQuery, scopeDf, scopeDocCount
    }));
  }

  const scored = candidates.map((c) => {
    const recordIso = c.occurredAt ?? null;
    const recency = recencyFactor(recordIso, { now, windowDays: params.recencyWindowDays });
    const act = state.get(`${c.spaceId}::${c.recordId}`);
    const reinforceTimesMs = act?.reinforceTimesMs ?? [];
    const g2 = g2Multiplier({ reinforceTimesMs, now, params });
    const deliveryMult = mode === 'ambient'
      ? deliveryMultiplier({ lastDeliveryMs: act?.lastDeliveryMs ?? null, now, mode, params })
      : 1;
    // 基础分：真实路径的 A0 分（score = (1+cov)*recency，cov 在 AND 下恒 1）。
    // scan 回退候选无分数 → 已在上面拒用；这里 candidates 都有原生分或
    // 可重算的 (1+cov)*recency。优先原生分，缺失时按 adapter 公式重算。
    const base = typeof c.a0Score === 'number' ? c.a0Score : (1 + (c.coverage ?? 0)) * recency;
    const finalScore = base * g2.multiplier * deliveryMult;
    const tier = tiers.get(c.recordId);
    return {
      recordId: c.recordId, position: c.position, finalScore,
      boosted: g2.multiplier > 1 + 1e-9,
      // applyTierGate（activation-02）的输入形状：tier.level / tier.name / breakdown.recordId。
      tier: { level: tier.tier, name: tier.tierName, ...tier },
      breakdown: { recordId: c.recordId },
      g2: { multiplier: Number(g2.multiplier.toFixed(6)), clamped: g2.clamped, count: reinforceTimesMs.length }
    };
  });
  scored.sort((x, y) => y.finalScore - x.finalScore || (x.recordId < y.recordId ? -1 : x.recordId > y.recordId ? 1 : 0));
  const gated = applyTierGate(scored);
  const ranked = gated.order.map((s) => ({ recordId: s.recordId, position: s.position, finalScore: s.finalScore, tier: s.tier.tier, tierName: s.tier.tierName, boosted: s.boosted, g2: s.g2 }));
  assertSameMembership({ input: candidates, ranked, strategy: 'G1G2' });
  return {
    strategy: 'G1G2', refused: false,
    ranked, changed: gated.moves.length > 0 || ranked.some((r, i) => r.recordId !== candidates[i].recordId),
    gateMoves: gated.moves,
    timingMs: performance.now() - t0,
    notes: [
      `tier 分布：${[...tiers.values()].map((t) => t.tierName).join(',')}`,
      'G2 乘数只来自 user_revisited（replayEvents 派生态）；gate 只约束 boosted 上移'
    ]
  };
}

export { DEFAULT_PARAMS };
