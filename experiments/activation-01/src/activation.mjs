// 激活计算：从重放后的派生状态计算单条记录的当前激活。
//
// 六种信号在这里的分离方式：
//   Validity      —— 不在这里：效力是硬过滤，属于候选投影（candidates.mjs）。
//                    激活值再高也无法让 retracted/superseded 记录复活。
//   Evidence      —— 只读 report（provenance + 已授权确认数），激活事件永不增长它。
//   Importance    —— 只读 report（语料静态属性），任何事件不得修改。
//   Activation    —— 本模块唯一可变信号，仅由 user_revisited 事件驱动。
//   Relevance     —— 不在这里：来自当前查询/情境的词元覆盖（ranking.mjs），当前问题优先。
//   RecentDelivery —— 只读 report + ambient 抑制输入；不阻止 explicit 追问。
//
// 三种激活候选（A1/A2/A3），全部满足：
//   - 零事件 → 中性乘数 1.0（无事件时退回基线 A0）。
//   - 增益有界、边际递减（clamp + 对数/幂律形式）。
//   - 时间下限 clamp > 0（旧记忆不会被打到零，保底可达性）。
//   - 只用事件时间戳，不用任何"回忆刷新回忆"的自反输入。

import { recencyFactor } from './candidates.mjs';

export const DEFAULT_PARAMS = Object.freeze({
  // A1：有界次数强化。mult = 1 + wCount * log1p(count)
  wCount: 0.5,
  // A2：时间衰减 + 强化。mult = clamp((1 + wStrength*log1p(count)) * 2^(-elapsed/halfLifeDays), floor, ceil)
  wStrength: 0.75,
  halfLifeDays: 30,          // 实验候选值，非人脑验证参数；对照 H=7
  // A3：ACT-R 风格。B = ln(Σ t_j^-d)；mult = clamp(1 + wActr * B, floor, ceil)
  actrDecay: 0.5,            // ACT-R 经典默认 d=0.5
  wActr: 0.35,
  minIntervalDays: 1 / 24,   // 数值稳定：事件年龄下限 1 小时（含未来时间戳钳制）
  bEpsilon: 1e-12,
  // 共同边界
  floor: 0.4,                // 激活乘数下限：旧记录保底可达性
  ceil: 2.25,                // 激活乘数上限：即使 100 次回忆也 ≤ 2.25 倍
  // RecentDelivery 抑制（仅 ambient）：刚提及过的话题不再主动浮现
  suppressionWindowHours: 6,
  suppressionStrength: 0.5,  // 窗口内乘 0.5
  suppressionDecayHours: 24, // 6~24h 内线性回到 1.0
  recencyWindowDays: 120     // 与 A0 真实 HEAD 相同
});

export const STRATEGIES = Object.freeze(['A0', 'A1', 'A2', 'A3']);

function getEntry(state, spaceId, recordId) {
  return state?.get?.(`${spaceId}::${recordId}`) ?? null;
}

// 单条记录的派生状态视图（只读）。
export function getActivation(state, spaceId, recordId) {
  const entry = getEntry(state, spaceId, recordId);
  if (!entry) {
    return {
      reinforceCount: 0, reinforceTimesMs: [], lastRevisitMs: null,
      lastDeliveryMs: null, counts: {}, corrections: 0,
      confirmations: { authorized: 0, unauthorized: 0 }, hasEvents: false
    };
  }
  return {
    reinforceCount: entry.reinforceTimesMs.length,
    reinforceTimesMs: entry.reinforceTimesMs.slice(),
    lastRevisitMs: entry.reinforceTimesMs.length ? entry.reinforceTimesMs[entry.reinforceTimesMs.length - 1] : null,
    lastDeliveryMs: entry.lastDeliveryMs,
    counts: { ...entry.counts },
    corrections: entry.corrections,
    confirmations: { ...entry.confirmations },
    hasEvents: true
  };
}

const DAY_MS = 86_400_000;

// A1：有界次数强化。零事件 → 1.0。
export function multiplierA1(reinforceCount, params = DEFAULT_PARAMS) {
  if (!reinforceCount) return 1;
  return 1 + params.wCount * Math.log1p(reinforceCount);
}

// A2：强度 × 半衰期衰减。elapsed 自最近一次强化起算；从未强化则自记录时间起算。
export function multiplierA2({ reinforceTimesMs, lastRevisitMs, recordTimeMs, now, halfLifeDays, params = DEFAULT_PARAMS }) {
  const H = halfLifeDays ?? params.halfLifeDays;
  const strength = 1 + params.wStrength * Math.log1p(reinforceTimesMs.length);
  const anchorMs = lastRevisitMs ?? recordTimeMs;
  if (anchorMs === null || anchorMs === undefined || !Number.isFinite(anchorMs)) {
    return { multiplier: 1, strength, elapsedDays: 0, clamped: false }; // 无任何时间信息：中性
  }
  // 未来时间戳（时钟异常）：年龄钳到 0，可解释为"视作刚刚"，绝不取负。
  const elapsedDays = Math.max(0, (now - anchorMs) / DAY_MS);
  const multiplier = strength * Math.pow(2, -elapsedDays / H);
  return { multiplier, strength, elapsedDays, clamped: false };
}

