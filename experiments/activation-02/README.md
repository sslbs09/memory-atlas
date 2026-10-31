# Activation-02 · 相关性保护与动态记忆激活（第二阶段）

基线：activation-01 @ `34d8cf9`（Atlas master `4f112f2` 不变）。
分支：`experiment/activation-02`（独立 worktree `<Memory Atlas worktrees>\activation-02`）。
评估时钟：`2026-10-31T12:00:00.000Z`（固定）。全部合成数据，无 LLM、无向量库、无新增依赖。

## 核心问题

**能否保留重复回忆带来的收益，却不让频繁出现但无关的记忆挤掉真正应该被想起的内容？**

## 1. D03 根因诊断（scripts/diagnose-D03.mjs → results-v2/diagnose-D03.json）

D03 是 ambient 场景（情境「周末在家做什么吃的」）。逐候选证据（节选）：

| recordId | 命中词元 | cov | recency | act(H7) | A0分 | H7分 | 排名 A0→H7 |
|---|---|---|---|---|---|---|---|
| rec-recipe-hotpot | 周末+在家+家做（3 二元）+周,末,在,家 | 0.4706 | 0.9900 | 0.7399 | 1.4559 | 1.0773 | 1→2 |
| rec-gym-runs | 周末（1 二元）+周,末（全是组成字） | 0.1765 | 0.8700 | **2.1723** | 1.0235 | **2.2234** | 4→1 |
| rec-bike-riding | 周末（与 gym 完全相同的词元证据） | 0.1765 | 0.6977 | 0.4000 | 0.8208 | 0.3283 | 8→8 |

六个问题的结论：
1. **ambient 下 coverage 不恒为 1**（0.0588–0.4706）；**explicit AND 下结构性恒为 1**——对 base 36 查询 + 24 探针 × 两空间全量枚举 60 组配置全部 coverage=1，且与真实源码一致（`glm-retrieval/src/adapter.mjs:233-239`「collectCandidates 已按词元求交：到达这里的文档命中了全部词元」+ `store.mjs:274-289` postings 交集）。
2. 高频无关记忆入池原因：ambient 规则是「与情境词元交集>0」，gym 靠 周末/周/末 3 个词元入池。
3. gym 的全部一元命中（周、末）都是其唯一二元（周末）的组成字——零独立证据。
4. 存在真正可区分的证据：hotpot 3 个二元跨 3 个语段 vs gym 1 个二元。
5. 年龄衰减是**放大器不是根因**：A2-H7 双向拉大分差（hotpot ↓0.74 / gym ↑2.17），但取消衰减（G2 预演）后 gym 2.22 仍 > hotpot 1.46。
6. 词元质量层面证据足够（3:1）；coverage 比值层面 D03 恰好可分（2.67:1）但只存在于实验自建的 ambient 路径。

## 2. Coverage Gate 判定：**废弃**

真实 GLM AND 检索（生产 explicit 路径）中 coverage 结构性恒为 1 → 任何 coverage 比值闸门在该路径上**恒不触发**；正式 association.mjs（ambient 对应物）只用 subject/source_session 结构共现，根本不产生词面 coverage。D03 的 coverage 可分性是实验自建 ambient 路径的产物，且 2:1 阈值由 D03 单样本反推——按任务书纪律废弃，不换任意阈值。

## 3. 三条最小路线与实现

| 路线 | 实现 | 一句话 |
|---|---|---|
| G1 Lexical Evidence Tier | `src/tiers.mjs` + gate | 有序类别阶梯 T0 id 命中 > T1 完整短语 > T2 ≥2 二元 > T3 单二元+有区分度残差一元 > T4 弱匹配；**boosted（激活乘数>1）候选不得越过更高 tier**；抑制不受闸门约束。「无区分度」用多数规则（scope 内 df>50%） |
| G2 取消普遍年龄惩罚 | `src/strategies.mjs g2Multiplier` | 未强化记录激活恒为 1.0（A0 recency 原样保留在基础分）；强化信号只来自 user_revisited，形式沿用 A2（强度×半衰期衰减，clamp [0.4,2.25]）以保留回忆分布判别 |
| G3 仅最近投递抑制 | `src/strategies.mjs` | A0 排序原样 + ambient 投递抑制（6h×0.5，24h 线性恢复）；explicit 恒不抑制 |

