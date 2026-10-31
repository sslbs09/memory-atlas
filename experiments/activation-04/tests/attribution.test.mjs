// activation-04 归因实验测试 —— 锁定不变量与归因结论数据。
//
// 覆盖：
//   1. 五策略成员资格零改动（真实候选集上逐策略断言）
//   2. LR = activation-03 rankG1G2 原样（含 gate 修复行为）、D = rankG3 原样
//   3. R 在路径 C（无 base 分数）诚实拒用
//   4. L 永不消费事件（有无事件剧本 → L 输出逐位一致）
//   5. 零事件时 R ≡ A0、LR ≡ A0（多候选场景）
//   6. 证据普查：AND 下 coverage 结构性恒 1，而 phraseHit/idHit/tier 可变
//   7. 事件重放幂等（同 eventId / sourceEventId 折叠 → 状态哈希一致）
//   8. 已提交的归因结果与关键结论一致（防报告与数据漂移）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAttributionScenario } from '../src/attribution-runner.mjs';
import { rankL, rankR, rankLR, rankD } from '../src/attribution-strategies.mjs';
import { holdoutV4Scenarios } from '../fixtures/holdout-v4.mjs';
import { holdoutV3Scenarios } from '../../activation-03/fixtures/holdout-v3.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scenarioById = new Map([...holdoutV3Scenarios(), ...holdoutV4Scenarios()].map((s) => [s.id, s]));

test('五策略在同一真实候选集上成员资格零改动（V07 多候选）', async () => {
  const rec = await runAttributionScenario(scenarioById.get('V07-recent-weak-invoice'));
  const ids = rec.candidatesExplain.map((c) => c.recordId).sort();
  for (const strategy of ['A0', 'L', 'R', 'LR', 'D']) {
    assert.deepEqual([...rec.strategyRankings[strategy]].sort(), ids, `${strategy} 改变了成员资格`);
  }
});

test('LR 逐字复用 activation-03：零事件 ≡ A0；带事件时 gate 修复可见（V01 vs V07）', async () => {
  const v01 = await runAttributionScenario(scenarioById.get('V01-phrase-vs-scatter-old'));
  assert.equal(v01.strategyRefused.LR ?? null, null);
  assert.deepEqual(v01.strategyRankings.LR, v01.strategyRankings.A0, '零事件下 LR 必须 ≡ A0（gate 只约束 boosted）');
  assert.notDeepEqual(v01.strategyRankings.L, v01.strategyRankings.A0, 'L 在 V01 应修复（phrase vs 散词）');

  const v07 = await runAttributionScenario(scenarioById.get('V07-recent-weak-invoice'));
  assert.equal(v07.gateMoves.length, 0, 'V07 同 tier 合法上移，不触发 gate');
  assert.deepEqual(v07.strategyRankings.LR[0], 'rec-invoice-deadline');
});

test('D 逐字复用 activation-03 G3 语义：explicit 恒绕过、ambient 抑制', async () => {
  const v02 = await runAttributionScenario(scenarioById.get('V02-explicit-reask-expense'));
  assert.deepEqual(v02.strategyRankings.D, v02.strategyRankings.A0, 'explicit 2h 前刚投递也恒不抑制');
  assert.equal(v02.recentDeliveryPenalty.explicitBypass, true);

  const v08 = await runAttributionScenario(scenarioById.get('V08-ambient-delivery-zhao'));
  assert.equal(v08.recentDeliveryPenalty.applied, true, 'ambient 1h 前投递必须抑制');
  assert.deepEqual(v08.strategyRankings.D[0], 'rec-v4b-zhao-hike', 'D 修复重复投递 top1');
  assert.ok(v08.strategyRefused.LR, 'LR 在结构关联候选上拒用');
});

test('R 在路径 C（scan 回退，无 base 分数）诚实拒用；L/D 路径 C 恒等', async () => {
  const c01 = await runAttributionScenario(scenarioById.get('C01-scan-after-index-failure'));
  assert.ok(c01.strategyRefused.R, 'R 必须在 scan 回退上拒用');
  assert.match(c01.strategyRefused.R, /R_DISABLED/);
  assert.deepEqual(c01.strategyRankings.L, c01.strategyRankings.A0, 'L 无词元证据时恒等');
  assert.deepEqual(c01.strategyRankings.LR, c01.strategyRankings.A0, 'LR 在 scan 回退拒用 → A0');
});

test('L 永不消费事件：V02 带事件剧本与去事件重放，L 排序逐位一致', async () => {
  const withEvents = await runAttributionScenario(scenarioById.get('V02-explicit-reask-expense'));
  const scenario = JSON.parse(JSON.stringify(scenarioById.get('V02-explicit-reask-expense')));
  // 去事件：直接构造无事件运行（清空剧本引用）
  const { SCENARIO_EVENTS_V4 } = await import('../fixtures/corpus-v4.mjs');
  const saved = SCENARIO_EVENTS_V4['V02-explicit-reask-expense'];
  delete SCENARIO_EVENTS_V4['V02-explicit-reask-expense'];
  try {
    const withoutEvents = await runAttributionScenario(scenario);
    assert.deepEqual(withoutEvents.strategyRankings.L, withEvents.strategyRankings.L, 'L 不得随事件变化');
    assert.notDeepEqual(withoutEvents.strategyRankings.R, withEvents.strategyRankings.R, 'R 必须随事件变化（对照）');
  } finally {
    SCENARIO_EVENTS_V4['V02-explicit-reask-expense'] = saved;
  }
});

