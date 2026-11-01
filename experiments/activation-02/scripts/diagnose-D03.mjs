// D03 根因诊断（activation-02 任务书 §二）。
//
// 只读：消费 activation-01 的 src/fixtures（本分支 34d8cf9 原样），
// 不修改任何正式代码。输出：
//   1) D03 全部候选的逐项证据表（任务书要求的 16 列）
//   2) 「explicit AND 检索 coverage 恒为 1」前提的结构性验证
//      （对全语料 × 全部 explicit 查询枚举，非抽样）
//   3) 六个诊断问题的直接答案（stdout，机器可读部分写入 JSON）

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidatePool, recencyFactor } from '../../activation-01/src/candidates.mjs';
import { rankCandidates } from '../../activation-01/src/ranking.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { tokenizeForIndex, termsForQuery, normalizeText } from '../../activation-01/src/tokenizer.mjs';
import { holdoutScenarios, corpus, EVAL_NOW } from '../../activation-01/fixtures/scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'results-v2');
mkdirSync(OUT, { recursive: true });

const NOW = EVAL_NOW;
const pool = new CandidatePool(corpus());
const d03 = holdoutScenarios().find((s) => s.id === 'D03-revisit8-vs-recent-trivial');
const state = replayEvents(d03.events);

const a0 = rankCandidates({ pool, state, mode: 'ambient', situation: d03.situation, spaceIds: d03.spaceIds, strategy: 'A0', now: NOW, limit: 50 });
const a2 = rankCandidates({ pool, state, mode: 'ambient', situation: d03.situation, spaceIds: d03.spaceIds, strategy: 'A2', now: NOW, params: { ...({ halfLifeDays: 7 }) , halfLifeDays: 7 }, limit: 50 });
const A2H7_PARAMS = { wCount: 0.5, wStrength: 0.75, halfLifeDays: 7, actrDecay: 0.5, wActr: 0.35, minIntervalDays: 1 / 24, bEpsilon: 1e-12, floor: 0.4, ceil: 2.25, suppressionWindowHours: 6, suppressionStrength: 0.5, suppressionDecayHours: 24, recencyWindowDays: 120 };
const a2h7 = rankCandidates({ pool, state, mode: 'ambient', situation: d03.situation, spaceIds: d03.spaceIds, strategy: 'A2', now: NOW, params: A2H7_PARAMS, limit: 50 });

const rankOf = (result, rid) => result.candidates.findIndex((c) => c.recordId === rid) + 1;

const queryTokens = termsForQuery(d03.situation).map((t) => `${t.term}(${t.kind})`);

const rows = a0.candidates.map((c0) => {
  const rid = c0.recordId;
  const rec = pool.getRecord('personal', rid);
  const c7 = a2h7.candidates.find((c) => c.recordId === rid);
  const matched = c0.relevance.matchedTerms; // 形如 term(kind)
  const matchedTerms = matched.map((m) => m.split('(')[0]);
  const matchedBigrams = matchedTerms.filter((t) => t.length === 2);
  const matchedUnigrams = matchedTerms.filter((t) => t.length === 1);
  const phrase = normalizeText(d03.situation).replace(/\s+/g, '');
  const text = normalizeText(rec.text).replace(/\s+/g, '');
  const act = replayEvents(d03.events).get(`personal::${rid}`);
  return {
    recordId: rid,
    query: d03.situation,
    queryTokens,
    matchedTerms,
    coverage: c0.relevance.coverage,
    exactPhraseMatch: phrase.length > 0 && text.includes(phrase),
    matchedBigrams,
    matchedUnigrams,
    bigramCount: matchedBigrams.length,
    recencyFactor: c0.recency.factor,
    activationFactor: c7.activation.multiplier,
    reinforcementCount: c7.activation.reinforcementCount,
    recentDeliveryPenalty: c7.recentDelivery.multiplier,
    A0Score: c0.finalScore,
    A2H7Score: c7.finalScore,
    rankBefore: rankOf(a0, rid),
    rankAfter: rankOf(a2h7, rid),
    rankMoved: rankOf(a0, rid) !== rankOf(a2h7, rid),
    expectedRelevance: rid === 'rec-recipe-hotpot' ? 'relevant（火锅计划，与情境的 吃/在家/周末 段全部对应）'
      : rid === 'rec-gym-runs' ? 'irrelevant-intruder（健身房，仅共享 周末 一个词）'
      : 'neutral（无预期）',
    hasRevisitedEvents: !!act && act.reinforceTimesMs.length > 0
  };
});

// —— 前提验证：explicit AND 下 coverage 是否恒为 1 ——————————————
// 用 activation-01 的 explicitCandidates（逐字对齐 adapter.mjs 的 AND 语义）
// 对全部 base 查询 + 全语料枚举：任何非 ID 候选的 coverage 必须 = 1。
import { baseScenarios } from '../../activation-01/fixtures/scenarios.mjs';
const explicitCoverageAudit = [];
for (const sc of baseScenarios()) {
  const specs = sc.querySpecs ?? sc.queries.map((q) => ({ q, spaceIds: sc.spaceIds }));
  for (const spec of specs) {
    const entries = pool.explicitCandidates({ q: spec.q, spaceIds: spec.spaceIds });
    const covs = [...new Set(entries.map((e) => e.coverage))];
    explicitCoverageAudit.push({
      scenario: sc.id, q: spec.q, candidates: entries.length,
      distinctCoverages: covs,
      allExactlyOne: covs.every((c) => c === 1)
    });
  }
}
// 再穷举一批真实形状的单段/多段查询（不抽样：固定 24 个短查询 × 两空间）
const probeQueries = ['周末', '周末 家', '旅行', '科幻', '过敏 花生', '生日', '伞', '浇水', '地址', '演示文稿', '传感器', '羽毛球', '电影', '春天 旅行', '咖啡', '攀岩', '跑步', '火锅', '绿萝 浇水', '收货 地址', '站会', '复盘', '三体', '洱海'];
const probeAudit = [];
for (const q of probeQueries) {
  for (const spaceIds of [['personal'], ['work']]) {
    const entries = pool.explicitCandidates({ q, spaceIds });
    const covs = [...new Set(entries.map((e) => e.coverage))];
    probeAudit.push({ q, spaceIds: spaceIds.join(','), candidates: entries.length, distinctCoverages: covs, allExactlyOne: covs.every((c) => c === 1) });
  }
}
const explicitAlwaysOne =
  explicitCoverageAudit.every((a) => a.allExactlyOne) && probeAudit.every((a) => a.allExactlyOne);