// A3：ACT-R Base-Level Activation。B = ln(Σ t_j^-d)，t 为各次强化事件年龄（天）。
// 未来时间戳年龄钳到 minIntervalDays；零事件 B=0 → 乘数恰为 1（退回基线）。
export function activationB({ reinforceTimesMs, now, params = DEFAULT_PARAMS }) {
  const minInterval = params.minIntervalDays;
  let sum = 0;
  for (const tMs of reinforceTimesMs) {
    const ageDays = Math.max(minInterval, (now - tMs) / DAY_MS);
    sum += Math.pow(ageDays, -params.actrDecay);
  }
  const b = sum > 0 ? Math.log(sum + params.bEpsilon) : 0;
  return { b, sum };
}

export function multiplierA3({ reinforceTimesMs, now, params = DEFAULT_PARAMS }) {
  const { b } = activationB({ reinforceTimesMs, now, params });
  return 1 + params.wActr * b;
}

// RecentDelivery 抑制乘数：仅 ambient 模式调用。explicit/followup 恒为 1
// ——用户明确追问永远允许正常召回。
export function deliveryMultiplier({ lastDeliveryMs, now, mode, params = DEFAULT_PARAMS }) {
  if (mode === 'explicit' || lastDeliveryMs === null || lastDeliveryMs === undefined) return 1;
  const hours = Math.max(0, (now - lastDeliveryMs) / 3_600_000);
  if (hours < params.suppressionWindowHours) {
    return 1 - params.suppressionStrength;
  }
  if (hours < params.suppressionDecayHours) {
    const t = (hours - params.suppressionWindowHours)
      / (params.suppressionDecayHours - params.suppressionWindowHours);
    return (1 - params.suppressionStrength) + t * params.suppressionStrength;
  }
  return 1;
}

function clamp(mult, params) {
  if (mult < params.floor) return { value: params.floor, clamped: 'floor' };
  if (mult > params.ceil) return { value: params.ceil, clamped: 'ceil' };
  return { value: mult, clamped: null };
}

// 统一入口：按策略计算激活乘数（含 clamp），并返回完整分解供 explain 使用。
export function buildActivation({ state, spaceId, recordId, record, now, strategy, params = DEFAULT_PARAMS, mode }) {
  const act = getActivation(state, spaceId, recordId);
  const recordIso = record?.occurredAt ?? record?.acceptedAt ?? null;
  const recordTimeMs = recordIso !== null ? Date.parse(recordIso) : null;
  const base = {
    reinforcementCount: act.reinforceCount,
    reinforceTimesMs: act.reinforceTimesMs,
    lastRevisitMs: act.lastRevisitMs,
    lastDeliveryMs: act.lastDeliveryMs,
    counts: act.counts,
    hasEvents: act.hasEvents
  };
  if (strategy === 'A0') {
    return {
      ...base, strategy, activationRaw: 0, activationMultiplier: 1, clamped: null,
      deliveryMultiplierValue: 1, reasons: act.hasEvents
        ? ['A0 基线：不消费派生事件，激活恒为中性 1.0']
        : ['零事件：中性激活']
    };
  }
  let raw;
  let reasons = [];
  let clamped = null;
  if (strategy === 'A1') {
    const m = multiplierA1(act.reinforceCount, params);
    const c = clamp(m, params);
    raw = c.value;
    clamped = c.clamped;
    if (act.reinforceCount > 0) {
      reasons.push(`user_revisited×${act.reinforceCount}：1 + ${params.wCount}·log1p(${act.reinforceCount}) = ${m.toFixed(4)}`
        + (clamped ? ` → clamp ${clamped}` : ''));
    } else {
      reasons.push('零事件：中性激活 1.0');
    }
  } else if (strategy === 'A2') {
    const m = multiplierA2({ reinforceTimesMs: act.reinforceTimesMs, lastRevisitMs: act.lastRevisitMs, recordTimeMs, now, params });
    const c = clamp(m.multiplier, params);
    raw = c.value;
    clamped = c.clamped;
    reasons.push(`A2：S=${m.strength.toFixed(4)}（count=${act.reinforceCount}）× 2^(-${m.elapsedDays.toFixed(2)}d / ${params.halfLifeDays}d) = ${m.multiplier.toFixed(4)}`
      + (clamped ? ` → clamp ${clamped}` : ''));
  } else if (strategy === 'A3') {
    const { b, sum } = activationB({ reinforceTimesMs: act.reinforceTimesMs, now, params });
    const m = multiplierA3({ reinforceTimesMs: act.reinforceTimesMs, now, params });
    const c = clamp(m, params);
    raw = c.value;
    clamped = c.clamped;
    reasons.push(`A3 ACT-R：B=ln(Σ t^-${params.actrDecay})=ln(${sum.toFixed(4)})=${b.toFixed(4)} → 1 + ${params.wActr}·B = ${m.toFixed(4)}`
      + (clamped ? ` → clamp ${clamped}` : ''));
  } else {
    throw Object.assign(new Error(`未知策略 ${strategy}`), { code: 'ACT_STRATEGY_UNKNOWN' });
  }
  const dm = deliveryMultiplier({ lastDeliveryMs: act.lastDeliveryMs, now, mode, params });
  if (dm !== 1) {
    reasons.push(`recentDelivery 抑制（ambient，最近投递 ${((now - act.lastDeliveryMs) / 3_600_000).toFixed(1)}h 前）×${dm.toFixed(2)}`);
  }
  return {
    ...base, strategy, activationRaw: raw, activationMultiplier: raw, clamped,
    deliveryMultiplierValue: dm, reasons
  };
}

// 便捷：与 A0 相同口径的 recency（供 ranking 使用）。
export { recencyFactor };
