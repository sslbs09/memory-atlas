// 影子运行器 —— 对每个场景：一次取齐真实候选集 → 三策略重排 → 机器可读影子记录。
//
// 红线执行点（activation-03 任务书 §三）：
//   - 相同查询只取一次候选集（harness.query / 路径 B 一次调用）；
//   - 正式返回保持 A0 原样：本模块只读候选，不调用任何写入接口；
//   - 影子运行不产生任何事件：runner 根本不持有 EventLog（事件只来自
//     fixtures 剧本，经 activation-01 replayEvents 重放为只读派生态）；
//   - candidate_retrieved / 未真实投递不进入剧本：剧本里的 delivered_reference
//     只表示“ fixtures 声明的历史真实投递”，其记录规则由 event-bridge 单测验证。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPathAHarness, createPathBHarness, makeTempDir } from './real-harness.mjs';
import { rankA0, rankG3, rankG1G2 } from './shadow-strategies.mjs';
import { computeTierFromReal, classifyEvidencePath } from './evidence.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { termsForQuery, tokenizeForIndex } from '../../activation-01/src/tokenizer.mjs';
import { holdoutV3Scenarios } from '../fixtures/holdout-v3.mjs';
import { MIRA_RECORDS, OTHER_RECORDS, MIRA_B_RECORDS, OTHER_B_RECORDS, SCENARIO_EVENTS, NOW_MS } from '../fixtures/corpus-v3.mjs';

