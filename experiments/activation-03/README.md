# Activation-03 · 真实检索路径下的影子评价（Shadow Runner）

基线：activation-02 @ `daffba2`（Atlas master `4f112f2` 不变）。
分支：`experiment/activation-03`（独立 worktree `<Memory Atlas worktrees>\activation-03`）。
评估时钟：`2026-11-01T12:00:00.000Z`（冻结）。全部合成数据，无 LLM、无向量库、无新增依赖。

## 核心问题

**G1G2 在真实 Memory Atlas / GLM 检索路径上，是否仍能提供可靠收益？**

## 结论：**SHADOW GO（限定路径 A）—— G1G2 仅在 explicit 关键词路径保持收益；ambient/fallback 自动降级拒用**

```
explicit（路径 A，14 场景，分母 14，无排除）
  策略    Top1 Acc   MRR      nDCG@5   Top3入侵  forbidden召回  p50排序
  A0      0.4286     0.7738   0.8320   4         0             0.010ms
  G3      0.4286     0.7738   0.8320   4         0             0.008ms   ← explicit 恒不抑制，与 A0 同序
  G1G2    0.7143     0.8810   0.9047   4         0             0.110ms   ← +4 场景修复，0 回归，2 次 gate 可解释

ambient（路径 B 直连探测，6 场景，排序分母 5；B06 零候选显式排除）
  策略    Top1 Acc   MRR      nDCG@5   降级拒用
  A0      0.0        1.0      0.8636   —
  G3      0.4        1.0      0.9130   0/5        ← 2/2 抑制场景修复，repeatTop1 2→0
  G1G2    0.0        1.0      0.8636   5/5        ← 全部拒用 = 与 A0 逐位一致

fallback（路径 C，6 场景，排序分母 5；C05 无 grade≥2 显式排除，行为单独验证）
  策略    Top1 Acc   MRR      nDCG@5   降级拒用
  A0      0.4        0.7      0.8050   —
  G3      0.4        0.7      0.8050   0          ← C05 抑制行为单独验证通过
  G1G2    0.4        0.7      0.8050   6/6        ← 全部拒用 = 与 A0 逐位一致
```

硬不变量（全 30 场景 + 21 项测试）：撤回错误召回 **0**、跨空间泄漏 **0**、影子运行零副作用（修订号/派生态不变）、事件生命周期 10 项全过、activation-02 的 18 项守卫测试全过、Atlas master / WhiteMoon / glm-retrieval / DeepSeek UI / activation-01/02 历史结果零修改、生产 Activation 保持默认关闭。

---

## 1. 真实候选路径分析

见 **[PATH-ANALYSIS.md](PATH-ANALYSIS.md)**（逐行读取生产代码的六问题逐路径回答）。三句话版本：

1. **路径 A（explicit）是生产唯一活跃检索路径**；AND 求交使候选间词元证据同质（coverage 结构性恒 1），A0 排序 ≈ 纯 recency；G1 的 tier 区分度被压缩到 T0（idHit）/T1（phrase），但**足够让闸门在 2 个场景产生可解释的修复**，G2 的重提乘数在 4 个场景修复 top1。
2. **路径 B（association）在生产是休眠路径**：无调用方、Atlas 投影不传 subject/sourceSession、整句情境零锚——且关联候选**没有词元证据**，G1 不适用。
3. **路径 C（scan 回退）没有任何评分或词元证据**，G1G2 必须拒用。

## 2. 可运行的 Shadow Runner

`src/real-harness.mjs` + `src/shadow-runner.mjs`。**真实调用链**：`NativeAuthority` + `createMemoryService` + `RetrievalCoordinator`（Atlas worktree 根，逐字 master）+ `adapters/glm-retrieval.mjs` 工厂 + 真 `SearchAdapter`（`ATLAS_GLM_MODULE` → 生产 adapter.mjs，只读导入；SQLite 索引在临时目录）。每场景一次候选获取，三策略共用；正式排序 = A0（coordinator 原样）。

影子记录（`results-v3/shadow-traces.jsonl`，30 行）含任务书要求的全部字段：`queryId / spaceId / candidateSetHash / candidateCount / baselineRanking / shadowRanking / rankChanges / evidenceTier / activationComponents / recentDeliveryPenalty / fallbackReason / indexState / elapsedMs`，另加 `gateMoves`（逐次重排的人类可读原因）与 `idMap`（control 记录的派生 id 解析）。

红线执行：影子运行不持有任何 EventLog；`candidate_retrieved` 只以只读事件存在；fixtures 里的 `delivered_reference` 仅代表剧本声明的历史真实投递，其**记录规则**由 Event Bridge 测试约束（生成≠投递）。

## 3. Event Bridge 合成生命周期测试

