// Event Bridge 合成生命周期测试（activation-03 任务书 §四）。
//
// 覆盖六类生命周期 + 五条硬不变量：
//   1. 用户主动重提（带/不带话语观测）
//   2. 模型生成引用（只读，永不强化）
//   3. 回答实际投递（有/无投递确认）
//   4. 用户纠正（非正式路径拒绝）
//   5. 同源重复转发（sourceEventId 幂等）
//   6. 服务重启（eventId 不碰撞）
//   不变量：跨空间不串联 / 撤回记录不因高激活恢复 / 写入成功但日志失败不伪造
//   成功 / shadow 查询零记录 / 内部候选事件零强化

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBridge, LIFECYCLE_KINDS, REJECTION_REASONS } from '../src/event-bridge.mjs';
import { createEventIdFactory } from '../../activation-02/src/event-ids.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { EventLog } from '../../activation-01/src/events.mjs';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');

function fixedClock() { return () => T0; }

test('生命周期1：用户主动重提——有话语观测才允许 user_revisited', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-1' }) });
  const withoutUtterance = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a',
    provenance: { surface: 'pipeline', utteranceObserved: false }
  });
  assert.equal(withoutUtterance.eventRecorded, false);
  assert.equal(withoutUtterance.reason, REJECTION_REASONS.UTTERANCE_NOT_OBSERVED);

  const withUtterance = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a',
    provenance: { surface: 'user', utteranceObserved: true, utterance: '刚才说的火锅是哪家来着' }
  });
  assert.equal(withUtterance.eventRecorded, true);
  assert.equal(withUtterance.eventType, 'user_revisited');

  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 1, '唯一强化类事件生效');
});

test('生命周期2：模型生成引用是只读事件——永不强化', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-2' }) });
  const outcome = bridge.observe({
    kind: LIFECYCLE_KINDS.GENERATION_CITED, spaceId: 'mira', recordId: 'rec-a',
    provenance: { model: 'GLM' }
  });
  assert.equal(outcome.eventRecorded, true);
  assert.equal(outcome.eventType, 'generated_reference');
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a')?.reinforceTimesMs.length ?? 0, 0, '只读事件零强化');
  assert.equal(state.get('mira::rec-a')?.counts.generated_reference, 1, '只读事件仅作审计计数');
});

test('生命周期3：只有生成、没有投递确认 → 不得记录 delivered_reference', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-3' }) });
  const noAck = bridge.observe({
    kind: LIFECYCLE_KINDS.DELIVERY_ACK, spaceId: 'mira', recordId: 'rec-a',
    provenance: { deliveryConfirmed: false }
  });
  assert.equal(noAck.eventType, 'generated_reference', '退化为只读引用，不冒充投递');
  const ack = bridge.observe({
    kind: LIFECYCLE_KINDS.DELIVERY_ACK, spaceId: 'mira', recordId: 'rec-a',
    provenance: { deliveryConfirmed: true, channel: 'chat' }
  });
  assert.equal(ack.eventType, 'delivered_reference');
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a').lastDeliveryMs, T0, '真实投递更新最近投递');
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 0, '投递永不强化');
});

test('生命周期4：用户纠正必须走正式权威——缺回执拒绝', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-4' }) });
  const informal = bridge.observe({
    kind: LIFECYCLE_KINDS.FORMAL_CORRECTION, spaceId: 'mira', recordId: 'rec-a',
    provenance: { formalAuthorization: false }
  });
  assert.equal(informal.eventRecorded, false);
  assert.equal(informal.reason, REJECTION_REASONS.CORRECTION_NOT_FORMAL);
  const formal = bridge.observe({
    kind: LIFECYCLE_KINDS.FORMAL_CORRECTION, spaceId: 'mira', recordId: 'rec-a',
    provenance: { formalAuthorization: true, operationId: 'corr-latte-001' }
  });
  assert.equal(formal.eventRecorded, true);
  assert.equal(formal.eventType, 'user_corrected');
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a').corrections, 1);
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 0, '纠正不强化激活；效力变更属正式权威');
});

test('生命周期5：同源重复转发——同 sourceEventId 同空间只强化一次', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-5' }) });
  const provenance = { surface: 'user', utteranceObserved: true };
  const first = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a',
    sourceEventId: 'src-msg-42', provenance
  });
  const forward = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a',
    sourceEventId: 'src-msg-42', provenance
  });
  assert.equal(first.eventRecorded, true);
  assert.equal(forward.status, 'duplicate', '幂等成功：不产生第二次强化');
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 1);
});