组合候选：**G1 = A2-H7+gate；G1G2 = G2-H7+gate**。策略矩阵 9 个：A0/A1/A2-H7/A2-H30/A3（activation-01 原实现逐字复用）+ G2-H7/G3/G1/G1G2。

## 4. 新独立保留集 holdout-v2（23 场景，fixtures/holdout-v2.mjs）

- 6 explicit / 10 ambient / 2 suppression / 5 structural；覆盖任务书要求的全部 13 类（高频无关、词元质量、单字误命中、短语 vs 散字、长期约定、近期小事、最近提及、明确追问、单次旧记忆重提、同源重复、跨空间、撤回高激活、重启重放）。
- 语料复用 activation-01 的 26 条（不新增、不修改）。
- 期望与手工验算在 commit `2d0bfba` 先于任何策略运行冻结；相关性声明在 `3f30150` 冻结。
- **修正记录（公开）**：首轮运行后修正了三类 fixture 缺陷（amendment A1 手工分词算术错误 ×5 场景锚点、A2 Q11 情境重设计、A3 S1/S2 相关性补全），全部为输入侧确定性数据的核对修正，对 9 策略同时生效；受影响场景不再具备完整预注册纯度，报告中单独标注；首轮原始结果保留在 git 历史。

## 5. 统一评估（scripts/run-eval-v2.mjs → results-v2/eval-v2.json）

同一候选集/查询/时钟/期望；分 explicit/ambient/suppression/structural 四组；逐案例输出。
**注意：frozen-pass = 「行为符合预注册预测（含预测到的失败）」，不是质量分；质量看 vs RELEVANCE_V2 的排名指标。**

### 5.1 explicit 正确性（base 36 + holdout explicit 组）

全部 9 策略 base 36/36、Recall@5=1、forbidden 0 —— **explicit 零回归**；holdout explicit 组 frozen 全过（A1/A2-H30 在 E4 的失败是被预注册预测并记录的）。G1 闸门在 explicit 下结构性惰性（AND 候选同词元同 tier，有单元测试锁定）。

### 5.2 ambient 组（10 场景，质量指标 vs 相关性声明）

| 策略 | frozen | Top1 Acc | R@5 | MRR | nDCG@5 | Top3 入侵(总) | 质量缺失场景 |
|---|---|---|---|---|---|---|---|
| A0 | 8/8 | 0.556 | 0.889 | 0.686 | 0.691 | 19 | Q2/Q7/Q10/Q11（无激活） |
| A1 | 10/10 | 0.778 | 1.0 | **0.889** | **0.918** | **15** | Q1/Q5（入侵） |
| A2-H7 | 10/10 | 0.556 | 1.0 | 0.787 | 0.831 | 18 | Q1（入侵） |
| A2-H30 | 10/10 | 0.556 | 1.0 | 0.778 | 0.824 | 19 | Q1（入侵） |
| A3 | 10/10 | 0.556 | 0.778 | 0.659 | 0.616 | 20 | Q2/Q7/Q10/Q11（惩罚正当重提） |
| G2-H7 | 10/10 | 0.556 | 0.889 | 0.750 | 0.728 | 18 | Q1（无闸门）/Q2/Q11（不衰减噪声） |
| G3 | 10/10 | 0.556 | 0.889 | 0.686 | 0.691 | 19 | Q2/Q7/Q10/Q11（无激活收益） |
| G1 | **9/10** | 0.778 | 1.0 | 0.861 | 0.887 | 18 | **Q5（真实回归）** |
| G1G2 | 10/10 | **0.778** | 0.889 | 0.861 | 0.810 | 18 | Q2/Q11 top1、Q3/Q9 R@5 |

