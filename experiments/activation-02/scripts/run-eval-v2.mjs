// activation-02 统一评估（任务书 §四/§五/§七）。
//
// 协议：
//   - 9 个策略（A0/A1/A2-H7/A2-H30/A3 + G2-H7/G3/G1/G1G2）对同一候选集、
//     同一查询、同一固定时钟、同一冻结期望运行。禁止跨数据集对比。
//   - holdout-v2（23 场景）是唯一保留集：期望在 fixtures 中先于本脚本冻结。
//     activation-01 的 16 个动态场景在此仅作开发诊断集（观测性记录，不判 GO）。
//   - 输出：Recall@5 / MRR / nDCG@5 / Top1 准确率 / Top3 无关入侵数 /
//     旧约定可达性 / 撤回错误召回 / 跨空间泄漏 / 近投递重复 / 耗时 / 事件开销，
//     按 explicit / ambient / suppression / structural 分组，逐案例列出。

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidatePool } from '../../activation-01/src/candidates.mjs';
import { rankCandidates, explainRanking } from '../../activation-01/src/ranking.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { getActivation, DEFAULT_PARAMS } from '../../activation-01/src/activation.mjs';
import { replayShuffled, saveEventLog, loadEventLog } from '../../activation-01/src/replay.mjs';
import { corpus, baseScenarios, holdoutScenarios, EVAL_NOW } from '../../activation-01/fixtures/scenarios.mjs';
import { rankStrategyV2, DEFAULT_V2_PARAMS } from '../src/strategies.mjs';
import { holdoutV2Scenarios, RELEVANCE_V2, EXCLUDE_FROM_RANKING } from '../fixtures/holdout-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'results-v2');
mkdirSync(OUT, { recursive: true });

const NOW = EVAL_NOW;
const pool = new CandidatePool(corpus());
const DAY = 86_400_000;

const STRATEGIES = [
  { id: 'A0', family: 'A', params: DEFAULT_PARAMS },
  { id: 'A1', family: 'A', params: DEFAULT_PARAMS },
  { id: 'A2-H7', family: 'A', strategy: 'A2', params: { ...DEFAULT_PARAMS, halfLifeDays: 7 } },
  { id: 'A2-H30', family: 'A', strategy: 'A2', params: { ...DEFAULT_PARAMS, halfLifeDays: 30 } },
  { id: 'A3', family: 'A', params: DEFAULT_PARAMS },
  { id: 'G2-H7', family: 'G', params: DEFAULT_V2_PARAMS },
  { id: 'G3', family: 'G', params: DEFAULT_V2_PARAMS },
  { id: 'G1', family: 'G', params: DEFAULT_V2_PARAMS },
  { id: 'G1G2', family: 'G', params: DEFAULT_V2_PARAMS }
];

function runRank({ s, strat, state }) {
  const args = { pool, state, spaceIds: s.spaceIds, now: NOW, params: strat.params, limit: 50 };
  if (s.mode === 'explicit') {
    if (strat.family === 'A') return rankCandidates({ ...args, mode: 'explicit', query: s.query, strategy: strat.strategy ?? strat.id });
    return rankStrategyV2({ ...args, mode: 'explicit', query: s.query, strategyId: strat.id });
  }
  if (strat.family === 'A') return rankCandidates({ ...args, mode: 'ambient', situation: s.situation, strategy: strat.strategy ?? strat.id });
  return rankStrategyV2({ ...args, mode: 'ambient', situation: s.situation, strategyId: strat.id });
}

