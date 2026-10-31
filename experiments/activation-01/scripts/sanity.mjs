// 评价集健全性检查：打印每个用例的候选集与 coverage，验证非退化。
// 这个脚本只读 fixtures，不参与正式评估。
import { CandidatePool } from '../src/candidates.mjs';
import { corpus, baseScenarios, holdoutScenarios, tuningScenarios, EVAL_NOW } from '../fixtures/scenarios.mjs';

const pool = new CandidatePool(corpus());
console.log(`corpus: ${pool.recordCount} records`);

for (const s of baseScenarios()) {
  const specs = s.querySpecs ?? s.queries.map((q) => ({ q, spaceIds: s.spaceIds }));
  for (const spec of specs) {
    let cands;
    try {
      cands = pool.explicitCandidates({ q: spec.q, spaceIds: spec.spaceIds });
    } catch (e) {
      console.log(`${s.id} q="${spec.q}" ERROR ${e.message}`);
      continue;
    }
    console.log(`${s.id} q="${spec.q}" -> [${cands.map((c) => `${c.record.spaceId}/${c.record.recordId}:${c.coverage.toFixed(2)}`).join(', ') || 'NO_MATCH'}]`);
  }
}

console.log('\n--- ambient ---');
for (const s of [...holdoutScenarios(), ...tuningScenarios()]) {
  if (s.mode !== 'ambient') continue;
  const cands = pool.ambientCandidates({ situation: s.situation, spaceIds: s.spaceIds });
  console.log(`${s.id} sit="${s.situation}"`);
  for (const c of cands.sort((a, b) => b.coverage - a.coverage)) {
    console.log(`   ${c.record.recordId} cov=${c.coverage.toFixed(3)} [${c.matchedTerms.map((t) => t.term).join(',')}]`);
  }
}

console.log('\n--- dynamic explicit ---');
for (const s of holdoutScenarios()) {
  if (s.mode !== 'explicit') continue;
  const cands = pool.explicitCandidates({ q: s.query, spaceIds: s.spaceIds });
  console.log(`${s.id} q="${s.query}" -> [${cands.map((c) => c.record.recordId).join(', ') || 'NO_MATCH'}]`);
}

console.log(`\nEVAL_NOW = ${new Date(EVAL_NOW).toISOString()}`);