test('生命周期6：服务重启——新进程 nonce 使 eventId 结构性不碰撞', () => {
  const log = new EventLog();
  const provenance = { surface: 'user', utteranceObserved: true };
  const bridgeA = createEventBridge({
    now: fixedClock(), log,
    ids: createEventIdFactory({ prefix: 'ev3', nonce: 'process-a' })
  });
  bridgeA.observe({ kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a', provenance, atMs: T0 });
  // —— 进程重启：新 EventLog 挂接旧账本内容，新进程新 nonce ——
  const bridgeB = createEventBridge({
    now: fixedClock(),
    log: (() => { const l = new EventLog(); for (const e of log.events()) l.recordEvent(e); return l; })(),
    ids: createEventIdFactory({ prefix: 'ev3', nonce: 'process-b-restarted' })
  });
  const after = bridgeB.observe({ kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a', provenance, atMs: T0 + 1 });
  assert.equal(after.eventRecorded, true, '重启后的新事件正常记录');
  const merged = [...log.events(), ...bridgeB.events().filter((e) => !log.events().some((o) => o.eventId === e.eventId))];
  const ids = new Set(merged.map((e) => e.eventId));
  assert.equal(ids.size, merged.length, '合并日志中 eventId 零碰撞');
  const state = replayEvents(merged);
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 2, '两次真实重提都被保留（不吞事件）');
});

test('不变量：不同空间不串联——同 sourceEventId 不同空间各自记录，激活互不影响', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-6' }) });
  const provenance = { surface: 'user', utteranceObserved: true };
  bridge.observe({ kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a', sourceEventId: 'src-x', provenance });
  const other = bridge.observe({ kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'other', recordId: 'rec-a', sourceEventId: 'src-x', provenance });
  assert.equal(other.status, 'recorded', '跨空间同源是两个独立事件（EventLog 按 spaceId::sourceEventId 分键）');
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a').reinforceTimesMs.length, 1);
  assert.equal(state.get('other::rec-a').reinforceTimesMs.length, 1, '但两个空间各自独立强化，状态键隔离');
});

test('不变量：写入成功但事件日志失败——不得伪造成功', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-7' }) });
  bridge.injectLogFailure('disk full');
  const outcome = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-a',
    provenance: { surface: 'user', utteranceObserved: true }
  });
  assert.equal(outcome.eventRecorded, false);
  assert.equal(outcome.status, 'log-write-failed');
  assert.match(outcome.reason, /EVENT_LOG_WRITE_FAILED/);
  assert.equal(bridge.size, 0, '账本内容不含该事件');
  const state = replayEvents(bridge.events());
  assert.equal(state.size, 0, '重放不产生任何激活——失败不可被当成成功');
});

test('不变量：shadow 查询零记录、内部候选事件零强化', () => {
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-8' }) });
  const shadow = bridge.observe({ kind: LIFECYCLE_KINDS.SHADOW_QUERY, spaceId: 'mira', recordId: 'rec-a' });
  assert.equal(shadow.eventRecorded, false);
  assert.equal(shadow.reason, REJECTION_REASONS.SHADOW_QUERY_NOT_RECORDABLE);
  const internal = bridge.observe({ kind: LIFECYCLE_KINDS.INTERNAL_CANDIDATES, spaceId: 'mira', recordId: 'rec-a' });
  assert.equal(internal.eventType, 'candidate_retrieved');
  assert.equal(internal.eventRecorded, true);
  const state = replayEvents(bridge.events());
  assert.equal(state.get('mira::rec-a')?.reinforceTimesMs.length ?? 0, 0, 'candidate_retrieved 不产生任何强化——不允许冒充 user_revisited');
});

test('不变量：已撤回记录不因高激活恢复（激活状态存在但候选投影缺席）', async () => {
  // 该不变量的完整验证在 shadow runner 层：撤回记录被权威投影移除，
  // 任何激活乘数都作用不到它。这里验证事件侧：撤回后仍收到重提事件时，
  // 状态允许记录（审计事实），但重放出的激活无法让记录复活——由
  // tests/unit.test.mjs 的真实 harness 场景（E11）闭环证明候选层缺席。
  const bridge = createEventBridge({ now: fixedClock(), ids: createEventIdFactory({ nonce: 'test-nonce-9' }) });
  const outcome = bridge.observe({
    kind: LIFECYCLE_KINDS.USER_REMENTION, spaceId: 'mira', recordId: 'rec-retracted-phish',
    provenance: { surface: 'user', utteranceObserved: true, note: '撤回后误触发的重提观测' }
  });
  assert.equal(outcome.eventRecorded, true, '事件账本是审计事实，记录本身不等于恢复');
  assert.equal(replayEvents(bridge.events()).get('mira::rec-retracted-phish').reinforceTimesMs.length, 1);
});