### 5.3 抑制组（S1/S2）

全部带抑制的策略 orderAfter 通过；explicit 追问（E1）不被抑制。抑制使刚投递记录退出 top5（S 组 R@5 0.667）——这是**预期行为**（刚说过的不再重复），语义由 orderAfter 冻结断言表达。

### 5.4 结构组（X1–X4）

9 策略全过：同源重复幂等、重启落盘重放逐位一致、时钟异常有限分数+乱序无关、内部查询零强化。

### 5.5 硬不变量（全 23 场景）

撤回错误召回 0、跨空间泄漏 0（9 策略相同）；单候选场景 8/23、多候选 15/23 分开统计（eval-v2.json candidateCounts）。

### 5.6 开发诊断集（activation-01 的 16 场景，观测性）

- G1G2：D03 ✓ hotpot、D04 ✓ hotpot、D09 ✓、D12 ✓ shared-001（修复 A2 系的沉没）、D15 ✓ climb-b（分布判别保留）、D01 △（单次重提不足以越过未衰减噪声）、D02 ✓。
- G1：同 G1G2 但 D12 让位（继承 A2 衰减）；G2-H7：D03 仍未修（无闸门）；G3：D15 退回 A0 行为（无分布判别）。
- A3 在 D01/D02 的失败（惩罚正当重提）在新保留集 Q2/Q7/Q10 再次复现。

## 6. 每条排序变化的解释（gate 可解释性）

所有 gate 移动都记录在 `gateMoves`（recordId、fromRank、toRank、人类可读原因），例如 Q5：
`hotpot(weak) 不得越过 gym(multi-bigram)，fromRank 1 → toRank 3`。G1G2 在 23 场景中共触发 7 次重排（deltaVsA0），每次都可解释、可重放。

## 7. 事件 ID 重启检查（scripts/check-event-ids.mjs → results-v2/event-ids-check.json）

- **确认真实冲突**：两个独立进程为同一 (spaceId, recordId) 生成完全相同的 `ev-personal-rec-scifi-books-1`（fixtures 模块级计数器重启清零）；合并日志后同类型事件被静默折叠（2 次重提只算 1 次），不同主体则显式抛 eventId-conflict。
- 跨空间：id 内嵌 spaceId，同进程内不互相污染（这一条本来就安全）。
- **最小修复**（`src/event-ids.mjs`）：进程启动 nonce（默认时间戳36进制+随机段）使重启后新进程与历史日志结构性零碰撞；可选 `resumeFrom` 从旧日志最大序号续接；幂等语义不变（同 eventId/same sourceEventId 仍折叠）。测试 4 项 + 诊断脚本双重验证。未引入分布式 ID 服务。

## 8. GO / NO-GO：**有条件 GO（候选：G1G2）**

七项条件逐项：
1. **D03 类入侵消除** ✅ G1G2 在 Q1/Q5/D03/D04 全部以 gate 结构性阻止（A1/A2 类入侵不再存在）；G2-H7 单独不行（无闸门）。
2. **保住最近投递抑制** ✅ S1/S2 + E1 explicit 绕过。
3. **保住有证据的重复回忆收益** ✅ Q7（1 天前单次重提的 movie 回到第一）、Q10（同 tier 合法提升）、D02/D15（dev）；已知边界：单次弱重提对未衰减噪声的提升有限（Q2/Q11/D01，A1 在这些场景更强）。
4. **explicit 零回归** ✅ base 36/36 × 9 策略 + explicit holdout + 闸门惰性测试。
5. **撤回/权限/空间零回归** ✅ 0/0 + 结构组 5/5。
6. **新独立保留集证据** ✅ 23 场景（修正记录公开；受影响 6 场景的锚点格不再具备完整预注册纯度，但对比结论全部建立在 9 策略相同的实际输出上，不受影响）。
7. **无隐藏的样本特化规则** ✅ tier 阶梯是公开类别规则；gate 通用；权重全部继承 activation-01 先验值。

