// 事件日志持久化与确定性重放。
// 独立派生事件存储（JSONL）：不写进正式 Experience，不冒充新事实。
// 重放承诺：同样的日志 + 同样的时钟 → 同样的激活与排名（重启/重建测试的依据）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { replayEvents, validateEvent } from './events.mjs';

export function saveEventLog(path, events) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return { path, count: lines.length, bytes: Buffer.byteLength(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8') };
}

export function loadEventLog(path) {
  const raw = readFileSync(path, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

// 从日志文件重放派生状态。validateEvent 保证畸形行显式失败而不是被吞掉。
export function replayFromFile(path) {
  return replayEvents(loadEventLog(path).map((e) => validateEvent(e)));
}

// 同一事件流、不同到达顺序 → 同一状态（激活是时间戳的函数，不是到达顺序的函数）。
export function replayShuffled(events) {
  const copy = events.slice();
  // 固定置换（非随机）：逆转顺序，足以证明顺序无关性且可复现。
  copy.reverse();
  return replayEvents(copy);
}
