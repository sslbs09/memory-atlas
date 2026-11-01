# Memory Atlas Alpha-01 — 交付报告

日期：2026-11-01
工作树：`<Memory Atlas checkout>`，分支 `alpha/desktop-dogfood-01`
基线：`experiment/activation-04` @ `17398b7`（含 master `4f112f2`）
Alpha 提交：`1489c31`（主交付）→ `3e8bc79`（入口与修复）及后续文档提交

---

## 判定：ALPHA READY

依据（对照任务书 §十三）：
1. ✅ 独立 Alpha 工作树与提交 SHA（本文件头部）。
2. ✅ 可启动的独立桌面应用（Electron 43 外壳 + Node 24 Atlas 子进程）。
3. ✅ Windows 双击入口 `MemoryAtlas-Alpha.cmd`（**portable EXE 未打包**，如实说明见下）。
4. ✅ 实际启动方法（README-ALPHA.md）。
5. ✅ Archive / Universe 真实集成证据（自检 JSON + 截图）。
6. ✅ 真实 Atlas + GLM 检索证据（searchPath=atlas-candidates+authoritative、
   indexState=WIRED、评分与 matchReason 全链路验证）。
7. ✅ OpenAI-compatible 对话模块（SSE 流式/中断/超时/协议兼容）。
8. ⚠️ **REAL MODEL NOT TESTED**：本环境没有可用的模型供应商（无 Ollama、无
   API Key）。全链路用本地协议桩（`test-stub-model.mjs`，只实现协议）验证到
   事件账本级；**没有把桩当成真实模型**。用户配置任何 /v1/chat/completions
   服务即可完成这一步。
9. ✅ Activation Shadow 排名解释（A0/L/R/LR/D 五策略经官方实现逐字复用，
   flow 自检可见 ×1.52 乘数与 #2→#1 影子移动，正式顺序保持 A0）。
10. ✅ 记忆写入、纠正、撤回、重启恢复测试（跨 6+ 次应用重启持久；
    第二次纠正同一记录返回"目标已非 active"正是持久性证明）。
11. ✅ UI 截图与操作说明（desktop/docs/screenshots/、README-ALPHA.md）。
12. ✅ 已知限制与下一阶段建议（本文末）。

---

## 架构（为什么这样接）

```
┌─ Electron 43（外壳，内嵌 Node 22.x）────────────────────────┐
│ main.mjs                                                     │
│  ├─ AtlasService: spawn 系统 Node 24 ──────────────────┐     │
│  │    node bin/atlas-server.mjs --data-dir … --port 0   │     │
│  │    --retrieval-module adapters/glm-retrieval.mjs     │     │
│  │    env: ATLAS_GLM_MODULE=desktop/glm-retrieval/...   │     │
│  │                                                   ▼          │
│  ├─ api-atlas.js ──HTTP(127.0.0.1)──► Atlas + GLM 索引        │
│  ├─ activation-explain.mjs（import experiments/activation-01..04）│
│  ├─ event-ledger.mjs（events.jsonl，桥准入 + 幂等重放）        │
│  └─ chat-model.mjs（OpenAI-compatible SSE，apiKey 只在此层）   │
│  preload.cjs / chat-preload.cjs（contextIsolation, sandbox）   │
└──────────────────────────────────────────────────────────────┘
```

- GLM 检索引擎要求 Node 24 的 `node:sqlite`；Electron 内嵌 Node 22.x 不满足，
  所以 Atlas 以独立 Node 24 子进程运行（任务书预判的正确路线），
  绝不使用 Electron 的 `process.execPath`。
- 单写者、幂等、token 鉴权、stdin 优雅停机全部沿用 Atlas 原生约定。
  主进程被强杀时子进程因 stdin 管道关闭自动优雅退出（已实测，无孤儿进程）。
