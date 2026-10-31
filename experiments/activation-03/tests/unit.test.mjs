// activation-03 单元测试：真实路径 harness / 证据 / 策略 / 结构不变量。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPathAHarness, createPathBHarness, makeTempDir } from '../src/real-harness.mjs';
import { classifyEvidencePath, parseMatchReason, computeTierFromReal } from '../src/evidence.mjs';
import { rankA0, rankG3, rankG1G2, FALLBACK_REASONS } from '../src/shadow-strategies.mjs';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { termsForQuery } from '../../activation-01/src/tokenizer.mjs';
import { MIRA_RECORDS, OTHER_RECORDS, MIRA_B_RECORDS, NOW_MS } from '../fixtures/corpus-v3.mjs';

const NOW = NOW_MS;

test('真实链路冒烟：Atlas coordinator + 真 GLM adapter 一次取齐候选', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const harness = await createPathAHarness({ spaceId: 'mira', records: MIRA_RECORDS, engineMode: 'glm', indexDir: dir });
  t.after(() => harness.close());
  const result = await harness.query({ query: '周末在家吃火锅' });
  assert.equal(result.searchPath, 'atlas-candidates+authoritative');
  assert.equal(result.indexState, 'WIRED');
  assert.deepEqual(result.candidates.map((c) => c.recordId), ['rec-hotpot'],
    'AND 语义：只有完整包含全部词元的记录是候选');
  assert.equal(result.candidates[0].coverage, 1, 'coverage 结构性恒为 1（activation-02 诊断在真实链路复现）');
  assert.ok(result.candidates[0].matchReason.every((m) => m.startsWith('term:') || m.startsWith('recency:')),
    'matchReason 是原生词元证据');
});

test('explicit A0 的词元证据同质性：全候选 matchReason 词项一致（G1 在 AND 下分层失效的结构原因）', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const harness = await createPathAHarness({ spaceId: 'mira', records: MIRA_RECORDS, engineMode: 'glm', indexDir: dir });
  t.after(() => harness.close());
  const result = await harness.query({ query: '跑步' });
  const termSets = result.candidates.map((c) => JSON.stringify(parseMatchReason(c.matchReason).terms));
  assert.ok(new Set(termSets).size === 1, 'AND 求交后所有候选的原生词元证据完全相同');
  assert.equal(result.candidates[0].coverage, 1);
});

test('scan 回退：无 matchReason / 无 score，A0 = sequence 降序', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const harness = await createPathAHarness({ spaceId: 'mira', records: MIRA_RECORDS, engineMode: 'broken', indexDir: dir });
  t.after(() => harness.close());
  const result = await harness.query({ query: '跑步' });
  assert.equal(result.pathLabel, 'authoritative-scan-fallback');
  assert.equal(result.indexState, 'ADAPTER_FAILED');
  assert.ok(result.indexReport.fellBack);
  for (const c of result.candidates) {
    assert.equal(c.matchReason, null);
    assert.equal(c.a0Score, null);
  }
  const seqs = result.candidates.map((c) => c.sequence);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'scan 顺序 = sequence 降序');
});

test('G1G2 在 scan 回退上诚实拒用（fallbackReason 显式）', () => {
  const candidates = [
    { recordId: 'rec-a', spaceId: 'mira', position: 0, a0Score: null, coverage: null, matchReason: null, content: 'x', occurredAt: '2026-10-01', status: 'active', evidenceClass: 'none' },
    { recordId: 'rec-b', spaceId: 'mira', position: 1, a0Score: null, coverage: null, matchReason: null, content: 'y', occurredAt: '2026-10-02', status: 'active', evidenceClass: 'none' }
  ];
  const g1g2 = rankG1G2({ candidates, mode: 'explicit', state: new Map(), now: NOW, queryTerms: [], collapsedQuery: '', scopeDf: new Map(), scopeDocCount: 2 });
  assert.equal(g1g2.refused, true);
  assert.equal(g1g2.fallbackReason, FALLBACK_REASONS.NO_LEXICAL_EVIDENCE_SCAN);
  assert.deepEqual(g1g2.ranked.map((r) => r.recordId), ['rec-a', 'rec-b'], '回退 = A0 原序');
});

