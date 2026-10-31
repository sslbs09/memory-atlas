// 冻结记录：holdout-v3 / 语料的 sha256 + 首次运行前提交要求。
// 用法：node scripts/freeze-hash.mjs  → results-v3/freeze.json

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, '..');
const OUT = path.join(BASE, 'results-v3', 'freeze.json');

const FILES = [
  'fixtures/corpus-v3.mjs',
  'fixtures/holdout-v3.mjs',
  'src/real-harness.mjs',
  'src/evidence.mjs',
  'src/shadow-strategies.mjs',
  'src/shadow-runner.mjs',
  'src/event-bridge.mjs'
];

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const files = Object.fromEntries(FILES.map((f) => [f, sha256File(path.join(BASE, f))]));
const scenarioCount = 30;
const payload = {
  frozenAt: new Date().toISOString(),
  discipline: '本哈希在第一次 run-eval-v3 之前生成并随冻结 commit 提交；任何后续修改必须记录在 holdout-v3.mjs 的 AMENDMENTS，受影响场景不再计入完整 holdout。',
  scenarioCount,
  files
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
console.log(`freeze → ${OUT}`);
for (const [f, h] of Object.entries(files)) console.log(`  ${h.slice(0, 12)}…  ${f}`);
