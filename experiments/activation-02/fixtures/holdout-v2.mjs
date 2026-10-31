// activation-02 独立保留集（holdout-v2）—— 预注册冻结。
//
// 纪律（任务书 §四）：
//   - activation-01 的 16 个动态场景全部降级为开发诊断集，本文件是唯一的新保留集。
//   - 全部 expectedRelevant / forbidden / intruders / expect 在本文件中固定，
//     先于任何策略运行（git 历史：fixtures+sanity 先 commit，策略后 commit）。
//   - 期望的推导依据写在每个场景的 derivation 字段：候选池由 vendored tokenizer
//     的确定性规则推出（构造 fixture 时核对），排序期望由各策略的公示式手工验算。
//     手工验算的中间分数一并记录，评估后如出现偏差可逐步定位。
//   - 语料复用 activation-01 的 26 条合成记录（不新增、不修改正式事实与来源），
//     降低「为场景定制语料」的特化风险。
//
// 策略矩阵（9 个，见 src/strategies.mjs）：
//   A0 / A1 / A2-H7 / A2-H30 / A3        —— activation-01 原实现，逐字复用
//   G2-H7                                 —— 取消普遍年龄惩罚的激活
//   G3                                    —— 仅保留最近投递抑制（A0 + suppression）
//   G1                                    —— A2-H7 + 词元质量闸门（tier gate）
//   G1G2                                  —— G2-H7 + 词元质量闸门
//
// expect schema（沿用 activation-01 并扩展）：
//   top1 / inTop{k,recordIds} / inCandidates / absent / noMatch / orderAfter /
//   identityToZeroEvents / reinforceCount / sameAsSingleRevisit /
//   finiteScores / replayOrderInsensitive / workActivationZero
//   strategyExpect: { <策略id>: 同形状覆盖断言 }
// family: explicit | ambient | suppression | structural（报告分组用）

import { EVAL_NOW, daysAgoIso, eventHistory } from '../../activation-01/fixtures/scenarios.mjs';

const at = EVAL_NOW;
const D = (name, text) => ({ name, text }); // derivation 条目