function sha256(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

// 剧本事件 → replayEvents 输入（occurredAt=at；recordRevision 未知置 null）。
function eventsFor(scenarioId, spaceId) {
  const script = SCENARIO_EVENTS[scenarioId];
  if (!script) return [];
  return script.map((e, i) => ({
    eventId: `${scenarioId}-ev-${i + 1}`,
    spaceId,
    recordId: e.recordId,
    recordRevision: null,
    eventType: e.eventType,
    occurredAt: e.at,
    observedAt: e.at,
    sourceEventId: null,
    provenance: { fixture: scenarioId }
  }));
}

// 语料装载：显式场景声明自己的空间集合。
function corpusFor(spaces) {
  const bySpace = new Map();
  for (const spaceId of spaces) {
    if (spaceId === 'mira') bySpace.set('mira', MIRA_RECORDS);
    else if (spaceId === 'other') bySpace.set('other', OTHER_RECORDS);
    else if (spaceId === 'mira-b') bySpace.set('mira-b', MIRA_B_RECORDS);
    else if (spaceId === 'other-b') bySpace.set('other-b', OTHER_B_RECORDS);
    else throw new Error(`未知空间 ${spaceId}`);
  }
  return bySpace;
}

export async function runShadow({ scenarios = holdoutV3Scenarios(), log = console.error } = {}) {
  const records = [];
  for (const scenario of scenarios) {
    const entry = await runScenario(scenario);
    records.push(entry);
    log(`${entry.scenarioId} path=${entry.pathLabel} cand=${entry.candidateCount} ` +
      `changed[G3=${entry.strategies.G3?.changed} G1G2=${entry.strategies.G1G2?.changed ?? 'refused'}]`);
  }
  return records;
}

export async function runScenario(scenario) {
  const spaces = scenario.spaces ?? ['mira'];
  const mode = scenario.mode;
  const effectiveQuery = mode === 'explicit' ? scenario.query : scenario.situation;
  const nowMs = NOW_MS;
  const started = performance.now();

  // —— 1. 一次取齐候选集（按路径接线）——
  let harness;
  let candidateSet;
  let revisionBefore = null;
  let revisionAfter = null;

  if (scenario.path === 'B') {
    const dir = makeTempDir('b3-');
    harness = await createPathBHarness({
      spaceId: spaces[0], records: [...corpusFor(spaces).values()].flat(), indexDir: dir, situation: effectiveQuery
    });
    candidateSet = {
      pathLabel: harness.pathLabel, searchPath: harness.searchPath, indexState: harness.indexState,
      engineMode: harness.engineMode, outcome: harness.outcome, candidates: harness.candidates,
      indexReport: harness.indexReport
    };
  } else {
    const dir = makeTempDir('a3-');
    harness = await createPathAHarness({
      spaceId: 'mira',
      records: [...corpusFor(spaces).values()].flat(),
      engineMode: scenario.engineMode ?? 'glm',
      indexDir: dir
    });
    if (scenario.family === 'structural') {
      const before = await harness.svc.search({ spaceId: 'mira', limit: 1 });
      revisionBefore = before.revision;
    }
    const queryOptions = { limit: 50 };
    if (scenario.query !== undefined) queryOptions.query = scenario.query;
    if (scenario.since !== undefined) queryOptions.since = scenario.since;
    const response = await harness.query(queryOptions);
    candidateSet = response;
    if (scenario.family === 'structural') {
      const after = await harness.svc.search({ spaceId: 'mira', limit: 1 });
      revisionAfter = after.revision;
    }
  }

  const candidates = candidateSet.candidates;
  const queryTerms = effectiveQuery !== undefined && effectiveQuery !== null && effectiveQuery !== ''
    ? termsForQuery(effectiveQuery)
    : [];
  const collapsedQuery = effectiveQuery !== undefined && effectiveQuery !== null
    ? String(effectiveQuery).normalize('NFC').toLowerCase().replace(/\s+/g, '')
    : '';

  // —— 2. 证据标注（A 路径：原生 matchReason + 权威 content 合法重算）——
  // scope 词频表来自权威投影（inspect 可见的同一信息范围），不是候选集自举。
  let scope = { df: new Map(), scopeDocCount: 0 };
  if (scenario.path === 'A' && harness && typeof harness.svc.authority.inspect === 'function') {
    const inspected = harness.svc.authority.inspect('mira');
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
  const state = replayEvents(eventsFor(scenario.id, spaces[0]));

  // —— 4. 三策略共用同一候选集 ——
  const a0 = rankA0({ candidates });
  const g3 = rankG3({ candidates, mode, state, now: nowMs });
  const g1g2 = rankG1G2({
    candidates, mode, state, now: nowMs, queryTerms, collapsedQuery,
    scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
  });

  // —— 5. 影子记录（任务书 §三 字段全量）——
  const baselineRanking = a0.ranked.map((r) => r.recordId);
  const tiers = {};
  for (const c of candidates) {
    const t = computeTierFromReal({
      recordId: c.recordId, content: c.content, matchReason: c.matchReason, coverage: c.coverage,
      queryTerms, collapsedQuery, scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
    });
    tiers[c.recordId] = { tier: t.tier, name: t.tierName, evidenceClass: t.evidenceClass };
  }
  const rankOf = (order, id) => order.indexOf(id) + 1;
  const rankChanges = [];
  for (const strategyResult of [g3, g1g2]) {
    if (strategyResult.refused) continue;
    for (const r of strategyResult.ranked) {
      const from = rankOf(baselineRanking, r.recordId);
      const to = strategyResult.ranked.findIndex((x) => x.recordId === r.recordId) + 1;
      if (from !== to) rankChanges.push({ strategy: strategyResult.strategy, recordId: r.recordId, from, to });
    }
  }

  const evidenceTierSet = [...new Set(Object.values(tiers).map((t) => `${t.tier}:${t.name}`))];
  const activationComponents = {
    reinforced: [...state.entries()].filter(([, v]) => v.reinforceTimesMs.length > 0)
      .map(([k, v]) => ({ key: k, revisits: v.reinforceTimesMs.length })),
    recentDelivery: [...state.entries()].filter(([, v]) => v.lastDeliveryMs !== null)
      .map(([k, v]) => ({ key: k, lastDeliveryMs: v.lastDeliveryMs }))
  };

  const record = {
    queryId: scenario.id,
    family: scenario.family,
    mode,
    pathLabel: candidateSet.pathLabel,
    searchPath: candidateSet.searchPath,
    spaceId: spaces.join('+'),
    query: effectiveQuery ?? null,
    candidateSetHash: sha256(candidates.map((c) => c.recordId).sort()),
    candidateCount: candidates.length,
    baselineRanking,
    shadowRanking: {
      A0: baselineRanking,
      G3: g3.refused ? null : g3.ranked.map((r) => r.recordId),
      G1G2: g1g2.refused ? null : g1g2.ranked.map((r) => r.recordId)
    },
    rankChanges,
    evidenceTier: candidates.length === 0 ? 'empty' : evidenceTierSet.join('|'),
    evidenceDetail: tiers,
    activationComponents,
    recentDeliveryPenalty: {
      applied: g3.changed,
      suppressedRecords: g3.ranked.filter((r) => r.suppressed).map((r) => r.recordId),
      explicitBypass: mode === 'explicit'
    },
    fallbackReason: g1g2.refused ? g1g2.fallbackReason : null,
    indexState: candidateSet.indexState,
    indexReport: candidateSet.indexReport,
    searchPathNote: candidateSet.searchPath,
    elapsedMs: {
      candidateFetch: Number((performance.now() - started).toFixed(3)),
      A0: Number(a0.timingMs.toFixed(4)),
      G3: Number(g3.timingMs.toFixed(4)),
      G1G2: Number(g1g2.timingMs.toFixed(4))
    },
    gateMoves: g1g2.gateMoves ?? [],
    strategyNotes: { A0: a0.notes, G3: g3.notes, G1G2: g1g2.notes ?? [] },
    structuralProbe: scenario.family === 'structural' ? {
      revisionBefore, revisionAfter,
      revisionUnchanged: revisionBefore === null ? null : revisionBefore === revisionAfter
    } : null
  };

  if (harness && typeof harness.close === 'function') harness.close();
  return record;
}

export function writeShadowRecords(records, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return outPath;
}
