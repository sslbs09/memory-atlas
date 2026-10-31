// activation-01 正式评估：A0/A1/A2-H7/A2-H30/A3 对照。
//
// 协议：
//   - 固定评估时钟 EVAL_NOW（fixtures 内），无随机性，全部确定性。
//   - base 36 个 explicit 用例：Recall@5 / MRR / nDCG@5 / forbidden@5。
//   - holdout 16 个动态场景（15 动态 + D05b 显式追问）：逐场景逐策略判定 + 不变量。
//   - 权重敏感性扫描单独输出，不参与 GO 判定（权重为先验值，未做拟合）。
//   - 结果写入 results/*.json 与 results/REPORT.md。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidatePool } from '../src/candidates.mjs';
import { rankCandidates, explainRanking } from '../src/ranking.mjs';
import { replayEvents } from '../src/events.mjs';
import { getActivation, DEFAULT_PARAMS } from '../src/activation.mjs';
import { replayShuffled, saveEventLog, loadEventLog } from '../src/replay.mjs';
import { corpus, baseScenarios, holdoutScenarios, tuningScenarios, EVAL_NOW, eventHistory } from '../fixtures/scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RESULTS = join(ROOT, 'results');
mkdirSync(RESULTS, { recursive: true });

const NOW = EVAL_NOW;
const DAY = 86_400_000;
const pool = new CandidatePool(corpus());

const STRATEGIES = [
  { id: 'A0', strategy: 'A0', params: DEFAULT_PARAMS },
  { id: 'A1', strategy: 'A1', params: DEFAULT_PARAMS },
  { id: 'A2-H7', strategy: 'A2', params: { ...DEFAULT_PARAMS, halfLifeDays: 7 } },
  { id: 'A2-H30', strategy: 'A2', params: { ...DEFAULT_PARAMS, halfLifeDays: 30 } },
  { id: 'A3', strategy: 'A3', params: DEFAULT_PARAMS }
];

