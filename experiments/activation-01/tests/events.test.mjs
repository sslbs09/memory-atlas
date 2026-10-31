// 事件语义单元测试：幂等、来源、时间、校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, replayEvents, validateEvent, EVENT_TYPES } from '../src/events.mjs';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function revisit(over = {}) {
  return {
    eventId: 'e1', spaceId: 'personal', recordId: 'rec-a', recordRevision: 3,
    eventType: 'user_revisited',
    occurredAt: iso(T0 - 5 * 86_400_000), observedAt: iso(T0 - 5 * 86_400_000 + 60_000),
    sourceEventId: null, provenance: { channel: 'chat' }, signalVersion: 1,
    ...over
  };
}

test('事件类型枚举完整（任务书八类）', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    'candidate_retrieved', 'delivered_reference', 'generated_reference',
    'selected_for_context', 'ui_inspected', 'user_confirmed', 'user_corrected', 'user_revisited'
  ].sort());
});

test('recordEvent：合法事件被记录', () => {
  const log = new EventLog();
  const r = log.recordEvent(revisit());
  assert.equal(r.status, 'recorded');
  assert.equal(log.size, 1);
});

test('幂等：同 eventId 重放 → duplicate，账本不变', () => {
  const log = new EventLog();
  log.recordEvent(revisit());
  const r = log.recordEvent(revisit());
  assert.equal(r.status, 'duplicate');
  assert.equal(r.reason, 'duplicate-eventId');
  assert.equal(log.size, 1);
});

test('幂等：同 sourceEventId 跨工具转发 → 只算一次', () => {
  const log = new EventLog();
  log.recordEvent(revisit({ eventId: 'e-orig', sourceEventId: 'src-1' }));
  const r2 = log.recordEvent(revisit({ eventId: 'e-fwd-wechat', sourceEventId: 'src-1' }));
  const r3 = log.recordEvent(revisit({ eventId: 'e-fwd-email', sourceEventId: 'src-1' }));
  assert.equal(r2.status, 'duplicate');
  assert.equal(r3.status, 'duplicate');
  assert.equal(log.size, 1);
  const state = replayEvents(log.events());
  assert.equal(state.get('personal::rec-a').reinforceTimesMs.length, 1);
});

test('拒绝：同 sourceEventId 指向不同 recordId（上游异常）', () => {
  const log = new EventLog();
  log.recordEvent(revisit({ eventId: 'e-orig', sourceEventId: 'src-1' }));
  const r = log.recordEvent(revisit({ eventId: 'e-other', recordId: 'rec-b', sourceEventId: 'src-1' }));
  assert.equal(r.status, 'rejected');
  assert.match(r.reason, /source-event-conflict/);
  assert.equal(log.size, 1);
});

test('拒绝：同 eventId 携带不同主体', () => {
  const log = new EventLog();
  log.recordEvent(revisit());
  const r = log.recordEvent(revisit({ recordId: 'rec-b' }));
  assert.equal(r.status, 'rejected');
  assert.match(r.reason, /eventId-conflict/);
});

test('拒绝：没有真实观测时间的事件不得补造', () => {
  const log = new EventLog();
  const bad = revisit();
  delete bad.occurredAt;
  delete bad.observedAt;
  const r = log.recordEvent(bad);
  assert.equal(r.status, 'rejected');
});

test('拒绝：未知事件类型 / 坏时间戳 / 缺字段', () => {
  const log = new EventLog();
  assert.equal(log.recordEvent(revisit({ eventType: 'model_vibes' })).status, 'rejected');
  assert.equal(log.recordEvent(revisit({ occurredAt: 'not-a-date' })).status, 'rejected');
  assert.equal(log.recordEvent(revisit({ recordId: '' })).status, 'rejected');
  assert.equal(log.recordEvent(revisit({ spaceId: '' })).status, 'rejected');
});

test('observedAt 缺省时允许 occurredAt 兜底（规范化），反之亦然', () => {
  const e = validateEvent({ eventId: 'x', spaceId: 's', recordId: 'r', eventType: 'ui_inspected', occurredAt: iso(T0) });
  assert.equal(e.observedAt, iso(T0));
  const e2 = validateEvent({ eventId: 'y', spaceId: 's', recordId: 'r', eventType: 'ui_inspected', observedAt: iso(T0) });
  assert.equal(e2.occurredAt, iso(T0));
});

test('重放：乱序到达不改变状态（激活是时间戳的函数）', () => {
  const a = replayEvents([
    revisit({ eventId: 'e1' }),
    revisit({ eventId: 'e2', occurredAt: iso(T0 - 30 * 86_400_000) }),
    revisit({ eventId: 'e3', occurredAt: iso(T0 - 1 * 86_400_000) })
  ]);
  const b = replayEvents([
    revisit({ eventId: 'e3', occurredAt: iso(T0 - 1 * 86_400_000) }),
    revisit({ eventId: 'e1' }),
    revisit({ eventId: 'e2', occurredAt: iso(T0 - 30 * 86_400_000) })
  ]);
  assert.deepEqual(a.get('personal::rec-a').reinforceTimesMs, b.get('personal::rec-a').reinforceTimesMs);
});

test('重放：delivered_reference 取最近一次（乱序安全）', () => {
  const state = replayEvents([
    { ...revisit({ eventId: 'd1', eventType: 'delivered_reference' }) },
    { ...revisit({ eventId: 'd2', eventType: 'delivered_reference', occurredAt: iso(T0 - 20 * 86_400_000) }) }
  ]);
  const entry = state.get('personal::rec-a');
  assert.equal(entry.lastDeliveryMs, Date.parse(iso(T0 - 5 * 86_400_000)));
  assert.equal(entry.reinforceTimesMs.length, 0, '投递不是强化');
});

test('重放：user_confirmed 分授权/未授权计数，不进入强化', () => {
  const state = replayEvents([
    revisit({ eventId: 'c1', eventType: 'user_confirmed', formalAuthorization: true }),
    revisit({ eventId: 'c2', eventType: 'user_confirmed', formalAuthorization: false })
  ]);
  const entry = state.get('personal::rec-a');
  assert.equal(entry.reinforceTimesMs.length, 0);
  assert.equal(entry.confirmations.authorized, 1);
  assert.equal(entry.confirmations.unauthorized, 1);
});

test('重放：user_corrected 只计数，不由激活引擎应用', () => {
  const state = replayEvents([revisit({ eventId: 'u1', eventType: 'user_corrected' })]);
  assert.equal(state.get('personal::rec-a').corrections, 1);
  assert.equal(state.get('personal::rec-a').reinforceTimesMs.length, 0);
});

test('跨空间同 recordId 状态隔离（派生状态按 space 分键）', () => {
  const state = replayEvents([
    revisit({ eventId: 'p1' }),
    revisit({ eventId: 'w1', spaceId: 'work' })
  ]);
  assert.ok(state.has('personal::rec-a'));
  assert.ok(state.has('work::rec-a'));
  assert.equal(state.size, 2);
});