**被否决项（与 activation-01 结论一致并有新证据）**：A1（收益与入侵同源：Q1/Q5 入侵 + E4 explicit 回归）；A3（B<0 惩罚正当重提：Q2/Q7/Q10）；A2 系（D03/Q1 入侵 + Q8/Q12 沉没零事件相关记录）；G2-H7 单独（Q1 类入侵仍在）；**G1 单独（Q5 真实回归：闸门只约束 boosted，修不了自身激活源的衰减伤害）**；G3 单独可作为最小止血方案但无重复回忆收益（条件 3 仅靠抑制解读勉强成立）。

**为什么 G1G2 而不是 ambient 指标更高的 A1**：A1 的每一分 ambient 收益都来自与入侵同源的计数信号（activation-01 判决在新保留集复现），且有 explicit E4 回归；G1G2 的收益（闸门 + 无衰减激活）与入侵抑制来自同一机制的两面，且 explicit/结构零回归。G1G2 的已知代价：不衰减新近噪声（Q2/Q11 top1 让给 A2 的「歪打正着」）、强化后久未重提的记录仍会沉到 floor（Q3/Q9 的 R@5 0.5，A1 可避免）。

## 9. 若 GO：下一阶段最小集成方案

1. 接入点沿用 activation-01 的 `reranker.mjs` 适配点，`activation.enabled=false` 默认关闭；strategy=G1G2。
2. 阶段 1（零风险）：explicit 重排序 only —— G2 乘数（gate 在 explicit 惰性）；base 36 + holdout explicit 已证零回归。
3. 阶段 2：ambient 路径 —— 仅当平台确有词法 ambient 候选流时启用 G1 闸门 + 抑制；若正式 ambient 走 `association.mjs` 结构共现（无词元证据），**闸门不适用**，只接 G3 抑制——这是明确边界，不是遗漏。
4. 事件管线：eventId 生成换 `EventIdFactory`（nonce + resumeFrom），日志格式不变。
5. 真实交互数据上先影子运行（只记录 explain JSON，不改排序）后再评估开闸。

## 10. 交付物与运行方式

```
node --test tests/unit.test.mjs        # 18 项单元测试（tier/gate/G2/G3/event-ids/守卫）
node scripts/sanity-v2.mjs             # holdout-v2 结构校验
node scripts/diagnose-D03.mjs          # D03 逐候选证据表 + coverage 前提全量枚举
node scripts/check-event-ids.mjs       # 事件 ID 重启碰撞诊断 + 修复验证
node scripts/run-eval-v2.mjs           # 统一评估 → results-v2/eval-v2.json
cd ../activation-01 && node --test tests/*.test.mjs   # 60 项基线测试仍全过
```

组件：`src/tiers.mjs`（阶梯+df）、`src/strategies.mjs`（G2/G3/G1/G1G2 + gate fixup）、`src/event-ids.mjs`、`fixtures/holdout-v2.mjs`（23 场景 + 修正记录）、`scripts/`（5 个）、`tests/unit.test.mjs`（18 项）、`results-v2/`（diagnose-D03.json、event-ids-check.json、eval-v2.json、events-holdout-v2.jsonl）。

性能：单次排序 median A0 0.048ms / G3 0.118ms / G1G2 0.123ms（26 记录）；事件日志 333 B/级；gate fixup 最坏 O(n²)，n=50 上限内不可观测。

## 边界与诚实性

- 全部合成数据；未修改 Atlas master / activation-01 结果 / glm-retrieval / WhiteMoon / DeepSeek UI；未启用生产 Activation；仅本分支提交，未 push/merge。
- 预注册修正（A1–A3）已公开记录；首轮原始评估结果在 git 历史（`3f30150` 之后的第一次 run-eval 输出，可由历史版本复现）。
- 合成语料 26 条上单字碰撞密度可能高于真实库；tier 阶梯的实库表现未验证——这是阶段 5（影子运行）的前提，不是本阶段结论的一部分。
