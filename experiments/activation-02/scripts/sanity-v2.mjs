// holdout-v2 结构健全性检查（不运行任何排序/激活逻辑）。
// 只验证：期望引用的 recordId 存在、事件可被校验/重放、场景字段齐全。
// 这是预注册纪律的一部分：期望冻结在先，策略实现在后。

import { CandidatePool } from '../../activation-01/src/candidates.mjs';
import { replayEvents, validateEvent } from '../../activation-01/src/events.mjs';
import { corpus } from '../../activation-01/fixtures/scenarios.mjs';
import { holdoutV2Scenarios, HOLDOUT_V2_META } from '../fixtures/holdout-v2.mjs';

const pool = new CandidatePool(corpus());
const knownIds = new Set(pool.allRecords().map((r) => r.recordId));
const scenarios = holdoutV2Scenarios();

let errors = 0;
const fail = (msg) => { errors += 1; console.error('FAIL:', msg); };

if (scenarios.length !== HOLDOUT_V2_META.scenarioCount) {
  fail(`scenarioCount 不一致：meta=${HOLDOUT_V2_META.scenarioCount} actual=${scenarios.length}`);
}
if (scenarios.length < 20 || scenarios.length > 30) {
  fail(`场景数 ${scenarios.length} 不在任务书要求的 20–30 范围`);
}

const seenIds = new Set();
const EXPECT_KEYS = new Set(['top1', 'inTop', 'inCandidates', 'absent', 'noMatch', 'orderAfter',
  'identityToZeroEvents', 'reinforceCount', 'sameAsSingleRevisit', 'finiteScores',
  'replayOrderInsensitive', 'workActivationZero', 'strategyExpect', 'candidateCount', 'replayRoundTrip']);
const FAMILIES = new Set(['explicit', 'ambient', 'suppression', 'structural']);

for (const s of scenarios) {
  if (seenIds.has(s.id)) fail(`重复场景 id: ${s.id}`);
  seenIds.add(s.id);
  if (!FAMILIES.has(s.family)) fail(`${s.id}: family 非法 ${s.family}`);
  if (!s.derivation || !Array.isArray(s.derivation) || s.derivation.length === 0) fail(`${s.id}: 缺 derivation`);
  if (s.mode === 'explicit' && !s.query) fail(`${s.id}: explicit 场景缺 query`);
  if (s.mode === 'ambient' && !s.situation) fail(`${s.id}: ambient 场景缺 situation`);

  // 期望引用的 recordId 必须存在于语料
  const checkIds = (ids, where) => {
    for (const rid of ids) {
      if (!knownIds.has(rid)) fail(`${s.id} ${where}: 未知 recordId ${rid}`);
    }
  };
  const walkExpect = (expect, where) => {
    for (const key of Object.keys(expect)) {
      if (!EXPECT_KEYS.has(key)) fail(`${s.id} ${where}: 未知 expect 键 ${key}`);
      const v = expect[key];
      if (key === 'top1' && typeof v === 'string') checkIds([v], `${where}.top1`);
      if (key === 'inCandidates' || key === 'absent') checkIds(v, `${where}.${key}`);
      if (key === 'inTop') checkIds(v.recordIds, `${where}.inTop`);
      if (key === 'orderAfter') { checkIds([v.recordId, v.after], `${where}.orderAfter`); }
      if (key === 'strategyExpect') {
        for (const [sid, sub] of Object.entries(v)) walkExpect(sub, `${where}.strategyExpect.${sid}`);
      }
    }
  };
  walkExpect(s.expect, 'expect');

  // 事件必须全部可校验、可重放
  try {
    for (const e of s.events) validateEvent(e);
    replayEvents(s.events);
  } catch (err) {
    fail(`${s.id}: 事件重放失败 — ${err.message}`);
  }
}

// 类别覆盖核对（任务书 §四 要求的 13 类）
const categoryCoverage = {
  '高频无关记忆': ['Q1-ambient-freq-intrusion-bigram-quality', 'Q5-recent-trivial-intruder-single-revisit', 'E4-explicit-high-freq-vs-current-plan'],
  '不同词元质量': ['Q5-recent-trivial-intruder-single-revisit', 'Q7-recent-mention-strong-recall', 'Q9-uncommitted-umbrella-beats-commitment'],
  '中文单字误命中': ['Q2-single-char-noise-user-revisit'],
  '短语与散落单字竞争': ['Q5-recent-trivial-intruder-single-revisit', 'Q7-recent-mention-strong-recall'],
  '长期未完成约定': ['Q3-old-commitment-ambient-sink', 'Q9-uncommitted-umbrella-beats-commitment'],
  '近期小事': ['Q4-single-candidate-trivial', 'S1-suppression-window'],
  '最近主动提及': ['Q7-recent-mention-strong-recall', 'Q10-same-tier-legitimate-uplift'],
  '用户明确追问': ['E1-explicit-followup-just-delivered', 'E2-old-commitment-explicit'],
  '单次合法旧记忆重提': ['Q11-single-revisit-weak-boost', 'Q10-same-tier-legitimate-uplift'],
  '同源重复事件': ['X1-same-source-duplicate'],
  '跨空间隔离': ['Q8-cross-space-isolation'],
  '已撤回的高激活旧事实': ['E5-retracted-unreachable-explicit', 'Q6-retracted-ambient-unreachable'],
  '重启和事件重放': ['X2-restart-replay-identity']
};
for (const [cat, ids] of Object.entries(categoryCoverage)) {
  for (const id of ids) {
    if (!seenIds.has(id)) fail(`类别「${cat}」引用的 scenario 不存在: ${id}`);
  }
}

// family 分布
const byFamily = {};
for (const s of scenarios) byFamily[s.family] = (byFamily[s.family] ?? 0) + 1;

if (errors === 0) {
  console.log(`holdout-v2 sanity OK: ${scenarios.length} 场景，family 分布`, byFamily);
  console.log('类别覆盖:', Object.keys(categoryCoverage).length, '类全部映射到存在场景');
} else {
  console.error(`holdout-v2 sanity FAILED: ${errors} 项`);
  process.exit(1);
}
