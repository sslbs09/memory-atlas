// Event Bridge（实验性）—— 把真实 API 生命周期的可观测时刻映射为激活事件。
//
// 本阶段红线：只在本实验分支内使用，不接入正式用户会话链路；不修改 Atlas /
// WhiteMoon 的正式记忆权威。桥的唯一职责是**回答“事件在什么时刻才允许记录”**，
// 并在合成生命周期测试里逐条验证（tests/event-bridge.test.mjs）。
//
// 生命周期来源（对照真实 API，凭据字段缺失即拒绝，绝不静默修补）：
//   用户主动重提        用户会话观察到 utterance 指向某记录（provenance.surface='user'
//                       且 utteranceObserved=true）→ user_revisited（唯一强化类）
//   模型生成引用        生成管线引用了记录（generation_cited）→ generated_reference
//                       只读类：永不强化，也永不等价于“用户已看见”
//   回答实际投递        仅当投递通道确认（deliveryConfirmed=true）→
//                       delivered_reference（只更新最近投递，永不强化）；
//                       只有生成、没有投递确认 → 只允许 generated_reference
//   用户纠正            仅当走正式权威（Atlas control 回执 operationId/
//                       formalAuthorization）→ user_corrected；激活引擎只记录
//                       不应用，效力变更属正式权威
//   同源重复转发        sourceEventId 幂等：同空间同 sourceEventId 只记一次
//                       （EventLog 既有语义，直接复用）
//   服务重启            EventIdFactory（activation-02 nonce 方案）重启后新身份；
//                       不引入分布式 ID 服务
//   内部/影子查询       candidate_retrieved 形状只允许来自内部管线审计；
//                       shadow 查询一律拒绝（SHADOW_QUERY_NOT_RECORDABLE），
//                       保证影子运行零激活副作用
//
// 诚实失败语义：formal 写入成功而事件账本追加失败时，桥必须返回
// { formalWrite:'ok', eventRecorded:false, reason:'EVENT_LOG_WRITE_FAILED' }
// —— 上游不得把这个结果当成“强化已发生”。账本内容也不含该事件（可重放验证）。

import { EventLog, EVENT_TYPES } from '../../activation-01/src/events.mjs';
import { createEventIdFactory } from '../../activation-02/src/event-ids.mjs';

const READONLY_EVENT_TYPES = Object.freeze(new Set([
  'candidate_retrieved', 'selected_for_context', 'generated_reference', 'ui_inspected'
]));

export const LIFECYCLE_KINDS = Object.freeze({
  USER_REMENTION: 'user_remention',
  GENERATION_CITED: 'generation_cited',
  DELIVERY_ACK: 'delivery_ack',
  FORMAL_CORRECTION: 'formal_correction',
  INTERNAL_CANDIDATES: 'internal_candidates',
  UI_VIEW: 'ui_view',
  SHADOW_QUERY: 'shadow_query'
});

export const REJECTION_REASONS = Object.freeze({
  SHADOW_QUERY_NOT_RECORDABLE: 'shadow 查询不得写入任何事件（影子运行零激活副作用）',
  DELIVERY_NOT_CONFIRMED: '无投递确认：不得记录 delivered_reference（未真实投递的内容不写 delivered_reference）',
  UTTERANCE_NOT_OBSERVED: '无用户话语观测：不得记录 user_revisited（candidate_retrieved 不允许冒充 user_revisited）',
  CORRECTION_NOT_FORMAL: '纠正未走正式权威（缺 Atlas control 回执 formalAuthorization/operationId）：不得记录 user_corrected',
  NO_RECORD_BINDING: '生命周期观测缺少 recordId 绑定：无从归属，拒绝'
});

function iso(ms) { return new Date(ms).toISOString(); }

