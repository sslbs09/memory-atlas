# Release Notes — Memory Atlas v0.1.0-alpha.1

**2026-11-01 · Alpha（开发者预览）· Windows x64 Portable**

这是 Memory Atlas 第一次以"别人能用的产品"形态打包：解压即用的 Windows 桌面程序（自带 Node 24 运行时），加一个可被 DSH、MaiBot 或任何 MCP 客户端接入的统一记忆桥。

## 亮点

- **Windows Portable**：`MemoryAtlas-v0.1.0-alpha.1-win-x64.zip`，解压双击 `MemoryAtlas.exe` 即可运行。不需要安装 Node、npm，不需要 `npm install`。数据独立存放在 `%APPDATA%\Memory Atlas Alpha\`，不写解压目录。完整的 Archive / Universe 工作台与记忆对话实验都在。
- **统一 MCP Server**（`packages/memory-atlas-mcp`）：一个 stdio MCP server 把正在运行的 Atlas 暴露为 `atlas_search` / `atlas_get` / `atlas_health`；写入工具（`atlas_remember` / `atlas_correct` / `atlas_retract`）默认关闭，仅在 `MEMORY_ATLAS_ALLOW_WRITES=1` 时注册。每个实例绑定一个授权空间，模型无法越权选空间。协议基于 MCP TypeScript SDK v2（支持 2025-11-25 / 2026-07-28）。
- **跨客户端一致性**（本阶段核心实验，23/23 通过）：桌面端、DSH、MaiBot 三个客户端看同一空间的同一批记录；从 Atlas 正式接口纠正后，所有客户端只拿得到新版本；撤回后，没有任何客户端把该记录当当前事实；Atlas 重启后 MCP 连接自动跟随新端口且正式记录不丢。
- **桌面端**：新增 `--data-dir` 数据目录独立、双开保护、优雅关闭（Atlas 子进程随桌面程序退出，无孤儿进程）。

## 验证状态（节选，全文见 VERIFICATION 文档）

| 层级 | 结论 |
|---|---|
| Portable 发行（31 项全新目录验证） | PASS |
| 核心服务（写入/检索/纠正/撤回/隔离，57 项） | PASS |
| MCP 工具协议（真实 stdio，7 项） | PASS |
| DSH 0.2.1-rc.3 工具注册 | PASS（会话日志证据） |
| DSH 实际模型调用 | **NOT TESTED**（本机账户 403 无模型额度） |
| MaiBot 1.3.6 自带 MCP 客户端 | PASS |
| MaiBot 完整聊天回路 | **NOT TESTED**（需要 QQ 适配器与在线实例，避免真实流量） |
| 三客户端一致性实验 | PASS（23/23） |
| 20GB 规模 | NOT VALIDATED |

## 已知限制

- 检索是词法级的：搜「约定」不会命中「答应」。
- MCP 接入不等于自动记忆捕获；不存在"聊着聊着就记住了"的自动写入。
- Windows 构建未签名（SmartScreen 提示）。
- 未附带安装向导（Portable 优先）；激活/强化相关 UI 仍属实验性。

## 升级与回滚

数据格式自 v0.1 起未变；把旧数据目录用 `--data-dir` 指向新程序即可。回滚同理。

## 组件版本

Electron 43.3.0 · Node 24.22.2（随包） · MCP TypeScript SDK 2.4.0 · esbuild 0.28.2 · zod 4.6.7
