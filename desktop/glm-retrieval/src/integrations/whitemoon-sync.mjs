// WhiteMoon 集成适配层（可选，独立于检索引擎核心）。
//
// 引擎核心（tokenize/store/adapter/graph/association）零 WhiteMoon 依赖，可以
// 完全独立运行（Memory Atlas 方向的硬要求）。本文件是"从 WhiteMoon 正式
// Instance 文档到通用记录流"的只读适配器：
//   - 只读：绝不写 Core 的任何文件；效力判定完全沿用 Core 自己的
//     memory-control.js 推导（通过 WM_CORE_SRC 指向，默认 Qoder 工作树）。
//   - active（含 correct 型 memory-control，视为当前有效断言）→ 交付为
//     status:'active' 的记录；retract 型 control 记录与其目标 → 投影移除。
//   - supersedes 字段来自 control payload，驱动图投影的 supersedes 边。

import { pathToFileURL } from 'node:url';

const DEFAULT_CORE_SRC = '<WhiteMoon repo>/work/universal-memory-v0.1/core/src/memory-control.js';

let cached = null;
async function coreSemantics() {
  if (!cached) {
    cached = await import(pathToFileURL(process.env.WM_CORE_SRC ?? DEFAULT_CORE_SRC).href);
  }
  return cached; // { memoryHistory, readableExperience, MEMORY_CONTROL_TYPE }
}

// 一个 Instance JSON 文档 → { upserts: [...records], removals: [...] }
export async function recordsFromInstanceDoc(doc) {
  const { memoryHistory, readableExperience, MEMORY_CONTROL_TYPE } = await coreSemantics();
  const history = memoryHistory(doc.experiences);
  const upserts = [];
  const removals = [];
  for (const experience of doc.experiences) {
    const status = history.statuses.get(experience.id);
    const payload = experience.payload ?? {};
    const origin = typeof payload.origin === 'object' && payload.origin !== null ? payload.origin : {};
    const base = {
      recordId: experience.id,
      instanceId: doc.instanceId,
      revision: experience.recordSequence ?? 0,
      text: readableExperience(experience),
      status,
      sourceKind: payload.source ?? origin.channel ?? 'formal',
      sourceId: typeof origin.clientId === 'string' ? origin.clientId : null,
      eventId: typeof origin.actionId === 'string' ? origin.actionId : null,
      subject: typeof origin.subject === 'string' ? origin.subject : null,
      occurredAt: experience.timestamp ?? null,
      acceptedAt: experience.acceptedAt ?? null
    };
    if (experience.type === MEMORY_CONTROL_TYPE) {
      if (experience.payload.action === 'correct') {
        upserts.push({ ...base, supersedes: experience.payload.targetExperienceId });
      } else {
        // retract 型 control：自身状态 recorded，目标 retracted——投影移除。
        removals.push({ instanceId: doc.instanceId, recordId: experience.payload.targetExperienceId });
        removals.push({ instanceId: doc.instanceId, recordId: experience.id });
      }
      continue;
    }
    if (status === 'active') upserts.push(base);
    else removals.push({ instanceId: doc.instanceId, recordId: experience.id });
  }
  return { upserts, removals };
}

// 从一组 Instance 文档全量重建（rebuildIndex 路径）。
export async function rebuildFromInstanceDocs(adapter, docs) {
  const allRecords = [];
  for (const doc of docs) {
    const { upserts } = await recordsFromInstanceDoc(doc);
    allRecords.push(...upserts);
  }
  return adapter.rebuildIndex(allRecords);
}

// 增量同步：先应用 upserts，再应用 removals（撤回/失效投影清除）。
export async function syncInstanceDoc(adapter, doc) {
  const { upserts, removals } = await recordsFromInstanceDoc(doc);
  const upsertResults = adapter.upsertRecords(upserts);
  const removed = adapter.removeRecords(removals);
  return { upsertResults, removed };
}
