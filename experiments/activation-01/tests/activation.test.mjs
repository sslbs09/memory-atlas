// 激活计算单元测试：零事件中性、有界性、时间衰减、数值稳定、信号分离。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  multiplierA1, multiplierA2, activationB, multiplierA3,
  deliveryMultiplier, buildActivation, DEFAULT_PARAMS
} from '../src/activation.mjs';
import { replayEvents } from '../src/events.mjs';
import { getActivation } from '../src/activation.mjs';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function revState(daysAgoList, { spaceId = 'personal', recordId = 'rec-a' } = {}) {
  return replayEvents(daysAgoList.map((d, i) => ({
    eventId: `e${i}`, spaceId, recordId, eventType: 'user_revisited',
    occurredAt: iso(NOW - d * DAY), observedAt: iso(NOW - d * DAY + 60_000),
    sourceEventId: null, provenance: {}, signalVersion: 1
  })));
}

test('A1：零事件 → 恰好 1.0（退回基线）', () => {
  assert.equal(multiplierA1(0), 1);
});

test('A1：边际递减且有界', () => {
  const m1 = multiplierA1(1), m3 = multiplierA1(3), m8 = multiplierA1(8), m100 = multiplierA1(100);
  assert.ok(m1 < m3 && m3 < m8 && m8 < m100, '单调');
  // log1p 凹性 → 每多一次重提的边际增益严格递减
  const d1 = multiplierA1(2) - multiplierA1(1);
  const d8 = multiplierA1(9) - multiplierA1(8);
  const d50 = multiplierA1(51) - multiplierA1(50);
  assert.ok(d1 > d8 && d8 > d50, '边际递减');
  assert.ok(m100 <= 1 + DEFAULT_PARAMS.wCount * Math.log1p(1000), '远低于 100 倍权重');
  assert.equal(m8, 1 + DEFAULT_PARAMS.wCount * Math.log1p(8));
});

test('A2：两种半衰期给出不同乘数（时间尺度实验变量）', () => {
  const times = [NOW - 10 * DAY];
  const h7 = multiplierA2({ reinforceTimesMs: times, lastRevisitMs: NOW - 10 * DAY, recordTimeMs: null, now: NOW, halfLifeDays: 7 });
  const h30 = multiplierA2({ reinforceTimesMs: times, lastRevisitMs: NOW - 10 * DAY, recordTimeMs: null, now: NOW, halfLifeDays: 30 });
  assert.ok(h7.multiplier < h30.multiplier, '更短半衰期衰减更快');
  assert.ok(Math.abs(h7.multiplier - (1 + DEFAULT_PARAMS.wStrength * Math.log1p(1)) * 2 ** (-10 / 7)) < 1e-9);
});

test('A2：零事件且无记录时间 → 中性 1.0', () => {
  const m = multiplierA2({ reinforceTimesMs: [], lastRevisitMs: null, recordTimeMs: null, now: NOW });
  assert.equal(m.multiplier, 1);
});

test('A2：从未强化的旧记录随记录时间衰减，但 clamp 保底', () => {
  const m = multiplierA2({ reinforceTimesMs: [], lastRevisitMs: null, recordTimeMs: NOW - 3 * 365 * DAY, now: NOW });
  assert.ok(m.multiplier < 1, '旧记录低于基线');
  const clamped = Math.max(DEFAULT_PARAMS.floor, m.multiplier);
  assert.ok(clamped >= DEFAULT_PARAMS.floor);
});

test('A3：零事件 → B=0 → 乘数恰好 1.0', () => {
  const { b } = activationB({ reinforceTimesMs: [], now: NOW });
  assert.equal(b, 0);
  assert.equal(multiplierA3({ reinforceTimesMs: [], now: NOW }), 1);
});

test('A3：旧单次事件 B < 0（低于基线），新近密集事件 B > 0', () => {
  const old = activationB({ reinforceTimesMs: [NOW - 100 * DAY], now: NOW });
  assert.ok(old.b < 0);
  const recent = activationB({ reinforceTimesMs: [NOW - 1 * DAY, NOW - 2 * DAY, NOW - 3 * DAY], now: NOW });
  assert.ok(recent.b > 0);
});

test('A3：分布判别——同为 8 次，最近密集 > 一年分散', () => {
  const recent = multiplierA3({ reinforceTimesMs: Array.from({ length: 8 }, (_, i) => NOW - (i + 2) * DAY), now: NOW });
  const spread = multiplierA3({ reinforceTimesMs: Array.from({ length: 8 }, (_, i) => NOW - (45 + i * 45) * DAY), now: NOW });
  assert.ok(recent > spread);
});

