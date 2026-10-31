// 排序实验：A0/A1/A2/A3 四组策略，同一候选集、同一查询、同一时间、同一权限范围。
//
// 统一评分（重排序，不改变候选集成员资格）：
//   final = (1 + coverage) * recencyFactor(recordTime, now, 120d)   ← A0 真实 HEAD 公式
//           × activationMultiplier(strategy)                        ← A1/A2/A3 新增
//           × deliveryMultiplier(ambient only)                      ← A1/A2/A3 新增
//
// 不变量：
//   - 候选资格完全由投影决定（active + 空间范围 + 词元匹配），激活不改变成员资格。
//   - A0 不消费任何派生事件（它是"如果什么都不做"的世界）。
//   - explicit 模式不做 recentDelivery 抑制（用户明确追问必须正常召回）。
//   - tie-break 与真实 adapter.mjs:260 一致：score 降序，recordId 升序。

import { recencyFactor } from './candidates.mjs';
import { buildActivation, getActivation, DEFAULT_PARAMS, STRATEGIES } from './activation.mjs';

export { STRATEGIES };

const DAY_MS = 86_400_000;

function eligibilityOf(record) {
  if (record.status !== 'active') {
    return { eligible: false, reason: `status=${record.status}：非 active 投影不可达` };
  }
  return { eligible: true, reason: 'active' };
}

// 单条候选的完整评分分解（也供 explainRanking 直接调用）。
export function scoreCandidate({ pool, entry, state, strategy, now, mode, params = DEFAULT_PARAMS }) {
  const record = entry.record;
  const eligibility = eligibilityOf(record);
  const recordIso = record.occurredAt ?? record.acceptedAt;
  const recency = recencyFactor(recordIso, { now, windowDays: params.recencyWindowDays });
  const activation = buildActivation({
    state, spaceId: record.spaceId, recordId: record.recordId,
    record, now, strategy, params, mode
  });
  const deliveryMult = strategy === 'A0' ? 1 : activation.deliveryMultiplierValue;
  const finalScore = (1 + entry.coverage) * recency * activation.activationMultiplier * deliveryMult;
  const act = getActivation(state, record.spaceId, record.recordId);
  const breakdown = {
    recordId: record.recordId,
    spaceId: record.spaceId,
    strategy,
    mode,
    // —— 六种信号，逐一显式呈现 ——
    validity: { status: record.status, eligibility: eligibility.reason, eligible: eligibility.eligible },
    evidence: {
      sourceKind: record.sourceKind,
      sourceId: record.sourceId,
      confirmationsAuthorized: act.confirmations.authorized,
      confirmationsUnauthorized: act.confirmations.unauthorized,
      note: '证据只来自来源与正式授权路径；激活事件永不增长它'
    },
    importance: { level: record.importance, note: '静态属性；激活引擎只读，不由回忆频率增长' },
    relevance: {
      mode, coverage: Number(entry.coverage.toFixed(4)),
      matchedTerms: entry.matchedTerms.map((t) => `${t.term}(${t.kind})`),
      note: '当前查询/情境词元覆盖，当前问题优先'
    },
    activation: {
      raw: Number(activation.activationRaw.toFixed(6)),
      multiplier: Number(activation.activationMultiplier.toFixed(6)),
      clamped: activation.clamped,
      reinforcementCount: activation.reinforcementCount,
      hasEvents: activation.hasEvents
    },
    recentDelivery: {
      lastDeliveryMs: activation.lastDeliveryMs,
      multiplier: Number(deliveryMult.toFixed(6)),
      note: '仅 ambient 模式抑制；explicit 追问恒为 1'
    },
    recency: {
      factor: Number(recency.toFixed(6)),
      windowDays: params.recencyWindowDays,
      recordTime: recordIso
    },
    components: {
      relevanceTerm: Number(((1 + entry.coverage) * recency).toFixed(6)),
      activationTerm: Number(activation.activationMultiplier.toFixed(6)),
      deliveryTerm: Number(deliveryMult.toFixed(6))
    },
    finalScore: Number(finalScore.toFixed(6)),
    reasons: [...activation.reasons],
    eligibility
  };
  return { finalScore, breakdown };
}

function compareCandidates(a, b) {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (a.recordId < b.recordId) return -1;
  if (a.recordId > b.recordId) return 1;
  return a.spaceId < b.spaceId ? -1 : a.spaceId > b.spaceId ? 1 : 0;
}

// 主入口：对一次查询执行某策略的重排序。
// mode: 'explicit'（AND 词元匹配，正确性路径）| 'ambient'（情境重叠，自然联想路径）
export function rankCandidates({
  pool, state = new Map(), mode, query, situation, spaceIds,
  strategy = 'A0', now, params = DEFAULT_PARAMS, limit = 50
}) {
  if (!STRATEGIES.includes(strategy)) {
    throw Object.assign(new Error(`未知策略 ${strategy}`), { code: 'ACT_STRATEGY_UNKNOWN' });
  }
  if (!Number.isFinite(now)) {
    throw Object.assign(new Error('now 必须是有限毫秒时间戳（可注入时钟）'), { code: 'ACT_NOW_REQUIRED' });
  }
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
  const ranked = entries
    .map((entry) => scoreCandidate({ pool, entry, state, strategy, now, mode, params }))
    .sort(compareCandidates)
    .slice(0, limit);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    strategy, mode, query: effectiveQuery, now,
    candidates: ranked.map((r) => r.breakdown),
    timingMs: elapsedMs,
    totalCount: entries.length
  };
}

// explainRanking：回答"为什么 A 排在 B 前面"。返回可机器读的对比结构。
export function explainRanking({ result, recordIdA, spaceIdA, recordIdB, spaceIdB }) {
  const find = (rid, sid) => result.candidates.find(
    (c) => c.recordId === rid && (sid === undefined || c.spaceId === sid)
  );
  const a = find(recordIdA, spaceIdA);
  const b = find(recordIdB, spaceIdB);
  if (!a || !b) {
    throw Object.assign(new Error('explainRanking：候选不在结果中'), { code: 'ACT_EXPLAIN_MISSING' });
  }
  const rankOf = (c) => result.candidates.indexOf(c) + 1;
  return {
    query: result.query, strategy: result.strategy, mode: result.mode,
    a: { recordId: a.recordId, spaceId: a.spaceId, rank: rankOf(a), breakdown: a },
    b: { recordId: b.recordId, spaceId: b.spaceId, rank: rankOf(b), breakdown: b },
    aBeforeB: rankOf(a) < rankOf(b),
    verdict: rankOf(a) < rankOf(b)
      ? `${a.recordId}(#${rankOf(a)}) 排在 ${b.recordId}(#${rankOf(b)}) 之前：finalScore ${a.finalScore} > ${b.finalScore}`
      : `${b.recordId}(#${rankOf(b)}) 排在 ${a.recordId}(#${rankOf(a)}) 之前：finalScore ${b.finalScore} > ${a.finalScore}`,
    componentDiff: {
      relevanceTerm: Number((a.components.relevanceTerm - b.components.relevanceTerm).toFixed(6)),
      activationTerm: Number((a.components.activationTerm - b.components.activationTerm).toFixed(6)),
      deliveryTerm: Number((a.components.deliveryTerm - b.components.deliveryTerm).toFixed(6))
    }
  };
}
