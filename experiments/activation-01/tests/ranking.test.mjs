// 排序单元测试：A0 与真实 HEAD 的公式忠实性、策略性质、tie-break、模式语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidatePool, recencyFactor } from '../src/candidates.mjs';
import { rankCandidates, explainRanking } from '../src/ranking.mjs';
import { replayEvents } from '../src/events.mjs';
import { DEFAULT_PARAMS } from '../src/activation.mjs';
import { corpus, EVAL_NOW, eventHistory } from '../fixtures/scenarios.mjs';

const NOW = EVAL_NOW;
const pool = new CandidatePool(corpus());
const DAY = 86_400_000;

test('recencyFactor 与真实 adapter.mjs:79-84 行为一致', () => {
  // 无时间戳 → 0.8 中性
  assert.equal(recencyFactor(null, { now: NOW }), 0.8);
  // 0 天 → 1.0（0.6 + 0.4）
  assert.ok(Math.abs(recencyFactor(new Date(NOW).toISOString(), { now: NOW }) - 1) < 1e-6);
  // 120 天 → 0.6 + 0.4/e
  const d120 = recencyFactor(new Date(NOW - 120 * DAY).toISOString(), { now: NOW });
  assert.ok(Math.abs(d120 - (0.6 + 0.4 / Math.E)) < 1e-9);
  // 未来时间戳不产生负天数（钳到 0 → 1.0）
  assert.ok(Math.abs(recencyFactor(new Date(NOW + 5 * DAY).toISOString(), { now: NOW }) - 1) < 1e-6);
});

test('A0：公式 = (1+coverage) * recency，与真实 HEAD 相同（含 id 命中加成）', () => {
  const r = rankCandidates({ pool, mode: 'explicit', query: '花生 过敏', spaceIds: ['personal'], strategy: 'A0', now: NOW });
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  const recency = recencyFactor(c.recency.recordTime, { now: NOW });
  assert.equal(c.relevance.coverage, 1);
  assert.ok(Math.abs(c.finalScore - 2 * recency) < 1e-6);
  assert.equal(c.activation.multiplier, 1, 'A0 激活恒为 1');
});

test('A0：explicit coverage 恒 1.0（AND 求交后全部命中，与真实实现一致）', () => {
  const r = rankCandidates({ pool, mode: 'explicit', query: '旅行', spaceIds: ['personal'], strategy: 'A0', now: NOW });
  for (const c of r.candidates) assert.equal(c.relevance.coverage, 1);
  assert.equal(r.totalCount, 2);
});

test('A0 tie-break 与真实 adapter.mjs:260 一致：score 降序，recordId 升序', () => {
  // climb-a / climb-b occurredAt 相同、coverage 相同 → 平局 → recordId 升序
  const r = rankCandidates({
    pool, mode: 'ambient', situation: '攀岩馆哪家近', spaceIds: ['personal'],
    strategy: 'A0', now: NOW, state: new Map()
  });
  const order = r.candidates.filter((c) => c.recordId.startsWith('rec-climb')).map((c) => c.recordId);
  assert.deepEqual(order, ['rec-climb-a', 'rec-climb-b']);
});

test('A1：有界强化可翻转旧-但-被重提的记录（任务书示例 C 的机制）', () => {
  const state = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }));
  const r = rankCandidates({
    pool, state, mode: 'ambient', situation: '有没有还没完成的旅行约定',
    spaceIds: ['personal'], strategy: 'A1', now: NOW
  });
  assert.equal(r.candidates[0].recordId, 'rec-commitment-erhai');
  const erhai = r.candidates[0];
  // breakdown 中的乘数按 6 位小数舍入输出
  assert.ok(Math.abs(erhai.activation.multiplier - (1 + 0.5 * Math.log1p(3))) < 1e-6);
});

test('A2：H=7 与 H=30 在同一事件流上给出不同排名（半衰期是实验变量）', () => {
  const state = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [2, 9, 16] }));
  const a = rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A2', now: NOW, params: { ...DEFAULT_PARAMS, halfLifeDays: 7 } });
  const b = rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A2', now: NOW, params: { ...DEFAULT_PARAMS, halfLifeDays: 30 } });
  const gymA = a.candidates.find((c) => c.recordId === 'rec-gym-runs');
  const gymB = b.candidates.find((c) => c.recordId === 'rec-gym-runs');
  assert.ok(gymB.activation.multiplier > gymA.activation.multiplier);
});

