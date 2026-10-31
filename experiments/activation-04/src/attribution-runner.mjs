// 归因运行器（activation-04）—— 每场景一次真实候选获取 → 五策略（A0/L/R/LR/D）。
//
// 红线（沿用 activation-03 §三，全部继承）：
//   - 同一候选集五策略共用；成员资格零改动（断言锁定）；
//   - 正式返回 = A0 原样；影子运行不写任何事件账本；
//   - 事件只来自 fixtures 剧本（历史合成），经 replayEvents 只读重放；
//   - candidate_retrieved / 影子查询永不进入事件剧本。
//
// 与 activation-03 shadow-runner 的差异：策略集换成五策略；场景来源 = holdout-v3
// （30，语料 corpus-v3）+ holdout-v4（8，语料 corpus-v4）；trace 增加逐候选
// 解释字段（tier / g2 乘数 / 重提次数 / 最近投递 / 各策略排名与位移原因）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPathAHarness, createPathBHarness, makeTempDir } from '../../activation-03/src/real-harness.mjs';
import { rankA0V4, rankL, rankR, rankLR, rankD } from './attribution-strategies.mjs';
import { classifyEvidencePath, computeTierFromReal } from '../../activation-03/src/evidence.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { termsForQuery, tokenizeForIndex } from '../../activation-01/src/tokenizer.mjs';
import { holdoutV3Scenarios } from '../../activation-03/fixtures/holdout-v3.mjs';
import { MIRA_RECORDS, OTHER_RECORDS, MIRA_B_RECORDS, OTHER_B_RECORDS, SCENARIO_EVENTS } from '../../activation-03/fixtures/corpus-v3.mjs';
import { holdoutV4Scenarios } from '../fixtures/holdout-v4.mjs';
import { NOVA_RECORDS, NOVA_B_RECORDS, SCENARIO_EVENTS_V4, NOW_MS_V4 } from '../fixtures/corpus-v4.mjs';

