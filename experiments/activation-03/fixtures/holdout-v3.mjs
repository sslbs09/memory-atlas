// holdout-v3 —— activation-03 新独立保留集（30 场景，冻结于任何策略运行之前）。
//
// 冻结纪律（activation-03 任务书 §五）：
//   1. 本文件在 commit 冻结（见 results-v3/freeze.json 的 sha256）之后，
//      才允许第一次 run-shadow / run-eval。
//   2. 相关性等级（relevance 0..3）与 forbidden 是评价真值，冻结后不得因
//      运行结果修订；任何运行后修订必须在本文件 AMENDMENTS 记录，受影响
//      场景不再计入完整 holdout（单独标注）。
//   3. activation-02 的 23 个 holdout-v2 场景只作开发回归（其合成池前提与
//      真实路径不同，不进入本阶段指标分母）。
//
// relevance 等级：3=直接答案（期望第一）2=相关 1=边缘 0=无关/噪声。
// forbidden：任何排名都不得出现的 recordId（撤回/superseded/跨空间）。
// events：引用 fixtures/corpus-v3.mjs 的 SCENARIO_EVENTS（合成历史）。

import { MIRA_RECORDS, OTHER_RECORDS, MIRA_B_RECORDS, OTHER_B_RECORDS, NOW_ISO, NOW_MS } from './corpus-v3.mjs';

export const HOLDOUT_V3_META = Object.freeze({
  id: 'holdout-v3',
  createdAt: '2026-11-01',
  clock: NOW_ISO,
  clockMs: NOW_MS,
  scenarioCount: 30,
  families: { explicit: 14, ambient: 6, fallback: 6, structural: 4 },
  difficultTypeCoverage: Object.freeze({
    '1-多候选同词元覆盖': ['E03'],
    '2-多候选不同词元质量': ['E02', 'E13'],
    '3-高频无关记忆': ['E05', 'E02'],
    '4-中文单字噪声': ['E04'],
    '5-同一人物不同事件': ['E01'],
    '6-最近已经提及': ['B02', 'B03', 'C05'],
    '7-用户明确再次追问': ['E06'],
    '8-很旧但尚未履行的约定': ['E07', 'C03'],
    '9-同一事实多次不同来源': ['E08', 'B01'],
    '10-已纠正的高频旧事实': ['E09'],
    '11-结构关联但无词法证据': ['B01'],
    '12-索引故障后的权威扫描': ['C01', 'C02']
  }),
  denominators: Object.freeze({
    note: '排序指标分母 = 候选数>0 且存在 grade>=2 相关记录的场景；行为断言（structural 组）单独报告，不计入排序分母。',
    rule: 'negative-availability 场景（预期零候选/仅断言不可达）显式排除并逐个列名。'
  })
});

export const AMENDMENTS = Object.freeze([
  {
    id: 'A1',
    at: '2026-11-01',
    affected: ['C05-browse-suppression'],
    finding: '首轮运行发现 harness.query 只解构 query/limit，场景的 since 被静默丢弃（C05 实际按无时间窗浏览运行）；同时 Atlas 时间过滤默认字段是 timestamp=recordedAt（录入时间），场景意图是 occurredAt 窗口。',
    action: 'harness.query 改为透传全部选项；C05 显式声明 timeField: "occurredAt"。relevance/forbidden 真值不变。',
    purity: 'C05 不再具备完整预注册纯度；其余 29 场景不受影响（首轮与修订轮输出一致的差异仅由该 plumbing 缺陷引起）。'
  },
  {
    id: 'A2',
    at: '2026-11-01',
    affected: ['B03-suppression-decay-zone'],
    finding: 'SCENARIO_EVENTS 键名 B03-suppression-decay 与场景 id B03-suppression-decay-zone 不匹配，首轮 B03 无事件剧本（抑制从未触发）。',
    action: '剧本键名对齐场景 id。事件内容不变（delivered_reference @ 2026-11-01T02:00Z）。',
    purity: 'B03 不再具备完整预注册纯度；其余 29 场景不受影响。'
  }
]);

const S = (scenario) => Object.freeze(scenario);

