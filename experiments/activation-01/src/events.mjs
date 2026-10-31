// 派生事件存储：可审计、可重放、幂等。
//
// 语义（activation-01 任务书 §四）：
//   candidate_retrieved   后台查询把记录列为候选。永不强化。
//   selected_for_context  内部管线把记录选入上下文。永不强化（多次内部查询、
//                         用户完全没参与 → 不得积累任何激活）。
//   generated_reference   模型生成内容引用了记录，但尚未投递。不算用户已看见。
//   delivered_reference   成功投递到用户端。只更新"最近提及"状态，永不强化
//                         （防模型自我重复召回的自我强化循环）。
//   user_revisited        用户主动重提该记录内容。唯一强化类事件。
//   user_confirmed        用户确认内容。潜在证据来源，但必须走正式授权路径；
//                         激活引擎不得写入正式记录，也不得借此强化激活。
//   user_corrected        用户纠正内容。永不被旧记忆的高分覆盖；激活引擎只记录
//                         不应用，效力变更必须由正式权威（Core）完成。
//   ui_inspected          管理 UI 查看。只读行为，永不改变任何激活状态。
//
// 幂等：eventId 全局唯一；同 sourceEventId（跨工具转发同一事件）在同一空间内
// 只算一次；同 sourceEventId 指向不同 recordId 视为上游异常，拒绝。
//
// 时间：occurredAt = 真实交互时间；observedAt = 引擎观测时间。二者至少一个。
// 没有真实观测到的事件不得补造——不允许无 observedAt 的"补录"。

export const EVENT_TYPES = Object.freeze([
  'candidate_retrieved',
  'selected_for_context',
  'generated_reference',
  'delivered_reference',
  'user_revisited',
  'user_confirmed',
  'user_corrected',
  'ui_inspected'
]);

export const REINFORCING_TYPES = Object.freeze(new Set(['user_revisited']));
export const DELIVERY_TYPES = Object.freeze(new Set(['delivered_reference']));
// 只读类事件：连最近提及状态都不允许碰。
export const READONLY_TYPES = Object.freeze(new Set([
  'candidate_retrieved', 'selected_for_context', 'generated_reference', 'ui_inspected'
]));

export const SIGNAL_VERSION = 1;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'ACT_EVENT_INVALID' });
}

