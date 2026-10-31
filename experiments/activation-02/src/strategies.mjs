// G 路线统一实现（activation-02 任务书 §三）。
//
//   G2-H7  取消普遍年龄惩罚：未强化记录激活恒为 1.0（A0 的 recencyFactor 原样
//          保留在基础分中）；强化信号只来自真实 user_revisited，形式沿用 A2
//          （强度 × 距最近重提的半衰期衰减，clamp [0.4, 2.25]），以保留 D15 式
//          「回忆分布判别」能力。
//   G3     仅保留最近投递抑制：A0 召回排序原样，只加 RecentDelivery 的 ambient
//          抑制；explicit 追问恒不抑制。不消费 user_revisited。
//   G1     A2-H7 + 词元质量闸门（tiers.mjs）：激活只允许在同质量候选间重排，
//          boosted 候选不得越过更高 tier 的候选；抑制不受闸门约束。
//   G1G2   G2-H7 + 词元质量闸门。
//
// 边界：
//   - 候选集成员资格完全由投影决定，与 activation-01 完全一致。
//   - A0/A1/A2/A3 不经本模块（直接用 activation-01 的 rankCandidates，逐字基线）。
//   - gate 是有序类别约束，不含可调数值阈值；无区分度判定用多数规则（df>50%）。
//   - 全部确定性：同输入同输出，无随机源。

import { recencyFactor } from '../../activation-01/src/candidates.mjs';
import { deliveryMultiplier, DEFAULT_PARAMS, getActivation } from '../../activation-01/src/activation.mjs';
import { termsForQuery } from '../../activation-01/src/tokenizer.mjs';
import { computeTier, prepareTierContext, TIER_NAMES } from './tiers.mjs';

const DAY_MS = 86_400_000;
const BOOST_EPSILON = 1e-9;

export const V2_STRATEGIES = Object.freeze(['G2-H7', 'G3', 'G1', 'G1G2']);

export const DEFAULT_V2_PARAMS = Object.freeze({
  ...DEFAULT_PARAMS,            // 复用 activation-01 参数（floor/ceil/suppression/recencyWindow）
  halfLifeDays: 7               // G2-H7 / G1 / G1G2 的半衰期（与 A2-H7 对齐，最小差异）
});

function clampTo(mult, params) {
  if (mult < params.floor) return { value: params.floor, clamped: 'floor' };
  if (mult > params.ceil) return { value: params.ceil, clamped: 'ceil' };
  return { value: mult, clamped: null };
}

// G2 激活乘数：只从 user_revisited 生成有界信号；未强化 → 恰为 1.0。
export function g2Multiplier({ reinforceTimesMs, now, params }) {
  if (!reinforceTimesMs || reinforceTimesMs.length === 0) {
    return {
      multiplier: 1, clamped: null, strength: 1, elapsedDays: 0,
      reasons: ['零重提事件：中性 1.0（G2 不对未强化记忆施加年龄惩罚）']
    };
  }
  const strength = 1 + params.wStrength * Math.log1p(reinforceTimesMs.length);
  const anchorMs = Math.max(...reinforceTimesMs);
  const elapsedDays = Math.max(0, (now - anchorMs) / DAY_MS);
  const raw = strength * Math.pow(2, -elapsedDays / params.halfLifeDays);
  const c = clampTo(raw, params);
  return {
    multiplier: c.value, clamped: c.clamped, strength, elapsedDays,
    reasons: [
      `G2：S=${strength.toFixed(4)}（count=${reinforceTimesMs.length}）× 2^(-${elapsedDays.toFixed(2)}d / ${params.halfLifeDays}d) = ${raw.toFixed(4)}`
        + (c.clamped ? ` → clamp ${c.clamped}` : ''),
      '未强化记录不衰减（与 A2 的差异点）'
    ]
  };
}

function eligibilityOf(record) {
  if (record.status !== 'active') {
    return { eligible: false, reason: `status=${record.status}：非 active 投影不可达` };
  }
  return { eligible: true, reason: 'active' };
}