export function holdoutV3Scenarios() {
  return [
    // ============ explicit（路径 A）============
    S({
      id: 'E01-xiaolin-person-events', family: 'explicit', path: 'A', mode: 'explicit',
      query: '小林', spaces: ['mira'],
      difficultTypes: [5],
      intent: '同一人物（小林）的多个事件中找回用户重提的那件（借书未还）',
      events: 'E01-xiaolin-person-events',
      relevance: { 'rec-xiaolin-book': 3, 'rec-xiaolin-cafe': 1, 'rec-xiaolin-birthday': 1 },
      forbidden: ['rec-retracted-phish', 'other-xiaolin-book'],
      prediction: { A0: 'cafe(新) 第一，book 沉第二', G3: '同 A0', G1G2: 'book 重提 boost → 第一（同 tier 内合法上移）' }
    }),
    S({
      id: 'E02-token-quality-gate', family: 'explicit', path: 'A', mode: 'explicit',
      query: '健身房 跑步', spaces: ['mira'],
      difficultTypes: [2, 3],
      intent: '强匹配（短语）与高频重提的弱匹配（散词）同时候选；闸门必须阻止 boosted 越过更优 tier',
      events: 'E02-token-quality-gate',
      relevance: { 'rec-gym-run': 3, 'rec-gym-treadmill': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'treadmill(新) 第一（recency 误排）', G3: '同 A0', G1G2: 'run=T1 phrase、treadmill=T2 multi-bigram+boosted → gate 把 treadmill 压回 run 之后，run 第一；gateMove 必须记录' }
    }),
    S({
      id: 'E03-same-coverage-uplift', family: 'explicit', path: 'A', mode: 'explicit',
      query: '游泳', spaces: ['mira'],
      difficultTypes: [1],
      intent: '两候选同词元同覆盖（AND 下 cov=1）：旧但被重提的相关项合法上移',
      events: 'E03-same-coverage-uplift',
      relevance: { 'rec-swim-class': 3, 'rec-swim-pool': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'pool(新) 第一', G3: '同 A0', G1G2: 'class boost → 第一（tier 相同：2 字查询短语命中同质）' }
    }),
    S({
      id: 'E04-single-char-noise', family: 'explicit', path: 'A', mode: 'explicit',
      query: '药', spaces: ['mira'],
      difficultTypes: [4],
      intent: '单字查询：噪声（药店打卡）靠 recency 压过真答案（药盒位置）',
      events: null,
      relevance: { 'rec-medicine-drawer': 3, 'rec-pharmacy-run': 0, 'rec-herb-tea': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'pharmacy(0) 第一 —— 入侵', G3: '同 A0', G1G2: '无事件 → 同 A0；tier 全 T4 同质，闸门无差异。已知失效模式：单字查询无激活时不可修' }
    }),
    S({
      id: 'E05-freq-irrelevant-explicit', family: 'explicit', path: 'A', mode: 'explicit',
      query: '跑步', spaces: ['mira'],
      difficultTypes: [3],
      intent: '高频重提的装备闲聊（grade0）在 recency 与激活双重作用下压过真跑步安排',
      events: 'E05-freq-irrelevant-explicit',
      relevance: { 'rec-run-weekend': 3, 'rec-gym-run': 1, 'rec-gym-treadmill': 1, 'rec-run-gear': 0 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'gear(0,最新) 第一 —— 入侵', G3: '同 A0（explicit 不抑制）', G1G2: 'gear 8 次重提 → boost 更强；全部候选 T1（2 字查询短语命中同质）→ 闸门无法区分 → G1G2 仍 gear 第一。已知失效模式：AND 同词元 + 2 字查询短语同质' }
    }),
    S({
      id: 'E06-explicit-reask', family: 'explicit', path: 'A', mode: 'explicit',
      query: '周五 老周', spaces: ['mira'],
      difficultTypes: [7],
      intent: '用户明确再次追问刚投递过的内容：explicit 恒不抑制，且重提 boost 生效',
      events: 'E06-explicit-reask',
      relevance: { 'rec-friday-meal': 3, 'rec-friday-cancel': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'cancel(新) 第一', G3: '同 A0（explicit 绕过抑制）', G1G2: 'meal 重提 boost → 第一' }
    }),
    S({
      id: 'E07-old-commitment-explicit', family: 'explicit', path: 'A', mode: 'explicit',
      query: '送伞', spaces: ['mira'],
      difficultTypes: [8],
      intent: '六月未履行的约定 vs 十月的新记录：无激活事件时诚实下沉，但必须保持可达',
      events: null,
      relevance: { 'rec-umbrella-commitment': 3, 'rec-buy-umbrella': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'buy-umbrella(新) 第一，commitment 第二（可达 top5）', G3: '同 A0', G1G2: '无事件 → 同 A0。验收口径：commitment ∈ top5（可达性），不强求第一' }
    }),
    S({
      id: 'E08-duplicate-sources', family: 'explicit', path: 'A', mode: 'explicit',
      query: 'WiFi 密码', spaces: ['mira'],
      difficultTypes: [9],
      intent: '同一事实两次记录（聊天+便签）：top1 落在任一高相关记录均算召回正确（MRR 口径），严格 Top1 允许 grade2',
      events: null,
      relevance: { 'rec-wifi-password': 3, 'rec-wifi-note': 2 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'note(新) 第一（grade2）', G3: '同 A0', G1G2: '同 A0。去重不在激活引擎职责内（记录合并是权威层的事）' }
    }),
    S({
      id: 'E09-corrected-highfreq', family: 'explicit', path: 'A', mode: 'explicit',
      query: '咖啡', spaces: ['mira'],
      difficultTypes: [10],
      intent: '被纠正的 8 次重提旧口味必须结构性不可达；纠正记录可达',
      events: 'E09-corrected-highfreq',
      relevance: { 'key:corr-latte': 3, 'rec-coffee-machine': 0 },
      forbidden: ['rec-retracted-phish', 'rec-latte'],
      prediction: { 全策略: 'rec-latte 在投影中已 superseded → 结构性缺席（比实验池更强的保证）；corr-latte 第一' }
    }),
    S({
      id: 'E10-cross-space-explicit', family: 'explicit', path: 'A', mode: 'explicit',
      query: '三体', spaces: ['mira', 'other'],
      difficultTypes: [],
      intent: '跨空间同名 recordId 不得串联：other 空间的同名记录不得出现在 mira 查询',
      events: null,
      relevance: { 'rec-xiaolin-book': 3 },
      forbidden: ['other-xiaolin-book', 'rec-retracted-phish'],
      prediction: { 全策略: '仅 mira 空间候选' }
    }),
    S({
      id: 'E11-retracted-unreachable-explicit', family: 'explicit', path: 'A', mode: 'explicit',
      query: '中奖', spaces: ['mira'],
      difficultTypes: [],
      intent: '已撤回钓鱼记录（历史 0 重提但激活概念上可控）在任何关键词下不可达',
      events: null,
      relevance: { 'rec-lottery-warning': 3 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: 'phish 结构性缺席' }
    }),
    S({
      id: 'E12-multi-term-and', family: 'explicit', path: 'A', mode: 'explicit',
      query: '东京 旅行', spaces: ['mira'],
      difficultTypes: [1],
      intent: '双词 AND：旅行计划记录可达；无事件下三策略同序',
      events: null,
      relevance: { 'rec-trip-tokyo': 3 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: 'trip-tokyo 第一' }
    }),
    S({
      id: 'E13-idhit-gate', family: 'explicit', path: 'A', mode: 'explicit',
      query: 'X-T30 相机', spaces: ['mira'],
      difficultTypes: [2],
      intent: 'id 命中（T0）+ 重提电池记录（T1 phrase）：闸门必须阻止 boosted T1 越过 T0',
      events: 'E13-idhit-gate',
      relevance: { 'rec-x-t30-camera': 3, 'rec-camera-backup': 2 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'backup(新) 第一（grade2）', G3: '同 A0', G1G2: 'backup boost（T1）不得越过 camera（T0 idHit）→ gate 移回，camera 第一；gateMove 必须记录' }
    }),
    S({
      id: 'E14-single-candidate-trivial', family: 'explicit', path: 'A', mode: 'explicit',
      query: '相机包', spaces: ['mira'],
      difficultTypes: [],
      intent: '单候选平凡场景：三策略必须完全同序（sanity）',
      events: null,
      relevance: { 'rec-camera-bag': 3 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: '同序；SINGLE_CANDIDATE 备注' }
    }),

    // ============ ambient（路径 B：association 直连探测；生产休眠）============
    S({
      id: 'B01-association-no-lexical', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '林然', spaces: ['mira-b'],
      difficultTypes: [11, 9],
      intent: '结构关联候选（同 subject / 同 session）没有任何词元证据：G1 不得启用，G1G2 必须整体拒用；G3 抑制可用',
      events: null,
      relevance: { 'rec-b-linran-movie': 2, 'rec-b-linran-hike': 3, 'rec-b-linran-tea': 2, 'rec-b-session-mate': 1 },
      forbidden: ['rec-b-retracted', 'rec-b2-linran-note'],
      prediction: { A0: '词面锚（movie/hike）在前，关联候选（tea/session-mate）随后（anchor 分 ×0.99）', G3: '同 A0（无投递事件）', G1G2: 'refused：NO_LEXICAL_EVIDENCE_ASSOCIATION → 回退 A0 顺序；降级计数 +1' }
    }),
    S({
      id: 'B02-recent-delivery', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '林然', spaces: ['mira-b'],
      difficultTypes: [6],
      intent: '2 小时前刚投递过的关联候选不得在新 ambient 轮次重复第一',
      events: 'B02-recent-delivery',
      relevance: { 'rec-b-linran-movie': 2, 'rec-b-linran-hike': 3, 'rec-b-linran-tea': 2, 'rec-b-session-mate': 1 },
      forbidden: ['rec-b-retracted'],
      prediction: { A0: 'movie 第一（重复）', G3: 'movie ×0.5 → hike 第一', G1G2: 'refused（同 B01）' }
    }),
    S({
      id: 'B03-suppression-decay-zone', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '林然', spaces: ['mira-b'],
      difficultTypes: [6],
      intent: '10 小时前投递：抑制乘数在 6~24h 线性恢复区间（≈0.611），仍足以让位',
      events: 'B03-suppression-decay',
      relevance: { 'rec-b-linran-movie': 2, 'rec-b-linran-hike': 3, 'rec-b-linran-tea': 2, 'rec-b-session-mate': 1 },
      forbidden: ['rec-b-retracted'],
      prediction: { A0: 'movie 第一', G3: 'movie ×≈0.611 → hike 第一', G1G2: 'refused（同 B01）' }
    }),
    S({
      id: 'B04-cross-space-association', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '林然', spaces: ['mira-b', 'other-b'],
      difficultTypes: [],
      intent: '跨空间结构关联隔离：other-b 的同 subject 记录不得出现在 mira-b 查询',
      events: null,
      relevance: { 'rec-b-linran-movie': 2, 'rec-b-linran-hike': 3, 'rec-b-linran-tea': 2, 'rec-b-session-mate': 1 },
      forbidden: ['rec-b2-linran-note', 'rec-b-retracted'],
      prediction: { 全策略: '仅 mira-b 实例候选（bySubject 按 instance_id 过滤）' }
    }),
    S({
      id: 'B05-retracted-ambient-unreachable', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '林然', spaces: ['mira-b'],
      difficultTypes: [],
      intent: '已撤回记录不得成为锚、也不得被关联召回',
      events: null,
      relevance: { 'rec-b-linran-movie': 2, 'rec-b-linran-hike': 3, 'rec-b-linran-tea': 2, 'rec-b-session-mate': 1 },
      forbidden: ['rec-b-retracted'],
      prediction: { 全策略: 'retracted 投影即移除 → 缺席' }
    }),
    S({
      id: 'B06-sentence-situation-empty', family: 'ambient', path: 'B', mode: 'ambient',
      situation: '和林然周末做什么', spaces: ['mira-b'],
      difficultTypes: [],
      intent: '整句情境直接作为 q：AND 语义下无锚 → 零候选 → 关联不可达（结构性发现：生产形状的 associate 无法服务整句情境）',
      events: null,
      relevance: {},
      forbidden: [],
      prediction: { 全策略: '零候选（NO_MATCH）；不计入排序分母，单独列入 negative-availability' }
    }),

    // ============ fallback（路径 C：权威扫描回退）============
    S({
      id: 'C01-scan-after-index-failure', family: 'fallback', path: 'C', mode: 'explicit',
      query: '跑步', spaces: ['mira'], engineMode: 'broken',
      difficultTypes: [12, 3],
      intent: '索引故障后权威扫描接管：答案仍是真答案；无 matchReason → G1G2 必须拒用；explicit 不抑制',
      events: 'E05-freq-irrelevant-explicit',
      relevance: { 'rec-run-weekend': 3, 'rec-gym-run': 1, 'rec-gym-treadmill': 1, 'rec-run-gear': 0 },
      forbidden: ['rec-retracted-phish'],
      prediction: { A0: 'sequence 降序（gear 第一 —— 录入顺序决定，非 occurredAt）', G3: '同 A0', G1G2: 'refused：NO_LEXICAL_EVIDENCE_SCAN → 回退 A0；降级计数 +1' }
    }),
    S({
      id: 'C02-scan-not-wired', family: 'fallback', path: 'C', mode: 'explicit',
      query: '跑步', spaces: ['mira'], engineMode: 'none',
      difficultTypes: [12],
      intent: '未接线（NOT_WIRED）与故障（C01）同属回退：成员一致、顺序一致',
      events: 'E05-freq-irrelevant-explicit',
      relevance: { 'rec-run-weekend': 3, 'rec-gym-run': 1, 'rec-gym-treadmill': 1, 'rec-run-gear': 0 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: '与 C01 相同成员与顺序（scan 语义与故障原因无关）' }
    }),
    S({
      id: 'C03-scan-old-commitment', family: 'fallback', path: 'C', mode: 'explicit',
      query: '送伞', spaces: ['mira'], engineMode: 'broken',
      difficultTypes: [8, 12],
      intent: '回退路径上旧约定可达性：scan 按录入 sequence 排序，旧约定（后录入）仍可达',
      events: null,
      relevance: { 'rec-umbrella-commitment': 3, 'rec-buy-umbrella': 1 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: 'commitment 录入晚于 buy-umbrella → sequence 大 → scan 第一；G1G2 refused（无 matchReason）' }
    }),
    S({
      id: 'C04-scan-retracted', family: 'fallback', path: 'C', mode: 'explicit',
      query: '中奖', spaces: ['mira'], engineMode: 'broken',
      difficultTypes: [12],
      intent: '回退路径上撤回记录同样不可达（validity 过滤在权威层）',
      events: null,
      relevance: { 'rec-lottery-warning': 3 },
      forbidden: ['rec-retracted-phish'],
      prediction: { 全策略: 'phish 缺席' }
    }),
    S({
      id: 'C05-browse-suppression', family: 'fallback', path: 'C', mode: 'ambient',
      since: '2026-10-30T00:00:00.000Z', timeField: 'occurredAt', spaces: ['mira'], engineMode: 'broken',
      difficultTypes: [6, 12],
      intent: '回退路径的 ambient 浏览（occurredAt 时间窗）：G3 以稳定后移表达抑制（不伪造分数）',
      events: 'C05-browse-suppression',
      relevance: { 'rec-friday-cancel': 1, 'rec-swim-pool': 1, 'rec-run-gear': 0, 'rec-gym': 1 },
      forbidden: ['rec-retracted-phish', 'key:corr-latte', 'rec-friday-meal'],
      prediction: { A0: 'friday-cancel 第一（sequence 降序）—— 刚投递过的重复', G3: 'friday-cancel 后移到首个未抑制者之后', G1G2: 'refused：NO_LEXICAL_EVIDENCE_SCAN' }
    }),
    S({
      id: 'C06-scan-cross-space', family: 'fallback', path: 'C', mode: 'explicit',
      query: '三体', spaces: ['mira', 'other'], engineMode: 'broken',
      difficultTypes: [12],
      intent: '回退路径跨空间隔离（querySpace 按 spaceDoc）',
      events: null,
      relevance: { 'rec-xiaolin-book': 3 },
      forbidden: ['other-xiaolin-book'],
      prediction: { 全策略: '仅 mira' }
    }),

    // ============ structural（行为断言，不计入排序分母）============
    S({
      id: 'X01-restart-determinism', family: 'structural', path: 'A', mode: 'explicit',
      query: '健身房 跑步', spaces: ['mira'], engineMode: 'glm',
      intent: '同场景双进程（全新索引目录）重放：影子记录逐位一致',
      events: 'E02-token-quality-gate',
      relevance: { 'rec-gym-run': 3, 'rec-gym-treadmill': 1 },
      forbidden: [],
      assertion: '两次运行的 shadow 记录 JSON 相同（时间戳字段除外）'
    }),
    S({
      id: 'X02-shadow-zero-side-effect', family: 'structural', path: 'A', mode: 'explicit',
      query: '跑步', spaces: ['mira'], engineMode: 'glm',
      intent: '影子查询零副作用：space 修订号不变、事件账本零新增、派生态快照不变',
      events: 'E05-freq-irrelevant-explicit',
      relevance: {},
      forbidden: [],
      assertion: 'revision 不变 + bridge.size==0 + state 快照相等'
    }),
    S({
      id: 'X03-internal-readonly-events', family: 'structural', path: 'A', mode: 'explicit',
      query: '跑步', spaces: ['mira'], engineMode: 'glm',
      intent: '内部候选事件只读；shadow_query 一律拒绝',
      events: null,
      relevance: {},
      forbidden: [],
      assertion: 'internal_candidates 记录后 replay 无 reinforce；observe(shadow_query) rejected'
    }),
    S({
      id: 'X04-log-failure-honesty', family: 'structural', path: 'A', mode: 'explicit',
      query: '跑步', spaces: ['mira'], engineMode: 'glm',
      intent: '正式写入成功但事件日志失败：不得伪造成功，账本无该事件',
      events: null,
      relevance: {},
      forbidden: [],
      assertion: 'injectLogFailure 后 observe 返回 eventRecorded=false / log-write-failed；账本为空'
    })
  ];
}
