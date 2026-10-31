// 十项失败模式回归测试（任务书 §六，逐条对应）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidatePool } from '../src/candidates.mjs';
import { rankCandidates } from '../src/ranking.mjs';
import { replayEvents } from '../src/events.mjs';
import { getActivation } from '../src/activation.mjs';
import { replayShuffled, saveEventLog, loadEventLog } from '../src/replay.mjs';
import { DEFAULT_PARAMS } from '../src/activation.mjs';
import { corpus, EVAL_NOW, eventHistory, holdoutScenarios, daysAgoIso } from '../fixtures/scenarios.mjs';
import { mktemp } from './helpers.mjs';

const NOW = EVAL_NOW;
const DAY = 86_400_000;
const pool = new CandidatePool(corpus());

function scenarioState(id) {
  const s = holdoutScenarios().find((x) => x.id === id);
  return replayEvents(s.events);
}

function orderOf(result) { return result.candidates.map((c) => c.recordId); }

// FM1 自我强化循环：模型反复自行召回（20 次投递，零用户重提）不得提高激活。
test('FM1 模型自我重复召回不产生任何强化（结构性与排名双重验证）', () => {
  const state = scenarioState('D14-model-self-reinforcement');
  const act = getActivation(state, 'personal', 'rec-scifi-books');
  assert.equal(act.reinforceCount, 0, 'delivered_reference 不是强化');
  assert.equal(act.lastDeliveryMs !== null, true, '但更新最近提及');

  // 环境联想排名与零事件完全一致（18 个候选的完整顺序）
  for (const strategy of ['A1', 'A2', 'A3']) {
    const withEvents = rankCandidates({ pool, state, mode: 'ambient', situation: '用户想找科幻小说来看', spaceIds: ['personal'], strategy, now: NOW });
    const zero = rankCandidates({ pool, state: new Map(), mode: 'ambient', situation: '用户想找科幻小说来看', spaceIds: ['personal'], strategy, now: NOW });
    assert.deepEqual(orderOf(withEvents), orderOf(zero), `${strategy} 排名必须与零事件一致`);
  }
});

// FM1b 内部查询同理（50 次内部事件，零用户参与）。
test('FM1b 内部查询/管线事件零强化', () => {
  const state = scenarioState('D08-internal-queries-no-reinforce');
  assert.equal(getActivation(state, 'personal', 'rec-scifi-books').reinforceCount, 0);
  for (const strategy of ['A1', 'A2', 'A3']) {
    const withEvents = rankCandidates({ pool, state, mode: 'ambient', situation: '用户想找科幻小说来看', spaceIds: ['personal'], strategy, now: NOW });
    const zero = rankCandidates({ pool, state: new Map(), mode: 'ambient', situation: '用户想找科幻小说来看', spaceIds: ['personal'], strategy, now: NOW });
    assert.deepEqual(orderOf(withEvents), orderOf(zero), `${strategy}`);
  }
});

// FM2 错误记忆强化：已撤回 / 已纠正的记录不得因历史重提复活。
test('FM2 撤回记录即使 8 次历史重提也不可达（explicit + ambient）', () => {
  const state = scenarioState('D06-retracted-high-freq');
  const r = rankCandidates({ pool, state, mode: 'explicit', query: '钓鱼', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  assert.equal(r.totalCount, 0);
  const r2 = rankCandidates({ pool, state, mode: 'ambient', situation: '周末去水边放松钓鱼怎么样', spaceIds: ['personal'], strategy: 'A3', now: NOW });
  assert.ok(!orderOf(r2).includes('rec-fishing-retracted'));
});

test('FM2b 被纠正的旧地址不得覆盖新地址', () => {
  const state = scenarioState('D13-corrected-memory');
  const r = rankCandidates({ pool, state, mode: 'explicit', query: '收货地址', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  assert.equal(orderOf(r)[0], 'rec-address-new');
  assert.ok(!orderOf(r).includes('rec-address-old'));
});

// FM3 频繁但无关：高频记忆的乘数必须有界（结构保证），排名效应由评估量化。
test('FM3 高频记忆乘数有界（ceil 结构保证）', () => {
  const state = scenarioState('D03-revisit8-vs-recent-trivial');
  const gym = getActivation(state, 'personal', 'rec-gym-runs');
  assert.equal(gym.reinforceCount, 8);
  for (const strategy of ['A1', 'A2', 'A3']) {
    const r = rankCandidates({ pool, state, mode: 'ambient', situation: '周末在家做什么吃的', spaceIds: ['personal'], strategy, now: NOW });
    const gymEntry = r.candidates.find((c) => c.recordId === 'rec-gym-runs');
    assert.ok(gymEntry.activation.multiplier <= DEFAULT_PARAMS.ceil + 1e-12, `${strategy}`);
  }
});

// FM4 长期约定：三年前的约定不得因时间衰减而丧失明确查询可达性。
test('FM4a 旧约定在 explicit 明确追问下任何策略都第一（硬保证）', () => {
  const state = scenarioState('D05b-old-commitment-explicit');
  for (const [strategy, params] of [['A0'], ['A1'], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 7 }], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 30 }], ['A3']]) {
    const r = rankCandidates({ pool, state, mode: 'explicit', query: '洱海 约定', spaceIds: ['personal'], strategy, now: NOW, params });
    assert.equal(orderOf(r)[0], 'rec-commitment-erhai', `${strategy}`);
    assert.ok(r.candidates[0].activation.multiplier >= DEFAULT_PARAMS.floor - 1e-12, `${strategy} floor 保底`);
  }
});