function parseIso(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// 校验并规范化一条事件。任何字段缺失/形状不对都拒绝，绝不静默修补。
export function validateEvent(input) {
  if (!input || typeof input !== 'object') throw invalid('event 必须是对象');
  const { eventId, spaceId, recordId, eventType } = input;
  if (typeof eventId !== 'string' || !eventId) throw invalid('eventId 必须是非空字符串');
  if (typeof spaceId !== 'string' || !spaceId) throw invalid('spaceId 必须是非空字符串');
  if (typeof recordId !== 'string' || !recordId) throw invalid('recordId 必须是非空字符串');
  if (!EVENT_TYPES.includes(eventType)) {
    throw invalid(`eventType 必须是 ${EVENT_TYPES.join(' / ')}`);
  }
  const observedAt = input.observedAt ?? null;
  const occurredAt = input.occurredAt ?? null;
  if (observedAt === null && occurredAt === null) {
    throw invalid('occurredAt 与 observedAt 至少需要一个（没有真实观测不得补造事件）');
  }
  const observedMs = observedAt !== null ? parseIso(observedAt) : null;
  if (observedAt !== null && observedMs === null) throw invalid('observedAt 不是可解析的 ISO 时间');
  const occurredMs = occurredAt !== null ? parseIso(occurredAt) : null;
  if (occurredAt !== null && occurredMs === null) throw invalid('occurredAt 不是可解析的 ISO 时间');
  const sourceEventId = typeof input.sourceEventId === 'string' && input.sourceEventId ? input.sourceEventId : null;
  const provenance = input.provenance && typeof input.provenance === 'object'
    ? { ...input.provenance }
    : {};
  const revision = input.recordRevision === undefined ? null : Number(input.recordRevision);
  if (revision !== null && !Number.isSafeInteger(revision)) throw invalid('recordRevision 必须是安全整数');
  return {
    eventId,
    spaceId,
    recordId,
    recordRevision: revision,
    eventType,
    occurredAt: occurredAt ?? observedAt,   // 规范化：缺省即观测时间
    observedAt: observedAt ?? occurredAt,
    occurredMs: occurredMs ?? observedMs,
    observedMs: observedMs ?? occurredMs,
    sourceEventId,
    provenance,
    formalAuthorization: input.formalAuthorization === true,
    signalVersion: input.signalVersion ?? SIGNAL_VERSION
  };
}

// 事件账本：append-only。recordEvent 拒绝或去重时原账本不变。
export class EventLog {
  constructor() {
    this.#events = [];
    this.#byEventId = new Map();
    this.#bySourceKey = new Map(); // `${spaceId}::${sourceEventId}` -> { eventId, recordId }
  }

  #events;
  #byEventId;
  #bySourceKey;

  // 返回 { status: 'recorded' | 'duplicate' | 'rejected', reason?, event? }。
  // duplicate 是幂等成功：重放同一事件流得到同样状态。
  recordEvent(input) {
    let event;
    try {
      event = validateEvent(input);
    } catch (err) {
      return { status: 'rejected', reason: err.message };
    }
    if (this.#byEventId.has(event.eventId)) {
      const prior = this.#byEventId.get(event.eventId);
      if (prior.spaceId === event.spaceId && prior.recordId === event.recordId
        && prior.eventType === event.eventType) {
        return { status: 'duplicate', reason: 'duplicate-eventId', event: prior };
      }
      return { status: 'rejected', reason: 'eventId-conflict:同 eventId 携带不同主体' };
    }
    if (event.sourceEventId !== null) {
      const sourceKey = `${event.spaceId}::${event.sourceEventId}`;
      const prior = this.#bySourceKey.get(sourceKey);
      if (prior) {
        if (prior.recordId === event.recordId && prior.eventType === event.eventType) {
          // 同一来源事件跨工具转发：只算一次，不产生第二次强化。
          return { status: 'duplicate', reason: 'duplicate-sourceEventId', event: this.#byEventId.get(prior.eventId) };
        }
        return { status: 'rejected', reason: 'source-event-conflict:同 sourceEventId 指向不同记录' };
      }
      this.#bySourceKey.set(sourceKey, { eventId: event.eventId, recordId: event.recordId, eventType: event.eventType });
    }
    this.#byEventId.set(event.eventId, event);
    this.#events.push(event);
    return { status: 'recorded', event };
  }

  events() { return this.#events.slice(); }
  get size() { return this.#events.length; }
}

// 确定性重放：事件顺序无关（激活是时间戳的函数，不是到达顺序的函数）。
// 重放路径与摄入路径（EventLog）执行同一套幂等规则：同 eventId 的重复、
// 同 sourceEventId 的跨工具转发只折叠一次；冲突显式抛错，绝不静默吞掉。
export function replayEvents(events) {
  const state = new Map();
  const byEventId = new Map();
  const bySourceKey = new Map();
  for (const raw of events) {
    const e = validateEvent(raw);
    const priorId = byEventId.get(e.eventId);
    if (priorId) {
      if (priorId.spaceId === e.spaceId && priorId.recordId === e.recordId
        && priorId.eventType === e.eventType) continue; // 幂等重放：重复行
      throw invalid('eventId-conflict:同 eventId 携带不同主体');
    }
    if (e.sourceEventId !== null) {
      const sourceKey = `${e.spaceId}::${e.sourceEventId}`;
      const priorSrc = bySourceKey.get(sourceKey);
      if (priorSrc) {
        if (priorSrc.recordId === e.recordId && priorSrc.eventType === e.eventType) {
          continue; // 同一来源事件跨工具转发：只算一次
        }
        throw invalid('source-event-conflict:同 sourceEventId 指向不同记录');
      }
      bySourceKey.set(sourceKey, { recordId: e.recordId, eventType: e.eventType });
    }
    byEventId.set(e.eventId, e);
    const key = `${e.spaceId}::${e.recordId}`;
    let entry = state.get(key);
    if (!entry) {
      entry = {
        spaceId: e.spaceId,
        recordId: e.recordId,
        reinforceTimesMs: [],
        lastDeliveryMs: null,
        counts: {},
        corrections: 0,
        confirmations: { authorized: 0, unauthorized: 0 }
      };
      state.set(key, entry);
    }
    entry.counts[e.eventType] = (entry.counts[e.eventType] ?? 0) + 1;
    if (REINFORCING_TYPES.has(e.eventType)) {
      entry.reinforceTimesMs.push(e.occurredMs);
    }
    if (DELIVERY_TYPES.has(e.eventType)) {
      // 乱序/重复时间戳：取 max，即"最近一次真实投递"。
      entry.lastDeliveryMs = entry.lastDeliveryMs === null
        ? e.occurredMs
        : Math.max(entry.lastDeliveryMs, e.occurredMs);
    }
    if (e.eventType === 'user_corrected') entry.corrections += 1;
    if (e.eventType === 'user_confirmed') {
      if (e.formalAuthorization) entry.confirmations.authorized += 1;
      else entry.confirmations.unauthorized += 1;
    }
  }
  // 规范化：强化时间升序，便于解释输出稳定。
  for (const entry of state.values()) entry.reinforceTimesMs.sort((a, b) => a - b);
  return state;
}

export function emptyActivation() {
  return new Map();
}