test('A1 对分布不敏感（已知局限）：同次数 → 同乘数', () => {
  const recent = multiplierA1(8);
  const spread = multiplierA1(8);
  assert.equal(recent, spread);
});

test('未来时间戳（时钟异常）：年龄钳制，无 NaN、无负年龄', () => {
  const future = [NOW + 2 * DAY];
  const { b } = activationB({ reinforceTimesMs: future, now: NOW });
  assert.ok(Number.isFinite(b));
  // 年龄钳到 minIntervalDays=1h：sum = (1/24)^-0.5 = sqrt(24)
  assert.ok(Math.abs(b - Math.log(Math.sqrt(24))) < 1e-9);
});

test('buildActivation：clamp 生效且在分解中可见', () => {
  const state = revState([1, 2, 3], {});
  const big = { ...DEFAULT_PARAMS, wCount: 10 }; // 故意夸张，触发 ceil
  const out = buildActivation({
    state, spaceId: 'personal', recordId: 'rec-a',
    record: { occurredAt: iso(NOW - 5 * DAY) }, now: NOW, strategy: 'A1', params: big, mode: 'ambient'
  });
  assert.equal(out.activationMultiplier, DEFAULT_PARAMS.ceil);
  assert.equal(out.clamped, 'ceil');
});

test('buildActivation：A0 不消费事件（激活恒 1）', () => {
  const state = revState([1, 2, 3]);
  const out = buildActivation({
    state, spaceId: 'personal', recordId: 'rec-a',
    record: { occurredAt: iso(NOW - 5 * DAY) }, now: NOW, strategy: 'A0', mode: 'ambient'
  });
  assert.equal(out.activationMultiplier, 1);
  assert.match(out.reasons[0], /不消费派生事件/);
});

test('deliveryMultiplier：仅 ambient 抑制；explicit 恒 1；窗口外恢复', () => {
  const last = NOW - 2 * 3_600_000; // 2h 前
  assert.equal(deliveryMultiplier({ lastDeliveryMs: last, now: NOW, mode: 'ambient' }), 0.5);
  assert.equal(deliveryMultiplier({ lastDeliveryMs: last, now: NOW, mode: 'explicit' }), 1);
  const old = NOW - 30 * DAY;
  assert.equal(deliveryMultiplier({ lastDeliveryMs: old, now: NOW, mode: 'ambient' }), 1);
  const mid = NOW - 12 * 3_600_000; // 12h：线性恢复
  const midMult = deliveryMultiplier({ lastDeliveryMs: mid, now: NOW, mode: 'ambient' });
  assert.ok(midMult > 0.5 && midMult < 1);
});

test('六信号分离：确认不强化、纠正不应用、重要性只读、证据不随回忆增长', () => {
  const base = revState([5]);
  const withConfirmed = replayEvents([
    {
      eventId: 'r1', spaceId: 'personal', recordId: 'rec-a', eventType: 'user_revisited',
      occurredAt: iso(NOW - 5 * DAY), observedAt: iso(NOW - 5 * DAY), sourceEventId: null, provenance: {}, signalVersion: 1
    },
    {
      eventId: 'c1', spaceId: 'personal', recordId: 'rec-a', eventType: 'user_confirmed',
      occurredAt: iso(NOW - 1 * DAY), observedAt: iso(NOW - 1 * DAY), sourceEventId: null,
      provenance: {}, formalAuthorization: true, signalVersion: 1
    }
  ]);
  const before = getActivation(base, 'personal', 'rec-a');
  const after = getActivation(withConfirmed, 'personal', 'rec-a');
  assert.equal(after.reinforceCount, before.reinforceCount, 'user_confirmed 不得强化激活');
  assert.equal(after.confirmations.authorized, 1, '授权确认进入证据计数');

  const record = { occurredAt: iso(NOW - 5 * DAY), importance: 'high' };
  const out = buildActivation({ state: base, spaceId: 'personal', recordId: 'rec-a', record, now: NOW, strategy: 'A1', mode: 'ambient' });
  assert.equal(record.importance, 'high', '激活引擎不修改 importance');
  assert.equal(out.counts.user_revisited, 1);
});

test('getActivation：无事件的记录返回零值结构（不抛错）', () => {
  const a = getActivation(new Map(), 'personal', 'rec-none');
  assert.equal(a.reinforceCount, 0);
  assert.equal(a.lastDeliveryMs, null);
  assert.equal(a.hasEvents, false);
});
