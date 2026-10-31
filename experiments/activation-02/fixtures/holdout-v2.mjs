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
          A0: { top1: 'rec-umbrella' },          // A0 无激活信号：新近无关小事压过 315 天前的电影记录
          A1: { top1: 'rec-movie-wandering' },
          'A2-H7': { top1: 'rec-movie-wandering' },
          'A2-H30': { top1: 'rec-movie-wandering' },
          A3: { top1: 'rec-umbrella' },          // A3 对 3/10 天前重提给出 B<0 惩罚（已知缺陷）
          'G2-H7': { top1: 'rec-umbrella' },     // G2 不衰减未强化的 umbrella（全额 1.050）→ movie 0.987 不够
          G3: { top1: 'rec-umbrella' },
          G1: { top1: 'rec-movie-wandering' },
          G1G2: { top1: 'rec-umbrella' }
        }
      },
      derivation: [
        D('情境词元', 'uni 10 + bi 9 = 19；movie 3/19（电影 1 个二元，无残差）T4；erhai/umbrella(一)/weather(时) 各 1/19 T4 → 全员同 T4，gate 不介入'),
        D('A0', 'umbrella (1.053)×0.997=1.050 > weather 1.030 > movie (1.158)×0.629=0.728 → umbrella'),
        D('A1', 'movie ×(1+0.5·log1p(2))=1.549 → 1.128 ✓'),
        D('A2-H7', 'movie ×(1.824×2^(-3/7))=1.355 → 0.987 > umbrella ×2^(-1/7)=0.951 ✓（A2 对 umbrella 的普遍衰减歪打正着）'),
        D('G2-H7', 'umbrella 未强化 → 乘数 1.0 全额 1.050 > movie 0.987 ✗ —— G2 的结构性弱点：不衰减未强化新近干扰'),
        D('A3', 'B=ln(3^-0.5+10^-0.5)=-0.112→×0.961=0.699 ✗'),
        D('G1(A2-H7+gate)', '同 A2-H7（gate 无动作）✓；G1G2 同 G2 ✗')
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
          A0: { top1: 'rec-umbrella' },
          A1: { top1: 'rec-commitment-erhai' },
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
        D('情境词元', 'uni 12 + bi 11 = 23；erhai 7/23（春天+旅行 2 二元）T2；yunnan 6/23 T2；umbrella 3/23（还没 1 二元）T4'),
        D('A0', 'umbrella (1.130)×0.997=1.127 > yunnan (1.261)×0.863=1.088 > erhai (1.304)×0.6=0.782'),
        D('A1', 'erhai ×1.99=1.556 ✓（T2 boosted，不越界）'),
        D('A2-H7/H30/A3/G2', 'erhai 距上次重提 30d → A2-H7 ×0.134→floor 0.4 → 0.313；×1.3=1.017(H30) 仍 < umbrella(H30 ×0.977=1.101)；A3 负 B → floor；诚实下沉但必须保持候选可达（inCandidates）'),
        D('G 系', 'umbrella 未强化全额 1.127（G2）或 ×0.906=1.021（A2）→ umbrella top1；G1 系 erhai 0.4 不 boosted，gate 无动作')
      ],
      note: '长期未完成约定·ambient：衰减策略下诚实下沉，可达性必须保留；A1（纯计数）是唯一能把它抬回第一的策略 —— 记录 gate/衰减的代价'
    },
    {
      id: 'Q4-single-candidate-trivial', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '帮我记着那把黑色长柄伞',
      events: [],
      expect: { top1: 'rec-umbrella', candidateCount: 1 },
      derivation: [D('候选', 'umbrella 10/21（黑色/长柄/柄伞…），其余记录 0 命中不入池 → 单候选'), D('期望', '单候选简单回忆，所有策略一致')],
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
        D('情境词元', 'uni 9 + bi 8 = 17；gym 11/17（周末/跑步/健身/去健 4 二元）T2；hotpot 3/17（周末 1 二元无残差）T4；yunnan 1/17（去）T4'),
        D('A0', 'gym (1.647)×0.871=1.434 > hotpot (1.176)×0.997=1.172 ✓'),
        D('单次重提(0.5d)', 'A1 hotpot ×1.346=1.578 ✗；A2-H7 ×1.281=1.501 ✗；A2-H30 ×1.330=1.559 ✗；G2-H7 同 A2-H7 ✗'),
        D('A3', 'hotpot t=0.5d → B=ln(2^0.5)=0.347→×1.121=1.314 < gym 1.434 ✓'),
        D('G1/G1G2', 'hotpot boosted(T4) 不得越过 gym(T2) → gym ✓（单次重提即可反转一切非 gate 策略 —— 闸门的最小反例）')
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
          A0: { top1: 'rec-travel-yunnan' },
          A1: { top1: 'rec-movie-wandering' },
          'A2-H7': { top1: 'rec-movie-wandering' },
          'A2-H30': { top1: 'rec-movie-wandering' },
          A3: { top1: 'rec-travel-yunnan' },     // 单次 1d 重提 → B=ln(1)=0 → 无增益（A3 已知边界）
          'G2-H7': { top1: 'rec-movie-wandering' },
          G3: { top1: 'rec-travel-yunnan' },
          G1: { top1: 'rec-movie-wandering' },
          G1G2: { top1: 'rec-movie-wandering' }
        }
      },
      derivation: [
        D('情境词元', 'uni 9 + bi 8 = 17；movie 7/17（流浪/浪地/地球 3 二元）T2；yunnan(地)/erhai(的) 各 1/17 T4'),
        D('A0', 'yunnan (1.059)×0.863=0.914 > movie (1.412)×0.629=0.888 ✗（A0 无激活）'),
        D('A1', 'movie ×1.346=1.195 ✓；A2-H7 ×(1.346×2^(-1/7))=1.220→1.082 ✓；A2-H30 ×1.315→1.168 ✓；G2-H7 同 A2-H7 ✓'),
        D('A3', 't=1d → 1^-0.5=1 → B=ln(1)=0 → 乘数 1.0 → 0.888 < yunnan 0.914 ✗')
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
          A1: { top1: 'rec-commitment-erhai' },  // 无闸门的纯计数会把它抬到第一
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
        D('情境词元', 'uni 8 + bi 9 = 17；umbrella 5/17（还没+没有 2 二元）T2；erhai 4/17（约定 1 二元，组成字无残差）T4 —— 词面质量上「还没完成」与借伞未还更贴'),
        D('A0', 'umbrella (1.294)×0.997=1.290 > erhai (1.235)×0.6=0.741'),
        D('A1', 'erhai ×1.99=1.475 > 1.290 → 若无闸门则 erhai top1；该策略在矩阵中无闸门 → 期望 erhai（闸门代价的对照点：把此策略加上 G1 后 umbrella 应回到第一）'),
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
          A0: { top1: 'rec-movie-wandering' },
          A1: { top1: 'rec-commitment-erhai' },
          'A2-H7': { top1: 'rec-commitment-erhai' },
          'A2-H30': { top1: 'rec-commitment-erhai' },
          A3: { top1: 'rec-movie-wandering' },
          'G2-H7': { top1: 'rec-commitment-erhai' },
          G3: { top1: 'rec-movie-wandering' },
          G1: { top1: 'rec-commitment-erhai' },
          G1G2: { top1: 'rec-commitment-erhai' }
        }
      },
      derivation: [
        D('情境词元', 'uni 8 + bi 7 = 15；erhai 4/15（日出 1 二元 + 残差「看」）T3；movie 4/15（一起 1 二元 + 残差「看」）T3 → 同 tier，gate 必须放行'),
        D('A0', 'movie (1.267)×0.629=0.777 > erhai (1.267)×0.6=0.760 → movie'),
        D('重提 1d', 'A1 erhai ×1.346=1.023 ✓；A2-H7 ×(1.346×2^(-1/7))=1.219→0.927 ✓；A2-H30 ×1.315=0.999 ✓；G2 同 A2 ✓；A3 B=ln(1)=0 → 0.760 ✗ movie'),
        D('gate 校验', 'erhai 与 movie 同 T3 → gate 无动作 → 合法重排不被拦截（防 gate 过冻的正控制）')
      ],
      note: '同 tier 合法重排正控制：闸门不得阻止同质量候选间的激活重排（单次 1d 重提的旧约定应能越过同质量的记录）'
    },
    {
      id: 'Q11-single-revisit-weak-boost', family: 'ambient', mode: 'ambient',
      spaceIds: ['personal'], at, situation: '突然想吃花生酱还是喝咖啡',
      events: eventHistory({ spaceId: 'personal', recordId: 'rec-allergy-peanut', rev: [2] }),
      expect: {
        strategyExpect: {
          A0: { top1: 'rec-coffee-cafe' },
          A1: { top1: 'rec-allergy-peanut' },
          'A2-H7': { top1: 'rec-allergy-peanut' },
          'A2-H30': { top1: 'rec-allergy-peanut' },
          A3: { top1: 'rec-coffee-cafe' },
          'G2-H7': { top1: 'rec-coffee-cafe' },  // G2 不衰减 coffee（未强化全额）→ allergy ×1.104=0.810 < 0.918
          G3: { top1: 'rec-coffee-cafe' },
          G1: { top1: 'rec-allergy-peanut' },
          G1G2: { top1: 'rec-coffee-cafe' }
        }
      },
      derivation: [
        D('情境词元', 'uni 10 + bi 8 = 18；allergy 4/18（花生 1 二元 + 残差「吃」）T3；coffee 3/18（咖啡 1 二元无残差）T4'),
        D('A0', 'coffee (1.167)×0.787=0.918 > allergy (1.222)×0.600=0.734'),
        D('A1', 'allergy ×1.346=0.988 ✓；A2-H7 ×(1.346×2^(-2/7))=1.104→0.810，coffee 被 A2 衰减 ×2^(-91/7)→floor 0.4=0.367 → allergy ✓'),
        D('G2-H7', 'coffee 未强化 → 全额 0.918 > allergy 0.810 ✗（G2 弱点第三次出现）'),
        D('A3', 't=2d → B=ln(2^-0.5)=-0.347→×0.879=0.645 ✗'),
        D('G1(A2-H7)', 'allergy 0.810 ✓（T3 已在 T4 之前）；G1G2 同 G2 ✗')
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
