// 统一归因评价（activation-04）—— 同一候选集/时钟/事件历史下比较 A0/L/R/LR/D。
//
// 分母纪律（沿用 activation-03，禁止隐性排除）：
//   - 排序指标分母 = candidateCount>0 且存在 grade>=2 的场景；排除显式列名。
//   - explicit / ambient 分组报告；单候选场景单独统计（无重排空间）。
//   - 4 个上轮改善案例（E01/E02/E06/E13）逐项归因：每个策略是否修复。
//   - 证据普查：coverage（结构性恒 1）≠ phraseHit ≠ idHit ≠ bigram 计数 —— 分开统计。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAttribution, writeAttributionRecords } from '../src/attribution-runner.mjs';
import { holdoutV4Scenarios, HOLDOUT_V4_META, AMENDMENTS_V4 } from '../fixtures/holdout-v4.mjs';
import { holdoutV3Scenarios } from '../../activation-03/fixtures/holdout-v3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'results-v4');

const STRATEGIES = ['A0', 'L', 'R', 'LR', 'D'];
const PRIOR_FIXED = ['E01-xiaolin-person-events', 'E02-token-quality-gate', 'E06-explicit-reask', 'E13-idhit-gate'];

function dcg(gains) {
  return gains.reduce((acc, g, i) => acc + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
}

function metricsFor({ ranking, relevance, forbidden }) {
  const grades = ranking.map((id) => relevance[id] ?? 0);
  const relevant = ranking.map((id, i) => ({ id, i, grade: relevance[id] ?? 0 })).filter((x) => x.grade >= 2);
  const firstRel = relevant.length > 0 ? relevant[0] : null;
  const mrr = firstRel ? 1 / (firstRel.i + 1) : 0;
  const gains5 = grades.slice(0, 5);
  const ideal = Object.values(relevance).filter((g) => g >= 1).sort((a, b) => b - a).slice(0, 5);
  const idcg = dcg(ideal.length > 0 ? ideal : [0]);
  const top1Grade = grades[0] ?? null;
  const primaryIds = Object.entries(relevance).filter(([, g]) => g === 3).map(([id]) => id);
  return {
    top1Correct: top1Grade === 3,
    top1Grade,
    top1Id: ranking[0] ?? null,
    mrr: Number(mrr.toFixed(4)),
    ndcg5: Number((dcg(gains5) / idcg).toFixed(4)),
    top3Intrusion: grades.slice(0, 3).filter((g) => g === 0).length,
    forbiddenHits: ranking.filter((id) => (forbidden ?? []).includes(id)),
    primaryReachable: ranking.slice(0, 5).some((id) => primaryIds.includes(id)),
    order: ranking
  };
}

function resolveRelevance(record, relevance) {
  return Object.fromEntries(Object.entries(relevance).map(([id, grade]) => [
    id.startsWith('key:') ? record.idMap[id.slice(4)] ?? id : id, grade
  ]));
}
function resolveIds(record, list) {
  return (list ?? []).map((id) => (id.startsWith('key:') ? record.idMap[id.slice(4)] ?? id : id));
}

function summarize(cases) {
  const out = {};
  for (const strategy of STRATEGIES) {
    const ms = cases.map((c) => c.perStrategy[strategy]);
    out[strategy] = {
      top1Accuracy: ms.length ? Number((ms.filter((m) => m.top1Correct).length / ms.length).toFixed(4)) : null,
      mrr: ms.length ? Number((ms.reduce((a, m) => a + m.mrr, 0) / ms.length).toFixed(4)) : null,
      ndcg5: ms.length ? Number((ms.reduce((a, m) => a + m.ndcg5, 0) / ms.length).toFixed(4)) : null,
      top3IntrusionTotal: ms.reduce((a, m) => a + m.top3Intrusion, 0),
      forbiddenRecallTotal: ms.reduce((a, m) => a + m.forbiddenHits.length, 0),
      primaryReachableCount: ms.filter((m) => m.primaryReachable).length
    };
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const v3 = holdoutV3Scenarios();
  const v4 = holdoutV4Scenarios();
  console.error(`场景：v3 ${v3.length} + v4 ${v4.length} = ${v3.length + v4.length}（5 策略）`);

  // ===== 影子运行 =====
  const records = await runAttribution({ scenarios: [...v3, ...v4] });
  writeAttributionRecords(records, path.join(OUT_DIR, 'attribution-traces.jsonl'));

  // ===== 逐案指标 =====
  const scenarioById = new Map([...v3, ...v4].map((s) => [s.id, s]));
  const perCase = [];
  for (const rec of records) {
    const scenario = scenarioById.get(rec.queryId);
    const relevance = resolveRelevance(rec, scenario.relevance ?? {});
    const forbidden = resolveIds(rec, scenario.forbidden ?? []);
    const hasRanking = rec.candidateCount > 0 && Object.values(relevance).some((g) => g >= 2);
    const caseEntry = {
      id: rec.queryId, corpus: rec.corpus, family: rec.family, mode: rec.mode, path: rec.pathLabel,
      candidateCount: rec.candidateCount, singleCandidate: rec.singleCandidate, hasRanking,
      excludedReason: hasRanking ? null : (rec.candidateCount === 0 ? 'zero-candidates' : 'no-grade2-relevant'),
      perStrategy: {}, top1GradeByStrategy: {}, fixedByStrategy: {}
    };
    if (hasRanking) {
      for (const strategy of STRATEGIES) {
        const m = metricsFor({ ranking: rec.strategyRankings[strategy], relevance, forbidden });
        caseEntry.perStrategy[strategy] = m;
        caseEntry.top1GradeByStrategy[strategy] = m.top1Grade;
        caseEntry.fixedByStrategy[strategy] = m.top1Correct;
      }
    } else {
      for (const strategy of STRATEGIES) caseEntry.perStrategy[strategy] = { skipped: true };
    }
    perCase.push(caseEntry);
  }

  // ===== 分组汇总（v3 explicit / v4 explicit / ambient v3 / ambient v4 / fallback v3）=====
  const groups = {
    'explicit-v3': perCase.filter((c) => c.family === 'explicit' && c.corpus === 'v3'),
    'explicit-v4': perCase.filter((c) => c.family === 'explicit' && c.corpus === 'v4'),
    'explicit-combined': perCase.filter((c) => c.family === 'explicit'),
    'ambient-v3': perCase.filter((c) => c.family === 'ambient' && c.corpus === 'v3'),
    'ambient-v4': perCase.filter((c) => c.family === 'ambient' && c.corpus === 'v4'),
    'fallback-v3': perCase.filter((c) => c.family === 'fallback')
  };
  const byGroup = {};
  for (const [name, cases] of Object.entries(groups)) {
    const ranking = cases.filter((c) => c.hasRanking);
    const multi = ranking.filter((c) => !c.singleCandidate);
    byGroup[name] = {
      scenarios: cases.length,
      rankingDenominator: ranking.length,
      multiCandidateDenominator: multi.length,
      singleCandidateScenarios: ranking.filter((c) => c.singleCandidate).map((c) => c.id),
      excluded: cases.filter((c) => !c.hasRanking).map((c) => ({ id: c.id, reason: c.excludedReason })),
      all: summarize(ranking),
      multiCandidateOnly: summarize(multi)
    };
  }

  // ===== 上轮 4 个改善案例逐项归因 =====
  const priorFixedAttribution = PRIOR_FIXED.map((id) => {
    const c = perCase.find((x) => x.id === id);
    return {
      id,
      candidateCount: c.candidateCount,
      a0Top1: { id: c.perStrategy.A0.top1Id, grade: c.perStrategy.A0.top1Grade },
      byStrategy: Object.fromEntries(STRATEGIES.map((s) => [
        s, { top1: c.perStrategy[s].top1Id, grade: c.perStrategy[s].top1Grade, fixed: c.fixedByStrategy[s] }
      ])),
      fixedBy: STRATEGIES.filter((s) => s !== 'A0' && c.fixedByStrategy[s]),
      tierHomogeneous: homogeneousTier(rec4(id)),
      lrRefused: rec4(id).strategyRefused.LR ?? null
    };
  });
  function rec4(id) { return records.find((r) => r.queryId === id); }
  function homogeneousTier(rec) {
    const tiers = [...new Set(rec.candidatesExplain.map((e) => e.evidence.tier))];
    return { homogeneous: tiers.length <= 1, tiers };
  }

  // ===== 全集归因矩阵：每个策略修复了哪些 / 独特修复 / 回归 =====
  const rankingCases = perCase.filter((c) => c.hasRanking);
  const attributionMatrix = {
    fixedBy: {},
    uniqueFixedBy: {},
    regressionsVsA0: {},
    lrVsL: {}
  };
  for (const strategy of STRATEGIES) {
    attributionMatrix.fixedBy[strategy] = rankingCases.filter((c) => c.fixedByStrategy[strategy]).map((c) => c.id);
  }
  for (const strategy of ['L', 'R', 'LR', 'D']) {
    attributionMatrix.uniqueFixedBy[strategy] = rankingCases
      .filter((c) => c.fixedByStrategy[strategy] && STRATEGIES.filter((s) => s !== strategy && s !== 'A0').every((s) => !c.fixedByStrategy[s]))
      .map((c) => c.id);
  }
  // 回归：某策略 top1 grade 严格低于 A0 top1 grade（把 A0 的正确修坏），或 forbidden 新增。
  for (const strategy of ['L', 'R', 'LR', 'D']) {
    attributionMatrix.regressionsVsA0[strategy] = rankingCases
      .filter((c) => c.perStrategy[strategy].top1Grade < c.perStrategy.A0.top1Grade
        || c.perStrategy[strategy].forbiddenHits.length > c.perStrategy.A0.forbiddenHits.length)
      .map((c) => ({ id: c.id, a0Grade: c.perStrategy.A0.top1Grade, strategyGrade: c.perStrategy[strategy].top1Grade }));
  }
  // LR 相对 L 的独有修复 / L 相对 LR 的独有修复 / LR 引入而 L 没有的错误
  attributionMatrix.lrVsL = {
    lrFixesThatLMisses: rankingCases.filter((c) => c.fixedByStrategy.LR && !c.fixedByStrategy.L).map((c) => c.id),
    lFixesThatLRMisses: rankingCases.filter((c) => c.fixedByStrategy.L && !c.fixedByStrategy.LR).map((c) => c.id),
    lrErrorsLLacks: rankingCases.filter((c) => c.perStrategy.LR.top1Grade < c.perStrategy.L.top1Grade
      || c.perStrategy.LR.forbiddenHits.length > c.perStrategy.L.forbiddenHits.length)
      .map((c) => ({ id: c.id, lGrade: c.perStrategy.L.top1Grade, lrGrade: c.perStrategy.LR.top1Grade })),
    rErrorsLLacks: rankingCases.filter((c) => c.perStrategy.R.top1Grade < c.perStrategy.L.top1Grade)
      .map((c) => ({ id: c.id, lGrade: c.perStrategy.L.top1Grade, rGrade: c.perStrategy.R.top1Grade }))
  };

  // ===== 证据普查：coverage 恒 1 ≠ phrase/idHit/bigram 恒定 =====
  const explicitRecords = records.filter((r) => r.mode === 'explicit' && r.pathLabel === 'explicit-index' && r.candidateCount > 1);
  const census = {
    explicitMultiCandidateScenarios: explicitRecords.length,
    candidates: explicitRecords.reduce((a, r) => a + r.candidateCount, 0),
    coverageDistribution: {},
    phraseHitVariation: 0,
    idHitCount: 0,
    tierVariationScenarios: 0,
    tierHomogeneousScenarios: 0,
    perScenario: explicitRecords.map((r) => {
      const cov = [...new Set(r.candidatesExplain.map((e) => String(e.evidence.coverage)))];
      const phrase = r.candidatesExplain.map((e) => e.evidence.phraseHit);
      const tiers = [...new Set(r.candidatesExplain.map((e) => e.evidence.tier))];
      return {
        id: r.queryId,
        candidateCount: r.candidateCount,
        coverageValues: cov,
        phraseHitTrue: phrase.filter(Boolean).length,
        idHitTrue: r.candidatesExplain.filter((e) => e.evidence.idHit).length,
        tiers,
        tierVaried: tiers.length > 1
      };
    })
  };
  for (const r of explicitRecords) {
    for (const e of r.candidatesExplain) {
      const k = String(e.evidence.coverage);
      census.coverageDistribution[k] = (census.coverageDistribution[k] ?? 0) + 1;
      if (e.evidence.phraseHit) census.phraseHitVariation += 0; // per-scenario below
    }
    if (new Set(r.candidatesExplain.map((e) => e.evidence.phraseHit)).size > 1) census.phraseHitVariation += 1;
    census.idHitCount += r.candidatesExplain.filter((e) => e.evidence.idHit).length;
    const tiers = new Set(r.candidatesExplain.map((e) => e.evidence.tier));
    if (tiers.size > 1) census.tierVariationScenarios += 1; else census.tierHomogeneousScenarios += 1;
  }

  // ===== D（RecentDelivery）专项 =====
  const dScenarios = records.filter((r) => ['B02-recent-delivery', 'B03-suppression-decay-zone', 'C05-browse-suppression', 'V08-ambient-delivery-zhao'].includes(r.queryId));
  const recentDelivery = dScenarios.map((r) => ({
    id: r.queryId, mode: r.mode, path: r.pathLabel,
    top1ByStrategy: Object.fromEntries(STRATEGIES.map((s) => [s, r.strategyRankings[s][0] ?? null])),
    suppressed: r.recentDeliveryPenalty.suppressedRecords
  }));

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      clock: '2026-11-01T12:00:00.000Z',
      strategies: STRATEGIES,
      strategyDefinitions: {
        A0: '正式原始排序（coordinator 原样，恒等映射）',
        L: '仅词面质量：tier 升序稳定排序（id-hit < phrase < multi-bigram < bigram+residual < weak），不消费事件',
        R: '仅动态激活：原生 a0Score × g2Multiplier（activation-02 G2 数学），无词面闸门；路径 C 无 base 分数 → 拒用',
        LR: 'activation-03 G1G2 原样：base × G2 乘数 + tier 闸门（gate 只约束 boosted 上移）',
        D: '原始排序 + RecentDelivery 抑制（= activation-03 G3 语义原样：ambient 抑制 / explicit 恒绕过 / 路径 C 稳定后移）'
      },
      holdoutV4: HOLDOUT_V4_META,
      amendmentsV4: AMENDMENTS_V4,
      denominatorsCheck: 'byGroup[*].scenarios / rankingDenominator / excluded 显式列名；单候选场景单独统计。'
    },
    byGroup,
    priorFixedAttribution,
    attributionMatrix,
    evidenceCensus: census,
    recentDelivery,
    perCase
  };

  fs.writeFileSync(path.join(OUT_DIR, 'attribution.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'evidence-census.json'), JSON.stringify(census, null, 2), 'utf8');

  // ===== 控制台摘要 =====
  for (const [name, agg] of Object.entries(byGroup)) {
    console.error(`\n== ${name}（场景 ${agg.scenarios}，分母 ${agg.rankingDenominator}，多候选 ${agg.multiCandidateDenominator}）==`);
    for (const strategy of STRATEGIES) {
      const s = agg.all[strategy];
      console.error(`  ${strategy}: top1=${s.top1Accuracy} MRR=${s.mrr} nDCG@5=${s.ndcg5} 入侵=${s.top3IntrusionTotal} forbidden=${s.forbiddenRecallTotal}`);
    }
  }
  console.error('\n上轮 4 案例逐项归因：');
  for (const f of priorFixedAttribution) {
    console.error(`  ${f.id}: fixedBy=[${f.fixedBy.join(',')}] tier homogeneous=${f.tierHomogeneous.homogeneous} (${f.tierHomogeneous.tiers})`);
  }
  console.error('\n归因矩阵：');
  console.error(`  L 独特修复: ${JSON.stringify(attributionMatrix.uniqueFixedBy.L)}`);
  console.error(`  R 独特修复: ${JSON.stringify(attributionMatrix.uniqueFixedBy.R)}`);
  console.error(`  LR 独特修复: ${JSON.stringify(attributionMatrix.uniqueFixedBy.LR)}`);
  console.error(`  LR 修而 L 未修: ${JSON.stringify(attributionMatrix.lrVsL.lrFixesThatLMisses)}`);
  console.error(`  L 修而 LR 未修: ${JSON.stringify(attributionMatrix.lrVsL.lFixesThatLRMisses)}`);
  console.error(`  LR 相对 L 的错误: ${JSON.stringify(attributionMatrix.lrVsL.lrErrorsLLacks)}`);
  for (const strategy of ['L', 'R', 'LR', 'D']) {
    console.error(`  ${strategy} 相对 A0 回归: ${JSON.stringify(attributionMatrix.regressionsVsA0[strategy])}`);
  }

  return report;
}

main().catch((error) => { console.error(error); process.exit(1); });
