# Activation-04 · 归因实验与本地体验（Attribution & Local Dogfood）

基线：activation-03 @ `d4e4a9a`（Atlas master `4f112f2` 不变；本 worktree `<Memory Atlas worktrees>\activation-04`，分支 `experiment/activation-04`）。
评估时钟：`2026-11-01T12:00:00.000Z`（与 v3 相同冻结时钟）。全部合成数据，无 LLM、无向量库、无新增依赖。

## 核心问题

**Activation-03 的检索改进（Top1 0.429 → 0.714）究竟来自哪里？**

- A. 更好的词面相关性判断（L）
- B. 动态回忆强化（R）
- C. 两者组合（LR）
- D. 最近投递后的重复抑制（D）

## 结论

```
1. 增益归因：上轮 4 个改善案例一半来自 L、一半来自 R —— 不是"全部来自记忆强化"。
   E01/E06（tier 同质）由 R 修复；E02/E13（tier 有差异）由 L 修复、且 R 单独在这些
   场景是错的（boost 保留错误 top1）—— 是 tier 闸门（词面判断）把 R 的错误拦下来的。

2. 单因子都不够（explicit 合并 21 场景，分母 21）：
        A0      L       R       LR      D
   Top1 0.3333  0.5238  0.6190  0.7143  0.3333
   MRR  0.7063  0.7778  0.8492  0.8730  0.7063
   nDCG5 0.8013  0.8507  0.8834  0.9051  0.8013
   （多候选子集 16 场景：A0 0.125 / L 0.375 / R 0.5 / LR 0.625）

3. LR 有独特、可重复的新案例收益：V02/V04/V05（新近重提类）由 R 分量修复而 L 不能；
   零事件词面类 V01 由 L 修复而 LR 不能（LR 无事件时不消费 tier 作为排序键）——
   这是 LR 相对 L 的已知缺口，不是新增错误（LR 在全部场景无相对 A0 回归）。

4. 决策：ACTIVATION SHADOW GO（重申，仍限定路径 A、仍默认关闭正式排序）。
   D 单独结论：RECENT-DELIVERY GO（ambient 浏览抑制 3/3 适用场景修复，explicit 绕过逐位验证）。

对任务书最终问题的回答：两者是互补而非替代 ——
强化乘数提供词面判断给不出的"旧但被真实重提"信号（6/14 个可修复案例），
词面闸门提供强化信号自己拦不住的安全性（boost 倒置防护）。
"更聪明的强化"只有在"更会判断相关性的闸门"约束下才可用。
```

---

## 1. 归因实验设计

五策略在同一批真实候选集、相同查询、相同时钟、相同事件历史上对照（每场景一次真实候选获取，五策略共用；成员资格零改动由断言与测试锁定）：

| 策略 | 定义 | 实现 |
|---|---|---|
| A0 | 正式原始排序（coordinator 原样） | activation-03 `rankA0` 逐字复用 |
| L | 仅词面质量：tier 升序稳定排序（T0 id-hit < T1 phrase < T2 multi-bigram < T3 bigram+residual < T4 weak），**不消费任何事件** | `rankL`（tier 判定 = activation-03 `computeTierFromReal` 原样） |
| R | 仅动态激活：原生 a0Score × G2 乘数（activation-02 数学），**无词面闸门**；路径 C 无 base 分数 → 拒用 | `rankR`（乘数 = activation-02 `g2Multiplier` 原样） |
| LR | activation-03 的 G1G2 原样：base × G2 + tier 闸门（gate 只约束 boosted 上移） | `rankG1G2` import 复用 |
| D | 原始排序 + RecentDelivery 抑制（ambient 抑制 / explicit 恒绕过 / 路径 C 稳定后移） | activation-03 `rankG3` import 复用（语义即 D） |

不修参数、不造新公式：新增代码只有两个"单因子"策略，全部数学组件 import 自 activation-01/02/03。

## 2. 上轮 4 个改善案例逐项归因（核心交付）

