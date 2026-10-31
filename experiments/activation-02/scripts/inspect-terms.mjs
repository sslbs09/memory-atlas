// 诊断辅助：打印给定情境下关键记录的词元命中明细（用于核对 fixture 推导）。
import { CandidatePool } from '../../activation-01/src/candidates.mjs';
import { corpus } from '../../activation-01/fixtures/scenarios.mjs';
import { termsForQuery } from '../../activation-01/src/tokenizer.mjs';

const pool = new CandidatePool(corpus());
const q = process.argv[2];
const rids = process.argv.slice(3);
console.log('situation:', q);
console.log('queryTerms:', termsForQuery(q).map((t) => `${t.term}(${t.kind})`).join(' '));
const total = new Set(termsForQuery(q).map((t) => t.term)).size;
for (const rid of rids) {
  const terms = pool.docTerms('personal', rid);
  const matched = termsForQuery(q).filter((t) => terms.has(t.term));
  const uniq = [...new Set(matched.map((m) => m.term))];
  console.log(rid.padEnd(22), `matched=${uniq.length}/${total}`, JSON.stringify(uniq));
}