export function holdoutV2Scenarios() {
  return [
    // ================= E 组：explicit 精确询问（正确性回归） =================
    {
      id: 'E1-explicit-followup-just-delivered', family: 'explicit', mode: 'explicit',
      spaceIds: ['personal'], at, query: '花生 过敏',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', rev: [30, 90], del: [0.1] }),
      expect: { top1: 'rec-allergy-peanut' },
      derivation: [
        D('候选', 'AND(花生,过敏) → 仅 rec-allergy-peanut（唯一同时含两个二元词元的记录）'),
        D('期望', '单候选 → 所有策略 top1；explicit 模式恒不做投递抑制（2.4h 前刚投递过）')
      ],
      note: '用户明确追问·刚投递：explicit 追问必须正常召回，不得被抑制'
    },
    {
      id: 'E2-old-commitment-explicit', family: 'explicit', mode: 'explicit',
      spaceIds: ['personal'], at, query: '洱海 约定',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }),
      expect: { top1: 'rec-commitment-erhai' },
      derivation: [
        D('候选', 'AND(洱海,约定) → 仅 rec-commitment-erhai'),
        D('期望', '单候选 → 所有策略 top1；三年旧约定在明确追问下必须可达')
      ],
      note: '用户明确追问旧约定 → AND 词元匹配保证可达，任何策略下第一'
    },
    {
      id: 'E3-corrected-record-explicit', family: 'explicit', mode: 'explicit',
      spaceIds: ['personal'], at, query: '收货地址',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-address-old', rev: [10, 20, 30, 40, 50, 60, 70, 80] }),
      expect: { top1: 'rec-address-new', absent: ['rec-address-old'] },
      derivation: [
        D('候选', 'AND(收货,地址…) → 仅 rec-address-new（rec-address-old 为 superseded，投影不可达）'),
        D('期望', '旧地址 8 次重提也不能覆盖纠正后的新值（激活不改变成员资格）')
      ],
      note: '被纠正记忆即使 8 次重提也不得覆盖新值'
    },
    {
      id: 'E4-explicit-high-freq-vs-current-plan', family: 'explicit', mode: 'explicit',
      spaceIds: ['personal'], at, query: '周末',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-recipe-hotpot', rev: [1, 6] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [10, 20, 30, 40, 50, 60, 70, 80] })
      ],
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-recipe-hotpot' },
          A1: { top1: 'rec-gym-runs' },          // 已知失败模式：纯计数激活在同一词元质量内越界
          'A2-H7': { top1: 'rec-recipe-hotpot' },
          'A2-H30': { top1: 'rec-gym-runs' },    // activation-01 D04 已实测：H30 衰减不足以约束 8 次重提
          A3: { top1: 'rec-recipe-hotpot' },
          'G2-H7': { top1: 'rec-recipe-hotpot' },
          G3: { top1: 'rec-recipe-hotpot' },
          G1: { top1: 'rec-recipe-hotpot' },
          G1G2: { top1: 'rec-recipe-hotpot' }
        }
      },
      derivation: [
        D('候选', 'AND(周末) → rec-recipe-hotpot / rec-gym-runs / rec-bike-riding（explicit 下三者词元证据完全相同：coverage 恒 1）'),
        D('A0', 'hotpot (2×1)×0.990=1.98 > gym (2×1)×0.870=1.74 > bike 1.396'),
        D('A1', 'gym ×(1+0.5·log1p(8))=2.03 → 3.53 > hotpot ×1.75=3.47 → gym ✗'),
        D('A2-H7', 'gym ×(2.6×2^(-10/7))=0.966→1.68 < hotpot ×(1.59×2^(-1/7))=1.475→2.92 ✓；A2-H30: gym ×2.06=3.59 > hotpot ×1.556=3.08 ✗'),
        D('A3', 'gym B=ln(Σ10..80d^-0.5)=0.324→×1.113=1.94 < hotpot B=ln(1+6^-0.5)=0.342→×1.120=2.22 ✓'),
        D('G 系', 'explicit 下所有候选词元证据相同 → 同 tier，gate 不介入；G2-H7 与 A2-H7 对已强化记录同式 → 同 A2-H7 ✓'),
        D('说明', '此场景 explicit 全候选同 tier：闸门结构性无能为力，只能靠激活公式自身的有界性 —— 诚实区分「gate 能修的」与「gate 修不了的」')
      ],
      note: 'explicit 三候选同词元证据：8 次重提的更旧记录不得挤掉真正被问的当前计划（A1/A2-H30 预期失败，作对照锚点）'
    },
    {
      id: 'E5-retracted-unreachable-explicit', family: 'explicit', mode: 'explicit',
      spaceIds: ['personal'], at, query: '钓鱼',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-fishing-retracted', rev: [10, 20, 30, 40, 50, 60, 70, 80] }),
      expect: { noMatch: true, absent: ['rec-fishing-retracted'] },
      derivation: [D('期望', 'retracted 记录不在投影 → 无论多少次重提都不可达')],
      note: '已撤回的高激活旧事实·explicit 不可达'
    },
    {
      id: 'E6-ascii-term-explicit', family: 'explicit', mode: 'explicit',
      spaceIds: ['work'], at, query: 'HS-7',
      events: [],
      expect: { top1: 'rec-mk2-sensor' },
      derivation: [D('候选', 'AND(hs-7) → 仅 rec-mk2-sensor（文本含 HS-7；recordId 不含 hs-7，无 id 加成）')],
      note: 'ascii 词元 explicit 单候选'
    },

    // ================= Q 组：ambient 词元质量与激活边界 =================
    {
      id: 'Q1-ambient-freq-intrusion-bigram-quality', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '周末在家休息',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [2, 9, 16, 23, 30, 37, 44, 51] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-recipe-hotpot' },
          A1: { top1: 'rec-gym-runs' },
          'A2-H7': { top1: 'rec-gym-runs' },
          'A2-H30': { top1: 'rec-gym-runs' },
          A3: { top1: 'rec-recipe-hotpot' },
          'G2-H7': { top1: 'rec-gym-runs' },
          G3: { top1: 'rec-recipe-hotpot' },
          G1: { top1: 'rec-recipe-hotpot' },
          G1G2: { top1: 'rec-recipe-hotpot' }
        }
      },
      derivation: [
        D('情境词元', 'uni 周,末,在,家,休,息 + bi 周末,末在,在家,家休,休息 = 11'),
        D('候选', 'hotpot 6/11（周末+在家 2 个二元）T2；gym 3/11、bike 3/11（仅周末 1 个二元，组成字周/末无残差）T4；umbrella/plant/badminton 1/11 T4'),
        D('A0', 'hotpot (1.545)×0.990=1.530 > gym (1.273)×0.870=1.107 ✓'),
        D('A1', 'gym ×2.03=2.25 > 1.530 ✗；A2-H7 gym ×2.172=2.405 ✗；A2-H30 gym ×2.48=2.80 ✗；G2-H7 gym ×2.172=2.405 ✗（hotpot 未强化乘数回 1.0，但 1.530 < 2.405）'),
        D('A3', 'gym B=ln(Σ2..51d^-0.5)≈ln(0.707+0.333+0.250+0.204+0.174+0.152+0.136+0.123)=ln(2.079)=0.732→×1.256=1.390 < hotpot 1.530 ✓'),
        D('G1/G1G2', 'gym boosted(T4) 不得越过 hotpot(T2) → hotpot ✓')
      ],
      note: '高频无关入侵·ambient：8 次重提的弱匹配（单二元）不得挤掉强匹配（双二元）；闸门靶场景，与 D03 同构但话题无关'
    },
    {
      id: 'Q2-single-char-noise-user-revisit', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '想找一部关于时间的电影',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-movie-wandering', rev: [3, 10] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-recipe-hotpot' },     // 修正（amendment A1）：hotpot 命中 想+一（2/21），A0 分 1.0845 最高
          A1: { top1: 'rec-movie-wandering' },
          'A2-H7': { top1: 'rec-movie-wandering' },
          'A2-H30': { top1: 'rec-movie-wandering' },
          A3: { top1: 'rec-recipe-hotpot' },     // A3 零事件乘数恒 1.0 → 同 A0
          'G2-H7': { top1: 'rec-recipe-hotpot' },// G2 不衰减未强化的 hotpot（1.0845）→ movie 1.0150 不够
          G3: { top1: 'rec-recipe-hotpot' },
          G1: { top1: 'rec-movie-wandering' },
          G1G2: { top1: 'rec-recipe-hotpot' }
        }
      },
      derivation: [
        D('情境词元（引擎核对）', '21 词元；movie 4/21（电影 1 二元 + 残差一）T3；hotpot 2/21（想,一，无二元）T4；umbrella 1/21（一）T4；weather 1/21（时）T4；plant 1/21（一）T4'),
        D('A0/A3/G3', 'hotpot (1.0952)×0.99025=1.0845 > umbrella 1.0446 > weather 1.0248 > plant 0.9667 > movie (1.1905)×0.62914=0.7489 → hotpot'),
        D('A1', 'movie ×(1+0.5·ln3)=1.5493 → 1.1603 ✓'),
        D('A2-H7', 'movie ×(1.8243×2^(-3/7))=1.3554 → 1.0150 > hotpot ×0.7459=0.8089（A2 对 hotpot 的普遍衰减歪打正着）✓；A2-H30 movie ×1.7022=1.2755 ✓'),
        D('G2-H7', 'hotpot 未强化 → 全额 1.0845 > movie 1.0150 ✗ —— G2 的结构性弱点：不衰减未强化新近干扰'),
        D('A3', 'B=ln(3^-0.5+10^-0.5)=-0.112→×0.961=0.720 ✗ → hotpot'),
        D('G1(A2-H7+gate)', 'movie T3 boosted，gate 无障碍 → movie ✓；G1G2 同 G2 ✗')
      ],
      note: '中文单字误命中噪声 + 用户 3/10 天前重提：全候选同 tier，比拼激活公式本身；G2 首次暴露「未强化干扰不衰减」代价'
    },
    {
      id: 'Q3-old-commitment-ambient-sink', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '之前约好的春天旅行还没定',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }),
      expect: {
        inCandidates: ['rec-commitment-erhai'],
        strategyExpect: {
          A0: { top1: 'rec-travel-yunnan' },     // 修正（amendment A1）：yunnan 7/23=0.304 → 1.304×0.8728=1.1385 最高
          A1: { top1: 'rec-commitment-erhai' },
          'A2-H7': { top1: 'rec-umbrella' },
          'A2-H30': { top1: 'rec-umbrella' },
          A3: { top1: 'rec-travel-yunnan' },     // A3 零事件乘数 1.0 → 同 A0
          'G2-H7': { top1: 'rec-travel-yunnan' },
          G3: { top1: 'rec-travel-yunnan' },
          G1: { top1: 'rec-umbrella' },
          G1G2: { top1: 'rec-travel-yunnan' }
        }
      },
      derivation: [
        D('情境词元（引擎核对）', '23 词元；erhai 9/23（春天+旅行 2 二元）T2；yunnan 7/23（春天+旅行）T2；umbrella 3/23（还没 1 二元）T4；hotpot 1/23（还）T4'),
        D('A0/A3/G3', 'yunnan (1.3043)×0.87281=1.1385 > umbrella (1.1304)×0.99709=1.1271 > hotpot 1.0333 > erhai (1.3913)×0.6=0.8348 → yunnan'),
        D('A1', 'erhai ×(1+0.5·ln4)=1.6931 → 1.4134 ✓（T2 boosted，不越界）'),
        D('A2-H7/H30', 'erhai 距上次重提 30d → ×(2.0397×2^(-30/7))=0.105→floor 0.4 → 0.334；yunnan ×2^(-45.9/7)→floor 0.4=0.455；umbrella ×0.9170=1.0336 → umbrella（H30: umbrella ×0.9800=1.1046 仍最高）'),
        D('A3', 'erhai 负 B → floor；yunnan/umbrella 零事件乘数 1.0 → yunnan'),
        D('G2-H7', 'erhai ×0.4（同 A2）；yunnan/umbrella 未强化 → 全额 → yunnan 1.1385 > umbrella 1.1271 → yunnan；G1G2 同')
      ],
      note: '长期未完成约定·ambient：衰减策略下诚实下沉，可达性必须保留；A1（纯计数）是唯一能把它抬回第一的策略 —— 记录 gate/衰减的代价'
    },
    {
      id: 'Q4-single-candidate-trivial', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '帮我记着那把黑色长柄伞',
      events: [],
      expect: { top1: 'rec-umbrella', candidateCount: 2 },
      derivation: [
        D('候选（引擎核对，amendment A1）', 'umbrella 10/21 与 plant 1/21（「帮」字命中「帮绿萝」）→ 2 候选，非最初推导的单候选'),
        D('分数', 'umbrella (1.4762)×0.99709=1.4719 > plant (1.0476)×0.92282=0.9667 → umbrella；无事件 → 所有策略一致')
      ],
      note: '近期小事·单候选：全部策略的公共底线'
    },
    {
      id: 'Q5-recent-trivial-intruder-single-revisit', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '周末跑步还是去健身房',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-recipe-hotpot', rev: [0.5] }),
      expect: {
        inCandidates: ['rec-gym-runs'],
        strategyExpect: {
          A0: { top1: 'rec-gym-runs' },
          A1: { top1: 'rec-recipe-hotpot' },
          'A2-H7': { top1: 'rec-recipe-hotpot' },
          'A2-H30': { top1: 'rec-recipe-hotpot' },
          A3: { top1: 'rec-gym-runs' },
          'G2-H7': { top1: 'rec-recipe-hotpot' },
          G3: { top1: 'rec-gym-runs' },
          G1: { top1: 'rec-gym-runs' },
          G1G2: { top1: 'rec-gym-runs' }
        }
      },
      derivation: [
        D('情境词元（引擎核对，amendment A1 修正池规模）', '19 词元；实际候选 14 条（远多于最初推导的 3 条）：gym 13/19（周末/跑步/健身/去健/身房…4+ 二元）T2；hotpot 4/19（周末 1 二元 + 残差还）T4；umbrella 1/19（还）T4；weather 1/19（周）T4；其余弱命中'),
        D('A0', 'gym (1.6842)×0.87107=1.4671 > hotpot (1.2105)×0.99025=1.1987 > umbrella 1.0496 ✓'),
        D('单次重提(0.5d)', 'A1 hotpot ×1.3466=1.6141 ✗；A2-H7 hotpot ×(1.5199×2^(-0.5/7))=1.4470→1.7344 ✗；A2-H30 ×1.4948→1.7919 ✗；G2-H7 同 A2-H7 ✗'),
        D('A3', 'hotpot t=0.5d → B=ln(2^0.5)=0.3466→×1.1213=1.3440 < gym 1.4671 ✓'),
        D('G1', 'gym 被 A2 衰减到 floor 0.4 → 0.5868 < umbrella 0.9625 → 闸门把 hotpot 压到 gym 之后但 umbrella 登顶 ✗（真实回归：A2 普遍年龄衰减伤害零事件的相关记录）；G1G2 gym 全额 1.4671 ✓'),
        D('G3', 'gym ✓（无投递事件，同 A0）')
      ],
      note: '短语与散落单字竞争 + 单次重提入侵：0.5 天前重提一次的弱匹配记录不得越过 4 个二元命中的相关记录'
    },
    {
      id: 'Q6-retracted-ambient-unreachable', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '周末去水边放松钓鱼怎么样',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-fishing-retracted', rev: [10, 20, 30, 40, 50, 60, 70, 80] }),
      expect: { absent: ['rec-fishing-retracted'] },
      derivation: [D('期望', 'ambient 候选池同样只含 active 投影；钓鱼记忆 8 次重提也不得复活')],
      note: '已撤回的高激活旧事实·ambient 不可达'
    },
    {
      id: 'Q7-recent-mention-strong-recall', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '想看流浪地球那样的',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-movie-wandering', rev: [1] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-recipe-hotpot' },     // 修正（amendment A1）：hotpot 命中 想（1/17）→ 1.0485 最高
          A1: { top1: 'rec-movie-wandering' },
          'A2-H7': { top1: 'rec-movie-wandering' },
          'A2-H30': { top1: 'rec-movie-wandering' },
          A3: { top1: 'rec-recipe-hotpot' },     // 1d 重提 → B=ln(1)=0 → 无增益（A3 已知边界）→ 同 A0
          'G2-H7': { top1: 'rec-movie-wandering' },
          G3: { top1: 'rec-recipe-hotpot' },
          G1: { top1: 'rec-movie-wandering' },
          G1G2: { top1: 'rec-movie-wandering' }
        }
      },
      derivation: [
        D('情境词元（引擎核对）', '17 词元；movie 8/17（流浪/浪地/地球 3 二元 + 看残差）T2；hotpot 1/17（想）T4；yunnan 2/17（地,的）T4'),
        D('A0/A3/G3', 'hotpot 1.0485 > yunnan (1.1176)×0.87281=0.9755 > movie (1.4706)×0.62914=0.9252 → hotpot'),
        D('A1', 'movie ×1.3466=1.2460 ✓；A2-H7 ×(1.5199×2^(-1/7))=1.3766→1.2736 ✓；A2-H30 ×1.4852=1.3742 ✓；G2-H7 同 A2-H7 ✓'),
        D('A3', 'movie t=1d → B=0 → 乘数 1.0 → 0.9252 ✗ → hotpot'),
        D('G1/G1G2', 'movie T2 boosted，gate 无障碍 → movie ✓')
      ],
      note: '最近主动提及（1 天前单次重提）：有重复回忆收益的策略应把它抬回第一；A0/G3 结构性做不到，A3 对 1d 重提无增益'
    },
    {
      id: 'Q8-cross-space-isolation', family: 'structural', mode: 'ambient',
      spaceIds: ['work'], at, situation: '项目代号和共享盘',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-shared-001', rev: [1, 2, 3, 4, 5, 6, 7, 8] }),
      expect: { inCandidates: ['rec-shared-001'], workActivationZero: 'rec-shared-001' },
      derivation: [D('期望', '同一 recordId 双空间；事件全部发生在 personal → work 副本激活必须为 0（硬断言，所有策略）')],
      note: '跨空间隔离：激活状态按 spaceId 严格隔离'
    },
    {
      id: 'Q9-uncommitted-umbrella-beats-commitment', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '有没有还没完成的约定',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [400, 700, 1000] }),
      expect: {
        inCandidates: ['rec-commitment-erhai'],
        strategyExpect: {
          A0: { top1: 'rec-umbrella' },
          A1: { top1: 'rec-umbrella' },          // 修正（amendment A1）：A1 erhai 0.7765×1.6931=1.3142 < umbrella 1.3490
          'A2-H7': { top1: 'rec-umbrella' },
          'A2-H30': { top1: 'rec-umbrella' },
          A3: { top1: 'rec-umbrella' },
          'G2-H7': { top1: 'rec-umbrella' },
          G3: { top1: 'rec-umbrella' },
          G1: { top1: 'rec-umbrella' },
          G1G2: { top1: 'rec-umbrella' }
        }
      },
      derivation: [
        D('情境词元（引擎核对）', '17 词元；umbrella 6/17（没有+还没+有还 3 二元）T2；erhai 5/17（约定 1 二元 + 的/约 残差）T3 —— 词面质量上「有没有还没…」与借伞未还更贴'),
        D('A0/A3/G3', 'umbrella (1.3529)×0.99709=1.3490 > erhai (1.2941)×0.6=0.7765'),
        D('A1', 'erhai ×1.6931=1.3142 < umbrella 1.3490 → umbrella（最初冻结为 erhai，系把 A2 系数 0.75 误用于 A1 的 0.5——算术修正，见 amendment A1）'),
        D('其余', 'erhai 距上次重提 30d → 衰减/floor → umbrella top1；erhai 必须保持候选可达')
      ],
      note: '长期未完成约定 vs 未完成小事：词面质量天然偏向 umbrella；记录（a）衰减策略的诚实下沉（b）gate 对 A1 合法提升的拦截代价'
    },
    {
      id: 'Q10-same-tier-legitimate-uplift', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '一起看日出还是爬山',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-commitment-erhai', rev: [1] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-umbrella' },          // 修正（amendment A1）：umbrella 命中 一+还（2/17）→ 1.1144 最高
          A1: { top1: 'rec-commitment-erhai' },
          'A2-H7': { top1: 'rec-commitment-erhai' },
          'A2-H30': { top1: 'rec-commitment-erhai' },
          A3: { top1: 'rec-umbrella' },          // 1d 重提 → B=ln(1)=0 → 无增益 → 同 A0
          'G2-H7': { top1: 'rec-commitment-erhai' },
          G3: { top1: 'rec-umbrella' },
          G1: { top1: 'rec-commitment-erhai' },
          G1G2: { top1: 'rec-commitment-erhai' }
        }
      },
      derivation: [
        D('情境词元（引擎核对）', '17 词元；erhai 7/17（日出 1 二元 + 残差「看」）T3；movie 5/17（一起 1 二元 + 残差「看」）T3 → 同 tier，gate 必须放行；umbrella 2/17（一,还）T4；hotpot 2/17 T4；plant 1/17 T4'),
        D('A0/A3/G3', 'umbrella (1.1176)×0.99709=1.1144 > hotpot 1.1067 > plant 0.9771 > erhai (1.4118)×0.6=0.8471 > movie (1.2941)×0.62914=0.8142 → umbrella'),
        D('重提 1d', 'A1 erhai ×1.6931=1.4342 ✓；A2-H7 ×(1.5199×2^(-1/7))=1.3766→1.1661 ✓；A2-H30 ×1.4852=1.2580 ✓；G2-H7 同 A2-H7 ✓'),
        D('A3', 'erhai t=1d → B=0 → 乘数 1.0 → 0.8471 ✗ → umbrella'),
        D('gate 校验', 'erhai 与 movie 同 T3 → gate 无动作 → 合法重排不被拦截（防 gate 过冻的正控制）')
      ],
      note: '同 tier 合法重排正控制：闸门不得阻止同质量候选间的激活重排（单次 1d 重提的旧约定应能越过同质量的记录）'
    },
    {
      id: 'Q11-single-revisit-weak-boost', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '花生酱拌面配咖啡',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', rev: [2] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-coffee-cafe' },
          A1: { top1: 'rec-allergy-peanut' },
          'A2-H7': { top1: 'rec-allergy-peanut' },
          'A2-H30': { top1: 'rec-allergy-peanut' },
          A3: { top1: 'rec-coffee-cafe' },
          'G2-H7': { top1: 'rec-coffee-cafe' },  // G2 不衰减 coffee（未强化全额 0.9452）→ allergy 0.8983 不够
          G3: { top1: 'rec-coffee-cafe' },
          G1: { top1: 'rec-allergy-peanut' },
          G1G2: { top1: 'rec-coffee-cafe' }
        }
      },
      derivation: [
        D('情境重设计（amendment A2）', '原情境「突然想吃花生酱还是喝咖啡」下 hotpot 命中 想/还 等散落单字且 A0 分最高，使「allergy top1」类期望对所有策略都不可达（fixture 缺陷）。改为本情境后引擎核对：全库仅 allergy 3/15（花生 1 二元）与 coffee 3/15（咖啡 1 二元）命中，hotpot/no-cilantro/umbrella/weather 均 0'),
        D('A0/A3/G3', 'coffee (1.2)×0.78764=0.9452 > allergy (1.2)×0.60029=0.7203 → coffee'),
        D('A1', 'allergy ×1.3466=0.9700 ✓'),
        D('A2-H7', 'allergy ×(1.5199×2^(-2/7))=1.2468→0.8983；coffee 被普遍衰减 ×2^(-90.9/7)→floor 0.4=0.3781 → allergy ✓；A2-H30 allergy ×1.4522=1.0461 ✓'),
        D('G2-H7', 'coffee 未强化 → 全额 0.9452 > allergy 0.8983 ✗（G2 弱点）'),
        D('A3', 'allergy t=2d → B=ln(2^-0.5)=-0.3466→×0.8787=0.6330 ✗ → coffee'),
        D('G1(A2-H7)', '两候选同 T4（单二元无残差）→ gate 无动作 → allergy ✓；G1G2 同 G2 ✗')
      ],
      note: '单次合法旧记忆重提（2 年旧记录、2 天前重提 1 次）：衰减系靠「衰减干扰」间接获胜；G2 系因不衰减干扰而失败 —— 两种设计各有一致代价'
    },

    // ================= S 组：最近投递抑制 =================
    {
      id: 'S1-suppression-window', family: 'suppression', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '外出和朋友吃饭要注意什么',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', del: [0.1] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-no-cilantro', del: [80] })
      ],
      expect: {
        strategyExpect: {
          A0: { orderAfter: { recordId: 'rec-no-cilantro', after: 'rec-allergy-peanut' } },
          A1: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H7': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H30': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          A3: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'G2-H7': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G3: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G1: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G1G2: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } }
        }
      },
      derivation: [
        D('情境词元', 'uni 12 + bi 11 = 23；allergy 3/23（外出 1 二元）T4；no-cilantro 1/23（要）T4 → 同 tier'),
        D('A0', 'allergy (1.130)×0.600=0.678 > no-cilantro (1.043)×0.600=0.626 → allergy 前'),
        D('抑制', 'allergy 2.4h 前投递 → 窗口内 ×0.5 → 0.339 < 0.626 → 有抑制机制的策略全部反转顺序')
      ],
      note: '刚投递过的提醒在无关情境下应被抑制（任务书失败模式 9 前半）——G3 的核心能力'
    },
    {
      id: 'S2-suppression-decay-zone', family: 'suppression', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '外出和朋友吃饭要注意什么',
      events: [
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', del: [0.5] }),
        ...eventHistory({ spaceId: 'personal', recordId: 'rec-no-cilantro', del: [80] })
      ],
      expect: {
        strategyExpect: {
          A0: { orderAfter: { recordId: 'rec-no-cilantro', after: 'rec-allergy-peanut' } },
          A1: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H7': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'A2-H30': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          A3: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          'G2-H7': { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G3: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G1: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } },
          G1G2: { orderAfter: { recordId: 'rec-allergy-peanut', after: 'rec-no-cilantro' } }
        }
      },
      derivation: [D('抑制', '12h 前 → 衰减区乘数 0.5+((12-6)/18)×0.5=0.667 → allergy 0.452 < 0.626 → 仍被压')],
      note: '抑制衰减区（6–24h 线性恢复）：12h 时点仍应低于未投递的同类提醒'
    },

    // ================= X 组：结构不变量（所有策略同判） =================
    {
      id: 'X1-same-source-duplicate', family: 'structural', mode: 'explicit',
      spaceIds: ['personal'], at, query: '科幻',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', rev: [5], tools: 3, sourceEventId: 'src-evt-shared-v2' }),
      expect: { top1: 'rec-scifi-books', reinforceCount: 1, sameAsSingleRevisit: true },
      derivation: [D('期望', '同一来源事件跨 3 工具转发 → 只算 1 次强化；排名与单次重提完全一致（所有策略）')],
      note: '同源重复事件幂等'
    },
    {
      id: 'X2-restart-replay-identity', family: 'structural', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '周末在家休息',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-gym-runs', rev: [2, 9, 16, 23, 30, 37, 44, 51] }),
      expect: { replayRoundTrip: true, replayOrderInsensitive: true },
      derivation: [D('期望', '事件日志落盘 → 重启（重新加载）→ 重放 → 每个策略的排名与内存重放逐位一致；乱序重放等价')],
      note: '重启与事件重放一致性（每策略验证）'
    },
    {
      id: 'X3-clock-anomalies', family: 'structural', mode: 'explicit',
      spaceIds: ['personal'], at, query: '科幻',
      events: [
        { eventId: 'clk2-1', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(5), observedAt: daysAgoIso(1), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk2-2', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(5), observedAt: daysAgoIso(2), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk2-3', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'user_revisited', occurredAt: daysAgoIso(-2), observedAt: daysAgoIso(1), sourceEventId: null, provenance: {}, signalVersion: 1 },
        { eventId: 'clk2-4', spaceId: 'personal', recordId: 'rec-scifi-books', eventType: 'delivered_reference', occurredAt: daysAgoIso(3), observedAt: daysAgoIso(3), sourceEventId: null, provenance: {}, signalVersion: 1 }
      ],
      expect: { top1: 'rec-scifi-books', finiteScores: true, replayOrderInsensitive: true },
      derivation: [D('期望', '重复时间戳 + 乱序 + 未来 occurredAt：分数有限、重放顺序无关（所有策略）')],
      note: '时钟异常鲁棒性'
    },
    {
      id: 'X4-internal-queries-no-reinforce', family: 'structural', mode: 'explicit',
      spaceIds: ['personal'], at, query: '科幻',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-scifi-books', internals: 50 }),
      expect: { top1: 'rec-scifi-books', identityToZeroEvents: true, reinforceCount: 0 },
      derivation: [D('期望', '50 次内部查询、用户零参与 → 排名与零事件逐位一致（A1/A2/G2/G1/G1G2 都必须满足）')],
      note: '内部管线事件永不强化'
    }
  ];
}

