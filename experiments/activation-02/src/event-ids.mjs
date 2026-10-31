// 事件身份生成（activation-02 任务书 §六）。
//
// 发现（check-event-ids 的诊断结论）：
//   activation-01 的 fixtures/scenarios.mjs 用模块级单调计数器（eventUid）生成
//   eventId（形如 `ev-<spaceId>-<recordId>-<n>`）。它是进程内状态：
//     1. 进程重启后从 1 重新计数；
//     2. 同一 (spaceId, recordId) 在新进程里再次生成事件 → 与已持久化日志中的
//        eventId 碰撞：同类型同主体被 replayEvents 静默折叠为 duplicate（真实
//        事件被吞），不同主体则显式抛 eventId-conflict；
//     3. 跨空间：id 内嵌 spaceId，同进程内不会互相污染（这一条是安全的）。
//
// 最小修复（不引入分布式 ID 服务）：
//   - 进程启动 nonce（默认时间戳36进制 + 随机段）：重启后的新进程即使不读日志，
//     生成的 id 也与历史日志结构性不可能碰撞；
//   - 可选 resumeFrom（读已有日志续接最大序号）：在需要「同进程语义延续」时，
//     序号从历史最大值之后继续，避免新旧格式混排时同 id；
//   - 幂等语义不变：幂等仍由「调用方对同一逻辑事件复用同一 eventId /
//     sourceEventId」承担，本模块只负责为**新**事件生成不碰撞的身份。

import { randomBytes } from 'node:crypto';

export function bootNonce(now = Date.now()) {
  return `${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

export class EventIdFactory {
  // resumeFrom: 已持久化的 eventId 列表（可选）。同前缀且末段为整数的 id 会被
  // 解析出序号，新序号从最大值之后继续。
  constructor({ prefix = 'ev', nonce = bootNonce(), resumeFrom = [] } = {}) {
    if (typeof prefix !== 'string' || !prefix) throw new Error('prefix 必须是非空字符串');
    this.prefix = prefix;
    this.nonce = nonce;
    this.seq = 0;
    for (const id of resumeFrom) {
      const n = tailSeq(id, prefix);
      if (n !== null && n >= this.seq) this.seq = n;
    }
  }

  next(spaceId, recordId) {
    this.seq += 1;
    return `${this.prefix}-${spaceId}-${recordId}-${this.nonce}-${this.seq}`;
  }
}

export function createEventIdFactory(options) {
  return new EventIdFactory(options);
}

// 末段序号解析：`<prefix>-...-<int>` → int；不匹配返回 null。
// 旧格式（activation-01 fixtures：`ev-<spaceId>-<recordId>-<n>`）与新格式
// （`ev-<spaceId>-<recordId>-<nonce>-<n>`）都以其为续接依据。
export function tailSeq(id, prefix) {
  if (typeof id !== 'string' || !id.startsWith(`${prefix}-`)) return null;
  const tail = id.slice(id.lastIndexOf('-') + 1);
  if (!/^\d+$/.test(tail)) return null;
  const n = Number(tail);
  return Number.isSafeInteger(n) ? n : null;
}

// 从日志文件内容（事件对象数组）续接的便捷封装。
export function resumeFromEvents(events, prefix = 'ev') {
  return createEventIdFactory({ prefix, resumeFrom: events.map((e) => e.eventId) });
}
