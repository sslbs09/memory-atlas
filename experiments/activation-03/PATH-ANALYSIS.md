# Activation-03 · 真实候选路径分析（交付物 1）

分析对象 = 真实生产代码，逐行读取，非文档复述：

| 组件 | 路径 | 本阶段角色 |
|---|---|---|
| GLM `searchCandidates` | `<WhiteMoon repo>/work/universal-memory-v0.1\glm-retrieval\src\adapter.mjs`（生产 `ATLAS_GLM_MODULE` 指向的同一文件） | 路径 A 引擎；路径 B 直连对象 |
| GLM `association` | 同上 `src/association.mjs` + `src/store.mjs`（bySubject/bySourceSession） | 路径 B 的候选生成器 |
| Atlas `RetrievalCoordinator` | `<Memory Atlas worktrees>\activation-03\src\retrieval.js`（master 4f112f2 逐字 worktree） | 路径 A/C 的协调层 |
| Atlas 权威扫描回退 | 同上 `src/query.js` `querySpace` | 路径 C 的应答者 |
| Activation-02 G1G2 Reranker | `experiments/activation-02/src/strategies.mjs` + `tiers.mjs`（本阶段逐字复用 G2 乘数与 tier 闸门 fixup） | 被测重排序器 |

三条路径逐项回答（任务书 §二的六个问题）：

---

## A · explicit 关键词检索（Atlas coordinator + 真 GLM 索引）—— 生产唯一活跃检索路径

**候选从哪里来？**
`createRetrievalCoordinator.search()` → `buildRetrievalRequest`（active 视图、有 q、无 order）→ `adapter.searchCandidates({instanceId, q, limit})` → 真 SearchAdapter：`termsForQuery(q)` 产生词元（CJK 一元+相邻二元、ASCII 整段）→ `store.collectCandidates` **倒排求交（AND，最小集合优先）** → 逐窗口取回。

**候选成员资格由谁决定？**
索引只提议。Atlas 把每条候选按 recordId 回读权威存储，经 `admits()`（kinds/status/visibility/时间窗）复核；索引列出但权威没有的进 `residue`（NOT_IN_FORMAL_HISTORY / STALE_PROJECTION），永不服务。**成员资格 = 权威存储**，与接入前完全一致。

**是否真的存在可比较的词元质量？**
**候选之间不存在。** `collectCandidates` 是 AND 求交：只有命中**全部**查询词元的文档才到达评分，且 `matchedTerms: terms` 全量返回（`store.mjs:320`）→ 每条候选 `coverage = matchedTerms/terms = 1.0`（结构性，非巧合；activation-02 的诊断在真实链路上逐位复现，本阶段 21 项测试含专门锁定）。`matchReason` 的词元条目对全部候选完全相同（且有 `MATCH_REASON_MAX_ENTRIES=8` 截断——长查询尾部词元不出现）。idHit 加成 `coverage = min(1, cov+0.5)` 在 AND 下被 1.0 封顶，**不可观测**。
候选间唯一真实差异：`recencyFactor(occurredAt/acceptedAt)` 与 recordId 平序。**生产 explicit A0 排序 ≈ 纯 recency**（score = 2×recency）。

**词元证据是原生输出还是重新计算？**
原生：`matchReason`（`term:<t>(<kind>)`、`recency:*`）与 `coverage` 是 adapter DTO 原生输出。影子侧仅对两项做合法重算并逐候选标注 `evidenceSource`：idHit 判定（与 `adapter.mjs:238` 同规则：词元是 recordId 小写子串）与 phrase 命中（规范化权威 content 包含规范化查询——reranker 在权威层之后运行，读 content 是合法输入）。

**能否在不改变候选集的前提下重排序？**
能。三策略影子重排共用同一候选数组，`assertSameMembership` 断言零成员变化；Atlas 的 coordinator 本身不重排（「候选顺序即排序」）。

**缺少证据时如何诚实降级？**
路径 A 有原生词元证据，G1G2 正常启用（tier 由原生 matchReason + 权威 content 计算）。但 tier 的**区分度被 AND 压缩**：T2/T3/T4 由查询级词元种类决定 → 候选间同质；只有 T0（idHit）与 T1（phrase，影子重算）存在候选间差异。闸门的真实作用域 = 「boosted 候选不得越过 id 命中/短语命中候选」。

**实证结论（holdout-v3 explicit 组，14 场景）：**
G1G2 修复 4 个多候选场景的 top1（E01 人物事件重提、E02 短语 vs 散词闸门、E06 明确追问重提、E13 idHit 闸门），top1 0.4286→0.7143，MRR 0.7738→0.881，nDCG@5 0.832→0.905，forbidden 0，gateMoves 2 次全部可解释可重放。**已知失效模式被如实保留**：E04（单字噪声）与 E05（2 字查询短语同质 + 高频重提）——AND 同词元下闸门无法区分，G1G2 不比 A0 差也不更好（无激活时同序；有激活时不改变既有顺序）。

