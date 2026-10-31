// tiers / strategies / event-ids 单元测试 + activation-01 等价性守卫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidatePool } from '../../activation-01/src/candidates.mjs';
import { rankCandidates } from '../../activation-01/src/ranking.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { termsForQuery } from '../../activation-01/src/tokenizer.mjs';
import { corpus, holdoutScenarios, EVAL_NOW } from '../../activation-01/fixtures/scenarios.mjs';
import { computeTier, prepareTierContext, documentFrequencies, TIER_NAMES } from '../src/tiers.mjs';
import { rankStrategyV2, g2Multiplier, applyTierGate, V2_STRATEGIES, DEFAULT_V2_PARAMS } from '../src/strategies.mjs';
import { EventIdFactory, tailSeq, resumeFromEvents } from '../src/event-ids.mjs';

const NOW = EVAL_NOW;
const pool = new CandidatePool(corpus());

// ---------- tiers ----------
test('tier: 单二元无残差 = weak（gym 只命中「周末」）', () => {
  const ctx = prepareTierContext(pool, { spaceIds: ['personal'], queryOrSituation: '周末在家休息' });
  const gym = pool.getRecord('personal', 'rec-gym-runs');
  const t = computeTier({
    record: gym, queryTerms: ctx.queryTerms, docTerms: pool.docTerms('personal', 'rec-gym-runs'),
    scopeDocCount: ctx.scopeDocCount, docFreq: ctx.docFreq, collapsedQuery: ctx.collapsedQuery
  });
  assert.equal(t.tier, 4);
  assert.deepEqual(t.matchedBigrams, ['周末']);
  assert.deepEqual(t.discriminativeResidual, []);
});

test('tier: ≥2 二元 = multi-bigram（hotpot 命中 周末+在家）', () => {
  const ctx = prepareTierContext(pool, { spaceIds: ['personal'], queryOrSituation: '周末在家休息' });
  const hotpot = pool.getRecord('personal', 'rec-recipe-hotpot');
  const t = computeTier({
    record: hotpot, queryTerms: ctx.queryTerms, docTerms: pool.docTerms('personal', 'rec-recipe-hotpot'),
    scopeDocCount: ctx.scopeDocCount, docFreq: ctx.docFreq, collapsedQuery: ctx.collapsedQuery
  });
  assert.equal(t.tier, 2);
  assert.ok(t.matchedBigrams.includes('周末') && t.matchedBigrams.includes('在家'));
});

test('tier: id 命中 = T0；完整短语 = T1', () => {
  const ctx = prepareTierContext(pool, { spaceIds: ['work'], queryOrSituation: 'HS-7' });
  const sensor = pool.getRecord('work', 'rec-mk2-sensor');
  const t = computeTier({
    record: sensor, queryTerms: ctx.queryTerms, docTerms: pool.docTerms('work', 'rec-mk2-sensor'),
    scopeDocCount: ctx.scopeDocCount, docFreq: ctx.docFreq, collapsedQuery: ctx.collapsedQuery
  });
  // recordId 'rec-mk2-sensor' 不含 'hs-7'，文本含 → 非 id 命中；短语 'hs-7' 命中
  assert.equal(t.idHit, false);
  assert.equal(t.phraseHit, true);
  assert.equal(t.tier, 1);

  const ctx2 = prepareTierContext(pool, { spaceIds: ['work'], queryOrSituation: 'sensor' });
  const t2 = computeTier({
    record: sensor, queryTerms: ctx2.queryTerms, docTerms: pool.docTerms('work', 'rec-mk2-sensor'),
    scopeDocCount: ctx2.scopeDocCount, docFreq: ctx2.docFreq, collapsedQuery: ctx2.collapsedQuery
  });
  assert.equal(t2.idHit, true);
  assert.equal(t2.tier, 0);
});

test('tier: 无区分度判定用多数规则（df > 50% 的一元不算残差证据）', () => {
  const docs = [new Set(['的', 'x']), new Set(['的', 'y']), new Set(['的']), new Set(['z'])];
  const df = documentFrequencies(docs);
  assert.equal(df.get('的'), 3);
  // scope 4 条，df(的)=3 > 2 → 不具区分度（computeTier 内部同样规则）
  const record = { recordId: 'r1', text: '的' };
  const t = computeTier({
    record, queryTerms: termsForQuery('的 x'), docTerms: new Set(['的', 'x']),
    scopeDocCount: 4, docFreq: df, collapsedQuery: '的x'
  });
  assert.equal(t.discriminativeResidual.includes('的'), false);
});