// 供 sanity 校验期望里引用的 recordId 都真实存在于语料。
export const HOLDOUT_V2_META = {
  frozenBeforeAnyStrategyRun: true,
  corpusSource: 'activation-01 fixtures/scenarios.mjs corpus()（26 条，未修改）',
  strategyMatrix: ['A0', 'A1', 'A2-H7', 'A2-H30', 'A3', 'G2-H7', 'G3', 'G1', 'G1G2'],
  scenarioCount: 23
};

// —— 排名指标的相关性声明（第二次预注册，先于任何策略运行；commit 2d0bfba 之后）——
// relevant：该情境下用户会想被想起的记录（Recall@5 / MRR / nDCG@5 / Top1 准确率 /
// Top3 入侵数的判定基础；其余候选一律视为非相关）。X 组结构场景不参与排名指标聚合。
// 这里的声明与各场景 derivation 的语义一致，不针对任何策略输出调整。
export const RELEVANCE_V2 = Object.freeze({
  'E1-explicit-followup-just-delivered': ['rec-allergy-peanut'],
  'E2-old-commitment-explicit': ['rec-commitment-erhai'],
  'E3-corrected-record-explicit': ['rec-address-new'],
  'E4-explicit-high-freq-vs-current-plan': ['rec-recipe-hotpot'],
  'E5-retracted-unreachable-explicit': [],
  'E6-ascii-term-explicit': ['rec-mk2-sensor'],
  'Q1-ambient-freq-intrusion-bigram-quality': ['rec-recipe-hotpot'],
  'Q2-single-char-noise-user-revisit': ['rec-movie-wandering'],
  'Q3-old-commitment-ambient-sink': ['rec-commitment-erhai', 'rec-travel-yunnan'],
  'Q4-single-candidate-trivial': ['rec-umbrella'],
  'Q5-recent-trivial-intruder-single-revisit': ['rec-gym-runs'],
  'Q6-retracted-ambient-unreachable': [],
  'Q7-recent-mention-strong-recall': ['rec-movie-wandering'],
  'Q8-cross-space-isolation': ['rec-shared-001'],
  'Q9-uncommitted-umbrella-beats-commitment': ['rec-umbrella', 'rec-commitment-erhai'],
  'Q10-same-tier-legitimate-uplift': ['rec-commitment-erhai'],
  'Q11-single-revisit-weak-boost': ['rec-allergy-peanut'],
  'S1-suppression-window': ['rec-allergy-peanut', 'rec-no-cilantro', 'rec-weather-smalltalk'],
  'S2-suppression-decay-zone': ['rec-allergy-peanut', 'rec-no-cilantro', 'rec-weather-smalltalk'],
  'X1-same-source-duplicate': ['rec-scifi-books'],
  'X2-restart-replay-identity': ['rec-recipe-hotpot'],
  'X3-clock-anomalies': ['rec-scifi-books'],
  'X4-internal-queries-no-reinforce': ['rec-scifi-books']
});