`src/event-bridge.mjs`（实验性，不接入正式会话链路）+ `tests/event-bridge.test.mjs`（10 项全过）：

| 生命周期 | 记录规则 | 测试 |
|---|---|---|
| 用户主动重提 | 仅当 `provenance.surface='user'` 且 `utteranceObserved=true` → `user_revisited`（唯一强化类） | ✔（含管线观测拒绝） |
| 模型生成引用 | `generated_reference` 只读，永不强化 | ✔ |
| 回答实际投递 | 仅当 `deliveryConfirmed=true` → `delivered_reference`（只更新最近投递）；否则退化为 generated_reference | ✔ |
| 用户纠正 | 仅当正式权威回执（`formalAuthorization` + `operationId`）→ `user_corrected`（记录不应用） | ✔ |
| 同源重复转发 | 同空间同 `sourceEventId` 幂等折叠，不二次强化 | ✔ |
| 服务重启 | `EventIdFactory`（nonce）结构性零碰撞；合并日志双进程重放两条重提都保留 | ✔ |
| 跨空间 | 按 `spaceId::key` 隔离，状态不串联 | ✔ |
| 撤回恢复 | 激活状态存在 ≠ 候选复活：投影移除是结构保证（E11/E05 组） | ✔ |
| 写入成功但日志失败 | 返回 `eventRecorded=false / log-write-failed`，账本无该事件，重放零激活——**不伪造成功** | ✔ |
| Shadow 查询 | 一律拒绝（`SHADOW_QUERY_NOT_RECORDABLE`），影子查询零激活副作用 | ✔ |

## 4. 新保留集与冻结记录

`fixtures/holdout-v3.mjs`：**30 场景**（explicit 14 / ambient 6 / fallback 6 / structural 4），覆盖任务书 12 类困难案例（映射表见 `HOLDOUT_V3_META.difficultTypeCoverage`）。每场景含固定候选语料、冻结时钟、事件剧本、relevance 0..3 真值、forbidden 列表。

冻结纪律：`scripts/freeze-hash.mjs` → `results-v3/freeze.json`（7 个文件的 sha256），**冻结 commit `139a973` 先于任何策略运行**。首轮运行后发现两处**输入侧 plumbing 缺陷**（与相关性真值无关），已按任务书记录为 `AMENDMENTS`（A1：C05 的 since 被 harness 静默丢弃 + Atlas 时间过滤默认字段是 recordedAt，需显式 `timeField:'occurredAt'`；A2：B03 事件剧本键名与场景 id 不匹配）。**C05、B03 不再声称完整预注册纯度**；其余 28 场景不受影响。activation-02 的 23 个 holdout-v2 场景只作开发回归（其合成池前提不适用于真实路径），其 18 项守卫测试全过。

## 5. A0 / G3 / G1G2 对照（顶部表）与分母

分母纪律：排序指标只计入 `candidateCount>0 且存在 grade≥2` 的场景；**排除显式列名**（B06 zero-candidates、C05 no-grade2-relevant），不存在隐性排除。对照组：`byFamily[*].scenarios / rankingDenominator / excluded`。

**Activation-02 分母核对（任务书要求）**：README §5.2 标注 ambient 组 10 场景，但 `top1Accuracy=0.5556=5/9` 的分母是 **9** —— Q6-retracted-ambient-unreachable 的 `metrics=null`（撤回目标不在候选池，负可用性场景）被隐性排除且未在表格中说明。本报告同类排除全部显式列名。

## 6. 逐案例排名解释（gate 可解释性）

G1G2 在 30 场景中只产生 4 次影子重排 + 2 次 gate 强制移动，全部可解释可重放（trace 的 `rankChanges`/`gateMoves`）：

| 场景 | A0 top1 → G1G2 top1 | 机制 |
|---|---|---|
| E01 小林（人物多事件） | cafe(grade1) → book(grade3) | 1 天前重提 → G2 乘数 1.575；tier 同质（T1）→ 合法上移 |
| E02 健身房 跑步（词元质量） | treadmill(grade1,8 次重提,T2) → gym-run(grade3,T1 phrase) | **gate**：boosted T2 不得越过 T1 |
| E06 周五 老周（明确追问） | cancel(grade1) → meal(grade3) | explicit 不抑制 + 重提乘数；tier 同质（T2） |
| E13 X-T30 相机（idHit） | backup(grade2,boosted,T1) → camera(grade3,T0) | **gate**：boosted T1 不得越过 T0 |

诚实失效保留（不修饰）：E04 单字噪声与 E05 2 字查询短语同质 + 高频重提 —— AND 同词元下闸门无候选间差异，G1G2 与 A0 同序，问题未修。E07 旧约定无事件 → 诚实下沉但 top5 可达（`primaryReachable` 全组 14/14）。E08 多来源记录 → 激活引擎不做去重（权威层职责）。