test('激活乘数被 clamp 到 [floor, ceil]：1000 次重提也不超过上限', () => {
  const state = replayEvents(Array.from({ length: 1000 }, (_, i) => ({
    eventId: `e${i}`, spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited',
    occurredAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    observedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    sourceEventId: null, provenance: {}, signalVersion: 1
  })));
  for (const strategy of ['A1', 'A2', 'A3']) {
    const r = rankCandidates({ pool, state, mode: 'explicit', query: '科幻', spaceIds: ['personal'], strategy, now: NOW });
    const m = r.candidates[0].activation.multiplier;
    assert.ok(m <= DEFAULT_PARAMS.ceil + 1e-12, `${strategy} 上限`);
    assert.ok(m >= DEFAULT_PARAMS.floor - 1e-12, `${strategy} 下限`);
  }
});

test('零事件状态下 A1/A2/A3 的 explicit 排名与 A0 完全一致（退回基线）', () => {
  for (const q of ['花生', '旅行', '科幻', '生日']) {
    const orders = ['A0', 'A1', 'A2', 'A3'].map((s) => rankCandidates({
      pool, state: new Map(), mode: 'explicit', query: q, spaceIds: ['personal'], strategy: s, now: NOW
    }).candidates.map((c) => c.recordId));
    assert.deepEqual(orders[1], orders[0], `A1@${q}`);
    assert.deepEqual(orders[2], orders[0], `A2@${q}`);
    assert.deepEqual(orders[3], orders[0], `A3@${q}`);
  }
});

test('explicit 模式不做 recentDelivery 抑制；ambient 做', () => {
  const state = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', del: [0.1] }));
  const explicit = rankCandidates({ pool, state, mode: 'explicit', query: '花生 过敏', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  assert.equal(explicit.candidates[0].recentDelivery.multiplier, 1, '用户明确追问不被抑制');
  const ambient = rankCandidates({ pool, state, mode: 'ambient', situation: '和朋友出去下馆子点什么菜', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  const allergy = ambient.candidates.find((c) => c.recordId === 'rec-allergy-peanut');
  assert.equal(allergy.recentDelivery.multiplier, 0.5, 'ambient 抑制生效');
});

test('候选资格与激活解耦：retracted/superseded 永不入候选（任何策略）', () => {
  for (const strategy of ['A0', 'A1', 'A2', 'A3']) {
    const r = rankCandidates({ pool, mode: 'explicit', query: '钓鱼', spaceIds: ['personal'], strategy, now: NOW });
    assert.equal(r.totalCount, 0, `${strategy}`);
    const r2 = rankCandidates({ pool, mode: 'explicit', query: '中山南二路', spaceIds: ['personal'], strategy, now: NOW });
    assert.equal(r2.totalCount, 0, `${strategy} superseded 不可达`);
  }
});

test('explainRanking：回答"为什么 A 排在 B 前面"（含分量差）', () => {
  const state = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }));
  const r = rankCandidates({ pool, state, mode: 'ambient', situation: '有没有还没完成的旅行约定', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  const x = explainRanking({ result: r, recordIdA: 'rec-commitment-erhai', recordIdB: 'rec-umbrella' });
  assert.equal(x.a.recordId, 'rec-commitment-erhai');
  assert.ok(x.aBeforeB);
  assert.match(x.verdict, /排在/);
  assert.equal(typeof x.componentDiff.activationTerm, 'number');
  assert.ok(x.a.breakdown.reasons.length > 0);
});

test('排名确定性：同一输入两次调用结果逐字节一致', () => {
  const state = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [2, 9, 16, 23] }));
  const a = rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A3', now: NOW });
  const b = rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy: 'A3', now: NOW });
  assert.deepEqual(a.candidates, b.candidates);
});

test('now 必须显式注入（可注入时钟），缺失即拒绝', () => {
  assert.throws(() => rankCandidates({ pool, mode: 'explicit', query: '花生', spaceIds: ['personal'], strategy: 'A0' }), /now/);
});