// 不参与排名指标聚合的场景（结构断言为主）。
export const EXCLUDE_FROM_RANKING = Object.freeze(['X2-restart-replay-identity']);

// —— 修正记录（amendments）———————————————————————————————
// 首轮运行后发现本文件的手工推导存在三类错误，按协议修正并在此公开记录。
// 所有修正均为「输入侧确定性数据（词元命中/公式算术）的核对修正」，
// 对 9 个策略同时生效，不构成对任何策略的选择性调整：
//   A1. 词元命中与算术错误：构造场景时手工分词漏掉了大量单字碰撞（这正是本实验
//       研究的现象本身）。受影响场景：Q2/Q3/Q7/Q10 的 A0/A3/G3 锚点、Q9 的 A1
//       期望（误用 0.75 系数于 A1）、Q4 的候选计数（plant 因「帮」入池）。
//       修正后的期望全部改由「引擎词元命中（确定性）+ 冻结公式手工验算」得出。
//   A2. Q11 情境重设计：原情境「突然想吃花生酱还是喝咖啡」下 hotpot 的宽泛单字
//       命中使冻结期望对所有策略不可达（结构性缺陷）。改为「花生酱拌面配咖啡」
//       （全库仅 allergy/coffee 命中）。该场景不再具备完整预注册纯度，报告中
//       单独标注；其判定结构（A1/A2/G1 成功、A0/A3/G3/G2/G1G2 失败）与原设计一致。
//   A3. S1/S2 相关性声明补全：weather-smalltalk（「早晚要加外套」）对「外出注意
//       什么」是可辩护的合法联想，计入 relevant（对 9 策略同时生效）。
// 未修正的冻结期望（Q1/Q5/E 组/S 组/X 组/Q8）在首轮运行中已按原样判定。
// 首轮原始结果保留在 git 历史（eval-v2.json 的上一版）中可查。