| 场景 | A0 top1 | L | R | LR | tier 分布 | 机制 |
|---|---|---|---|---|---|---|
| E01 小林（人物多事件） | cafe(grade1) | ✗ | **✓** | ✓ | 同质（全 T4） | R：重提乘数 ×1.575 上移 book；L 无候选间差异 |
| E02 健身房 跑步 | treadmill(grade1) | **✓** | ✗ | ✓ | 有差异（T1/T2） | L：phrase 优于散词；R 单独错（boost 保留 treadmill）→ LR 靠 gate 修复 |
| E06 周五 老周（明确追问） | cancel(grade1) | ✗ | **✓** | ✓ | 同质（全 T2） | R：meal 重提乘数 |
| E13 X-T30 相机（idHit） | backup(grade2) | **✓** | ✗ | ✓ | 有差异（T0/T1） | L：idHit=T0 优于 phrase=T1；R 单独错（boost 保留 backup）→ LR 靠 gate 修复 |

**逐字回答任务书的问题**：
- L 单独修复 2/4（E02、E13）；R 单独修复 2/4（E01、E06）。
- "Top1 0.429 → 0.714"不能记在记忆强化头上：**一半增益是词面质量判断**（其中两次还是以"闸门拦截强化错误"的形式出现）。
- LR 比 L 多解决：E01、E06（R 分量的独有价值）。
- LR 在这 30 场景没有引入 L 没有的错误（LR 相对 A0 的回归全集为空；唯一 "L 对 LR" 的差异见 §4 V01）。

## 3. 新独立案例（holdout-v4，8 场景，冻结于 fdb0030）

冻结纪律：语料 + 场景 + 期望（relevance/forbidden）+ 归因代码在 `fdb0030` 冻结（7 文件 sha256），**先于任何五策略运行**；冻结前只做过输入侧管道探针（AND 候选可达性，见 `results-v4/probe-plumbing.json`），未消费任何策略输出。困难类型覆盖任务书全部 8 类 + ambient 投递抑制。

| 场景 | 类型 | cand | A0 | L | R | LR | D |
|---|---|---|---|---|---|---|---|
| V01 phrase-vs-scatter | 旧而相关 + 短语 vs 散词 | 2 | g1 ✗ | **g3 ✓** | g1 ✗ | g1 ✗ | g1 ✗ |
| V02 explicit-reask | 明确追问（2h 前刚投递） | 2 | g1 ✗ | g1 ✗ | **g3 ✓** | **g3 ✓** | g1 ✗（explicit 绕过） |
| V03 freq-irrelevant | 高频无关（已知失效） | 2 | g0 ✗ | g0 ✗ | g0 ✗ | g0 ✗ | g0 ✗ |
| V04 commitment-book-return | 长期约定 + 多次重提 | 2 | g1 ✗ | g1 ✗ | **g3 ✓** | **g3 ✓** | g1 ✗ |
| V05 multi-revisit-health | 同一记忆 5 次重提 | 2 | g1 ✗ | g1 ✗ | **g3 ✓** | **g3 ✓** | g1 ✗ |
| V06 retracted-highfreq | 撤回的高频旧记录 | 2 | g3 ✓ | g3 ✓ | g3 ✓ | g3 ✓ | g3 ✓（forbidden=0） |
| V07 recent-weak-invoice | 新近弱相关 + 组合 | 2 | g1 ✗ | **g3 ✓** | **g3 ✓** | **g3 ✓** | g1 ✗ |
| V08 ambient-delivery（路径 B） | 刚投递抑制 | 3 | g2 ✗ | g2 ✗ | g2 ✗ | 拒用 | **g3 ✓** |

v4 explicit 组（分母 7）：A0 0.1429 / L 0.4286 / R 0.7143 / LR 0.7143 / D 0.1429。
诚实记录：V03 与 v3 的 E04/E05/E07/E08 同属已知失效模式（AND 同词元 tier 同质 / 无事件旧约定 / 同事实多来源），L/R/LR 均不可修——这些需要检索层（索引侧）改进，不是重排序器能解决的。V06 验证"激活状态存在 ≠ 候选复活"：撤回记录带 5 次历史重提，全策略结构性缺席。

## 4. 归因矩阵（v3+v4 排序分母 29 = explicit 21 + ambient 6 + fallback 5-3单候选；结构组不计入）

