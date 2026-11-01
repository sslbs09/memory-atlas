# WhiteMoon Universal Memory · Backend B（GLM）

独立检索索引与维护后端 + Memory Atlas 图投影。**派生物，不是第二套事实权威。**

> **v2 修复轮（GPT 验收）已落实**：复合键分隔符 NUL→`:`（Node 22 node:sqlite 截断
> 问题根治，schema v2 强制旧库重建）；索引与图**同一事务**提交（含内存代际经落盘
> meta 再同步，杜绝"索引已提交、图失败"中间态）；单一代际状态 + `recoverGraph()`
> 自动恢复（关系字段持久化进 documents）；统一 SearchAdapter DTO 见
> **[SEARCH-DTO-v1.md](./SEARCH-DTO-v1.md)**（q/query 别名、null≡undefined、
> offset/cursor 二选一、outcome/hasMore/returned、coverage、matchReason 恒数组、
> indexRevision 语义冻结）；Atlas 只读子图门面
> `src/integrations/atlas-graph.mjs`（speculative 永不升级、节点不带正文、无写路径）。
> 真实负向测试锁定：q「台灯」不命中只含「书包」的记录、非相邻单字不拼成二元命中、
> 部分词命中不算命中、撤回投影任何词不可达。

## 定位与边界（必读）

| 边界 | 声明 |
|---|---|
| 事实权威 | 只有 WhiteMoon Core 的正式 Instance 文档（Backend A）。本模块的一切都可删除后从正式来源全量重建 |
| 效力判定 | 不在检索层决定。本模块只信任调用方交付的 `status`，且**默认只投影 active 记录**；已纠正/已撤回内容进入 `removed_ledger` 台账并从索引与图中移除。Backend A 仍在服务端做最终 status/revision/visibility 过滤（双层防线） |
| 候选正文 | `searchCandidates` **默认不携带正文**（`includeText` 为显式的受信内部选项）。未经 Backend A 校验的正文不会经本模块流向客户端 |
| 相似度 | 不存在任何"相似即重复"路径。「喜欢」与「不喜欢」是不同的词元集合，永远分别可检索（mnemon#133 教训内建） |
| 时间衰减 | 只影响 score 排序（0.6~1.0 有界因子），不影响任何记录的存在性与效力 |
| 关联 | 只使用结构化字段共现（同主体/同会话/时间邻近），有界（锚点 ≤5、总量 ≤12），永远标注 `association:`；图推测边永远标注 `confidence:'speculative'` 并解释推测性，不冒充因果 |
| 跨实例 | 实例分区在文档、倒排、图三个层面都成立；关联与图边永不跨实例。对外的跨实例权限由 Host（Backend A）执行 |
| 正式数据 | 本模块对 Core **只读**。演示脚本输出中含"Core 正式文档前后一致"的直接证据 |

## 选型说明

`node:sqlite`（Node 24 内置，零原生编译，Windows 实测可用）+ 自建 CJK 倒排。
不用 FTS5：`unicode61` 不切分中文、`trigram` 无法命中 1~2 字短词——本模块对 CJK
建立逐字一元 + 相邻二元倒排（`src/tokenize.mjs`），1~2 字短词、代号（MK-II）、
日期（2026年3月14日）全部子串可查且相邻性精确（「台灯」命中、「灯台」不命中）。

## 目录

```
glm-retrieval/
├── src/
│   ├── tokenize.mjs            CJK 一元/二元 + ASCII 词元；查询词提取
│   ├── store.mjs               SQLite 存储：documents/postings/removed_ledger/meta；
│   │                           手写嵌套事务；rebuild 原子回滚；verify 全量互证
│   ├── adapter.mjs             SearchAdapter（B4 契约六方法 + 候选/游标/打分）
│   ├── association.mjs         B3 有界关联召回
│   ├── graph.mjs               Memory Atlas 图投影（节点/边/证据/推测标注/有界子图）
│   └── integrations/
│       └── whitemoon-sync.mjs  WhiteMoon 只读集成（可选；引擎核心零 WhiteMoon 依赖）
├── test/                       17 个测试文件，45+ 用例（node:test）
├── scripts/
│   ├── demo-sync.mjs           B6 联调演示（独立运行 + Core 只读同步 + 灾难重建）
│   └── bench.mjs               性能探针（--docs 可调）
└── results/                    真实运行输出
```

## 接口（B4 契约）