function sha256(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

// 语料装载：v3 空间 + v4 空间（场景用 corpus 字段选择事件剧本来源）。
const CORPUS_SPACES = new Map([
  ['mira', MIRA_RECORDS], ['other', OTHER_RECORDS],
  ['mira-b', MIRA_B_RECORDS], ['other-b', OTHER_B_RECORDS],
  ['nova', NOVA_RECORDS], ['nova-b', NOVA_B_RECORDS]
]);

function corpusFor(spaces) {
  const bySpace = new Map();
  for (const spaceId of spaces) {
    if (!CORPUS_SPACES.has(spaceId)) throw new Error(`未知空间 ${spaceId}`);
    bySpace.set(spaceId, CORPUS_SPACES.get(spaceId));
  }
  return bySpace;
}

function eventsFor(scenario, spaceId) {
  const script = (scenario.corpus === 'v4' ? SCENARIO_EVENTS_V4 : SCENARIO_EVENTS)[scenario.id];
  if (!script) return [];
  return script.map((e, i) => ({
    eventId: `${scenario.id}-ev-${i + 1}`,
    spaceId,
    recordId: e.recordId,
    recordRevision: null,
    eventType: e.eventType,
    occurredAt: e.at,
    observedAt: e.at,
    sourceEventId: null,
    provenance: { fixture: scenario.id }
  }));
}

function effectiveQueryOf(scenario) {
  return scenario.mode === 'explicit' ? scenario.query : scenario.situation;
}

export async function runAttributionScenario(scenario, { nowMs = NOW_MS_V4 } = {}) {
  const spaces = scenario.spaces ?? ['nova'];
  const mode = scenario.mode;
  const effectiveQuery = effectiveQueryOf(scenario);
  const started = performance.now();

  // —— 1. 一次取齐候选集（按路径接线，接线方式 = activation-03 原样）——
  let harness;
  let candidateSet;
  if (scenario.path === 'B') {
    const dir = makeTempDir('b4-');
    harness = await createPathBHarness({
      spaceId: spaces[0], records: [...corpusFor(spaces).values()].flat(), indexDir: dir, situation: effectiveQuery
    });
    candidateSet = {
      pathLabel: harness.pathLabel, searchPath: harness.searchPath, indexState: harness.indexState,
      engineMode: harness.engineMode, outcome: harness.outcome, candidates: harness.candidates,
      indexReport: harness.indexReport
    };
  } else {
    const dir = makeTempDir('a4-');
    harness = await createPathAHarness({
      spaceId: spaces[0] === 'nova' ? 'nova' : spaces[0],
      records: [...corpusFor(spaces).values()].flat(),
      engineMode: scenario.engineMode ?? 'glm',
      indexDir: dir
    });
    const queryOptions = { limit: 50 };
    if (scenario.query !== undefined) queryOptions.query = scenario.query;
    if (scenario.since !== undefined) queryOptions.since = scenario.since;
    if (scenario.timeField !== undefined) queryOptions.timeField = scenario.timeField;
    candidateSet = await harness.query(queryOptions);
  }

  const candidates = candidateSet.candidates;
  const queryTerms = effectiveQuery !== undefined && effectiveQuery !== null && effectiveQuery !== ''
    ? termsForQuery(effectiveQuery)
    : [];
  const collapsedQuery = effectiveQuery !== undefined && effectiveQuery !== null
    ? String(effectiveQuery).normalize('NFC').toLowerCase().replace(/\s+/g, '')
    : '';

  // —— 2. 证据标注 + scope 词频表（activation-03 原样口径）——
  let scope = { df: new Map(), scopeDocCount: 0 };
  if (scenario.path === 'A' && harness && typeof harness.svc.authority.inspect === 'function') {
    const inspected = harness.svc.authority.inspect(spaces[0]);
    if (inspected.available) {
      const active = inspected.spaceDoc.records.filter((r) => r.kind === 'experience' || r.kind === 'correction');
      const statuses = inspected.validity.statuses;
      const df = new Map();
      let count = 0;
      for (const rec of active) {
        if (statuses.get(rec.recordId) !== 'active') continue;
        count += 1;
        for (const t of tokenizeForIndex(rec.content ?? '')) df.set(t, (df.get(t) ?? 0) + 1);
      }
      scope = { df, scopeDocCount: count };
    }
  }
  for (const c of candidates) {
    c.evidenceClass = classifyEvidencePath({ matchReason: c.matchReason, coverage: c.coverage });
  }

  // —— 3. 派生态（只读重放）——
  const state = replayEvents(eventsFor(scenario, spaces[0]));

  // —— 4. 五策略共用同一候选集 ——
  const common = {
    candidates, mode, state, now: nowMs, queryTerms, collapsedQuery,
    scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
  };
  const a0 = rankA0V4({ candidates });
  const lex = rankL(common);
  const dyn = rankR(common);
  const both = rankLR(common);
  const deliv = rankD(common);

  // —— 5. 逐候选解释（任务书 §四 的展示字段全部在此生成）——
  const g2Of = (recordId) => {
    const r = dyn.ranked.find((x) => x.recordId === recordId);
    if (r && r.g2) return r.g2;
    const lr = both.ranked.find((x) => x.recordId === recordId);
    return lr?.g2 ?? { multiplier: 1, clamped: null, count: 0 };
  };
  const candidatesExplain = candidates.map((c) => {
    const tier = computeTierFromReal({
      recordId: c.recordId, content: c.content, matchReason: c.matchReason, coverage: c.coverage,
      queryTerms, collapsedQuery, scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
    });
    const act = state.get(`${c.spaceId}::${c.recordId}`);
    const g2 = g2Of(c.recordId);
    return {
      recordId: c.recordId,
      content: c.content,
      occurredAt: c.occurredAt,
      evidence: {
        evidenceClass: c.evidenceClass,
        coverage: c.coverage,
        matchReason: (c.matchReason ?? []).slice(0, 8),
        idHit: tier.idHit,
        phraseHit: tier.phraseHit,
        matchedBigrams: tier.matchedBigrams,
        matchedUnigrams: tier.matchedUnigrams,
        tier: tier.tier,
        tierName: tier.tierName,
        tierLabel: tier.label
      },
      activation: {
        revisitCount: act?.reinforceTimesMs?.length ?? 0,
        g2Multiplier: g2.multiplier,
        g2Clamped: g2.clamped,
        lastDeliveryMs: act?.lastDeliveryMs ?? null,
        lastDeliveryIso: act?.lastDeliveryMs != null ? new Date(act.lastDeliveryMs).toISOString() : null
      },
      rankBy: {}
    };
  });
  const explainById = new Map(candidatesExplain.map((e) => [e.recordId, e]));

  // —— 6. 各策略排名 + 位移原因 ——
  const strategyResults = { A0: a0, L: lex, R: dyn, LR: both, D: deliv };
  const strategyRankings = {};
  const strategyRankChanges = {};
  const strategyNotes = {};
  const fallbackReasons = {};
  const baselineRanking = a0.ranked.map((r) => r.recordId);
  const rankOf = (order, id) => order.indexOf(id) + 1;
  for (const [label, result] of Object.entries(strategyResults)) {
    const ids = result.ranked.map((r) => r.recordId);
    strategyRankings[label] = ids;
    for (const id of ids) explainById.get(id).rankBy[label] = rankOf(ids, id);
    strategyRankChanges[label] = label === 'A0' ? [] : ids
      .map((id, i) => ({ recordId: id, from: baselineRanking.indexOf(id) + 1, to: i + 1 }))
      .filter((m) => m.from !== m.to);
    strategyNotes[label] = result.notes ?? [];
    if (result.refused) fallbackReasons[label] = result.fallbackReason;
  }

  const record = {
    queryId: scenario.id,
    corpus: scenario.corpus ?? 'v3',
    family: scenario.family,
    mode,
    pathLabel: candidateSet.pathLabel,
    searchPath: candidateSet.searchPath,
    spaceId: spaces.join('+'),
    query: effectiveQuery ?? null,
    candidateSetHash: sha256(candidates.map((c) => c.recordId).sort()),
    candidateCount: candidates.length,
    singleCandidate: candidates.length <= 1,
    baselineRanking,
    strategyRankings,
    strategyRankChanges,
    strategyRefused: fallbackReasons,
    gateMoves: both.gateMoves ?? [],
    candidatesExplain,
    strategyNotes,
    recentDeliveryPenalty: {
      applied: deliv.changed,
      suppressedRecords: (deliv.ranked ?? []).filter((r) => r.suppressed).map((r) => r.recordId),
      explicitBypass: mode === 'explicit'
    },
    indexState: candidateSet.indexState,
    elapsedMs: {
      candidateFetch: Number((performance.now() - started).toFixed(3)),
      A0: Number(a0.timingMs.toFixed(4)),
      L: Number(lex.timingMs.toFixed(4)),
      R: Number(dyn.timingMs.toFixed(4)),
      LR: Number(both.timingMs.toFixed(4)),
      D: Number(deliv.timingMs.toFixed(4))
    },
    idMap: harness && harness.createdIds ? Object.fromEntries(harness.createdIds) : {}
  };

  if (harness && typeof harness.close === 'function') harness.close();
  return record;
}

export async function runAttribution({ scenarios = null, log = console.error } = {}) {
  const all = scenarios ?? [...holdoutV3Scenarios(), ...holdoutV4Scenarios()];
  const records = [];
  for (const scenario of all) {
    const entry = await runAttributionScenario(scenario);
    records.push(entry);
    log(`${entry.queryId} path=${entry.pathLabel} cand=${entry.candidateCount} ` +
      `LΔ=${entry.strategyRankChanges.L.length} RΔ=${entry.strategyRankChanges.R.length} ` +
      `LRΔ=${entry.strategyRankChanges.LR.length} DΔ=${entry.strategyRankChanges.D.length}` +
      (entry.strategyRefused.R ? ' R-refused' : '') +
      (entry.strategyRefused.LR ? ' LR-refused' : ''));
  }
  return records;
}

export function writeAttributionRecords(records, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return outPath;
}