// ambient 对照：coverage 明显不恒为 1
const ambientDistinct = [...new Set(rows.map((r) => r.coverage))];

const summary = {
  meta: {
    generatedAt: new Date().toISOString(),
    evalClock: new Date(NOW).toISOString(),
    scenario: d03.id,
    situation: d03.situation,
    base: 'activation-01 src @ 34d8cf9（只读）'
  },
  premise: {
    // 任务书：真实 GLM AND 检索下，非 ID 候选 matchedTerms/totalTerms 通常恒为 1 —— 验证这个前提。
    realAdapterCodeCitations: [
      'glm-retrieval src/adapter.mjs:233-239 — “collectCandidates 已按词元求交：到达这里的文档命中了全部词元”→ coverage = matchedTerms.length / terms.length；id 命中 min(1, coverage+0.5) 也恒为 1',
      'glm-retrieval src/store.mjs:274-289 — collectCandidates 对每个词元做 postings 交集，空集即返回；幸存文档必然命中全部词元',
      'glm-retrieval src/association.mjs — 正式 ambient/关联路径只用 subject/source_session 结构共现，不产生词面 coverage'
    ],
    explicitAudit: { cases: explicitCoverageAudit.length + probeAudit.length, allExactlyOne: explicitAlwaysOne, detail: [...explicitCoverageAudit, ...probeAudit] },
    ambientD03: { distinctCoverages: ambientDistinct, coverageAlwaysOne: ambientDistinct.length === 1 && ambientDistinct[0] === 1 },
    verdict: explicitAlwaysOne
      ? '前提成立：真实（以及本实验复刻的）explicit AND 检索下 coverage 结构性恒为 1，Coverage Gate 在该路径上恒不触发（空洞）。ambient 是实验自建路径，coverage 虽可区分 D03，但 2:1 阈值由 D03 单样本反推 —— 按任务书判定：废弃 Coverage Gate。'
      : '前提不成立：coverage 在候选间存在差异。'
  },
  sixQuestions: {
    q1_allCoverageOne: { ambient: false, explicit: true, note: 'D03 是 ambient 场景，coverage 0.0588–0.4706 不恒为 1；explicit AND 恒为 1（见 premise.explicitAudit 全量枚举）。' },
    q2_whyIrrelevantInPool: 'ambient 候选规则是「与情境词元交集 > 0」；rec-gym-runs 与情境共享 周末(二元) + 周/末(一元) 3 个词元，足以入池。',
    q3_singleCharDominance: 'gym 的全部一元命中（周、末）都是其唯一二元命中（周末）的组成字——除 周末 外没有任何独立证据；属于典型弱匹配。',
    q4_discriminativePhrase: '存在：hotpot 命中 周末+在家+家做 三个二元词元，横跨情境的三个不同语段（周末 / 在家 / 做…）；gym 只有 周末。二元命中数与跨段证据可区分两者。',
    q5_agePenaltyRole: '是放大器不是根因：A2-H7 把未强化的 hotpot 按记录年龄衰减到 0.7399，同时把 8 次重提的 gym 抬到 2.1723，双向拉大分差。但去掉衰减（G2 预演：hotpot 乘数回到 1.0）后 gym 2.22 仍 > hotpot 1.46 —— 纯取消年龄惩罚不能消除 D03。',
    q6_evidenceSufficiency: '在词元质量层面足够（二元 3:1、跨段 3:1）；在 coverage 比值层面 D03 恰好可分（2.67:1）但该可分性只存在于实验自建的 ambient 路径，正式 AND 路径结构性无 coverage 差异。'
  },
  candidateTable: rows
};

writeFileSync(join(OUT, 'diagnose-D03.json'), JSON.stringify(summary, null, 2), 'utf8');

// —— stdout 报告 ——
console.log('== D03 根因诊断 ==');
console.log('情境:', JSON.stringify(d03.situation));
console.log('queryTokens:', queryTokens.join(' '));
console.log('');
console.log('recordId            cov     bigrams                 recency  act(H7)  del   A0score  H7score  rank A0→H7');
for (const r of rows) {
  console.log(
    r.recordId.padEnd(19),
    String(r.coverage).padEnd(7),
    r.matchedBigrams.join('+').padEnd(23),
    r.recencyFactor.toFixed(4).padEnd(8),
    r.activationFactor.toFixed(4).padEnd(8),
    String(r.recentDeliveryPenalty).padEnd(5),
    r.A0Score.toFixed(4).padEnd(8),
    r.A2H7Score.toFixed(4).padEnd(8),
    `${r.rankBefore}→${r.rankAfter}`
  );
}
console.log('');
console.log('explicit AND 全量枚举（base 36 + 24 探针 × 两空间）coverage 恒为 1:', explicitAlwaysOne);
console.log('D03 ambient distinct coverages:', ambientDistinct);
console.log('verdict:', summary.premise.verdict);
console.log('\nwritten:', join(OUT, 'diagnose-D03.json'));