```js
import { SearchAdapter } from './src/adapter.mjs';

const adapter = new SearchAdapter({ path: 'index.sqlite' }); // 或省略 path → 内存库

adapter.upsertRecords([{
  recordId, instanceId, revision, text, status,          // 必需（status 缺省 active）
  sourceKind, sourceId, sourceSession, subject, eventId, // 来源/主体（可选）
  occurredAt, acceptedAt,                                // 时间（可选）
  supersedes, derivedFrom, mentions: [], relations: []   // 图投影关系字段（可选，由调用方交付）
}]);
// → [{recordId, instanceId, outcome: INDEXED|UNCHANGED|STALE_SKIP|PROJECTION_REMOVED}]

adapter.removeRecords(ids);            // 'recordId' 或 {instanceId, recordId} → 真实删除清单
adapter.searchCandidates({
  q?, recordId?, instanceId?, instanceIds?,
  since?, until?, sourceKind?, sourceId?, sourceSession?, subject?, types?,
  limit?, cursor?, includeText?=false, associate?=false
});
// → { indexState:'READY'|'REBUILDING', indexGeneration, totalCount, nextCursor,
//     candidates:[{ recordId, instanceId, indexRevision, score, matchReason[], indexState:'INDEXED', status }] }

adapter.rebuildIndex(records);         // 代际+1，原子；中断回滚，旧代际完好
adapter.getIndexStats();               // documents/postings/removedLedger/perInstance/...
adapter.verifyIndex();                 // SQLite 完整性 + 倒排互证 + 图边端点/计数互证

adapter.graph.overview({instanceId});  // 图统计（只统计 confirmed 边）
adapter.graph.neighbors(recordId, {instanceId, depth≤2, limit≤50, includeSpeculative});
adapter.graph.timeline({instanceId, since, until, limit});
adapter.graph.stats({instanceId});
```

查询拒绝空查询（q 与至少一个过滤条件必须给其一）；q 与 recordId 二选一（与
Backend A `/memory-search` 语义一致）；所有失败点名错误码，不静默降级。

## 与 Backend A 的对接状态

- **契约词汇对齐**：`q/recordId/status/limit/offset(→cursor)/order/instance/types`
  与 `host/src/memory-api.js` 的 `parseMemoryQuery` 同义；本模块新增
  `since/until/sourceKind/sourceId/sourceSession/subject/cursor/includeText/associate`。
- **分工**：GLM 交付候选（recordId + indexRevision + score + matchReason）；
  Qoder 在 Host 侧做 instance/visibility/status/revision/来源有效性的最终过滤
  与正文取回（A5）。本模块不替代也不绕过该过滤。
- **待接线**：Host 尚未调用本模块（Qoder 负责接线）；接入方式 =
  Host 在 Core 写入路径后调用 `upsertRecords`（active 记录 + 纠正链字段），
  重建路径调用 `rebuildFromInstanceDocs`（`src/integrations/whitemoon-sync.mjs`，
  只读）。

## 运行

```bash
cd /e/WhiteMoon/work/universal-memory-v0.1/glm-retrieval
npm test                 # 45+ 用例（含 Windows 文件库/WAL/并发风暴/损坏恢复）
npm run demo             # B6 联调演示：独立运行 + 真实 Core 只读同步 + 灾难重建
npm run bench            # 性能探针（--docs N 可调）
```

## 实测（Node 24.19.0 / Windows）

- 45/45 测试通过（`results/` 留档）
- 2000 条合成记录：索引 0.31 ms/条（批事务，含分词+倒排+图）；2 字 CJK 查询 27.5ms
  （命中 1800）；唯一词 6.1ms；图 timeline 1.3ms；verifyIndex 全量互证 338ms
- 灾难演练：库文件破坏 → open() 点名 `INDEX_STORE_UNAVAILABLE`（不伪装空索引）→
  原始来源完好 → 从来源重建 → 查询恢复

## 已知限制

1. **20GB SCALE NOT VALIDATED**。本模块未做 20GB 实测；bench 的外推不作为容量声明。
   后续按 10MB→100MB→500MB 阶段实测（`bench.mjs --docs`）。
2. 候选打分的覆盖率/新近度因子是 v0.1 启发式，未做检索质量评测（无标注集）。
3. `collectCandidates` 对高频一元词（如「的」）的求交集合可能较大；当前规模无碍，
   10 万级文档时需加词频截断或改倒排存储布局。
4. 图投影的 speculative 边只在查询时计算，不持久化（避免推测物沉淀为数据）。
5. `DatabaseSync` 为同步 API：适合 Host 内嵌的受信组件；若未来做独立服务进程，
   需要加请求队列（接口不变）。
6. 撤回类 control 记录不进图（其目标记录节点随投影移除）；「被谁撤回」的审查
   属于 Backend A 的管理视图，不属于检索投影。
