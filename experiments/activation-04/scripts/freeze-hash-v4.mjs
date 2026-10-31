// 冻结哈希（activation-04）—— holdout-v4 语料 + 场景 + 归因代码的 sha256。
// 冻结 commit 必须先于任何策略运行（沿用 activation-03 §五纪律）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const FILES = [
  'fixtures/corpus-v4.mjs',
  'fixtures/holdout-v4.mjs',
  'src/attribution-strategies.mjs',
  'src/attribution-runner.mjs',
  'scripts/run-attribution.mjs',
  'scripts/probe-plumbing-v4.mjs',
  'results-v4/probe-plumbing.json'
];

const hashes = {};
for (const rel of FILES) {
  hashes[rel] = createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

const out = {
  id: 'holdout-v4-freeze',
  frozenAt: new Date().toISOString(),
  discipline: '本 commit（fixtures + 归因代码 + 管道探针结果）先于任何五策略运行；运行后不得修改 relevance/forbidden。',
  files: hashes
};
fs.writeFileSync(path.join(ROOT, 'results-v4', 'freeze.json'), JSON.stringify(out, null, 2), 'utf8');
console.error(`冻结哈希 → results-v4/freeze.json（${FILES.length} 个文件）`);
