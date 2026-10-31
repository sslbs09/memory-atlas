// 统一评价（activation-03）—— 同一候选集/时间/期望下比较 A0 / G3 / G1G2。
//
// 分母纪律（任务书 §六）：
//   - 排序指标分母 = 该 family 内 candidateCount>0 且存在 grade>=2 相关记录的
//     场景；negative-availability（B06 等）显式排除并逐个列名。
//   - explicit / ambient / fallback 分组报告，不合成单一分数。
//   - structural 组只报告行为断言结果，不进入排序分母。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShadow, writeShadowRecords } from '../src/shadow-runner.mjs';
import { holdoutV3Scenarios, HOLDOUT_V3_META, AMENDMENTS } from '../fixtures/holdout-v3.mjs';
import { createEventBridge, LIFECYCLE_KINDS } from '../src/event-bridge.mjs';
import { createEventIdFactory } from '../../activation-02/src/event-ids.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'results-v3');

const STRATEGIES = ['A0', 'G3', 'G1G2'];

function dcg(gains) {
  return gains.reduce((acc, g, i) => acc + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
}

function metricsFor({ shadowRanking, relevance, forbidden, scenario }) {
  const grades = shadowRanking.map((id) => relevance[id] ?? 0);
  const relevant = shadowRanking.map((id, i) => ({ id, i, grade: relevance[id] ?? 0 }))
    .filter((x) => x.grade >= 2);
  const firstRel = relevant.length > 0 ? relevant[0] : null;
  const mrr = firstRel ? 1 / (firstRel.i + 1) : 0;
  const gains5 = grades.slice(0, 5);
  const ideal = Object.values(relevance).filter((g) => g >= 1).sort((a, b) => b - a).slice(0, 5);
  const idcg = dcg(ideal.length > 0 ? ideal : [0]);
  const ndcg5 = dcg(gains5) / idcg;
  const top1Grade = grades[0] ?? null;
  const top1Correct = top1Grade === 3;
  const top3Intrusion = grades.slice(0, 3).filter((g) => g === 0).length;
  const forbiddenHits = shadowRanking.filter((id) => (forbidden ?? []).includes(id));
  const primaryIds = Object.entries(relevance).filter(([, g]) => g === 3).map(([id]) => id);
  const primaryReachable = shadowRanking.slice(0, 5).some((id) => primaryIds.includes(id));
  return {
    top1Correct, top1Grade, mrr: Number(mrr.toFixed(4)), ndcg5: Number(ndcg5.toFixed(4)),
    recall5: relevant.length > 0 ? Number((relevant.filter((x) => x.i < 5).length / Math.min(relevant.length, 5)).toFixed(4)) : null,
    top3Intrusion, forbiddenHits,
    primaryReachable,
    order: shadowRanking
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scenarios = holdoutV3Scenarios();
  console.error(`holdout-v3: ${scenarios.length} 场景（冻结于运行前，AMENDMENTS=${AMENDMENTS.length}）`);

  // ===== 影子运行（每场景一次真实候选获取 + 三策略）=====
  const shadowRecords = await runShadow({ scenarios });
  const tracesPath = writeShadowRecords(shadowRecords, path.join(OUT_DIR, 'shadow-traces.jsonl'));
  console.error(`影子记录 → ${tracesPath}`);

  // X01 重启确定性：双进程重放比对
  const x01 = scenarios.find((s) => s.id === 'X01-restart-determinism');
  const x01second = (await runShadow({ scenarios: [x01], log: () => {} }))[0];
  const first = shadowRecords.find((r) => r.queryId === x01.id);
  const stripVolatile = (r) => {
    const clone = JSON.parse(JSON.stringify(r));
    for (const k of Object.keys(clone.elapsedMs)) clone.elapsedMs[k] = 0;
    return clone;
  };
  const x01Identical = JSON.stringify(stripVolatile(first)) === JSON.stringify(stripVolatile(x01second));

  // ===== 分组指标 =====
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const perCase = [];
  const families = {};

  for (const rec of shadowRecords) {
    const scenario = scenarioById.get(rec.queryId);
    const relevance = scenario.relevance ?? {};
    const hasRanking = rec.candidateCount > 0 && Object.values(relevance).some((g) => g >= 2);
    const caseEntry = {
      id: rec.queryId, family: rec.family, mode: rec.mode, path: rec.pathLabel,
      candidateCount: rec.candidateCount, hasRanking,
      excludedReason: hasRanking ? null
        : (rec.candidateCount === 0 ? 'zero-candidates' : 'no-grade2-relevant'),
      perStrategy: {}
    };
    if (hasRanking) {
      for (const strategy of STRATEGIES) {
        const ranking = strategy === 'A0' ? rec.baselineRanking : rec.shadowRanking[strategy];
        caseEntry.perStrategy[strategy] = metricsFor({
          shadowRanking: ranking ?? rec.baselineRanking, relevance, forbidden: scenario.forbidden, scenario
        });
      }
    } else {
      for (const strategy of STRATEGIES) {
        caseEntry.perStrategy[strategy] = { skipped: true };
      }
    }
    perCase.push(caseEntry);
    (families[rec.family] ??= []).push(caseEntry);
  }

  const summarizeFamily = (cases, family) => {
    const rankingCases = cases.filter((c) => c.hasRanking);
    const out = {
      scenarios: cases.length,
      rankingDenominator: rankingCases.length,
      excluded: cases.filter((c) => !c.hasRanking).map((c) => ({ id: c.id, reason: c.excludedReason })),
      byStrategy: {}
    };
    for (const strategy of STRATEGIES) {
      const ms = rankingCases.map((c) => c.perStrategy[strategy]);
      const timings = shadowRecords.filter((r) => r.family === family).map((r) => r.elapsedMs[strategy]);
      const sorted = [...timings].sort((a, b) => a - b);
      const p = (q) => Number((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(4));
      out.byStrategy[strategy] = {
        top1Accuracy: ms.length ? Number((ms.filter((m) => m.top1Correct).length / ms.length).toFixed(4)) : null,
        mrr: ms.length ? Number((ms.reduce((a, m) => a + m.mrr, 0) / ms.length).toFixed(4)) : null,
        ndcg5: ms.length ? Number((ms.reduce((a, m) => a + m.ndcg5, 0) / ms.length).toFixed(4)) : null,
        recall5Avg: ms.length ? Number((ms.reduce((a, m) => a + (m.recall5 ?? 0), 0) / ms.length).toFixed(4)) : null,
        top3IntrusionTotal: ms.reduce((a, m) => a + m.top3Intrusion, 0),
        forbiddenRecallTotal: ms.reduce((a, m) => a + m.forbiddenHits.length, 0),
        primaryReachableAll: ms.length ? ms.every((m) => m.primaryReachable) : null,
        primaryReachableCount: ms.filter((m) => m.primaryReachable).length,
        timingMs: { p50: p(0.5), p95: p(0.95) }
      };
    }
    // 影子 vs A0 差异率 / 降级 / gate
    const familyRecords = shadowRecords.filter((r) => r.family === family);
    const comparable = familyRecords.filter((r) => r.candidateCount > 1);
    out.shadowVsA0 = {
      comparableScenarios: comparable.length,
      G3: comparable.filter((r) => JSON.stringify(r.shadowRanking.G3) !== JSON.stringify(r.baselineRanking)).length,
      G1G2: comparable.filter((r) => r.shadowRanking.G1G2 !== null &&
        JSON.stringify(r.shadowRanking.G1G2) !== JSON.stringify(r.baselineRanking)).length
    };
    out.g1g2Downgrades = familyRecords.filter((r) => r.fallbackReason !== null).length;
    out.downgradeReasons = [...new Set(familyRecords.map((r) => r.fallbackReason).filter(Boolean))];
    out.gateMovesTotal = familyRecords.reduce((a, r) => a + r.gateMoves.length, 0);
    return out;
  };

  const byFamily = {};
  for (const family of ['explicit', 'ambient', 'fallback']) {
    byFamily[family] = summarizeFamily(families[family] ?? [], family);
  }

  // 近期投递重复率（有投递事件且候选存在的 ambient/fallback 场景）
  const repeatScenarios = shadowRecords.filter((r) =>
    ['B02-recent-delivery', 'C05-browse-suppression'].includes(r.queryId));
  const recentDeliveryRepeatTop1 = {};
  for (const strategy of STRATEGIES) {
    recentDeliveryRepeatTop1[strategy] = repeatScenarios.map((r) => {
      const order = strategy === 'A0' ? r.baselineRanking : r.shadowRanking[strategy];
      return { id: r.queryId, top1: order?.[0] ?? null };
    });
  }

  // 结构组断言
  const structural = {};
  for (const rec of shadowRecords.filter((r) => r.family === 'structural')) {
    structural[rec.queryId] = { passed: null, detail: rec.structuralProbe };
  }
  structural['X01-restart-determinism'] = { passed: x01Identical, detail: '双进程重放（时间戳归零后）逐位一致' };

  const report = {
    meta: {
      ...HOLDOUT_V3_META,
      generatedAt: new Date().toISOString(),
      amendmentCount: AMENDMENTS.length,
      denominatorsCheck: {
        note: '每个 family 显式列出 scenarios / rankingDenominator / excluded——与 Activation-02 ambient 组“10 场景 vs 9 分母”不同，这里不允许隐性排除。'
      }
    },
    byFamily,
    recentDeliveryRepeatTop1,
    structural,
    perCase,
    activation02CrossCheck: {
      finding: 'Activation-02 README §5.2 标注 ambient 组 10 场景，但 top1Accuracy=0.5556=5/9 的分母是 9：Q6-retracted-ambient-unreachable 的 metrics=null（撤回目标不在候选池，负可用性场景）被隐性排除，README 未显式说明。本报告的 byFamily[*].excluded 显式列名同类排除。'
    }
  };

  const outPath = path.join(OUT_DIR, 'eval-v3.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.error(`评价 → ${outPath}`);

  // ===== 控制台摘要 =====
  for (const [family, agg] of Object.entries(byFamily)) {
    console.error(`\n== ${family}（场景 ${agg.scenarios}，排序分母 ${agg.rankingDenominator}）==`);
    for (const strategy of STRATEGIES) {
      const s = agg.byStrategy[strategy];
      console.error(`  ${strategy}: top1=${s.top1Accuracy} MRR=${s.mrr} nDCG@5=${s.ndcg5} 入侵=${s.top3IntrusionTotal} forbidden=${s.forbiddenRecallTotal} p50=${s.timingMs.p50}ms`);
    }
    console.error(`  降级=${agg.g1g2Downgrades} gateMoves=${agg.gateMovesTotal}`);
  }
  console.error(`\n结构组: ${Object.entries(structural).map(([k, v]) => `${k}=${v.passed}`).join(' ')}`);

  return report;
}

main().catch((error) => { console.error(error); process.exit(1); });