## 7. 性能开销

n≤31 候选：p50 排序 A0 0.002–0.010ms / G3 0.008–0.129ms / G1G2 0.016–0.110ms；p95 最差 G1G2 0.71ms（explicit，4 候选）。gate fixup 最坏 O(n²) 在此规模不可观测。候选获取（真实索引检索）本身比三策略重排高一个数量级以上——重排不是瓶颈。

## 8. 真实集成可行性判断

1. **可接入**：activation-01 的 reranker 适配点（candidates 进、candidates 出）在真实 coordinator 上成立——成员资格由权威层保证，影子重排零成员变化已被断言锁定。
2. **边界即设计**：G1G2 必须按 `searchPath`/证据类别门控启用——路径 A 开，路径 B/C 自动拒用并落 `fallbackReason`。这个降级不是损失控制，而是正确性要求（路径 B/C 没有词元证据，boost 等于盲改）。
3. **ambient 缺失是结构性的**：若未来要让 ambient 生效，需要 (a) 一个调用方，(b) 投影携带 subject/sourceSession，(c) 情境→锚的词面查询拆分——三者皆缺，且即使补齐，association 候选仍无词元证据，G1 依旧不适用。
4. **explicit 的收益面**：A0 ≈ 纯 recency，任何有界的重提信号（G2）+ T0/T1 闸门都能在「旧但被重提」类查询上修复 top1；但 AND 同词元的噪声类查询（E04/E05）不可修，需要检索层（索引侧）改进，不是重排序器能解决的。

## 9. 决策：**SHADOW GO（限定路径 A）**

按任务书 §七规则逐项核对：

1. **真实候选路径 + 新保留集保持收益** ✅ explicit 组 Top1 +0.286 / MRR +0.107 / nDCG@5 +0.073，4 个多候选场景修复、0 回归；收益机制与 activation-02 一致（重提乘数 + tier 闸门）但**证据来源全部换成了生产原生输出**。
2. **无关键正确性回归** ✅ forbidden 0 / 跨空间 0 / 撤回 0 / explicit G3 与 A0 逐位一致 / 降级路径逐位一致 / 结构组 4 项全过。
3. **G3 独立收益** ✅（ambient/fallback 抑制 2+1 场景）——但不是「仅 G3 有收益」，故不判 G3 ONLY。
4. **ambient 收益不可外推** ✅ `NOT TRANSFERRED TO PRODUCTION ASSOCIATION` 显式成立：G1G2 在真实 ambient 路径 5/5 拒用。
5. **仍不自动启用生产排序** ✅ 生产 Activation 保持默认关闭；本阶段未修改任何正式记忆权威、效力、来源或权限边界；未 push / merge / 发布。

**建议的下一步（不在本阶段执行）**：路径 A 的影子接线（`searchPath=atlas-candidates+authoritative` 时启用 G1G2，其余路径直通 A0），先在真实交互数据上只记录 explain JSON 再评估开闸；同时把「AND 同词元噪声」类问题留给索引层。

## 10. 运行方式

```
cd experiments/activation-03
node --test tests/unit.test.mjs tests/event-bridge.test.mjs   # 21 项（真实 harness/证据/策略/gate + 生命周期）
node scripts/run-eval-v3.mjs                                  # 影子运行 + 统一评价 → results-v3/
node scripts/freeze-hash.mjs                                  # 冻结哈希（已随 139a973 提交）
cd ../activation-02 && node --test tests/unit.test.mjs        # 18 项守卫回归全过
```

组件：`src/`（real-harness / evidence / shadow-strategies / shadow-runner / event-bridge）、`fixtures/`（corpus-v3 / holdout-v3 + AMENDMENTS）、`scripts/`（freeze-hash / run-eval-v3）、`tests/`（21 项）、`results-v3/`（freeze.json / shadow-traces.jsonl / eval-v3.json）。

## 边界与诚实性

- 全部合成数据；未修改 Atlas master / WhiteMoon Core/Host/Body / glm-retrieval / DeepSeek UI / activation-01/02 历史结果；未导入私人记忆；未启用生产排序；仅本分支提交，未 push/merge。
- 路径 B 的影子探测是「直接驱动真 adapter 的 DTO 能力」，不是生产调用路径——生产根本不存在 ambient 候选流；报告所有位置均如此标注。
- AMENDMENTS A1/A2 公开记录；C05/B03 不计入完整预注册声明。
- 合成语料 34 条上单字碰撞密度可能高于真实库；tier 阶梯的实库表现以本轮真实 adapter 输出为下界，真实用户语料仍需影子运行验证。