// 单候选评分（结构对齐 activation-01 scoreCandidate，另加 tier/gate 字段）。
function scoreV2({ entry, act, strategyId, now, mode, params, tier }) {
  const record = entry.record;
  const recordIso = record.occurredAt ?? record.acceptedAt;
  const recency = recencyFactor(recordIso, { now, windowDays: params.recencyWindowDays });
  const deliveryMult = deliveryMultiplier({ lastDeliveryMs: act.lastDeliveryMs, now, mode, params });
  let activationMultiplier = 1;
  let activationReasons = [];
  let activationClamped = null;
  if (strategyId === 'G2-H7' || strategyId === 'G1G2') {
    const g2 = g2Multiplier({ reinforceTimesMs: act.reinforceTimesMs, now, params });
    activationMultiplier = g2.multiplier;
    activationReasons = g2.reasons;
    activationClamped = g2.clamped;
  } else if (strategyId === 'G1') {
    // G1 = A2-H7 + gate：激活形式与 A2-H7 完全一致（含对未强化记录的年龄衰减）。
    const strength = 1 + params.wStrength * Math.log1p(act.reinforceTimesMs.length);
    const anchorMs = act.reinforceTimesMs.length
      ? Math.max(...act.reinforceTimesMs)
      : (recordIso !== null ? Date.parse(recordIso) : null);
    let raw = 1;
    if (anchorMs !== null && Number.isFinite(anchorMs)) {
      const elapsedDays = Math.max(0, (now - anchorMs) / DAY_MS);
      raw = strength * Math.pow(2, -elapsedDays / params.halfLifeDays);
    }
    const c = clampTo(raw, params);
    activationMultiplier = c.value;
    activationClamped = c.clamped;
    activationReasons = [
      `G1（激活=A2-H7）：S=${strength.toFixed(4)}（count=${act.reinforceTimesMs.length}）× 2^(-elapsed/${params.halfLifeDays}d) = ${raw.toFixed(4)}`
        + (c.clamped ? ` → clamp ${c.clamped}` : '')
    ];
  } else if (strategyId === 'G3') {
    activationReasons = ['G3：不消费 user_revisited，激活恒为 1.0'];
  }
  const baseScore = (1 + entry.coverage) * recency;
  const finalScore = baseScore * activationMultiplier * deliveryMult;
  const boosted = activationMultiplier > 1 + BOOST_EPSILON;
  return {
    finalScore,
    boosted,
    tier: { level: tier.tier, name: tier.tierName },
    breakdown: {
      recordId: record.recordId,
      spaceId: record.spaceId,
      strategy: strategyId,
      mode,
      validity: { status: record.status, eligibility: eligibilityOf(record).reason, eligible: eligibilityOf(record).eligible },
      evidence: {
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        confirmationsAuthorized: act.confirmations.authorized,
        confirmationsUnauthorized: act.confirmations.unauthorized,
        note: '证据只来自来源与正式授权路径；激活事件永不增长它'
      },
      importance: { level: record.importance, note: '静态属性；激活引擎只读' },
      relevance: {
        mode,
        coverage: Number(entry.coverage.toFixed(4)),
        matchedTerms: entry.matchedTerms.map((t) => `${t.term}(${t.kind})`),
        note: '当前查询/情境词元覆盖，当前问题优先'
      },
      tier: { level: tier.tier, name: tier.tierName, label: tier.label, boosted, note: 'G1 词元质量等级；gate 只约束激活上移' },
      activation: {
        raw: Number(activationMultiplier.toFixed(6)),
        multiplier: Number(activationMultiplier.toFixed(6)),
        clamped: activationClamped,
        reinforcementCount: act.reinforceTimesMs.length,
        hasEvents: act.hasEvents
      },
      recentDelivery: {
        lastDeliveryMs: act.lastDeliveryMs,
        multiplier: Number(deliveryMult.toFixed(6)),
        note: '仅 ambient 模式抑制；explicit 追问恒为 1；抑制不受 tier 闸门约束'
      },
      recency: { factor: Number(recency.toFixed(6)), windowDays: params.recencyWindowDays, recordTime: recordIso },
      components: {
        relevanceTerm: Number(baseScore.toFixed(6)),
        activationTerm: Number(activationMultiplier.toFixed(6)),
        deliveryTerm: Number(deliveryMult.toFixed(6))
      },
      finalScore: Number(finalScore.toFixed(6)),
      reasons: [...activationReasons],
      eligibility: eligibilityOf(record)
    }
  };
}