test('FM4b ambient 中 A1 把旧约定恢复到第一；衰减策略保持候选可达（下沉幅度被量化）', () => {
  const state = scenarioState('D05-old-commitment-reachable');
  const a1 = rankCandidates({ pool, state, mode: 'ambient', situation: '有没有还没完成的旅行约定', spaceIds: ['personal'], strategy: 'A1', now: NOW });
  assert.equal(orderOf(a1)[0], 'rec-commitment-erhai', 'A1 示例 C：重提 3 次的旧约定应第一');
  for (const [strategy, params] of [['A2', { ...DEFAULT_PARAMS, halfLifeDays: 7 }], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 30 }], ['A3']]) {
    const r = rankCandidates({ pool, state, mode: 'ambient', situation: '有没有还没完成的旅行约定', spaceIds: ['personal'], strategy, now: NOW, params });
    const rank = orderOf(r).indexOf('rec-commitment-erhai');
    assert.ok(rank !== -1, `${strategy} 必须仍是候选（可达性）`);
    assert.ok(r.candidates.find((c) => c.recordId === 'rec-commitment-erhai').activation.multiplier >= DEFAULT_PARAMS.floor - 1e-12);
  }
});

// FM5 多空间隔离：同一 recordId 的激活不得跨空间串联。
test('FM5 事件只发生在 personal 时，work 空间激活必须为零', () => {
  const state = scenarioState('D12-cross-space-isolation');
  const personal = getActivation(state, 'personal', 'rec-shared-001');
  const work = getActivation(state, 'work', 'rec-shared-001');
  assert.equal(personal.reinforceCount, 8);
  assert.equal(work.reinforceCount, 0, '跨空间泄漏');
  assert.equal(work.lastDeliveryMs, null);
  const r = rankCandidates({ pool, state, mode: 'ambient', situation: '项目代号和文档在哪个共享盘', spaceIds: ['work'], strategy: 'A1', now: NOW });
  const shared = r.candidates.find((c) => c.recordId === 'rec-shared-001');
  assert.equal(shared.activation.reinforcementCount, 0);
  assert.equal(shared.activation.multiplier, 1);
  assert.equal(orderOf(r)[0], 'rec-shared-001');
});

