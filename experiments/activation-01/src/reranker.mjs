// 可选 Activation Reranker 适配点（接入规则 §十）。
//
// 本轮首先独立运行。只有离线评价出现真实收益，才允许在实验分支加入此适配点；
// 即使满足条件，也必须默认关闭：activation.enabled = false。
// 它不替换正式检索排序，不改变候选集成员资格，只对给定候选列表做确定性重排序。

import { replayEvents } from './events.mjs';
import { scoreCandidate, STRATEGIES } from './ranking.mjs';
import { DEFAULT_PARAMS } from './activation.mjs';

export function createActivationReranker({
  enabled = false,                    // 默认关闭——接入规则红线
  strategy = 'A2',
  params = DEFAULT_PARAMS,
  mode = 'explicit'
} = {}) {
  if (!STRATEGIES.includes(strategy)) {
    throw Object.assign(new Error(`未知策略 ${strategy}`), { code: 'ACT_STRATEGY_UNKNOWN' });
  }
  return {
    enabled,
    strategy,
    mode,
    // candidates: DTO 形状 [{ recordId, instanceId, score, ... }]（SEARCH-DTO-v1 候选）。
    // events: 派生事件数组（可来自 EventLog / replay）。
    // pool: 用于读取记录静态属性的 CandidatePool。
    // 返回：{ enabled, candidates(重排后), explanations }
    rerank({ candidates, events = [], pool, now, mode = this.mode }) {
      if (!enabled) {
        // 关闭态：字节级原样返回，绝不改变正式排序。
        return { enabled: false, candidates: candidates.slice(), explanations: null };
      }
      if (!Array.isArray(candidates)) {
        throw Object.assign(new Error('candidates 必须是数组'), { code: 'ACT_RERANKER_INVALID' });
      }
      const state = replayEvents(events);
      const scored = candidates.map((c) => {
        const record = pool.getRecord(c.instanceId, c.recordId);
        if (!record) {
          throw Object.assign(
            new Error(`reranker：候选 ${c.instanceId}/${c.recordId} 不在语料中（激活不改成员资格）`),
            { code: 'ACT_RERANKER_UNKNOWN_CANDIDATE' }
          );
        }
        const entry = {
          record,
          coverage: typeof c.coverage === 'number' ? c.coverage : 0,
          matchedTerms: Array.isArray(c.matchedTerms) ? c.matchedTerms : [],
          mode
        };
        const { finalScore, breakdown } = scoreCandidate({ pool, entry, state, strategy, now, mode, params });
        return { candidate: c, finalScore, breakdown };
      });
      scored.sort((x, y) => y.finalScore - x.finalScore
        || (x.candidate.recordId < y.candidate.recordId ? -1 : 1));
      return {
        enabled: true,
        strategy,
        candidates: scored.map((s) => ({ ...s.candidate, score: Number(s.finalScore.toFixed(4)) })),
        explanations: scored.map((s) => ({
          recordId: s.candidate.recordId,
          instanceId: s.candidate.instanceId,
          finalScore: Number(s.finalScore.toFixed(6)),
          reasons: s.breakdown.reasons,
          activation: s.breakdown.activation,
          recentDelivery: s.breakdown.recentDelivery
        }))
      };
    }
  };
}
