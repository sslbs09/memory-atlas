// holdout-v4 —— activation-04 归因实验新独立保留集（8 场景，冻结于任何策略运行之前）。
//
// 冻结纪律（沿用 activation-03 §五）：
//   1. 本文件与 corpus-v4.mjs 在冻结 commit 之后才允许第一次策略运行
//      （见 scripts/freeze-hash-v4.mjs → results-v4/freeze.json）。
//   2. relevance 0..3 与 forbidden 是评价真值，冻结后不得因运行结果修订；
//      运行后修订必须记录在 AMENDMENTS_V4，受影响场景移出严格 holdout。
//   3. 冻结前只允许「管道探针」：验证 AND 检索能到达预期候选成员（输入侧
//      plumbing），不运行、不查看任何策略排序输出。探针结果记录于本文件 PROBE。
//
// relevance 等级：3=直接答案（期望第一）2=相关 1=边缘 0=无关/噪声。
// forbidden：任何排名都不得出现的 recordId。
// 困难类型映射（activation-04 任务书 §三 清单 → 场景）：
//   语义相关但时间较旧        → V01
//   新近但只弱相关            → V07
//   完整短语与零散字词竞争    → V01, V07
//   高频无关记忆              → V03
//   长期有效约定              → V04
//   同一条记忆多次真实重提    → V05（含 V04/V07 的多重提）
//   已撤回的高频旧记录        → V06
//   用户明确再次追问          → V02
//   （最近已投递抑制 → V08，路径 B）

import { NOVA_RECORDS, NOVA_B_RECORDS, SCENARIO_EVENTS_V4, NOW_ISO_V4, NOW_MS_V4 } from './corpus-v4.mjs';

export const HOLDOUT_V4_META = Object.freeze({
  id: 'holdout-v4',
  createdAt: '2026-11-01',
  clock: NOW_ISO_V4,
  clockMs: NOW_MS_V4,
  scenarioCount: 8,
  families: { explicit: 7, ambient: 1 },
  corpus: 'corpus-v4.mjs（独立空间 nova / nova-b）',
  purpose: '归因实验的新独立案例：与 v3 的 30 场景合并评价，但新案例的期望独立冻结',
  difficultTypeCoverage: Object.freeze({
    '语义相关但时间较旧': ['V01-phrase-vs-scatter-old'],
    '新近但只弱相关': ['V07-recent-weak-invoice'],
    '完整短语与零散字词竞争': ['V01-phrase-vs-scatter-old', 'V07-recent-weak-invoice'],
    '高频无关记忆': ['V03-freq-irrelevant-annual'],
    '长期有效约定': ['V04-commitment-book-return'],
    '同一条记忆多次真实重提': ['V05-multi-revisit-health'],
    '已撤回的高频旧记录': ['V06-retracted-highfreq-password'],
    '用户明确再次追问': ['V02-explicit-reask-expense'],
    '最近已经提及（ambient 抑制）': ['V08-ambient-delivery-zhao']
  }),
  denominators: Object.freeze({
    note: '排序指标分母 = 候选数>0 且存在 grade>=2 的场景；单候选场景单独标注（无重排空间，三策略必然同序）。'
  })
});

const S = (scenario) => Object.freeze(scenario);