// ---------- 冻结期望检查 ----------
function checkExpect(expect, ctx) {
  const { result, order, state, events, s, strategyId } = ctx;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, ok, detail });
  if (expect.top1 !== undefined) add('top1', order[0] === expect.top1, `got=${order[0] ?? '∅'}`);
  if (expect.inTop) {
    const topK = order.slice(0, expect.inTop.k);
    for (const rid of expect.inTop.recordIds) add('inTop', topK.includes(rid), `${rid} rank=${order.indexOf(rid) + 1 || '∅'}`);
  }
  if (expect.inCandidates) {
    for (const rid of expect.inCandidates) {
      add('inCandidates', order.includes(rid), `${rid} rank=${order.indexOf(rid) + 1 || '∅'}`);
    }
  }
  if (expect.absent) for (const rid of expect.absent) add('absent', !order.includes(rid), rid);
  if (expect.noMatch !== undefined) add('noMatch', result.totalCount === 0, `totalCount=${result.totalCount}`);
  if (expect.candidateCount !== undefined) add('candidateCount', result.totalCount === expect.candidateCount, `got=${result.totalCount}`);
  if (expect.orderAfter) {
    const { recordId, after } = expect.orderAfter;
    const i = order.indexOf(recordId);
    const j = order.indexOf(after);
    add('orderAfter', i !== -1 && j !== -1 && i > j, `${recordId}(${i + 1}) after ${after}(${j + 1})`);
  }
  if (expect.finiteScores) add('finiteScores', result.candidates.every((c) => Number.isFinite(c.finalScore)), '');
  if (expect.replayOrderInsensitive) {
    const st2 = replayShuffled(events);
    const r2 = runRank({ s, strat: STRATEGIES.find((x) => x.id === strategyId), state: st2 });
    add('replayOrderInsensitive', JSON.stringify(r2.candidates.map((c) => c.recordId)) === JSON.stringify(order), '');
  }
  if (expect.identityToZeroEvents) {
    const zero = runRank({ s, strat: STRATEGIES.find((x) => x.id === strategyId), state: new Map() });
    add('identityToZeroEvents', JSON.stringify(zero.candidates.map((c) => c.recordId)) === JSON.stringify(order), '与零事件排名逐位一致');
  }
  if (expect.reinforceCount !== undefined) {
    const act = getActivation(state, s.spaceIds[0], ctx.targetRecord);
    add('reinforceCount', act.reinforceCount === expect.reinforceCount, `got=${act.reinforceCount}`);
  }
  if (expect.sameAsSingleRevisit) {
    const single = replayEvents(events.slice(0, 1).map((e) => ({ ...e, eventId: `${e.eventId}-single` })));
    const a = getActivation(state, s.spaceIds[0], ctx.targetRecord).reinforceTimesMs;
    const b = getActivation(single, s.spaceIds[0], ctx.targetRecord).reinforceTimesMs;
    add('sameAsSingleRevisit', JSON.stringify(a) === JSON.stringify(b), '');
  }
  if (expect.workActivationZero) {
    const act = getActivation(state, 'work', expect.workActivationZero);
    add('workActivationZero', act.reinforceCount === 0 && act.lastDeliveryMs === null, '');
  }
  if (expect.replayRoundTrip) {
    const tmp = join(OUT, `_rt-${strategyId}.jsonl`);
    saveEventLog(tmp, events);
    const st3 = replayEvents(loadEventLog(tmp));
    const r3 = runRank({ s, strat: STRATEGIES.find((x) => x.id === strategyId), state: st3 });
    add('replayRoundTrip', JSON.stringify(r3.candidates.map((c) => c.recordId)) === JSON.stringify(order), '落盘→重载→重放→排名逐位一致');
  }
  return checks;
}