// FM6 同源重复：同一事件跨工具转发只算一次强化。
test('FM6 同一来源事件跨 3 个工具转发 → reinforceCount = 1', () => {
  const state = scenarioState('D10-same-source-duplicate');
  const act = getActivation(state, 'personal', 'rec-scifi-books');
  assert.equal(act.reinforceCount, 1);
  const single = replayEvents(eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', rev: [5], tools: 1, sourceEventId: 'src-evt-shared' }));
  assert.deepEqual(
    getActivation(state, 'personal', 'rec-scifi-books').reinforceTimesMs,
    getActivation(single, 'personal', 'rec-scifi-books').reinforceTimesMs
  );
});

// FM7 时钟异常：重复时间戳、乱序、未来时间戳必须可解释。
test('FM7 未来时间戳钳制、乱序重放等价、分数全部有限', () => {
  const events = holdoutScenarios().find((s) => s.id === 'D11-clock-anomalies').events;
  const state = replayEvents(events);
  assert.ok(Number.isFinite(state.get('personal::rec-scifi-books').reinforceTimesMs[0]));
  const shuffled = replayShuffled(events);
  assert.deepEqual(
    [...state.values()].map((e) => e.reinforceTimesMs),
    [...shuffled.values()].map((e) => e.reinforceTimesMs)
  );
  for (const strategy of ['A1', 'A2', 'A3']) {
    const r = rankCandidates({ pool, state, mode: 'explicit', query: '科幻', spaceIds: ['personal'], strategy, now: NOW });
    for (const c of r.candidates) assert.ok(Number.isFinite(c.finalScore), `${strategy}`);
  }
});

// FM8 只读行为：UI 查看/日志检查/重建索引不改变激活。
test('FM8 只读事件（ui_inspected 等）不改变任何激活状态', () => {
  const readEvents = ['ui_inspected', 'candidate_retrieved', 'selected_for_context', 'generated_reference'].map((t, i) => ({
    eventId: `ro-${i}`, spaceId: 'personal', recordId: 'rec-allergy-peanut', eventType: t,
    occurredAt: daysAgoIso(1), observedAt: daysAgoIso(1), sourceEventId: null, provenance: {}, signalVersion: 1
  }));
  const state = replayEvents(readEvents);
  const act = getActivation(state, 'personal', 'rec-allergy-peanut');
  assert.equal(act.reinforceCount, 0);
  assert.equal(act.lastDeliveryMs, null, '只读事件连最近提及都不能碰');
  for (const strategy of ['A1', 'A2', 'A3']) {
    const withEvents = rankCandidates({ pool, state, mode: 'ambient', situation: '和朋友出去下馆子点什么菜', spaceIds: ['personal'], strategy, now: NOW });
    const zero = rankCandidates({ pool, state: new Map(), mode: 'ambient', situation: '和朋友出去下馆子点什么菜', spaceIds: ['personal'], strategy, now: NOW });
    assert.deepEqual(orderOf(withEvents), orderOf(zero), `${strategy}`);
  }
});

// FM9 最近提及：explicit 追问不被抑制；ambient 无关话题被抑制。
test('FM9a 用户明确追问刚提及过的事 → 正常召回', () => {
  const state = scenarioState('D07-explicit-followup-after-delivery');
  for (const [strategy, params] of [['A1'], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 7 }], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 30 }], ['A3']]) {
    const r = rankCandidates({ pool, state, mode: 'explicit', query: '花生 过敏', spaceIds: ['personal'], strategy, now: NOW, params });
    assert.equal(orderOf(r)[0], 'rec-allergy-peanut', `${strategy}`);
    assert.equal(r.candidates[0].recentDelivery.multiplier, 1, `${strategy} explicit 不抑制`);
  }
});

test('FM9b 刚提及过的事在无关 ambient 话题中退位（其余策略）而 A0 无能为力', () => {
  const state = scenarioState('D09-recent-delivery-suppression');
  const situation = '外出和朋友吃饭要注意什么';
  const a0 = rankCandidates({ pool, state, mode: 'ambient', situation, spaceIds: ['personal'], strategy: 'A0', now: NOW });
  const ids0 = orderOf(a0);
  assert.ok(ids0.indexOf('rec-allergy-peanut') < ids0.indexOf('rec-no-cilantro'),
    'A0 没有事件机制：刚提过的仍排在久未提及的之前');
  for (const [strategy, params] of [['A1'], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 7 }], ['A2', { ...DEFAULT_PARAMS, halfLifeDays: 30 }], ['A3']]) {
    const r = rankCandidates({ pool, state, mode: 'ambient', situation, spaceIds: ['personal'], strategy, now: NOW, params });
    const ids = orderOf(r);
    const allergy = r.candidates.find((c) => c.recordId === 'rec-allergy-peanut');
    const cilantro = r.candidates.find((c) => c.recordId === 'rec-no-cilantro');
    assert.ok(ids.indexOf('rec-allergy-peanut') > ids.indexOf('rec-no-cilantro'),
      `${strategy}：刚投递的过敏提醒应排到久未提及的香菜提醒之后`);
    assert.equal(allergy.recentDelivery.multiplier, 0.5, `${strategy} 抑制系数可见`);
  }
});

// FM10 重启与重建：同事件流 + 同时钟 → 同激活、同排名（落盘/重放/乱序）。
test('FM10 落盘重放与内存重放逐字段一致；乱序重放等价', () => {
  const events = eventHistory({ spaceId: 'personal', recordId: 'rec-badminton', rev: [3, 10, 17], del: [1] });
  const mem = replayEvents(events);
  const tmp = mktemp('events-fm10.jsonl');
  const saved = saveEventLog(tmp, events);
  assert.ok(saved.bytes > 0);
  const reloaded = replayEvents(loadEventLog(tmp));
  assert.deepEqual([...mem.entries()], [...reloaded.entries()]);
  assert.deepEqual(
    [...replayShuffled(events).values()].map((e) => ({ r: e.reinforceTimesMs, d: e.lastDeliveryMs })),
    [...mem.values()].map((e) => ({ r: e.reinforceTimesMs, d: e.lastDeliveryMs }))
  );
});