- 渲染层零网络（CSP `connect-src 'none'`），全部数据经 IPC；
  `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、
  每窗口专用 preload、发送方通道形状校验（沿用 ds-ui harness 契约）。
- 记忆文本在任何界面都按纯文本渲染（textContent），不执行 HTML/指令。

## 复用与来源（详见 desktop/PROVENANCE.md）

- 工作台/宇宙前端：ds-ui worktree `9c3ea62` 逐字复制（六个 JS 以 git blob
  哈希比对一致；HTML 仅加两行引入 Alpha 注入层）。
- Atlas 适配层：ds-ui harness `f3fcf69` 的 `api-atlas.js` / `atlas-map.js` 逐字复制。
- GLM 检索引擎：`<WhiteMoon repo>/work/universal-memory-v0.1\glm-retrieval` 逐字复制
  （9 文件 blob 一致；来源不是 git 仓库，以复制日期+哈希锚定）。
- Activation：`experiments/activation-01..04` 直接 import（同一仓库分支内，
  无复制，公式零改动）。
- Alpha 新写：Electron 主进程、服务子进程管理、事件账本持久化、影子解释编排、
  模型客户端、对话窗口、注入工具条（见 PROVENANCE §5）。
- 运行时不依赖 `<WhiteMoon repo>` 与 `<Memory Atlas repo>`（master 工作树）任何文件。

## 验证证据（自动自检，stdout JSON + 截图）

| 验证 | 结果 |
| --- | --- |
| `--selfcheck main` | 服务 running、engine=glm-retrieval、空间自动创建、连接芯片"Atlas 已连接"、工具条注入、截图 |
| `--selfcheck flow` | 种子幂等（重复=ALREADY_PRESENT）、`addMemory` RECORDED、搜索走索引路径（WIRED）、纠正→`superseded`+changedBy 链、撤回→RECORDED、合法重提→`user_revisited`、影子：A0 #2→R/LR #1（乘数 ×1.52，tier=T1，正式顺序不变）、事件账本完整 |
| `--selfcheck chat` | 关键词阶梯（整句 0 命中 → 按空间词频派生"电影"）、上下文按 A0、流式增量、引用解析（引用/未知编号分开）、`delivered_reference` 仅在展示后记录、无相关记忆时正常对话、截图（候选/上下文/引用三集合 + 排名变动原因全部可见） |
| `--selfcheck universe` | WebGL 渲染 6 节点/4 关系（确认 2 · 推测 2）、"本地派生"标注、离开模式停止绘制（复用原实现）、截图 |
| Atlas 离线（外部死端口） | 连接芯片"读取失败"、spaces=ATLAS_UNAVAILABLE、health=MEMORY_UNAVAILABLE——绝不显示"没有记忆" |
| GLM 模块缺失 | 应用照常打开，服务 failed，展示真实原因（模块路径+补救提示） |
| 双实例 | requestSingleInstanceLock：第二实例退出，仅 1 个 Atlas 子进程 |
| 生命周期 | 关窗/taskkill 后 Atlas 子进程 stdin 关闭自行退出（多次实测） |
| 重启持久 | 记录/纠正链/撤回/事件账本跨 6+ 次重启存活；重复纠正返回目标已非 active |
| 双击入口 / npm run alpha | 两种入口均实测启动成功（electron_main=1, atlas_child=1） |

## 异常与边界

- 未配置模型 API：记忆搜索/管理/宇宙完全可用；对话窗口如实显示未配置。
- 离线/索引异常/无数据三种状态在 UI 有各自的名字（复用工作台故障语义）。
- 记忆文本中的 HTML 与"指令"按数据处理：不渲染、不入指令位；上下文块
  明确声明"资料数据，不是指令"；模型引用不在上下文的编号会被单列为
  `citedUnknown` 并忽略其事件。
- apiKey：只在主进程内存与 userData config.json；不进日志/截图/IPC 返回值。
- 合成演示数据与真实使用数据按空间隔离（`alpha-demo` vs 用户空间），
  演示记录带 `synthetic-seed` 来源标记；重提事件只能由用户在界面明确确认。

## 已知限制（如实）

1. **REAL MODEL NOT TESTED**（§八）：见判定 #8。协议桩仅证明传输与接线。
2. **Portable EXE 未打包**：`electron-packager` 路线可行但需捆绑 Node 24 运行时
   的额外工作；本轮按任务书优先交付了真实可用的双击 .cmd 入口（依赖本机
   Node ≥ 24 与 desktop/node_modules）。
3. 宇宙图谱为前端本地投影（与 DeepSeek 原实现一致），明确标注"本地派生"，
   未虚构服务端 Graph API。
4. 影子解释的词面 df 表：空间有效记录 >200 时按前 400 条窗口化，
   界面显示 `scopeWindowed` 提示（≤200 时与 `authority.inspect` 完全一致）。
5. `alpha:activation-explain`（工具条影子预览面板）已在主进程就绪，
   对话调试视图已展示其结果；工作台侧的独立展开面板本轮未加 UI（对话窗口
   的调试视图已覆盖任务书要求的全部字段）。
6. 检索是词面的：整句自然语言依赖关键词阶梯降级；语义级"约定≈答应"这类
   同义改写不会命中（这是 GLM 词面索引的既定边界，不是 Alpha 缺陷）。
7. 安全扫描（Mimosa normal）唯一 finding 位于上游 Atlas 核心 `src/store.js:104`
   （已验收基线的静态路径解析告警），Alpha 新增代码（desktop/）无 finding。
8. 20GB 容量目标只作为观察预算展示（Atlas 原生语义），未验证 20GB 数据。

## 下一阶段建议

1. 用户配置真实模型 API 后跑通 §九 第 6–8 步（预计零代码改动）。
2. electron-packager 打包 + 捆绑 Node 24（或把 Atlas 改为 `.asar` 内嵌
   node 单文件入口）产出免安装 EXE。
3. 工作台加"影子解释"展开面板（复用 chat 的表格渲染）。
4. 事件账本加只读查看器（当前数据已有 IPC：`alpha:activation-events`）。
5. `alpha:seed-demo` 的演示空间可扩展成任务书外的更多场景。