以"修复"= A0 top1 非 grade3 且策略 top1 = grade3 计（14 个 A0 错误案例）：

```
修复数：L 4（E02,E13,V01,V07）  R 6（E01,E06,V02,V04,V05,V07）  LR 8（上两组并集）  D 0（explicit 设计性恒等）

LR 修而 L 未修：E01, E06, V02, V04, V05   （R 分量的独有价值，5 案）
L 修而 LR 未修：V01                        （零事件词面案例，1 案 —— LR 的已知缺口）
LR 相对 L 的错误：V01（L=g3, LR=g1）
  └ 性质：LR ≡ A0（无事件时 gate 无从生效），是继承 A0 的错误，不是新损伤
相对 A0 回归：L/R/LR/D 全部为空；forbidden 召回全集为 0
```

R 单独的风险实证（V03）：boost 不改变对错但放大错误 top1 的分差；LR 的 tier 闸门正是防 boost 倒置的安全件（E02/E13 在 R 单独下是错的）。

## 5. 证据普查：coverage 恒 1 ≠ exactPhrase/idHit 恒定

任务书指出的问题被数据证实。16 个多候选 explicit 场景、51 个候选：

- coverage 分布：**{1: 51}** —— AND 求交下结构性恒 1，对排序零区分度；
- phraseHit 在候选间可变的场景：5 个（V01/V07/E02/E13 等）；
- idHit 候选：3 个（E13 等）；
- tier 有候选间差异的场景：5 个；同质：15 个。

即：在真实链路上，reranker 能拿到的有效词面信号不是 coverage，而是 phrase/idHit/tier——这正是 L（与 LR 的 gate）的实际工作面。

## 6. D（RecentDelivery）独立结论：RECENT-DELIVERY GO

- ambient 路径：B02（2h 前）✓、B03（10h 衰减区）✓、V08（1h 前）✓ —— 3/3 适用场景修复重复投递 top1；
- 路径 C 浏览：C05 稳定后移抑制 ✓（activation-03 原样）；
- explicit 绕过：全集逐位验证（D ≡ A0，含 V02 的"2h 前刚投递再追问"）；
- 回归：0。

## 7. 动态事件边界（§五 复核，全部保持）

- `candidate_retrieved / selected_for_context / generated_reference / ui_inspected` 永不强化（只读类；demo 中显式演示 candidate_retrieved 被记录但零强化）；
- `generated_reference ≠ delivered_reference`（bridge 测试保持）；
- 只有合法重提（`surface='user'` + `utteranceObserved=true`）改变激活；影子运行不持 EventLog，事件只来自 fixtures 剧本；
- eventId / sourceEventId 幂等 + 双进程重放哈希一致（测试 + demo 独立进程复核）；
- 检索结果仍由正式效力与可见范围约束（撤回结构性缺席，V06 + demo 双验证）。

## 8. 本地体验工具（cli/dogfood.mjs）

真实链路：NativeAuthority + createMemoryService + RetrievalCoordinator（worktree 根逐字 master）+ 真 glm-retrieval SearchAdapter（`ATLAS_GLM_MODULE` 只读导入；SQLite 索引与权威日志持久化在 `.dogfood/`）。

```bash
cd experiments/activation-04
node cli/dogfood.mjs --demo        # 脚本化全流程（幂等，可重复跑）
node cli/dogfood.mjs               # 交互模式（add/query/browse/revisit/deliver/retract/explain/events/replay-check）
```

demo 覆盖任务书 §四 全部 9 项：合成空间与不同时间记忆 → 查询「电影」五策略并排（A0/L/R/LR/D + 逐条证据/激活/投递/名次）→ 经 Event Bridge 合法重提「多次一起看过的电影」×2 → 重查：R/LR 把电影 #2→#1（原因逐条打印：g2 ×1.824），A0/L 不变 → 投递后 browse：D 抑制刚投递的电影（×0.437，#4→#5）→ 撤回"昨天的小事"→ 关键词与浏览两条路径均结构性缺席 → **独立进程**重放 events.jsonl，激活状态哈希逐位一致。解释 JSON 落盘 `results-v4/dogfood-explain/`（含 query-1 vs query-2 事件前后对照 = 交付 #6/#7）。

