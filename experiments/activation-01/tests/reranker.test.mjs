// Activation Reranker 适配点测试：默认关闭、不改变成员资格、确定性重排。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivationReranker } from '../src/reranker.mjs';
import { CandidatePool } from '../src/candidates.mjs';
import { corpus, EVAL_NOW, eventHistory } from '../fixtures/scenarios.mjs';

const NOW = EVAL_NOW;
const pool = new CandidatePool(corpus());

test('默认关闭：rerank 原样返回，不触碰排序', () => {
  const rr = createActivationReranker();
  assert.equal(rr.enabled, false, 'activation.enabled 默认必须为 false');
  const candidates = [
    { recordId: 'rec-badminton', instanceId: 'personal', score: 1.5, coverage: 0.5, matchedTerms: [] },
    { recordId: 'rec-allergy-peanut', instanceId: 'personal', score: 0.9, coverage: 0.3, matchedTerms: [] }
  ];
  const out = rr.rerank({ candidates, events: [], pool, now: NOW });
  assert.equal(out.enabled, false);
  assert.deepEqual(out.candidates, candidates);
  assert.deepEqual(out.candidates.map((c) => c.score), [1.5, 0.9]);
});

test('开启后：确定性重排 + 解释，不改变候选集成员', () => {
  const rr = createActivationReranker({ enabled: true, strategy: 'A2', params: undefined });
  const events = eventHistory({ spaceId: 'personal', recordId: 'rec-badminton', rev: [1, 2, 3] });
  const candidates = [
    { recordId: 'rec-allergy-peanut', instanceId: 'personal', score: 1.0, coverage: 1, matchedTerms: [] },
    { recordId: 'rec-badminton', instanceId: 'personal', score: 0.9, coverage: 1, matchedTerms: [] }
  ];
  const out = rr.rerank({ candidates, events, pool, now: NOW });
  assert.equal(out.enabled, true);
  assert.equal(out.candidates.length, 2, '成员资格不变');
  assert.deepEqual(
    out.candidates.map((c) => c.recordId).sort(),
    candidates.map((c) => c.recordId).sort()
  );
  assert.equal(out.candidates[0].recordId, 'rec-badminton', '近期重提的记录应上升');
  assert.ok(out.explanations.every((e) => Array.isArray(e.reasons)));
  const again = rr.rerank({ candidates, events, pool, now: NOW });
  assert.deepEqual(out.candidates, again.candidates);
});

test('开启后：候选不在语料中 → 显式失败（不静默吞掉）', () => {
  const rr = createActivationReranker({ enabled: true, strategy: 'A1' });
  assert.throws(
    () => rr.rerank({ candidates: [{ recordId: 'rec-ghost', instanceId: 'personal', score: 1, coverage: 1, matchedTerms: [] }], events: [], pool, now: NOW }),
    /不在语料中/
  );
});

test('未知策略在构造期即拒绝', () => {
  assert.throws(() => createActivationReranker({ strategy: 'A9' }), /未知策略/);
});