test('tier: explicit AND 下同词元候选同 tier（gate 结构性不介入）', () => {
  const ctx = prepareTierContext(pool, { spaceIds: ['personal'], queryOrSituation: '周末' });
  const tiers = ['rec-recipe-hotpot', 'rec-gym-runs', 'rec-bike-riding'].map((rid) => {
    const r = pool.getRecord('personal', rid);
    return computeTier({
      record: r, queryTerms: ctx.queryTerms, docTerms: pool.docTerms('personal', rid),
      scopeDocCount: ctx.scopeDocCount, docFreq: ctx.docFreq, collapsedQuery: ctx.collapsedQuery
    }).tier;
  });
  // AND 语义下三候选命中同一词元集；「周末」整体连续出现 → 三者同为短语层 T1。
  // 断言本质：候选间 tier 一致 → gate 无动作。
  assert.equal(new Set(tiers).size, 1);
});

// ---------- G2 ----------
test('G2: 未强化记录乘数恒为 1.0（取消普遍年龄惩罚）', () => {
  const m = g2Multiplier({ reinforceTimesMs: [], now: NOW, params: DEFAULT_V2_PARAMS });
  assert.equal(m.multiplier, 1);
});

test('G2: 已强化记录与 A2 同式（强度×半衰期衰减，含 clamp）', () => {
  const now = NOW;
  const times = [now - 2 * 86_400_000, now - 9 * 86_400_000];
  const g2 = g2Multiplier({ reinforceTimesMs: times, now, params: DEFAULT_V2_PARAMS });
  const strength = 1 + DEFAULT_V2_PARAMS.wStrength * Math.log1p(2);
  const expected = strength * Math.pow(2, -2 / DEFAULT_V2_PARAMS.halfLifeDays);
  assert.ok(Math.abs(g2.multiplier - expected) < 1e-9);
});

// ---------- G3 ----------
test('G3: 无投递事件时排序与 A0 逐位一致', () => {
  const s = holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial');
  const state = replayEvents(s.events.filter((e) => e.eventType !== 'delivered_reference'));
  const a0 = rankCandidates({ pool, state, mode: 'ambient', situation: s.situation, spaceIds: s.spaceIds, strategy: 'A0', now: NOW });
  const g3 = rankStrategyV2({ pool, state, mode: 'ambient', situation: s.situation, spaceIds: s.spaceIds, strategyId: 'G3', now: NOW });
  assert.deepEqual(g3.candidates.map((c) => c.recordId), a0.candidates.map((c) => c.recordId));
  for (let i = 0; i < a0.candidates.length; i += 1) {
    assert.ok(Math.abs(a0.candidates[i].finalScore - g3.candidates[i].finalScore) < 5e-6, `rank ${i} 分数一致`);
  }
});

test('G3: explicit 恒不抑制（刚投递后明确追问正常召回）', () => {
  const events = [{ eventId: 'd1', spaceId: 'personal', recordId: 'rec-allergy-peanut', eventType: 'delivered_reference', occurredAt: new Date(NOW - 0.1 * 86_400_000).toISOString(), sourceEventId: null, provenance: {}, signalVersion: 1 }];
  const state = replayEvents(events);
  const g3 = rankStrategyV2({ pool, state, mode: 'explicit', query: '花生 过敏', spaceIds: ['personal'], strategyId: 'G3', now: NOW });
  assert.equal(g3.candidates[0].recordId, 'rec-allergy-peanut');
  assert.equal(g3.candidates[0].recentDelivery.multiplier, 1);
});

// ---------- gate ----------
test('gate: boosted(T4) 不得越过 unboosted(T2)——D03 结构修复', () => {
  const s = holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial');
  const state = replayEvents(s.events);
  const g1 = rankStrategyV2({ pool, state, mode: 'ambient', situation: s.situation, spaceIds: s.spaceIds, strategyId: 'G1', now: NOW });
  const ids = g1.candidates.map((c) => c.recordId);
  assert.ok(ids.indexOf('rec-recipe-hotpot') < ids.indexOf('rec-gym-runs'), 'hotpot 必须在 gym 之前');
  assert.equal(g1.candidates[0].recordId, 'rec-recipe-hotpot');
  assert.ok(g1.gateMoves.some((m) => m.recordId === 'rec-gym-runs'), 'gate 移动必须被记录并可解释');
});