## 9. 决策推导（按任务书 §六停止条件逐条核对）

1. **LEXICAL-ONLY GO？** 否 —— L 单独 0.5238 ≠ "几乎全部收益"（LR 0.7143），LR 在 5 个新/旧案例上有 L 拿不到的修复。
2. **ACTIVATION SHADOW GO？** 是 —— LR 在新案例（V02/V04/V05）有独特、可重复收益（确定性重放，非调参所得：参数与数学全部继承 activation-01/02/03 原值），全集零关键正确性回归、零 forbidden。**仍默认关闭正式排序**，仅影子。
3. **ACTIVATION NO-GO？** 否 —— 动态激活在 explicit 上没有损害明确查询（回归为空）；其风险形态（boost 倒置）恰由词面闸门拦截。
4. **RECENT-DELIVERY GO？** 是（限定 ambient/浏览路径；explicit 恒绕过）。

**建议**：保留事件机制与解释工具；若未来推进，优先级不是新权重公式，而是 (a) 路径 A 影子接线到真实交互数据，(b) LR 的已知缺口 V01 类（零事件词面案例）——那是"L 作为排序键"的方向，本阶段按停止条件不实现。

## 10. 运行方式与测试

```bash
cd experiments/activation-04
node scripts/run-attribution.mjs          # 38 场景 × 5 策略 → results-v4/{attribution-traces.jsonl, attribution.json, evidence-census.json}
node --test tests/attribution.test.mjs    # 10 项全过（不变量 + 结论数据锁定）
node scripts/freeze-hash-v4.mjs           # 冻结哈希（已随 fdb0030 提交）
node cli/dogfood.mjs --demo               # 本地体验全流程（独立进程重放校验）
cd ../activation-03 && node --test tests/unit.test.mjs tests/event-bridge.test.mjs   # 21 项全过
cd ../activation-02 && node --test tests/unit.test.mjs                                # 18 项全过
```

组件：`src/`（attribution-strategies / attribution-runner）、`fixtures/`（corpus-v4 / holdout-v4 + PROBE）、`scripts/`（freeze-hash-v4 / probe-plumbing-v4 / run-attribution）、`tests/`（10 项）、`cli/`（dogfood.mjs）、`results-v4/`（freeze.json / probe-plumbing.json / attribution-traces.jsonl / attribution.json / evidence-census.json / dogfood-explain/*）。

## 边界与诚实性

- 全部合成数据；未修改 Atlas master / WhiteMoon / glm-retrieval / DeepSeek UI / activation-01/02/03 历史结果（activation-03 的 results-v3 在本 worktree 保持 d4e4a9a 原样）；未导入私人记忆；生产 Activation 保持默认关闭；仅本分支提交，未 push/merge。
- **冻结后分析侧变更（公开记录）**：`scripts/run-attribution.mjs` 在 fdb0030 冻结后修改过一处 —— 归因矩阵分母排除结构组（X01 重启确定性探针是 E02 场景的双进程重复运行，计入会把同一修复数两次）。只影响归因矩阵的计数口径，不影响 fixtures、relevance/forbidden 真值、任何策略实现与 byGroup 指标。冻结哈希核对：7 文件中 6 个逐位一致，仅该脚本 DIFF（见上文核对输出）。
- 路径 B（V08）仍是"休眠路径的影子探测"，非生产调用路径；ambient 收益不外推到生产 association。
- holdout-v4 冻结前做过一次输入侧管道探针（候选可达性）；未因运行结果修改任何期望（AMENDMENTS_V4 为空）。fixture 设计中一处 AND 词元缺陷（"把书还给他"不含"还书"二元词元）在冻结前的探针阶段发现并修正了语料 content，期望真值未动。
- 单字/同词元噪声（E04/E05/V03）、无事件旧约定（E07）、同事实多来源（E08）为已知不可修失效模式，留给检索层。
- 分母全部显式列名（byGroup[*].excluded）；单候选场景单独统计；结构组（X01-X04）不计入归因分母（X01 是 E02 的双进程重复）。