test('G1G2 在结构关联候选上诚实拒用', () => {
  const candidates = [
    { recordId: 'rec-assoc', spaceId: 'mira', position: 0, a0Score: 0.99, coverage: null, matchReason: ['association:same-subject+time-window', 'anchor:rec-b'], content: 'x', occurredAt: null, status: 'active', evidenceClass: 'structural-association' }
  ];
  const g1g2 = rankG1G2({ candidates, mode: 'ambient', state: new Map(), now: NOW, queryTerms: [], collapsedQuery: '', scopeDf: new Map(), scopeDocCount: 1 });
  assert.equal(g1g2.refused, true);
  assert.equal(g1g2.fallbackReason, FALLBACK_REASONS.NO_LEXICAL_EVIDENCE_ASSOCIATION);
});

test('路径 B 直连：关联候选无词元证据（coverage null / association reason）', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const harness = await createPathBHarness({
    spaceId: 'mira-b', records: MIRA_B_RECORDS, indexDir: dir, situation: '林然'
  });
  t.after(() => harness.close());
  assert.ok(harness.candidates.length >= 3);
  const assoc = harness.candidates.filter((c) => classifyEvidencePath({ matchReason: c.matchReason, coverage: c.coverage }) === 'structural-association');
  assert.ok(assoc.length >= 1, '至少一条结构关联候选');
  for (const c of assoc) {
    assert.equal(c.coverage, null);
    assert.ok(c.matchReason.some((m) => m.startsWith('association:')));
    assert.ok(c.matchReason.some((m) => m.startsWith('anchor:')));
  }
});

test('路径 B 跨空间隔离：other-b 的同 subject 记录不出现在 mira-b 查询', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const { OTHER_B_RECORDS } = await import('../fixtures/corpus-v3.mjs');
  const harness = await createPathBHarness({
    spaceId: 'mira-b', records: [...MIRA_B_RECORDS, ...OTHER_B_RECORDS], indexDir: dir, situation: '林然'
  });
  t.after(() => harness.close());
  assert.ok(!harness.candidates.some((c) => c.recordId === 'rec-b2-linran-note'));
});

test('tier 计算：idHit(T0) 与 phrase(T1) 的区分在真实候选上成立', () => {
  const queryTerms = termsForQuery('X-T30 相机');
  const collapsedQuery = 'x-t30相机';
  const t0 = computeTierFromReal({
    recordId: 'rec-x-t30-camera', content: '相机机身是X-T30，镜头18-55',
    matchReason: ['term:x-t30(ascii)', 'term:相机(cjk-2)', 'term:相(cjk-1)', 'term:机(cjk-1)', 'recency:0.900'],
    coverage: 1, queryTerms, collapsedQuery, scopeDf: new Map(), scopeDocCount: 2
  });
  assert.equal(t0.tier, 0);
  const t1 = computeTierFromReal({
    recordId: 'rec-camera-backup', content: 'X-T30 相机备用电池在抽屉',
    matchReason: ['term:x-t30(ascii)', 'term:相机(cjk-2)', 'term:相(cjk-1)', 'term:机(cjk-1)', 'recency:0.900'],
    coverage: 1, queryTerms, collapsedQuery, scopeDf: new Map(), scopeDocCount: 2
  });
  assert.equal(t1.tier, 1);
});

