# Mnemosyne 互操作与吸收笔记

研究对象：[canyueY/dsh-mnemosyne](https://github.com/canyueY/dsh-mnemosyne)（Mnemosyne 2.0.0，2026-11-03 读取）。
本文是调研笔记，不是联调报告：**只读了它的 README、工具规格与 DSH 集成文档，没有运行它的代码，
也没有做过双向联调。** 下面凡标「提案」的都没有实现。

## 它是什么

Mnemosyne 是面向 AI Agent 的记忆基础设施：Python Node（FastAPI + SQLite Memory Bank）+
DSH 原生插件适配层，另有 REST `/api/v1` 与 MCP 入口。它的认知管线比 Atlas 宽：
观察 → 证据 → 候选评估 → 记忆 → 检索准入 → 行动 → 反馈 → 演化，
带 claim 解析、冲突检测、反馈学习、图式演化（后者明确标为 Roadmap，未交付）。

## 哲学对齐

两个项目的底层纪律几乎逐条重合——这不是巧合，是「可信记忆」这个问题本身的形状：

| 纪律 | Mnemosyne | Memory Atlas |
|---|---|---|
| 证据优先，保留来源与时间 | 核心原则 1 | recordId + source + origin + 回执 |
| 事实与推断分离 | 「Agent 的推测不能自动成为用户事实」 | 「模型生成的文字不会自动变成记忆」 |
| 变化优先于覆盖 | 核心原则 3 | 纠正链：superseded 保留，active 替换 |
| 可追溯 | 证据链 + 修正过程 | 纠正链 + 操作台账 + 事件账本 |
| 反对双重权威 | 「同一认知对象必须明确权威来源」 | 「检索索引是派生物，不是事实权威」 |
| 宿主不直连数据库 | 插件禁止直连 memory.db | 渲染层不持有任何记忆，只走 IPC |

## 能力差集

**它有、我们没有的：**

- **检索准入**：不只判断「匹配」，还判断「有没有资格进入上下文」（证据等级、可信度）。
  Atlas 的影子解释（activation-explain）已有 evidenceClass/tier 雏形，但没有把它做成检索门禁。
- **Token 预算上下文**（`memory_context`）：按 envelope（stable_prefix/tools/history/
  header_tags/output_reserve）先预留固定开销再裁剪记忆。对 Agent 宿主是实打实的便利。
- **Agent 反馈通道**（`memory_feedback`）：useful/incorrect 两信号；incorrect 触发失效
  **审查**而非自动删除。Atlas 只有 user_revisited（强化），没有「Agent 觉得这条不对」的信号。
- **候选晋升**（`memory_propose`）：Agent 提交候选，慢速通道评估后晋升。Atlas 的写入面板
  刻意只收人手写的内容——候选 inbox 是它的自然演化，但属于产品决策。
- claim 结构化解析、实体/时空模型、情绪评估、图式演化：更重的认知架构，与 Atlas
  「字面匹配、不猜」的诚实边界不同路。

**我们有、它没有的：**

- 给人用的桌面阅览室（它只有服务 + 插件，没有 GUI）。
- 零依赖 Node 便携发行（它需要 Python venv）。
- 只读默认、单空间授权的 MCP 安全模型（一个实例绑一个空间，模型换不了）。
- 人手纠正/撤回的完整 UX（两步确认、纠正链阅读、印章状态）。

## 吸收清单（按价值/风险排序）

1. **DSH 宿主契约笔记（已吸收，见下节）**——它踩过的坑直接写进我们的集成文档。
2. **提案：`atlas_feedback`**——Agent 经 MCP（ALLOW_WRITES 门禁）标记一条记忆
   useful/incorrect；incorrect 只写一条审查事件，人在桌面端看到后决定是否撤回。
   与 Atlas 哲学完全一致：Agent 可以举报，人才能定罪。未实现。
3. **提案：`atlas_context`**——只读工具，把搜索结果按 token 预算组装成上下文信封，
   诚实标注预算是估算还是实测（我们没有精确 tokenizer 时不宣称 measured——这也是
   Mnemosyne 自己踩过的坑，见其 tool-spec 注释）。未实现。
4. **Roadmap：候选 inbox**——Agent propose、人批准。需要先决定产品边界，不在本轮。
5. **明确不吸收**：自动晋升为事实、双语义权威、超出字面匹配的语义推断。
   Atlas 的卖点正是「搜不到就说没有，不猜」。

## DSH 宿主契约（来自 Mnemosyne 的实测教训）

Atlas 目前走 DSH 的通用 MCP 客户端 overlay（见
[release/examples/dsh-atlas-patch.yml](../release/examples/dsh-atlas-patch.yml)），
不经过 `defineTool`，所以下面第一条暂不直接影响我们；但若将来做 Atlas 原生 DSH 插件，
这些是已验证的宿主约束（Mnemosyne 2.0 适配，DSH `>=0.2.1-0 <0.3.0`）：

- `defineTool` 的 `output.schema` 拒绝 `type: 'json'` 与裸 `{}`；
  开放对象必须写 `{ type: 'object', additionalProperties: true }`。
- 插件清单是 `dsh.plugin.json`：`engines.dsh`、`entry.inject: ["tools"]`、settings namespace。
- MCP 错误码纪律：非法参数 `-32602`、未知工具 `-32601`、未初始化 `-32600`。
- 自动捕获只取 `session/event` 里的 user 与最终 assistant——与 Atlas「模型文字不自动成记忆」同源。
- settings 的 token 字段 role=secret，脱敏显示；preset fail-closed。

## 互操作：谁读谁

Mnemosyne 自己定义了四种接入模式（独立 / 只读 / 双向同步 / 托管），并明确
「不默认复制、不允许双重权威」。按它的框架，Atlas 与它的健康关系是：

- **Mnemosyne 只读 Atlas（它的模式 B）**：Atlas 的 MCP 是标准 stdio server，
  Mnemosyne 的适配器层可以把 Atlas 登记为一个外部记忆 Provider，检索 `atlas_search` /
  `atlas_get`。Atlas 记录在 Atlas 里仍是权威；Mnemosyne 引用时保留来源，不复制成自己的事实。
- **Atlas 读 Mnemosyne**：理论上可经它的 REST/MCP 作为非权威外部源（类似 Atlas 现有的
  「本地转写」位置：可查、标注、不作为正式记忆）。未实现，也没有需求验证。
- **双向同步 / 互相托管：不做。** 两套系统同时对同一份长期认知拥有写入权，
  是双方文档都明确反对的状态。

配置与联调都还没做过。真要做第一步，建议从「Mnemosyne 只读 Atlas」开始，
验收标准沿用 Atlas 的三客户端一致性实验：同一 recordId、更正跨端生效、空间不串。