// ---------- 排名指标 ----------
function rankingMetrics(order, relevant) {
  if (!relevant || relevant.length === 0) return null;
  const rel = new Set(relevant);
  const top5 = order.slice(0, 5);
  const recall5 = relevant.filter((r) => top5.includes(r)).length / relevant.length;
  let mrr = 0;
  for (const r of relevant) {
    const rank = order.indexOf(r) + 1;
    if (rank > 0) mrr = Math.max(mrr, 1 / rank);
  }
  const dcg = top5.reduce((acc, id, i) => acc + (rel.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const idcg = Array.from({ length: Math.min(relevant.length, 5) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return {
    recall5: Number(recall5.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    ndcg5: Number((idcg === 0 ? 1 : dcg / idcg).toFixed(4)),
    top1Correct: rel.has(order[0]),
    top3Intrusion: order.slice(0, 3).filter((id) => !rel.has(id)).length
  };
}

// ---------- holdout-v2 ----------
console.log('== holdout-v2 (23 场景 × 9 策略) ==');
const V2_RESULTS = [];
let replayTimeTotalMs = 0;
let replayCalls = 0;
for (const s of holdoutV2Scenarios()) {
  const perStrategy = {};
  for (const strat of STRATEGIES) {
    const t0 = process.hrtime.bigint();
    const state = replayEvents(s.events);
    replayTimeTotalMs += Number(process.hrtime.bigint() - t0) / 1e6;
    replayCalls += 1;
    const result = runRank({ s, strat, state });
    const order = result.candidates.map((c) => c.recordId);
    const frozen = s.expect.strategyExpect?.[strat.id] ?? (strat.id !== 'A0' ? s.expect : null);
    const targetRecord = s.events[0]?.recordId ?? null;
    const checks = frozen ? checkExpect(frozen, { result, order, state, events: s.events, s, strategyId: strat.id, targetRecord }) : [];
    const metrics = rankingMetrics(order, RELEVANCE_V2[s.id]);
    perStrategy[strat.id] = {
      checked: !!frozen,
      pass: checks.length > 0 ? checks.every((c) => c.ok) : null,
      checks: checks.filter((c) => !c.ok),
      order,
      candidateCount: result.totalCount,
      timingMs: result.timingMs,
      metrics,
      gateMoves: result.gateMoves ?? []
    };
  }
  V2_RESULTS.push({ id: s.id, family: s.family, mode: s.mode, expect: s.expect, perStrategy });
}

// ---------- activation-01 的 16 个动态场景（开发诊断集，观测性记录） ----------
console.log('== activation-01 dev set (16 场景，观测性) ==');
const DEV_RESULTS = [];
for (const s of holdoutScenarios()) {
  const perStrategy = {};
  for (const strat of STRATEGIES) {
    const state = replayEvents(s.events);
    const result = runRank({ s, strat, state });
    const order = result.candidates.map((c) => c.recordId);
    let frozen = null;
    if (s.expect?.strategyExpect?.[strat.id]) frozen = s.expect.strategyExpect[strat.id];
    else if (strat.family === 'A' && strat.id !== 'A0') frozen = s.expect;
    const targetRecord = s.events[0]?.recordId ?? null;
    const checks = frozen ? checkExpect(frozen, { result, order, state, events: s.events, s, strategyId: strat.id, targetRecord }) : [];
    perStrategy[strat.id] = {
      checked: !!frozen,
      pass: checks.length > 0 ? checks.every((c) => c.ok) : null,
      checks: checks.filter((c) => !c.ok),
      order,
      top1: order[0] ?? null
    };
  }
  DEV_RESULTS.push({ id: s.id, mode: s.mode, perStrategy });
}

// ---------- 基础 36 用例（explicit 正确性回归） ----------
console.log('== base 36 (explicit 回归) ==');
const BASE_RESULTS = {};
for (const strat of STRATEGIES) {
  const cases = [];
  for (const scenario of baseScenarios()) {
    const specs = scenario.querySpecs ?? scenario.queries.map((q) => ({
      q, spaceIds: scenario.spaceIds, expectedRelevant: scenario.expectedRelevant,
      forbidden: scenario.forbidden, expectNoMatch: scenario.expectNoMatch
    }));
    for (const spec of specs) {
      const state = new Map();
      const result = runRank({ s: { mode: 'explicit', query: spec.q, spaceIds: spec.spaceIds }, strat, state });
      const ids = result.candidates.map((c) => c.recordId);
      const expected = spec.expectedRelevant ?? [];
      let mrr = 0;
      for (const e of expected) {
        const r = ids.indexOf(e) + 1;
        if (r > 0) mrr = Math.max(mrr, 1 / r);
      }
      const recall5 = expected.length === 0
        ? (spec.expectNoMatch ? (ids.length === 0 ? 1 : 0) : 1)
        : expected.filter((e) => ids.slice(0, 5).includes(e)).length / expected.length;
      const dcg = ids.slice(0, 5).reduce((acc, id, i) => acc + (expected.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
      const idcg = Array.from({ length: Math.min(expected.length, 5) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
      const forbiddenHits = ids.slice(0, 5).filter((id) => (spec.forbidden ?? []).includes(id));
      cases.push({
        scenarioId: scenario.id, query: spec.q, ranked: ids,
        recall5, mrr: Number(mrr.toFixed(4)), ndcg5: Number((idcg === 0 ? 1 : dcg / idcg).toFixed(4)),
        forbiddenHits,
        pass: recall5 === 1 && forbiddenHits.length === 0 && (!spec.expectNoMatch || ids.length === 0)
      });
    }
  }
  BASE_RESULTS[strat.id] = cases;
}

// ---------- 聚合 ----------
function aggV2(familyFilter) {
  const rows = V2_RESULTS.filter((r) => (familyFilter ? r.family === familyFilter : true));
  const out = {};
  for (const strat of STRATEGIES) {
    const cells = rows.map((r) => r.perStrategy[strat.id]);
    const checked = cells.filter((c) => c.checked);
    const rankCells = rows.filter((r) => RELEVANCE_V2[r.id]?.length > 0 && !EXCLUDE_FROM_RANKING.includes(r.id)).map((r) => r.perStrategy[strat.id]);
    const n = rankCells.length || 1;
    out[strat.id] = {
      frozenPass: checked.length ? `${checked.filter((c) => c.pass).length}/${checked.length}` : 'n/a',
      failedScenarios: checked.filter((c) => !c.pass).map((c) => rows.find((r) => r.perStrategy[strat.id] === c).id),
      recall5: Number((rankCells.reduce((a, c) => a + c.metrics.recall5, 0) / n).toFixed(4)),
      mrr: Number((rankCells.reduce((a, c) => a + c.metrics.mrr, 0) / n).toFixed(4)),
      ndcg5: Number((rankCells.reduce((a, c) => a + c.metrics.ndcg5, 0) / n).toFixed(4)),
      top1Accuracy: Number((rankCells.filter((c) => c.metrics.top1Correct).length / n).toFixed(4)),
      top3IntrusionTotal: rankCells.reduce((a, c) => a + c.metrics.top3Intrusion, 0),
      medianTimingMs: Number(median(cells.map((c) => c.timingMs)).toFixed(4))
    };
  }
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const v2ByFamily = {
  explicit: aggV2('explicit'),
  ambient: aggV2('ambient'),
  suppression: aggV2('suppression'),
  structural: aggV2('structural'),
  all: aggV2(null)
};

// 近投递重复（S 组）：刚投递的记录（del 在 24h 内）是否仍占据 top1
const recentDeliveryRepeat = {};
for (const strat of STRATEGIES) {
  recentDeliveryRepeat[strat.id] = V2_RESULTS
    .filter((r) => r.family === 'suppression')
    .filter((r) => {
      const delivered = r.perStrategy[strat.id].order[0];
      const delEvents = (holdoutV2Scenarios().find((s) => s.id === r.id).events ?? []).filter((e) => e.eventType === 'delivered_reference' && (NOW - Date.parse(e.occurredAt)) < DAY);
      return delEvents.some((e) => e.recordId === delivered);
    }).length;
}

// 单候选 vs 多候选
const candidateCountTable = V2_RESULTS.map((r) => ({
  id: r.id,
  candidateCount: r.perStrategy.A0.candidateCount,
  kind: r.perStrategy.A0.candidateCount <= 1 ? 'single' : 'multi'
}));

// 与 A0 的逐案例差异（holdout-v2 排名序不同处）
const deltaVsA0 = {};
for (const strat of STRATEGIES.slice(1)) {
  deltaVsA0[strat.id] = [];
  for (const r of V2_RESULTS) {
    const a0 = r.perStrategy.A0.order.join(',');
    const mine = r.perStrategy[strat.id].order.join(',');
    if (a0 !== mine) {
      deltaVsA0[strat.id].push({
        scenario: r.id,
        a0Top1: r.perStrategy.A0.order[0] ?? null,
        mineTop1: r.perStrategy[strat.id].order[0] ?? null,
        a0FrozenPass: r.perStrategy.A0.pass,
        mineFrozenPass: r.perStrategy[strat.id].pass
      });
    }
  }
}

// 撤回错误召回 / 跨空间泄漏（全语料断言，所有场景）。
// 泄漏判定：recordId 在任何被查询空间内都找不到对应 active 投影才算泄漏
// （同 recordId 双空间时，查询空间内的副本是合法候选）。
const RETRACTED = ['rec-fishing-retracted'];
const leakage = {};
for (const strat of STRATEGIES) {
  let retractedHits = 0;
  let crossSpaceLeaks = 0;
  for (const s of holdoutV2Scenarios()) {
    const order = V2_RESULTS.find((r) => r.id === s.id).perStrategy[strat.id].order;
    retractedHits += order.filter((id) => RETRACTED.includes(id)).length;
    for (const rid of order) {
      const inQueriedSpace = s.spaceIds.some((sp) => pool.getRecord(sp, rid));
      if (!inQueriedSpace) crossSpaceLeaks += 1;
    }
  }
  leakage[strat.id] = { retractedHits, crossSpaceLeaks };
}

// 基础 36 汇总
function aggBase(cases) {
  const n = cases.length;
  return {
    pass: `${cases.filter((c) => c.pass).length}/${n}`,
    recall5: Number((cases.reduce((a, c) => a + c.recall5, 0) / n).toFixed(4)),
    mrr: Number((cases.reduce((a, c) => a + c.mrr, 0) / n).toFixed(4)),
    ndcg5: Number((cases.reduce((a, c) => a + c.ndcg5, 0) / n).toFixed(4)),
    forbiddenHits: cases.reduce((a, c) => a + c.forbiddenHits.length, 0)
  };
}
const baseSummary = Object.fromEntries(STRATEGIES.map((s) => [s.id, aggBase(BASE_RESULTS[s.id])]));

// 事件开销
const allEvents = holdoutV2Scenarios().flatMap((s) => s.events);
const tmpLog = join(OUT, 'events-holdout-v2.jsonl');
const saved = saveEventLog(tmpLog, allEvents);
const overhead = {
  scenarioEventCounts: Object.fromEntries(holdoutV2Scenarios().map((s) => [s.id, s.events.length])),
  totalEvents: allEvents.length,
  eventLogBytes: saved.bytes,
  bytesPerEvent: Number((saved.bytes / allEvents.length).toFixed(1)),
  avgReplayMsPerStateBuild: Number((replayTimeTotalMs / replayCalls).toFixed(4))
};

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    evalClock: new Date(NOW).toISOString(),
    atlasHead: '4f112f2',
    branch: 'experiment/activation-02',
    strategyMatrix: STRATEGIES.map((s) => s.id),
    holdoutV2FrozenAt: 'commit 2d0bfba（期望先于本脚本运行）'
  },
  base36Summary: baseSummary,
  holdoutV2: {
    byFamily: v2ByFamily,
    recentDeliveryRepeatTop1: recentDeliveryRepeat,
    candidateCounts: candidateCountTable,
    deltaVsA0,
    leakage,
    perCase: V2_RESULTS
  },
  devSetActivation01: DEV_RESULTS,
  overhead
};

writeFileSync(join(OUT, 'eval-v2.json'), JSON.stringify(report, null, 2), 'utf8');

// ---------- stdout 摘要 ----------
console.log('\n== base 36（explicit 正确性） ==');
for (const s of STRATEGIES) console.log(s.id.padEnd(6), JSON.stringify(baseSummary[s.id]));
for (const fam of ['explicit', 'ambient', 'suppression', 'structural']) {
  console.log(`\n== holdout-v2 · ${fam} ==`);
  for (const s of STRATEGIES) {
    const a = v2ByFamily[fam][s.id];
    console.log(s.id.padEnd(6), `frozen=${a.frozenPass}`, `top1=${a.top1Accuracy}`, `R@5=${a.recall5}`, `MRR=${a.mrr}`, `nDCG=${a.ndcg5}`, `intr=${a.top3IntrusionTotal}`, `fail=[${a.failedScenarios.join(',')}]`);
  }
}
console.log('\n== S 组近投递占 top1 次数（越少越好） ==');
for (const s of STRATEGIES) console.log(s.id.padEnd(6), recentDeliveryRepeat[s.id]);
console.log('\n== 撤回/泄漏（全 23 场景累计） ==');
for (const s of STRATEGIES) console.log(s.id.padEnd(6), JSON.stringify(leakage[s.id]));
console.log('\nwritten:', join(OUT, 'eval-v2.json'));
