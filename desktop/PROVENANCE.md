# Alpha-01 资产来源与版本（PROVENANCE）

本文件回答一个问题：Alpha 桌面应用里每一块不是本分支新写的代码，从哪来、什么版本。

原则：**复用而不隐藏**。所有复制进 `desktop/` 的外部资产都登记在这里；
原始位置保持只读，不被 Alpha 修改。运行时不依赖 `<WhiteMoon repo>` 与
`<Memory Atlas repo>`（master 工作树）的任何文件——一切都随本工作树走。

## 1. 本工作树自带的（无需复制）

Alpha 工作树 `alpha/desktop-dogfood-01` 从 `experiment/activation-04` 的
`17398b7` 创建，该提交包含 master `4f112f2`（独立 Memory Atlas 全部能力）：

| 资产 | 路径（相对本仓库根） | 版本 |
| --- | --- | --- |
| Memory Atlas 服务（权威存储 + HTTP API） | `src/`、`bin/`、`adapters/glm-retrieval.mjs` | master 4f112f2（17398b7 的祖先） |
| Activation 策略与事件机制 | `experiments/activation-01..04/src/` | 34d8cf9 / daffba2 / d4e4a9a / 17398b7 |

`desktop/main.mjs` 通过子进程运行 `bin/atlas-server.mjs`，通过 ESM import
复用 `experiments/activation-*/src` 的策略实现（import，不复制公式）。

## 2. 从 ds-ui 仓库复制的（UI 资产与 Atlas 适配层）

来源仓库：`<WhiteMoon repo>/work/universal-memory-v0.1\ds-ui`（HEAD `f3fcf69`）
其内嵌工作树 `ds-ui\worktree`（HEAD `9c3ea62`，分支 `frontend/memory-workbench-archive`）。
复制日期：2026-11-01。原始文件未做任何修改。

| 目标（desktop/ 下） | 来源 | 说明 |
| --- | --- | --- |
| `renderer/memory-workbench.html` | `worktree/renderer/memory-workbench.html` @ 9c3ea62 | 查/管/维/宇 四区档案工作台页面。Alpha 仅加两行：引入 `alpha.css` 与 `memory-capture.js` |
| `renderer/memory-workbench.js` | 同上 | 逐字复制（git blob `cb8365bd`） |
| `renderer/memory-workbench.css` | 同上 | 逐字复制 |
| `renderer/memory-universe.js` / `.css` | 同上 | 逐字复制（`16530cb7`） |
| `renderer/ui.css` | 同上 | 令牌层，逐字复制 |
| `renderer/i18n.js` / `theme.js` / `theme-init.js` / `universe-projection.js` | 同上 | 逐字复制 |
| `renderer/vendor/universe/3d-force-graph.min.js` | `worktree/renderer/vendor/universe/` | 3D 力导向图库，逐字复制 |
| `renderer/alpha.css`、`renderer/memory-capture.js` | **Alpha 新写** | 注入工具条/写入面板/重提面板，只用既有 `--ui-*` 令牌 |
| `renderer/chat.html` / `chat.js` / `chat.css` | **Alpha 新写** | 记忆对话实验窗口 |
| `locales/zh.json` `en.json` `ja.json` | `worktree/src/locales/` @ 9c3ea62 | 界面词典，逐字复制 |
| `api-atlas.js`、`atlas-map.js` | `ds-ui/src/harness/` @ f3fcf69 | Atlas HTTP → 渲染层契约适配层，逐字复制（仅文件头注释补充来源说明） |

## 3. 从 GLM Retrieval 复制的（检索引擎）

来源：`<WhiteMoon repo>/work/universal-memory-v0.1\glm-retrieval`（**不是 git
仓库**，无版本号；2026-11-01 复制时的内容）。
目标：`desktop/glm-retrieval/`（9 个文件，git blob 逐一比对全部一致：
`package.json`、`README.md`、`src/{adapter,association,graph,store,tokenize}.mjs`、
`src/integrations/{atlas-graph,whitemoon-sync}.mjs`）。

它声明 `engines.node >= 24`、使用 `node:sqlite`（Node 24 稳定内置）。
Alpha 用系统 Node 24 子进程运行它，Electron（内嵌 Node 22.x）从不加载它。

未复制：`SEARCH-DTO-v1.md`、`scripts/`、`test/`、`results/`（运行时不需要；
如需可从来源目录按需补齐）。

## 4. Electron

`desktop/package.json` 声明 `electron ^43.3.0`，与 ds-ui 当前使用的版本一致，
npm 缓存中已有对应二进制。Electron 只做窗口与 IPC 壳；记忆检索、索引、激活
策略全部不在 Electron 进程里。

## 5. 复制之外的新增代码（本分支新写）

| 文件 | 职责 |
| --- | --- |
| `desktop/main.mjs` | Electron 主进程：生命周期、IPC、聊天管线、事件接线 |
| `desktop/atlas-service.mjs` | Node 24 子进程管理（启动/就绪/优雅停机/真实报错） |
| `desktop/config-store.mjs` | 本机配置与状态（apiKey 只落本机 config.json） |
| `desktop/event-ledger.mjs` | 激活事件账本持久化（复用 activation-01/03 实现） |
| `desktop/activation-explain.mjs` | A0/L/R/LR/D 影子解释编排（复用 activation-02/03/04 实现） |
| `desktop/chat-model.mjs` | OpenAI-compatible 客户端（SSE 流式/中断/超时） |
| `desktop/preload.cjs` / `chat-preload.cjs` | 窗口桥（沿用 harness 契约 + Alpha 通道） |
| `MemoryAtlas-Alpha.cmd`、`package.json` 的 `alpha` 脚本 | Windows 双击入口与 `npm run alpha` |
