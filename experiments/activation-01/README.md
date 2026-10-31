# Activation-01 · 动态记忆激活与回忆强化实验

v0.2 第一阶段：在 Memory Atlas v0.1（HEAD `4f112f2`）上验证——
**记忆能否根据真实交互经历动态改变被想起的倾向，同时不损害事实正确性、长期约定与来源可信度。**

- 分支：`experiment/activation-01`（独立 worktree，本目录）
- 基线：A0 逐字复刻 `glm-retrieval/src/adapter.mjs @ 4f112f2` 的 `score = (1 + coverage) * recencyFactor`（含 AND 词元语义、id 命中 +0.5、`0.6 + 0.4·exp(-days/120)` recency、score 降序 + recordId 升序 tie-break）
- 运行：Node ≥ 24，无新增依赖，无向量库，无模型调用

## 运行方式

```bash
node --test tests/*.test.mjs     # 60 项单元测试（含 10 项失败模式回归）
node scripts/sanity.mjs          # 评价集候选集健全性检查
node scripts/run-eval.mjs        # 正式评估 → results/eval-results.json + results/REPORT.md
```

## 目录

```
src/
  tokenizer.mjs   自 glm-retrieval 原样内联的 CJK 一元/二元分词（vendored，含出处）
  candidates.mjs  候选池：active 投影、空间硬边界、explicit(AND)/ambient(重叠) 两种相关性
  events.mjs      八类派生事件、幂等（eventId + sourceEventId 双层）、重放、时间校验
  activation.mjs  A1/A2/A3 激活乘数、clamp、RecentDelivery 抑制、六信号分离
  ranking.mjs     统一评分 + 逐候选分解 + explainRanking("为什么 A 排在 B 前面")
  explain.mjs     机器可读解释 JSON
  replay.mjs      JSONL 事件日志落盘/加载/乱序重放
  reranker.mjs    可选 Activation Reranker 适配点（默认 enabled=false）
fixtures/scenarios.mjs   合成语料 26 记录 + 12 基础情景×3 查询 + 16 动态保留场景 + 调参场景
tests/            events / activation / ranking / failure-modes / reranker
scripts/          sanity / run-eval
results/          eval-results.json、REPORT.md、events-synthetic.jsonl（生成物）
```

## 六种信号的实现分离

| 信号 | 实现位置 | 变化来源 |
|---|---|---|
| Validity | candidates.mjs 投影硬过滤 | 只信任语料/正式管线交付的 status；激活无法复活 retracted/superseded |
| Evidence | explain 只读报告 | 仅来源字段 + 正式授权的 user_confirmed 计数；激活事件永不增长它 |
| Importance | 语料静态属性，explain 只读 | 任何事件不得修改（测试锁定） |
| Activation | activation.mjs | 仅 user_revisited；有界 clamp [0.4, 2.25] |
| Relevance | ranking.mjs 词元覆盖 | 仅当前查询/情境；当前问题优先 |
| RecentDelivery | activation.mjs 抑制乘数 | 仅 delivered_reference；explicit 追问恒不抑制 |

## 事件语义（八类）

`candidate_retrieved` / `selected_for_context` / `generated_reference` / `delivered_reference` /
`user_revisited`（唯一强化类）/ `user_confirmed`（证据，需正式授权）/ `user_corrected`（只记录不应用）/
`ui_inspected`（只读）。
幂等：同 eventId 重复、同 sourceEventId 跨工具转发 → 只算一次；同 sourceEventId 指向不同记录 → 显式拒绝。
时间：occurredAt（真实交互）与 observedAt（引擎观测）分离；未来时间戳年龄钳制；乱序重放等价。

## 策略

- **A0**：现有 GLM 基线（不消费事件）。
- **A1**：`1 + 0.5·log1p(次数)`，有界边际递减。
- **A2**：`S·2^(-elapsed/H)`，S = `1 + 0.75·log1p(次数)`；H ∈ {7, 30} 天为实验变量。
- **A3**：ACT-R `B = ln(Σ t_j^-0.5)` → `1 + 0.35·B`；零事件恰好回到基线 1.0。
- 共同边界：乘数 clamp [0.4, 2.25]；RecentDelivery 仅 ambient 抑制（6h 内 ×0.5，24h 线性恢复）。
- 权重全部为先验选定（未做任何拟合）；敏感性扫描在 results/weights 敏感性段单独报告。