// ---------- base 36 用例 ----------
function evalBaseCase(spec, strat, scenarioId) {
  const result = rankCandidates({
    pool, mode: 'explicit', query: spec.q, spaceIds: spec.spaceIds,
    strategy: strat.strategy, now: NOW, params: strat.params, limit: 50
  });
  const ids = result.candidates.map((c) => c.recordId);
  const expected = spec.expectedRelevant ?? [];
  const forbidden = spec.forbidden ?? [];
  let mrr = 0;
  for (const e of expected) {
    const r = ids.indexOf(e) + 1;
    if (r > 0) mrr = Math.max(mrr, 1 / r); // MRR：任一相关候选的最高排名倒数
  }
  const recall5 = expected.length === 0
    ? (spec.expectNoMatch ? (ids.length === 0 ? 1 : 0) : 1)
    : expected.filter((e) => ids.slice(0, 5).includes(e)).length / expected.length;
  const dcg = ids.slice(0, 5).reduce((acc, id, i) => acc + (expected.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const idcg = Array.from({ length: Math.min(expected.length, 5) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  const ndcg5 = idcg === 0 ? 1 : dcg / idcg;
  const forbiddenHits = ids.slice(0, 5).filter((id) => forbidden.includes(id));
  return {
    scenarioId, query: spec.q, spaceIds: spec.spaceIds,
    outcome: ids.length === 0 ? 'NO_MATCH' : 'MATCHED',
    expected, forbidden,
    ranked: ids,
    matchable: expected.length > 0,
    recall5, mrr: Number(mrr.toFixed(4)), ndcg5: Number(ndcg5.toFixed(4)),
    forbiddenHits,
    pass: recall5 === 1 && forbiddenHits.length === 0 && (!spec.expectNoMatch || ids.length === 0),
    timingMs: result.timingMs
  };
}

// ---------- holdout 动态场景 ----------
function checkExpect(expect, ctx) {
  const { result, order, state, events, s, strategyId } = ctx;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, ok, detail });
  if (expect.top1 !== undefined) {
    add('top1', order[0] === expect.top1, `got=${order[0] ?? '∅'}`);
  }
  if (expect.inCandidates) {
    for (const rid of expect.inCandidates) {
      add('inCandidates', order.includes(rid), `${rid} rank=${order.indexOf(rid) + 1 || '∅'}`);
    }
  }
  if (expect.absent) {
    for (const rid of expect.absent) {
      add('absent', !order.includes(rid), rid);
    }
  }
  if (expect.noMatch !== undefined) add('noMatch', result.totalCount === 0, `totalCount=${result.totalCount}`);
  if (expect.orderAfter) {
    const { recordId, after } = expect.orderAfter;
    const i = order.indexOf(recordId);
    const j = order.indexOf(after);
    add('orderAfter', i !== -1 && j !== -1 && i > j, `${recordId}(${i + 1}) after ${after}(${j + 1})`);
  }
  if (expect.finiteScores) {
    add('finiteScores', result.candidates.every((c) => Number.isFinite(c.finalScore)), '');
  }
  if (expect.replayOrderInsensitive) {
    const st2 = replayShuffled(events);
    const same = [...state.values()].map((e) => e.reinforceTimesMs.join(',')).join('|')
      === [...st2.values()].map((e) => e.reinforceTimesMs.join(',')).join('|');
    add('replayOrderInsensitive', same, '');
  }
  if (expect.identityToZeroEvents) {
    let same = true;
    for (const cand of ['A1', 'A2-H30', 'A3']) {
      const withE = rankCandidates(modeArgs(s, cand, ctx.state));
      const zeroE = rankCandidates(modeArgs(s, cand, new Map()));
      if (JSON.stringify(withE.candidates.map((c) => c.recordId)) !== JSON.stringify(zeroE.candidates.map((c) => c.recordId))) same = false;
    }
    add('identityToZeroEvents', same, '与零事件排名逐位一致');
  }
  if (expect.reinforceCount !== undefined) {
    const act = getActivation(ctx.state, s.spaceIds[0], ctx.targetRecord);
    add('reinforceCount', act.reinforceCount === expect.reinforceCount, `got=${act.reinforceCount}`);
  }
  if (expect.sameAsSingleRevisit) {
    const single = replayEvents(eventHistory({ spaceId: s.spaceIds[0], recordId: ctx.targetRecord, rev: [5], tools: 1, sourceEventId: 'src-evt-shared' }));
    const a = getActivation(ctx.state, s.spaceIds[0], ctx.targetRecord).reinforceTimesMs;
    const b = getActivation(single, s.spaceIds[0], ctx.targetRecord).reinforceTimesMs;
    add('sameAsSingleRevisit', JSON.stringify(a) === JSON.stringify(b), '');
  }
  if (expect.workActivationZero) {
    const act = getActivation(ctx.state, 'work', expect.workActivationZero);
    add('workActivationZero', act.reinforceCount === 0 && act.lastDeliveryMs === null, '');
  }
  if (expect.monotonic) {
    // 与参照场景相比，更多重提 → 乘数不降
    const refId = expect.monotonic;
    const ref = HOLDOUT_RESULTS.find((x) => x.id === refId);
    if (ref) {
      const mine = result.candidates.find((c) => c.recordId === ctx.targetRecord)?.activation.multiplier ?? 0;
      const theirs = ref.perStrategy[strategyId]?.result?.candidates.find((c) => c.recordId === ctx.targetRecord)?.activation.multiplier ?? 0;
      add('monotonic', mine >= theirs, `D02=${mine} vs D01=${theirs}`);
    }
  }
  return checks;
}

function modeArgs(s, strategyId, state) {
  const strat = STRATEGIES.find((x) => x.id === strategyId);
  return {
    pool, state, spaceIds: s.spaceIds, strategy: strat.strategy, now: NOW, params: strat.params, limit: 50,
    ...(s.mode === 'explicit' ? { mode: 'explicit', query: s.query } : { mode: 'ambient', situation: s.situation })
  };
}

function evalHoldoutScenario(s, strat) {
  const state = replayEvents(s.events);
  const result = rankCandidates(modeArgs(s, strat.id, state));
  const order = result.candidates.map((c) => c.recordId);
  const ctx = {
    result, order, state, events: s.events, s, strategyId: strat.id,
    targetRecord: s.events[0]?.recordId ?? null
  };
  let expect = strat.id === 'A0' ? null : s.expect;
  let checks = [];
  if (s.expect?.strategyExpect?.[strat.id]) {
    expect = s.expect.strategyExpect[strat.id];
  }
  const checked = expect !== null;
  if (expect) checks = checkExpect(expect, { ...ctx, targetRecord: s.events[0]?.recordId });
  // 附加 ambient 附加运行（如 D06 的 ambient 子断言）
  const extraRuns = [];
  if (s.expect?.strategyExpect?.ambient && strat.id === 'A3') {
    const amb = s.expect.strategyExpect.ambient;
    const r2 = rankCandidates({ pool, state, mode: 'ambient', situation: amb.situation, spaceIds: s.spaceIds, strategy: strat.strategy, now: NOW, params: strat.params });
    const order2 = r2.candidates.map((c) => c.recordId);
    for (const rid of amb.expect.absent ?? []) {
      extraRuns.push({ label: 'ambient-extra', ok: !order2.includes(rid), detail: rid });
    }
  }
  const allOk = checks.every((c) => c.ok) && extraRuns.every((c) => c.ok);
  return {
    strategyId: strat.id,
    checked,
    result,
    ranked: order,
    checks,
    extraRuns,
    pass: allOk,
    targetActivation: ctx.targetRecord ? getActivation(state, s.spaceIds[0], ctx.targetRecord) : null
  };
}

// ---------- 运行 ----------
console.log('== activation-01 evaluation ==');
console.log(`eval clock: ${new Date(NOW).toISOString()}`);

const baseByStrategy = {};
for (const s of STRATEGIES) {
  const cases = [];
  for (const scenario of baseScenarios()) {
    const specs = scenario.querySpecs ?? scenario.queries.map((q) => ({
      q, spaceIds: scenario.spaceIds,
      expectedRelevant: scenario.expectedRelevant,
      forbidden: scenario.forbidden,
      expectNoMatch: scenario.expectNoMatch
    }));
    for (const spec of specs) cases.push(evalBaseCase(spec, s, scenario.id));
  }
  baseByStrategy[s.id] = cases;
}

const HOLDOUT_RESULTS = [];
for (const s of holdoutScenarios()) {
  const perStrategy = {};
  for (const strat of STRATEGIES) {
    perStrategy[strat.id] = evalHoldoutScenario(s, strat);
    perStrategy[strat.id].result = {
      ...perStrategy[strat.id].result,
      candidates: perStrategy[strat.id].result.candidates.map((c) => ({
        recordId: c.recordId, finalScore: c.finalScore,
        coverage: c.relevance.coverage, recency: c.recency.factor,
        activationMultiplier: c.activation.multiplier, clamped: c.activation.clamped,
        reinforcementCount: c.activation.reinforcementCount,
        deliveryMultiplier: c.recentDelivery.multiplier,
        reasons: c.reasons
      }))
    };
  }
  HOLDOUT_RESULTS.push({ id: s.id, mode: s.mode, note: s.note, expect: s.expect, perStrategy });
}

const TUNING_RESULTS = tuningScenarios().map((s) => {
  const state = replayEvents(s.events);
  const per = {};
  for (const strat of STRATEGIES) {
    const r = rankCandidates(modeArgs(s, strat.id, state));
    per[strat.id] = { top1: r.candidates[0]?.recordId ?? null, ranked: r.candidates.map((c) => c.recordId) };
  }
  return { id: s.id, note: s.note, per };
});

// ---------- 性能与存储 ----------
const perf = { rankCalls: 0, totalTimeMs: 0, samples: [] };
for (let i = 0; i < 50; i += 1) {
  for (const s of STRATEGIES) {
    const state = replayEvents(holdoutScenarios()[2].events);
    const t0 = process.hrtime.bigint();
    rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: s.strategy, now: NOW, params: s.params });
    perf.samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}
perf.samples.sort((a, b) => a - b);
const cpu0 = process.cpuUsage();
// 重放性能（重建派生状态的完整成本）
const allEvents = holdoutScenarios().flatMap((s) => s.events);
const t0r = process.hrtime.bigint();
for (let i = 0; i < 20; i += 1) replayEvents(allEvents);
const replayMs = Number(process.hrtime.bigint() - t0r) / 1e6 / 20;
const cpu1 = process.cpuUsage(cpu0);
const tmpLog = join(RESULTS, 'events-synthetic.jsonl');
const saved = saveEventLog(tmpLog, allEvents);
const reloaded = replayEvents(loadEventLog(tmpLog));
const storage = {
  syntheticEventCount: allEvents.length,
  eventLogBytes: saved.bytes,
  bytesPerEvent: Number((saved.bytes / allEvents.length).toFixed(1)),
  replayRoundTripOk: JSON.stringify([...reloaded.entries()]) === JSON.stringify([...replayEvents(allEvents).entries()])
};

// ---------- 权重敏感性（报告用，不参与 GO） ----------
const sensitivity = [];
for (const w of [0.1, 0.15, 0.25, 0.35, 0.5]) {
  const params = { ...DEFAULT_PARAMS, wCount: w };
  const st3 = replayEvents(holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial').events);
  const r3 = rankCandidates({ pool, state: st3, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A1', now: NOW, params });
  const st4 = replayEvents(holdoutScenarios().find((x) => x.id === 'D04-high-freq-irrelevant-explicit').events);
  const r4 = rankCandidates({ pool, state: st4, mode: 'explicit', query: '周末 家', spaceIds: ['personal'], strategy: 'A1', now: NOW, params });
  sensitivity.push({ strategy: 'A1', wCount: w, D03_top1: r3.candidates[0].recordId, D04_top1: r4.candidates[0].recordId });
}
for (const w of [0.25, 0.35, 0.5, 0.75]) {
  for (const H of [7, 30]) {
    const params = { ...DEFAULT_PARAMS, wStrength: w, halfLifeDays: H };
    const st3 = replayEvents(holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial').events);
    const r3 = rankCandidates({ pool, state: st3, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A2', now: NOW, params });
    sensitivity.push({ strategy: `A2-H${H}`, wStrength: w, D03_top1: r3.candidates[0].recordId });
  }
}
for (const w of [0.1, 0.2, 0.35]) {
  const params = { ...DEFAULT_PARAMS, wActr: w };
  const st3 = replayEvents(holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial').events);
  const r3 = rankCandidates({ pool, state: st3, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A3', now: NOW, params });
  sensitivity.push({ strategy: 'A3', wActr: w, D03_top1: r3.candidates[0].recordId });
}

// ---------- 汇总 ----------
function agg(cases) {
  const n = cases.length;
  const matchable = cases.filter((c) => c.matchable);
  return {
    cases: n,
    pass: cases.filter((c) => c.pass).length,
    recall5: Number((cases.reduce((a, c) => a + c.recall5, 0) / n).toFixed(4)),
    mrrAll: Number((cases.reduce((a, c) => a + c.mrr, 0) / n).toFixed(4)),
    mrrMatchable: Number((matchable.reduce((a, c) => a + c.mrr, 0) / matchable.length).toFixed(4)),
    ndcg5: Number((cases.reduce((a, c) => a + c.ndcg5, 0) / n).toFixed(4)),
    forbiddenHits: cases.reduce((a, c) => a + c.forbiddenHits.length, 0)
  };
}
const baseSummary = Object.fromEntries(STRATEGIES.map((s) => [s.id, agg(baseByStrategy[s.id])]));
const holdoutPass = Object.fromEntries(STRATEGIES.map((s) => [
  s.id, HOLDOUT_RESULTS.filter((h) => h.perStrategy[s.id].checked && h.perStrategy[s.id].pass).map((h) => h.id)
]));
const holdoutChecked = Object.fromEntries(STRATEGIES.map((s) => [
  s.id, HOLDOUT_RESULTS.filter((h) => h.perStrategy[s.id].checked).map((h) => h.id)
]));

// 关键回归检查（GO2）：base 相对 A0 的 MRR 降幅、forbidden、结构失败
const regressions = {};
for (const s of STRATEGIES.slice(1)) {
  const a0 = baseSummary.A0;
  const cur = baseSummary[s.id];
  regressions[s.id] = {
    mrrDropVsA0: Number((a0.mrrMatchable - cur.mrrMatchable).toFixed(4)),
    recall5DropVsA0: Number((a0.recall5 - cur.recall5).toFixed(4)),
    forbiddenHits: cur.forbiddenHits,
    failedCases: baseByStrategy[s.id].filter((c, i) => !c.pass && baseByStrategy.A0[i].pass).map((c) => `${c.scenarioId}"${c.query}"`)
  };
}

// 解释样例
const stD05 = replayEvents(holdoutScenarios().find((x) => x.id === 'D05-old-commitment-reachable').events);
const rD05A1 = rankCandidates({ pool, state: stD05, mode: 'ambient', situation: '有没有还没完成的旅行约定', spaceIds: ['personal'], strategy: 'A1', now: NOW });
const rD05A0 = rankCandidates({ pool, state: stD05, mode: 'ambient', situation: '有没有还没完成的旅行约定', spaceIds: ['personal'], strategy: 'A0', now: NOW });
const explanations = {
  'D05-A1-erhai-vs-umbrella': JSON.parse(JSON.stringify(explainRanking({ result: rD05A1, recordIdA: 'rec-commitment-erhai', recordIdB: 'rec-umbrella' }))),
  'D03-A1-gym-vs-recipe': (() => {
    const st = replayEvents(holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial').events);
    const r = rankCandidates({ pool, state: st, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A1', now: NOW });
    return JSON.parse(JSON.stringify(explainRanking({ result: r, recordIdA: 'rec-gym-runs', recordIdB: 'rec-recipe-hotpot' })));
  })()
};

const perfSummary = {
  rankMedianMs: Number(perf.samples[Math.floor(perf.samples.length / 2)].toFixed(4)),
  rankP95Ms: Number(perf.samples[Math.floor(perf.samples.length * 0.95) - 1].toFixed(4)),
  rankMaxMs: Number(perf.samples[perf.samples.length - 1].toFixed(4)),
  replayAvgMs: Number(replayMs.toFixed(4)),
  cpuUserMs: Number((cpu1.user / 1000).toFixed(1)),
  cpuSystemMs: Number((cpu1.system / 1000).toFixed(1))
};

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    evalClock: new Date(NOW).toISOString(),
    atlasHead: '4f112f2',
    branch: 'experiment/activation-01',
    params: DEFAULT_PARAMS,
    strategies: STRATEGIES.map((s) => ({ id: s.id, strategy: s.strategy, halfLifeDays: s.params.halfLifeDays }))
  },
  baseSummary,
  holdoutPass,
  regressions,
  tuning: TUNING_RESULTS,
  sensitivity,
  perf: perfSummary,
  storage,
  explanations,
  baseCases: Object.fromEntries(STRATEGIES.map((s) => [s.id, baseByStrategy[s.id]])),
  holdoutDetail: HOLDOUT_RESULTS
};

writeFileSync(join(RESULTS, 'eval-results.json'), JSON.stringify(report, null, 2), 'utf8');

// ---------- REPORT.md ----------
const md = [];
md.push('# activation-01 评估报告（机器生成）');
md.push('');
md.push(`- 评估时钟：${new Date(NOW).toISOString()}（固定，无随机源）`);
md.push(`- 基线出处：glm-retrieval adapter.mjs @ Atlas HEAD 4f112f2（A0 公式逐字复刻）`);
md.push(`- 策略：${STRATEGIES.map((s) => s.id).join(' / ')}；参数：wCount=${DEFAULT_PARAMS.wCount}, wStrength=${DEFAULT_PARAMS.wStrength}, wActr=${DEFAULT_PARAMS.wActr}, floor=${DEFAULT_PARAMS.floor}, ceil=${DEFAULT_PARAMS.ceil}`);
md.push('');
md.push('## 1. 基础情景（36 个 explicit 用例）——正确性回归');
md.push('');
md.push('| 策略 | pass | Recall@5 | MRR(可判定) | MRR(全部) | nDCG@5 | forbidden 命中 |');
md.push('|---|---|---|---|---|---|---|');
for (const s of STRATEGIES) {
  const a = baseSummary[s.id];
  md.push(`| ${s.id} | ${a.pass}/${a.cases} | ${a.recall5} | ${a.mrrMatchable} | ${a.mrrAll} | ${a.ndcg5} | ${a.forbiddenHits} |`);
}
md.push('');
md.push('## 2. 动态保留场景（16 个）——逐场景判定（— = 该策略在此场景无可判定预期）');
md.push('');
md.push('| 场景 | ' + STRATEGIES.map((s) => s.id).join(' | ') + ' |');
md.push('|---|' + STRATEGIES.map(() => '---').join('|') + '|');
for (const h of HOLDOUT_RESULTS) {
  const row = STRATEGIES.map((s) => {
    const p = h.perStrategy[s.id];
    return p.checked ? (p.pass ? '✅' : '❌') : '—';
  }).join(' | ');
  md.push(`| ${h.id} | ${row} |`);
}
md.push('');
md.push('### 逐场景策略差异明细（失败检查项）');
for (const h of HOLDOUT_RESULTS) {
  const fails = STRATEGIES.filter((s) => !h.perStrategy[s.id].pass);
  if (fails.length === 0) continue;
  md.push('');
  md.push(`**${h.id}** — ${h.note}`);
  for (const s of fails) {
    const bad = h.perStrategy[s.id].checks.filter((c) => !c.ok);
    md.push(`- ${s.id}: ${bad.map((c) => `${c.check}(${c.detail})`).join(', ') || '附加运行失败'}`);
  }
}
md.push('');
md.push('## 3. 相对 A0 的回归（GO 条件 2）');
for (const [id, r] of Object.entries(regressions)) {
  md.push(`- ${id}: MRR 降幅 ${r.mrrDropVsA0}，Recall@5 降幅 ${r.recall5DropVsA0}，forbidden ${r.forbiddenHits}，A0 通过而它失败：${r.failedCases.length ? r.failedCases.join('; ') : '无'}`);
}
md.push('');
md.push('## 4. 调参场景');
for (const t of TUNING_RESULTS) {
  md.push(`- ${t.id}: ${STRATEGIES.map((s) => `${s.id}→${t.per[s.id].top1}`).join(', ')}`);
}
md.push('');
md.push('## 5. 权重敏感性（报告用，未参与判定）');
for (const r of sensitivity) md.push(`- ${JSON.stringify(r)}`);
md.push('');
md.push('## 6. 性能与存储');
md.push(`- 单次排序：median ${perfSummary.rankMedianMs}ms / p95 ${perfSummary.rankP95Ms}ms / max ${perfSummary.rankMaxMs}ms（26 记录合成库）`);
md.push(`- 事件重放：${perfSummary.replayAvgMs}ms/次（${allEvents.length} 事件）`);
md.push(`- 事件日志：${storage.eventLogBytes} bytes，${storage.bytesPerEvent} B/事件，round-trip ${storage.replayRoundTripOk ? '一致' : '不一致'}`);
md.push(`- CPU（本进程累计采样段）：user ${perfSummary.cpuUserMs}ms, sys ${perfSummary.cpuSystemMs}ms`);
md.push('');
md.push('## 7. 解释样例');
md.push('```json');
md.push(JSON.stringify(explanations, null, 2).slice(0, 4000));
md.push('```');
writeFileSync(join(RESULTS, 'REPORT.md'), md.join('\n'), 'utf8');

console.log('\n== base summary ==');
for (const s of STRATEGIES) console.log(s.id, JSON.stringify(baseSummary[s.id]));
console.log('\n== holdout pass counts（仅计可判定场景） ==');
for (const s of STRATEGIES) {
  const checked = holdoutChecked[s.id].length;
  console.log(s.id, `${holdoutPass[s.id].length}/${checked}`, 'checked:', holdoutChecked[s.id].join(',') || '(none)');
}
console.log('\n== perf ==', JSON.stringify(perfSummary));
console.log('== storage ==', JSON.stringify(storage));
console.log('\nwritten:', join(RESULTS, 'eval-results.json'), '+', join(RESULTS, 'REPORT.md'));