test('G3 explicit 恒不抑制；ambient 抑制且不改成员资格', () => {
  const candidates = [
    { recordId: 'rec-a', spaceId: 'mira', position: 0, a0Score: 2.0, coverage: 1, matchReason: ['term:游泳(cjk-2)'], content: 'x', occurredAt: '2026-10-30T10:00:00.000Z', status: 'active' },
    { recordId: 'rec-b', spaceId: 'mira', position: 1, a0Score: 1.9, coverage: 1, matchReason: ['term:游泳(cjk-2)'], content: 'y', occurredAt: '2026-10-01T10:00:00.000Z', status: 'active' }
  ];
  const state = new Map([['mira::rec-a', { reinforceTimesMs: [], lastDeliveryMs: NOW - 2 * 3_600_000, counts: {}, corrections: 0, confirmations: { authorized: 0, unauthorized: 0 } }]]);
  const explicitG3 = rankG3({ candidates, mode: 'explicit', state, now: NOW });
  assert.equal(explicitG3.changed, false);
  const ambientG3 = rankG3({ candidates, mode: 'ambient', state, now: NOW });
  assert.equal(ambientG3.changed, true);
  assert.deepEqual(ambientG3.ranked.map((r) => r.recordId), ['rec-b', 'rec-a']);
  const membership = ambientG3.ranked.map((r) => r.recordId).sort();
  assert.deepEqual(membership, ['rec-a', 'rec-b']);
});

test('G1G2 gate：boosted T2 不得越过 T1（真实形状）', () => {
  const queryTerms = termsForQuery('健身房 跑步');
  const collapsedQuery = '健身房跑步';
  const candidates = [
    { recordId: 'rec-gym-run', spaceId: 'mira', position: 0, a0Score: 1.94, coverage: 1, matchReason: ['term:健身房(cjk-2)'], content: '周末去健身房跑步一小时', occurredAt: '2026-10-21T10:00:00.000Z', status: 'active' },
    { recordId: 'rec-gym-treadmill', spaceId: 'mira', position: 1, a0Score: 1.97, coverage: 1, matchReason: ['term:健身房(cjk-2)'], content: '跑步前先去健身房拉伸', occurredAt: '2026-10-28T10:00:00.000Z', status: 'active' }
  ];
  const state = new Map([['mira::rec-gym-treadmill', { reinforceTimesMs: [NOW - 1 * 3_600_000, NOW - 2 * 3_600_000, NOW - 3 * 3_600_000, NOW - 4 * 3_600_000, NOW - 5 * 3_600_000, NOW - 6 * 3_600_000, NOW - 7 * 3_600_000, NOW - 8 * 3_600_000], lastDeliveryMs: null, counts: {}, corrections: 0, confirmations: { authorized: 0, unauthorized: 0 } }]]);
  const scopeDf = new Map();
  const g1g2 = rankG1G2({
    candidates, mode: 'explicit', state, now: NOW, queryTerms, collapsedQuery, scopeDf, scopeDocCount: 10,
    params: { recencyWindowDays: 120, halfLifeDays: 7, wStrength: 0.75, floor: 0.4, ceil: 2.25, suppressionWindowHours: 6, suppressionStrength: 0.5, suppressionDecayHours: 24, wCount: 0.5, actrDecay: 0.5, wActr: 0.35, minIntervalDays: 1 / 24, bEpsilon: 1e-12 }
  });
  assert.equal(g1g2.refused, false);
  assert.equal(g1g2.ranked[0].recordId, 'rec-gym-run', 'gate 把 boosted T2 压回 T1 之后');
  assert.ok(g1g2.gateMoves.length >= 1, 'gateMove 显式记录');
});

test('零副作用：影子查询前后修订号与派生态不变', async (t) => {
  const dir = makeTempDir('u-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件锁延迟：清理失败不影响测试结论 */ } });
  const harness = await createPathAHarness({ spaceId: 'mira', records: MIRA_RECORDS, engineMode: 'glm', indexDir: dir });
  t.after(() => harness.close());
  const before = await harness.svc.search({ spaceId: 'mira', query: '跑步', limit: 50 });
  const snapshot = JSON.stringify(before.records.map((r) => r.recordId));
  for (let i = 0; i < 5; i += 1) await harness.query({ query: '跑步' });
  const after = await harness.svc.search({ spaceId: 'mira', query: '跑步', limit: 50 });
  assert.equal(after.revision, before.revision, '查询不改变修订号');
  assert.equal(JSON.stringify(after.records.map((r) => r.recordId)), snapshot, '查询不改变排序');
});
