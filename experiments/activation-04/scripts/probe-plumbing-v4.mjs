// 冻结前管道探针（activation-04）—— 只验证「真实 AND 检索能到达预期候选成员」，
// 不运行、不查看任何策略排序输出（冻结纪律：策略运行必须发生在 freeze commit 之后）。
//
// 断言：expectedCandidates[scenario] ⊆ 实际候选集（额外噪声候选合法）。
// 任何失败都要在冻结前修正语料 content（输入侧 plumbing），不得动 relevance/forbidden。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPathAHarness, createPathBHarness, makeTempDir } from '../../activation-03/src/real-harness.mjs';
import { holdoutV4Scenarios, PROBE_V4 } from '../fixtures/holdout-v4.mjs';
import { NOVA_RECORDS, NOVA_B_RECORDS } from '../fixtures/corpus-v4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const scenarios = holdoutV4Scenarios();
  const failures = [];
  const report = [];

  for (const scenario of scenarios) {
    const effectiveQuery = scenario.mode === 'explicit' ? scenario.query : scenario.situation;
    let candidateIds;
    if (scenario.path === 'B') {
      const dir = makeTempDir('probe-b4-');
      const harness = await createPathBHarness({
        spaceId: scenario.spaces[0], records: NOVA_B_RECORDS, indexDir: dir, situation: effectiveQuery
      });
      candidateIds = harness.candidates.map((c) => c.recordId);
      harness.close();
    } else {
      const dir = makeTempDir('probe-a4-');
      const harness = await createPathAHarness({
        spaceId: 'nova', records: NOVA_RECORDS, engineMode: 'glm', indexDir: dir
      });
      const response = await harness.query({ query: effectiveQuery, limit: 50 });
      candidateIds = response.candidates.map((c) => c.recordId);
      harness.close();
    }
    const expected = PROBE_V4.expectedCandidates[scenario.id] ?? [];
    const missing = expected.filter((id) => !candidateIds.includes(id));
    const forbiddenLeak = candidateIds.filter((id) => id === 'rec-bank-password');
    report.push({ scenario: scenario.id, candidateIds, expected, missing });
    if (missing.length > 0) failures.push(`${scenario.id}: 预期候选不可达 ${missing.join(',')}（实际 ${candidateIds.join(',')}）`);
    if (forbiddenLeak.length > 0) failures.push(`${scenario.id}: retracted 记录泄漏到候选集`);
  }

  const out = { ranAt: new Date().toISOString(), report, failures };
  fs.mkdirSync(path.join(HERE, '..', 'results-v4'), { recursive: true });
  fs.writeFileSync(path.join(HERE, '..', 'results-v4', 'probe-plumbing.json'), JSON.stringify(out, null, 2), 'utf8');
  if (failures.length > 0) {
    console.error('PROBE FAIL:\n' + failures.join('\n'));
    process.exit(1);
  }
  console.error(`PROBE OK: ${scenarios.length} 场景的预期候选全部可达，retracted 无泄漏 → results-v4/probe-plumbing.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