test('零事件时 R ≡ A0（多候选真实场景 V01）', async () => {
  const v01 = await runAttributionScenario(scenarioById.get('V01-phrase-vs-scatter-old'));
  assert.deepEqual(v01.strategyRankings.R, v01.strategyRankings.A0, '无 user_revisited → g2 全 1 → R ≡ A0');
});

test('证据普查：AND 下 coverage 结构性恒 1，而 phraseHit/idHit/tier 在候选间可变', async () => {
  const v01 = await runAttributionScenario(scenarioById.get('V01-phrase-vs-scatter-old'));
  for (const c of v01.candidatesExplain) {
    assert.equal(c.evidence.coverage, 1, 'explicit AND 下 coverage 结构性恒 1');
  }
  const phraseValues = new Set(v01.candidatesExplain.map((c) => c.evidence.phraseHit));
  assert.equal(phraseValues.size, 2, 'V01 候选间 phraseHit 必须可变（1 短语 + 1 散词）');

  const e13 = await runAttributionScenario(scenarioById.get('E13-idhit-gate'));
  assert.ok(e13.candidatesExplain.some((c) => c.evidence.idHit), 'E13 必须存在 idHit 证据（T0）');

  const v03 = await runAttributionScenario(scenarioById.get('V03-freq-irrelevant-annual'));
  const tiers = new Set(v03.candidatesExplain.map((c) => c.evidence.tier));
  assert.equal(tiers.size, 1, 'V03 已知失效模式：单词查询短语同质，tier 无差异');
});

test('事件重放幂等：同 eventId 重复行与同 sourceEventId 转发折叠后状态哈希一致', () => {
  const base = [{
    eventId: 'e1', spaceId: 's', recordId: 'r', eventType: 'user_revisited',
    occurredAt: '2026-10-30T09:00:00.000Z', observedAt: '2026-10-30T09:00:00.000Z', provenance: {}
  }];
  const forwarded = { ...base[0], eventId: 'e2', sourceEventId: 'upstream-1' };
  const once = replayEvents([...base, forwarded]);
  const twice = replayEvents([...base, forwarded, ...base, forwarded]); // 重复行 + 重复转发
  const hash = (state) => JSON.stringify([...state.entries()].map(([k, v]) => [k, v.reinforceTimesMs, v.lastDeliveryMs]));
  assert.equal(hash(once), hash(twice), '幂等重放必须得到同一状态');
  assert.equal(once.get('s::r').reinforceTimesMs.length, 2, '两条合法重提都保留（同源转发只折叠一次）');
});

test('已提交的归因结果与关键结论一致（results-v4/attribution.json）', () => {
  const report = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'results-v4', 'attribution.json'), 'utf8'));
  const m = report.attributionMatrix;

  // 上轮 4 案例逐项归因：R 修 E01/E06（tier 同质），L 修 E02/E13（tier 有差异）
  const prior = Object.fromEntries(report.priorFixedAttribution.map((x) => [x.id, x]));
  assert.deepEqual(prior['E01-xiaolin-person-events'].fixedBy, ['R', 'LR']);
  assert.equal(prior['E01-xiaolin-person-events'].tierHomogeneous.homogeneous, true);
  assert.deepEqual(prior['E02-token-quality-gate'].fixedBy, ['L', 'LR']);
  assert.equal(prior['E02-token-quality-gate'].tierHomogeneous.homogeneous, false);
  assert.deepEqual(prior['E06-explicit-reask'].fixedBy, ['R', 'LR']);
  assert.deepEqual(prior['E13-idhit-gate'].fixedBy, ['L', 'LR']);

  // 归因矩阵：LR 修而 L 未修 5 案；L 修而 LR 未修仅 V01；零回归
  assert.deepEqual(m.lrVsL.lrFixesThatLMisses.sort(), [
    'E01-xiaolin-person-events', 'E06-explicit-reask', 'V02-explicit-reask-expense',
    'V04-commitment-book-return', 'V05-multi-revisit-health'
  ].sort());
  assert.deepEqual(m.lrVsL.lFixesThatLRMisses, ['V01-phrase-vs-scatter-old']);
  for (const strategy of ['L', 'R', 'LR', 'D']) {
    assert.deepEqual(m.regressionsVsA0[strategy], [], `${strategy} 不得有相对 A0 的回归`);
  }

  // 全体策略零 forbidden
  for (const group of Object.values(report.byGroup)) {
    for (const strategy of ['A0', 'L', 'R', 'LR', 'D']) {
      assert.equal(group.all[strategy].forbiddenRecallTotal, 0);
    }
  }

  // combined explicit 头条数字（21 场景）
  const c = report.byGroup['explicit-combined'].all;
  assert.equal(c.A0.top1Accuracy, 0.3333);
  assert.equal(c.L.top1Accuracy, 0.5238);
  assert.equal(c.R.top1Accuracy, 0.619);
  assert.equal(c.LR.top1Accuracy, 0.7143);
  assert.equal(c.D.top1Accuracy, 0.3333);
});

test('dogfood demo 产物存在且重启重放一致', () => {
  const dir = path.join(HERE, '..', 'results-v4', 'dogfood-explain');
  for (const f of ['query-1-baseline.json', 'query-2-after-revisit.json', 'browse-after-delivery.json', 'query-3-after-retract.json', 'replay-check.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `缺少 ${f}`);
  }
  const rc = JSON.parse(fs.readFileSync(path.join(dir, 'replay-check.json'), 'utf8'));
  assert.equal(rc.identical, true, '独立进程重放哈希必须一致');
  const q3 = JSON.parse(fs.readFileSync(path.join(dir, 'query-3-after-retract.json'), 'utf8'));
  assert.equal(q3.retractedRecordPresent, false, '撤回记录不得出现在任何候选路径');
});