export function createEventBridge({ log = new EventLog(), ids = createEventIdFactory({ prefix: 'ev3' }), now = () => Date.now() } = {}) {
  let forcedLogFailure = null; // 测试注入：下次 append 抛错

  function append(event) {
    if (forcedLogFailure) {
      const failure = forcedLogFailure;
      forcedLogFailure = null;
      throw Object.assign(new Error(failure.message ?? 'injected event-log failure'), { code: 'EVENT_LOG_WRITE_FAILED' });
    }
    return log.recordEvent(event);
  }

  // 返回 { formalWrite, eventRecorded, status, eventType, eventId, reason }
  function observe(lifecycle) {
    if (!lifecycle || typeof lifecycle !== 'object') {
      return { formalWrite: 'n/a', eventRecorded: false, reason: '观测必须是对象' };
    }
    const {
      kind, spaceId, recordId, atMs = now(),
      provenance = {}, sourceEventId = null, recordRevision = null
    } = lifecycle;

    if (kind === LIFECYCLE_KINDS.SHADOW_QUERY) {
      return { formalWrite: 'n/a', eventRecorded: false, reason: REJECTION_REASONS.SHADOW_QUERY_NOT_RECORDABLE };
    }
    if (typeof spaceId !== 'string' || !spaceId || typeof recordId !== 'string' || !recordId) {
      return { formalWrite: 'n/a', eventRecorded: false, reason: REJECTION_REASONS.NO_RECORD_BINDING };
    }

    let eventType = null;
    if (kind === LIFECYCLE_KINDS.USER_REMENTION) {
      if (provenance.surface !== 'user' || provenance.utteranceObserved !== true) {
        return { formalWrite: 'n/a', eventRecorded: false, reason: REJECTION_REASONS.UTTERANCE_NOT_OBSERVED };
      }
      eventType = 'user_revisited';
    } else if (kind === LIFECYCLE_KINDS.GENERATION_CITED) {
      eventType = 'generated_reference';
    } else if (kind === LIFECYCLE_KINDS.DELIVERY_ACK) {
      // 生成 ≠ 投递：没有通道确认就退化为 generated_reference（只读），
      // 绝不写 delivered_reference。
      eventType = provenance.deliveryConfirmed === true ? 'delivered_reference' : 'generated_reference';
    } else if (kind === LIFECYCLE_KINDS.FORMAL_CORRECTION) {
      if (provenance.formalAuthorization !== true || typeof provenance.operationId !== 'string' || !provenance.operationId) {
        return { formalWrite: 'n/a', eventRecorded: false, reason: REJECTION_REASONS.CORRECTION_NOT_FORMAL };
      }
      eventType = 'user_corrected';
    } else if (kind === LIFECYCLE_KINDS.INTERNAL_CANDIDATES) {
      eventType = 'candidate_retrieved';
    } else if (kind === LIFECYCLE_KINDS.UI_VIEW) {
      eventType = 'ui_inspected';
    } else {
      return { formalWrite: 'n/a', eventRecorded: false, reason: `未知生命周期 kind: ${String(kind)}` };
    }

    if (!EVENT_TYPES.includes(eventType)) {
      return { formalWrite: 'n/a', eventRecorded: false, reason: `非法事件类型 ${eventType}` };
    }

    const eventId = ids.next(spaceId, recordId);
    try {
      const outcome = append({
        eventId,
        spaceId,
        recordId,
        recordRevision,
        eventType,
        occurredAt: iso(atMs),
        observedAt: iso(atMs),
        sourceEventId,
        provenance: { ...provenance, lifecycleKind: kind, readonly: READONLY_EVENT_TYPES.has(eventType) }
      });
      // formal 写入是否成功由调用方另行陈述（桥只管事件侧）；这里的
      // formalWrite 字段保留给调用方合并——桥自身不伪造“正式写入成功”。
      return {
        formalWrite: 'unknown-to-bridge',
        eventRecorded: outcome.status === 'recorded',
        status: outcome.status,
        eventType,
        eventId,
        reason: outcome.reason ?? null
      };
    } catch (error) {
      return {
        formalWrite: 'unknown-to-bridge',
        eventRecorded: false,
        status: 'log-write-failed',
        eventType,
        eventId,
        reason: `EVENT_LOG_WRITE_FAILED:${error.code ?? error.message}`
      };
    }
  }

  function replay() {
    // 重放路径与摄入路径同一套幂等规则（activation-01 events.mjs）。
    return log.events();
  }

  return {
    observe,
    replay,
    events: () => log.events(),
    get size() { return log.size; },
    // 测试注入：下一次账本追加失败（模拟“正式写入成功、日志失败”）。
    injectLogFailure(message = 'injected event-log failure') { forcedLogFailure = { message }; },
    idFactory: ids
  };
}