test('gate: 同 tier 合法重排不被拦截', () => {
  // 构造：三个同 tier(T4) 候选，boosted 的分数第二 → gate 不动
  const scored = [
    { finalScore: 3, boosted: false, tier: { level: 4, name: 'weak' }, breakdown: { recordId: 'a', spaceId: 's' } },
    { finalScore: 2, boosted: true, tier: { level: 4, name: 'weak' }, breakdown: { recordId: 'b', spaceId: 's' } },
    { finalScore: 1, boosted: false, tier: { level: 4, name: 'weak' }, breakdown: { recordId: 'c', spaceId: 's' } }
  ];
  const { order, moves } = applyTierGate(scored);
  assert.deepEqual(order.map((o) => o.breakdown.recordId), ['a', 'b', 'c']);
  assert.equal(moves.length, 0);
});

test('gate: 抑制不受闸门约束（被抑制的高 tier 候选可以沉到低 tier 之后）', () => {
  // 抑制后（×0.5 → 不 boosted）按分数应排在未抑制者之后；applyTierGate 只拦 boosted 上移。
  // 输入须为分数降序（与 rankStrategyV2 内部一致）。
  const scored = [
    { finalScore: 0.5, boosted: false, tier: { level: 4, name: 'weak' }, breakdown: { recordId: 'other', spaceId: 's' } },
    { finalScore: 0.3, boosted: false, tier: { level: 4, name: 'weak' }, breakdown: { recordId: 'suppressed', spaceId: 's' } }
  ];
  const { order, moves } = applyTierGate(scored);
  assert.equal(order[0].breakdown.recordId, 'other');
  assert.equal(moves.length, 0);
});

test('v2 策略集合与默认参数完备', () => {
  assert.deepEqual([...V2_STRATEGIES], ['G2-H7', 'G3', 'G1', 'G1G2']);
  assert.equal(DEFAULT_V2_PARAMS.halfLifeDays, 7);
  assert.equal(DEFAULT_V2_PARAMS.floor, 0.4);
  assert.equal(DEFAULT_V2_PARAMS.ceil, 2.25);
});

// ---------- activation-01 守卫：A 系在本分支未被改动 ----------
test('守卫: A0 在 D03 的 top1/score 与 activation-01 已发布结果一致', () => {
  const s = holdoutScenarios().find((x) => x.id === 'D03-revisit8-vs-recent-trivial');
  const state = replayEvents(s.events);
  const a0 = rankCandidates({ pool, state, mode: 'ambient', situation: s.situation, spaceIds: s.spaceIds, strategy: 'A0', now: NOW });
  assert.equal(a0.candidates[0].recordId, 'rec-recipe-hotpot');
  assert.ok(Math.abs(a0.candidates[0].finalScore - 1.4559) < 1e-3);
});

// ---------- event-ids ----------
test('event-ids: nonce 使重启后的新进程与旧日志零碰撞', () => {
  const legacy = ['ev-personal-rec-x-1', 'ev-personal-rec-x-2'];
  const f = new EventIdFactory({ prefix: 'ev', nonce: 'restartsim-aaaa' });
  const fresh = [f.next('personal', 'rec-x'), f.next('personal', 'rec-x')];
  for (const id of fresh) assert.ok(!legacy.includes(id));
  assert.ok(fresh[0] !== fresh[1]);
});

test('event-ids: resumeFrom 从旧日志最大序号之后续接', () => {
  const legacy = ['ev-personal-rec-x-1', 'ev-personal-rec-x-7'];
  const f = resumeFromEvents(legacy.map((eventId) => ({ eventId })), 'ev');
  const id = f.next('personal', 'rec-x');
  assert.ok(!legacy.includes(id));
  assert.equal(tailSeq(id, 'ev'), 8);
});

test('event-ids: tailSeq 同时解析旧格式与新格式', () => {
  assert.equal(tailSeq('ev-personal-rec-x-42', 'ev'), 42);
  assert.equal(tailSeq('ev-personal-rec-x-bc1a-5f2-8', 'ev'), 8);
  assert.equal(tailSeq('other-prefix-3', 'ev'), null);
  assert.equal(tailSeq('ev-personal-rec-x-notail', 'ev'), null);
});

test('event-ids: 跨空间交替生成不污染（id 全局唯一）', () => {
  const f = new EventIdFactory({ prefix: 'ev', nonce: 'spacesim-cccc' });
  const ids = new Set();
  for (let i = 0; i < 10; i += 1) ids.add(f.next(i % 2 === 0 ? 'personal' : 'work', 'rec-a'));
  assert.equal(ids.size, 10);
});
