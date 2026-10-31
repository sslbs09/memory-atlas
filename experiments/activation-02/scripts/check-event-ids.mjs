// 事件 ID 重启碰撞诊断（任务书 §六）。
//
// 问题复现：activation-01 fixtures 的 eventUid 是模块级计数器，重启即清零。
// 用两个独立子进程模拟「重启前后」各生成同一 (spaceId, recordId) 的事件流，
// 展示 eventId 碰撞及其两种后果（静默吞事件 / 显式冲突）。
// 随后验证 EventIdFactory（boot nonce + resumeFrom）在同等条件下零碰撞。

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayEvents } from '../../activation-01/src/events.mjs';
import { EventIdFactory } from '../src/event-ids.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'results-v2');
mkdirSync(OUT, { recursive: true });

// 子进程：打印 fixtures eventHistory 为同一 (spaceId, recordId) 生成的 eventId。
// import 必须用 file:// URL（Windows 绝对路径不能直接作 ESM 说明符）。
const childPath = join(OUT, '_child-gen.mjs');
const fixturesUrl = new URL(`file:///${join(HERE, '..', '..', 'activation-01', 'fixtures', 'scenarios.mjs').replace(/\\/g, '/')}`).href;
writeFileSync(childPath, `
import { eventHistory } from ${JSON.stringify(fixturesUrl)};
const events = eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', rev: [5] });
console.log(JSON.stringify(events.map((e) => e.eventId)));
`, 'utf8');

const run = () => JSON.parse(execFileSync(process.execPath, [childPath], { encoding: 'utf8' }).trim());
const idsA = run();          // 「重启前」
const idsB = run();          // 「重启后」（新进程，计数器已清零）

const overlap = idsA.filter((id) => idsB.includes(id));

// 后果 A：同 eventId、同主体、同类型 → 静默 duplicate（真实第二次回忆被吞）。
let silentLoss = null;
try {
  const merged = [];
  const mk = (id, daysAgo) => ({
    eventId: id, spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited',
    occurredAt: new Date(Date.parse('2026-10-31T12:00:00.000Z') - daysAgo * 86_400_000).toISOString(),
    sourceEventId: null, provenance: {}, signalVersion: 1
  });
  merged.push(mk(idsA[0], 5), mk(idsB[0], 1));
  const state = replayEvents(merged);
  const entry = state.get('personal::rec-scifi-books');
  silentLoss = { mergedEventIds: [idsA[0], idsB[0]], reinforceCountAfterReplay: entry.reinforceTimesMs.length };
} catch (err) {
  silentLoss = { error: err.message };
}

// 后果 B：同 eventId、不同主体 → 显式拒绝。
let conflict = null;
try {
  replayEvents([
    { eventId: idsA[0], spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: '2026-10-26T12:00:00.000Z', sourceEventId: null, provenance: {}, signalVersion: 1 },
    { eventId: idsA[0], spaceId: 'work', recordId: 'rec-friday-demo', eventType: 'delivered_reference', occurredAt: '2026-10-30T12:00:00.000Z', sourceEventId: null, provenance: {}, signalVersion: 1 }
  ]);
  conflict = { rejected: false };
} catch (err) {
  conflict = { rejected: true, error: err.message };
}

// 修复验证：boot nonce 使重启后的新进程与旧日志零碰撞；resumeFrom 续接序号。
const legacyLog = idsA;
const factoryRestarted = new EventIdFactory({ prefix: 'ev', nonce: 'restartsim-aaaa' });
const newIds = Array.from({ length: idsA.length }, () => factoryRestarted.next('personal', 'rec-scifi-books'));
const overlapAfterFix = newIds.filter((id) => legacyLog.includes(id));

const factoryResumed = new EventIdFactory({ prefix: 'ev', nonce: 'restartsim-bbbb', resumeFrom: legacyLog });
const resumedIds = Array.from({ length: idsA.length }, () => factoryResumed.next('personal', 'rec-scifi-books'));
const overlapAfterResume = resumedIds.filter((id) => legacyLog.includes(id));

// 跨空间：同一工厂交替为两个空间生成 → id 全局唯一、互不污染。
const f = new EventIdFactory({ prefix: 'ev', nonce: 'spacesim-cccc' });
const interleaved = [];
for (let i = 0; i < 3; i += 1) {
  interleaved.push(f.next('personal', 'rec-a'), f.next('work', 'rec-a'));
}
const interleavedUnique = new Set(interleaved).size === interleaved.length;

// 幂等回归：显式复用同一 eventId 仍被折叠（语义不变）。
const dup = replayEvents([
  { eventId: 'x-1', spaceId: 'personal', recordId: 'r', eventType: 'user_revisited', occurredAt: '2026-10-30T12:00:00.000Z', sourceEventId: null, provenance: {}, signalVersion: 1 },
  { eventId: 'x-1', spaceId: 'personal', recordId: 'r', eventType: 'user_revisited', occurredAt: '2026-10-30T12:00:00.000Z', sourceEventId: null, provenance: {}, signalVersion: 1 }
]);
const idempotent = dup.get('personal::r').reinforceTimesMs.length === 1;

const report = {
  meta: { generatedAt: new Date().toISOString() },
  legacy: {
    childProcessIdsRunA: idsA,
    childProcessIdsRunB: idsB,
    overlap,
    verdict: overlap.length > 0
      ? `确认真实冲突：重启后同 (spaceId, recordId) 生成完全相同的 eventId（重叠 ${overlap.length}/${idsA.length}）`
      : '未复现冲突',
    silentLoss,
    conflict,
    crossSpacePollution: '无：id 内嵌 spaceId，同进程跨空间不碰撞'
  },
  fixed: {
    overlapAfterFix: overlapAfterFix.length,
    overlapAfterResume: overlapAfterResume.length,
    resumedFirstId: resumedIds[0],
    interleavedUnique,
    idempotentPreserved: idempotent,
    verdict: overlapAfterFix.length === 0 && overlapAfterResume.length === 0 && interleavedUnique && idempotent
      ? '修复有效：nonce 隔离重启碰撞、resumeFrom 续接序号、跨空间唯一、幂等语义不变'
      : '修复不充分'
  }
};

writeFileSync(join(OUT, 'event-ids-check.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