## 主要结果（详见 results/REPORT.md）

- 基础 36 用例（explicit）：五策略全部 36/36，Recall@5 = MRR = nDCG@5 = 1.0，forbidden 命中 0 —— **explicit 正确性零回归**。
- 动态保留 16 场景：A2-H7 15/16；A1、A2-H30、A3 各 14/16；A0 仅 2 个场景可判定。
- 各策略失败模式互不相同：
  - A1（次数强化）：D03/D04 高频入侵。敏感性显示 wCount ≤ 0.15 可消除入侵，但同一权重也消除其在 D05 的合法提升——**收益与入侵同源**。
  - A2（半衰期）：D03 入侵在任何 wStrength 下都存在——A2 对未强化记录按记录年龄普适衰减，削弱词面相关性。H=7 比 H=30 少犯 D04。
  - A3（ACT-R）：无入侵，但对单次较旧重提给出 B<0 惩罚，D01/D02 中"用户刚重提过的记忆"反而输给新近闲聊——**惩罚了想鼓励的行为**，按现状否决。
- A0 无法做到（事件策略能做到）：recentDelivery 抑制（D09）、旧约定 ambient 恢复（D05，仅 A1）、重提分布判别（D15，仅 A2/A3）。
- 性能：单次排序 median 0.07ms / p95 0.16ms（26 记录合成库）；150 事件重放 0.14ms；事件日志 333 B/条，落盘 round-trip 一致。

## GO / NO-GO

**有条件 GO（候选：A2-H7 变体）。** 五项 GO 条件逐项满足：
1. 保留测试真实收益：D09 抑制、D15 分布判别（A0 结构性无法做到）✅
2. 撤回/权限/主体归属/长期约定四类关键回归：0（D06/D13/D12/D05b/D07 全过，forbidden 0）✅
3. 不被模型自我召回刷高：结构性保证（仅 user_revisited 强化）+ FM1/FM1b/FM8 回归 ✅
4. 可解释可重放：逐候选分量分解 + 幂等重放 + 乱序/时钟异常等价 ✅
5. 成本：0.07ms/次排序、333B/事件 ✅

条件（全部满足才可离开实验分支）：
- `activation.enabled = false` 默认关闭（reranker.mjs 已按此实现）；
- 首次接入仅限 explicit 重排序（实验显示 explicit 模式零回归）；
- ambient（联想）启用前必须先解决 D03 类高频入侵——A2 的该问题在任何强度下存在，需要"强化不得反转超过阈值的 coverage 差"一类覆盖感知闸门（下一阶段验证）；
- A1 与 A3 按当前形态否决（A1 收益/入侵同源；A3 惩罚正当重提）。

## 状态分类

- 已实现：全部 src/、fixtures/、reranker 适配点（默认关闭）。
- 已测试：60 项单元测试 + 36 基础用例 + 16 动态保留场景（A0/A1/A2-H7/A2-H30/A3 全矩阵）。
- 未测试：与真实 WhiteMoon Host/Core 的端到端接线（本阶段按接入规则禁止）；真实交互数据上的表现。
- 计划中：ambient 覆盖感知闸门、权重在线校准（需真实 user_revisited 流）、Memory Universe 消费 explain JSON（本阶段不改 UI）。

## 边界与诚实性

- 全部合成数据；期望答案在看到任何策略输出之前固定于 fixtures；
- 未修改 <Memory Atlas repo> master、glm-retrieval、WhiteMoon Core/Host/Body、DeepSeek 前端；
- 仅在本分支提交，未 push/merge；
- A0 的行为以真实 HEAD 代码为准（vendored tokenizer + 逐行核对的公式），不是任务书转述。