function compareScored(a, b) {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (a.breakdown.recordId < b.breakdown.recordId) return -1;
  if (a.breakdown.recordId > b.breakdown.recordId) return 1;
  return a.breakdown.spaceId < b.breakdown.spaceId ? -1 : a.breakdown.spaceId > b.breakdown.spaceId ? 1 : 0;
}

// 词元质量闸门：boosted 候选不得排在 tier 严格更优（数值更小）的候选之前。
// 抑制（乘数<1）不 boosted，不受约束。确定性 fixup：每次把违规者移到最后一个
// 更优 tier 候选之后并重新扫描；每次移动严格后移，必然终止。
export function applyTierGate(scoredSorted) {
  const order = scoredSorted.slice();
  const moves = [];
  let guard = order.length + 1;
  while (guard-- > 0) {
    let fixed = false;
    for (let i = 0; i < order.length; i += 1) {
      const c = order[i];
      if (!c.boosted) continue;
      let lastBetter = -1;
      for (let j = i + 1; j < order.length; j += 1) {
        if (order[j].tier.level < c.tier.level) lastBetter = j;
      }
      if (lastBetter !== -1) {
        order.splice(i, 1);
        order.splice(lastBetter, 0, c);
        // 删除 i（< lastBetter）后，被越过的更优 tier 候选位于 lastBetter-1。
        const blocker = order[lastBetter - 1];
        moves.push({
          recordId: c.breakdown.recordId, fromRank: i + 1, toRank: lastBetter + 1,
          reason: `tier 闸门：${c.tier.name}(${c.breakdown.recordId}) 不得越过 ${blocker.tier.name}(${blocker.breakdown.recordId})`
        });
        fixed = true;
        break;
      }
    }
    if (!fixed) break;
  }
  return { order, moves };
}

// v2 主入口：G 系策略的统一排序。
export function rankStrategyV2({
  pool, state = new Map(), mode, query, situation, spaceIds,
  strategyId, now, params = DEFAULT_V2_PARAMS, limit = 50
}) {
  if (!V2_STRATEGIES.includes(strategyId)) {
    throw Object.assign(new Error(`未知 v2 策略 ${strategyId}`), { code: 'ACT_V2_STRATEGY_UNKNOWN' });
  }
  if (!Number.isFinite(now)) {
    throw Object.assign(new Error('now 必须是有限毫秒时间戳'), { code: 'ACT_NOW_REQUIRED' });
  }
  const useGate = strategyId === 'G1' || strategyId === 'G1G2';
  let entries;
  let effectiveQuery;
  if (mode === 'explicit') {
    effectiveQuery = query;
    entries = pool.explicitCandidates({ q: query, spaceIds });
  } else if (mode === 'ambient') {
    effectiveQuery = situation;
    entries = pool.ambientCandidates({ situation, spaceIds });
  } else {
    throw Object.assign(new Error(`mode 必须是 explicit / ambient，收到 ${mode}`), { code: 'ACT_MODE_INVALID' });
  }
  const t0 = process.hrtime.bigint();
  const ctx = prepareTierContext(pool, { spaceIds, queryOrSituation: effectiveQuery });
  const scored = entries.map((entry) => {
    const act = getActivation(state, entry.record.spaceId, entry.record.recordId);
    const tier = computeTier({
      record: entry.record,
      queryTerms: ctx.queryTerms,
      docTerms: pool.docTerms(entry.record.spaceId, entry.record.recordId),
      scopeDocCount: ctx.scopeDocCount,
      docFreq: ctx.docFreq,
      collapsedQuery: ctx.collapsedQuery
    });
    return scoreV2({ entry, act, strategyId, now, mode, params, tier });
  });
  scored.sort(compareScored);
  let ordered = scored;
  let gateMoves = [];
  if (useGate) {
    const gated = applyTierGate(scored);
    ordered = gated.order;
    gateMoves = gated.moves;
  }
  const top = ordered.slice(0, limit);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    strategy: strategyId, mode, query: effectiveQuery, now,
    candidates: top.map((s) => ({ ...s.breakdown, gateMoved: gateMoves.some((m) => m.recordId === s.breakdown.recordId) })),
    timingMs: elapsedMs,
    totalCount: entries.length,
    gateMoves
  };
}