---

## B · ambient 结构关联（association.mjs）—— **生产休眠路径**

**候选从哪里来？**
`findAssociations(store, anchorDocs)`：以词面命中的 top3 为锚，取**同 subject + 7 天时间窗**与**同 sourceSession** 的结构共现记录（`association.mjs`）。

**候选成员资格由谁决定？**
锚由词面查询决定；关联候选由结构字段决定；最终仍需经过（假想的）调用方权威复核。

**是否真的存在可比较的词元质量？——不存在，也无人消费。**
1. `associate=true` 的分支（`adapter.mjs:262-281`）给关联候选 `coverage: null`、`matchReason = [association:<原因>, anchor:<id>]`——**没有任何词元证据**。
2. **生产没有任何调用方**：`buildRetrievalRequest`（Atlas）与 `buildAdapterRequest`（Host）都不设置 `associate`；`associate` 字符串只出现在 adapter 自身。`whitemoon-sync.mjs`（唯一交付 subject/sourceSession 的模块）只被 demo 脚本引用。
3. **Atlas 投影结构性截断**：`projectRecord` 不投影 `subject`/`sourceSession` —— 即使有人打开 `associate`，经 Atlas 链路的关联也无输入可用。
4. **整句情境不可达**：`associate` 分支以词面查询 top3 为锚，而 AND 语义下整句情境（「和林然周末做什么」）零命中 → 无锚 → 零关联（holdout-v3 B06 实证）。

**词元证据是原生输出还是重新计算？**
关联候选没有原生词元证据，影子侧**拒绝编造**：`classifyEvidencePath = structural-association`，tier 强制 T4-none，`evidenceSource='none'`。

**能否重排序 / 如何降级？**
G1G2 整体拒用（`fallbackReason=NO_LEXICAL_EVIDENCE_ASSOCIATION`）。「G1G2 减去 G1」= G2-H7 单独，已被 activation-02 否决（Q1 类入侵），不是合法降级产物。G3（最近投递抑制）只消费 delivery 事件状态，不需要词元证据——**可用**。

**实证结论（ambient 组 5 个排序场景 + 1 负可用性）：**
G1G2 在全部场景拒用（降级 5/5），排序与 A0 逐位一致；G3 修复 2/2 抑制场景（B02 2h 内投递 ×0.5、B03 10h 线性恢复区间 ×0.611），repeatTop1 2/2→0/2。跨空间关联隔离（B04）、撤回不可达（B05）由 adapter 自身的 instance_id 过滤与投影移除保证。

---

## C · Atlas 权威扫描回退（querySpace）

**候选从哪里来？**
索引未接线（NOT_WIRED）、请求不可索引（NOT_APPLICABLE）、重建中（INDEX_REBUILDING）或适配器失败/拒绝（ADAPTER_FAILED/ADAPTER_REFUSED）时，`authoritativeScan → querySpace` 直接应答：可检索文本（searchableText）子串 AND，`status` 等过滤在权威层。

**候选成员资格由谁决定？**
存储自身（本路径没有索引参与）。

**是否真的存在可比较的词元质量？——不存在。**
`querySpace` 不产生 score、matchReason、coverage；默认排序 = **sequence 降序（录入顺序）**，不是 occurredAt。

**词元证据是原生输出还是重新计算？**
无。影子侧拒绝编造（`classifyEvidencePath = none`）。

**能否重排序 / 如何降级？**
G1G2 整体拒用（`NO_LEXICAL_EVIDENCE_SCAN`）。G3 在 ambient 浏览语义下以**稳定后移**表达抑制（不伪造分数）；explicit 查询不抑制。

**实证结论（fallback 组 5 个排序场景 + 1 行为场景）：**
成员与顺序在故障/未接线两种原因下完全一致（C01=C02）；撤回不可达（C04）、跨空间隔离（C06）保持；A0 的 recency 类失效（C01 噪声第一）在回退路径上未被修复——这是诚实的：没有词元证据时，激活引擎不应假装能修。

---

## 汇总：G1G2 的真实适用面

| 路径 | 生产状态 | G1 可用？ | G2 可用？ | G1G2 判定 |
|---|---|---|---|---|
| A explicit | **活跃** | 部分（仅 T0/T1 有候选间区分度） | 是 | **启用**（shadow 证实收益 +2.9 个场景的 top1） |
| B ambient | **休眠**（无调用方 + 投影截断 + 整句不可达） | **否**（无词元证据） | 单独=已否决 | **拒用**（自动降级，显式 fallbackReason） |
| C fallback | 故障时活跃 | 否 | 否 | **拒用**（同上） |

一句话：**G1G2 的可迁移收益只存在于 explicit 关键词路径；正式 association 路径不仅休眠，而且即使启用也不存在 G1 所需的词元证据** —— activation-02 的 ambient 收益不能外推为真实用户效果，`NOT TRANSFERRED TO PRODUCTION ASSOCIATION` 成立。