export function holdoutV4Scenarios() {
  return [
    S({
      id: 'V01-phrase-vs-scatter-old', family: 'explicit', path: 'A', mode: 'explicit',
      query: '身份证 挂失', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['语义相关但时间较旧', '完整短语与零散字词竞争'],
      intent: '旧但完整短语命中（grade3）vs 新但零散字词命中（grade1）；无事件 —— 只有词面质量（L）应该修复',
      events: null,
      relevance: { 'rec-idloss-report': 3, 'rec-idloss-copy': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'copy(新) 第一（recency 误排，top1 grade1）',
        L: 'report=T1 phrase、copy=T2 多二元 → report 第一',
        R: '零事件 → 同 A0',
        LR: '零事件 → 同 A0（gate 只约束 boosted；LR 无事件时不消费 tier 作为排序键）',
        D: 'explicit 恒不抑制 → 同 A0'
      }
    }),
    S({
      id: 'V02-explicit-reask-expense', family: 'explicit', path: 'A', mode: 'explicit',
      query: '报销 流程', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['用户明确再次追问'],
      intent: '2 小时前刚投递过的答案被再次追问：explicit 恒不抑制（D 绕过），同 tier 下 R 乘数应修复',
      events: 'V02-explicit-reask-expense',
      relevance: { 'rec-expense-flow': 3, 'rec-expense-note': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'note(新) 第一（top1 grade1）',
        L: '两候选均 T1 phrase 同质 → 同 A0',
        R: 'flow 今晨重提 → 乘数 ≈1.50 → flow 第一',
        LR: '同 R（同 tier，gate 无干预）',
        D: 'explicit 绕过抑制 → 同 A0（即使 flow 2h 前刚投递）'
      }
    }),
    S({
      id: 'V03-freq-irrelevant-annual', family: 'explicit', path: 'A', mode: 'explicit',
      query: '年会', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['高频无关记忆'],
      intent: '高频重提的闲聊（grade0）vs 真答案；单词查询短语同质 → 已知失效模式：L/R/LR 全部无候选间差异',
      events: 'V03-freq-irrelevant-annual',
      relevance: { 'rec-annual-plan': 3, 'rec-annual-lottery': 0 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'lottery(0, 新) 第一 —— 入侵',
        L: '均 T1 phrase 同质 → 同 A0（仍 lottery 第一）',
        R: 'lottery 10 次重提 → boost 强化错误 top1（幅度更大，仍 grade0 第一）',
        LR: '同 tier，gate 无干预 → 同 R 顺序',
        D: 'explicit 恒不抑制 → 同 A0'
      }
    }),
    S({
      id: 'V04-commitment-book-return', family: 'explicit', path: 'A', mode: 'explicit',
      query: '还书', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['长期有效约定', '同一条记忆多次真实重提'],
      intent: '长期约定（旧）+ 2 次真实重提 vs 新提醒（grade1）；同 tier 下 R 乘数应修复',
      events: 'V04-commitment-book-return',
      relevance: { 'rec-book-return': 3, 'rec-book-remind': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'remind(新) 第一（top1 grade1）',
        L: '均 T1 phrase 同质 → 同 A0',
        R: 'return 2 次重提（最近 1 天前）→ 乘数 ≈1.83 → return 第一',
        LR: '同 R',
        D: 'explicit 恒不抑制 → 同 A0'
      }
    }),
    S({
      id: 'V05-multi-revisit-health', family: 'explicit', path: 'A', mode: 'explicit',
      query: '体检', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['同一条记忆多次真实重提'],
      intent: '5 次真实重提（最近 2.8 天，半衰期内）的旧答案 vs 新边缘记录',
      events: 'V05-multi-revisit-health',
      relevance: { 'rec-health-report': 3, 'rec-health-center': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'center(新) 第一（top1 grade1）',
        L: '均 T1 phrase 同质 → 同 A0',
        R: 'report 乘数 ≈1.59 → report 第一',
        LR: '同 R',
        D: 'explicit 恒不抑制 → 同 A0'
      }
    }),
    S({
      id: 'V06-retracted-highfreq-password', family: 'explicit', path: 'A', mode: 'explicit',
      query: '密码', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['已撤回的高频旧记录'],
      intent: '带 5 次历史重提的已撤回记录必须结构性缺席（激活状态存在 ≠ 候选复活）；活跃候选 A0 已正确',
      events: 'V06-retracted-highfreq-password',
      relevance: { 'rec-safe-password': 3, 'rec-safe-box': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        全策略: 'bank-password 在投影中已 retracted → 结构性缺席（即使激活状态存在）；safe-password(新) 第一，forbidden=0'
      }
    }),
    S({
      id: 'V07-recent-weak-invoice', family: 'explicit', path: 'A', mode: 'explicit',
      query: '发票 报销', spaces: ['nova'], corpus: 'v4',
      difficultTypes: ['新近但只弱相关', '完整短语与零散字词竞争'],
      intent: '新近弱相关（零散字词，grade1）vs 旧答案（完整短语，grade3，3 次重提）：L 与 R 应各自独立修复（组合案例）',
      events: 'V07-recent-weak-invoice',
      relevance: { 'rec-invoice-deadline': 3, 'rec-invoice-done': 1 },
      forbidden: ['retr-v4-bank'],
      prediction: {
        A0: 'done(新) 第一（top1 grade1）',
        L: 'deadline=T1 phrase、done=T2 零散二元 → deadline 第一',
        R: 'deadline 3 次重提 → 乘数 ≈1.73 → deadline 第一',
        LR: 'deadline boost 同 tier 合法上移 → deadline 第一',
        D: 'explicit 恒不抑制 → 同 A0'
      }
    }),

    // ============ ambient（路径 B：association 直连探测；生产休眠）============
    S({
      id: 'V08-ambient-delivery-zhao', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '小赵', spaces: ['nova-b'], corpus: 'v4',
      difficultTypes: ['最近已经提及（ambient 抑制）'],
      intent: '1 小时前刚投递过的关联候选不得在 ambient 轮次重复第一：D（RecentDelivery 抑制）应修复；L/R/LR 均不适用或拒用',
      events: 'V08-ambient-delivery-zhao',
      relevance: { 'rec-v4b-zhao-hike': 3, 'rec-v4b-zhao-dinner': 2, 'rec-v4b-zhao-tea': 2 },
      forbidden: [],
      prediction: {
        A0: 'dinner(新, grade2) 第一 —— 重复投递',
        L: '词元候选 T4、关联候选 structural-association → 无候选间区分 → 同 A0',
        R: '零重提事件 → 同 A0',
        LR: 'refused：NO_LEXICAL_EVIDENCE_ASSOCIATION → 回退 A0',
        D: 'dinner ×0.5（1h < 6h 窗口）→ hike(3) 第一'
      }
    })
  ];
}

// 冻结前管道探针记录（输入侧 plumbing，只验证 AND 候选集成员可到达，
// 不运行、不查看任何策略排序输出；探针脚本与结果在冻结 commit 中提交）。
export const PROBE_V4 = Object.freeze({
  ranAt: '2026-11-01',
  purpose: '验证真实 AND 检索（collectCandidates 词元求交）能到达每个场景的预期候选',
  expectedCandidates: {
    'V01-phrase-vs-scatter-old': ['rec-idloss-report', 'rec-idloss-copy'],
    'V02-explicit-reask-expense': ['rec-expense-flow', 'rec-expense-note'],
    'V03-freq-irrelevant-annual': ['rec-annual-plan', 'rec-annual-lottery'],
    'V04-commitment-book-return': ['rec-book-return', 'rec-book-remind'],
    'V05-multi-revisit-health': ['rec-health-report', 'rec-health-center'],
    'V06-retracted-highfreq-password': ['rec-safe-password', 'rec-safe-box'],
    'V07-recent-weak-invoice': ['rec-invoice-deadline', 'rec-invoice-done'],
    'V08-ambient-delivery-zhao': ['rec-v4b-zhao-hike', 'rec-v4b-zhao-dinner']
  },
  note: '探针断言「预期候选 ⊆ 实际候选集」，不断言恰好相等（额外噪声候选合法）。'
});

export const AMENDMENTS_V4 = Object.freeze([]);
