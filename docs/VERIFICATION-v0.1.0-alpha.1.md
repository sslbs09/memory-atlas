# 验证报告 — Memory Atlas v0.1.0-alpha.1

本文件回答一个问题：**哪些结论是被证据支撑的，哪些没有。** 每一条都标注证据位置。

## 结论总表

| # | 验证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 核心服务测试套件 | 51 通过 / 0 失败 / 6 跳过 | `npm test`（node:test，57 项） |
| 2 | 核心流程（UTF-8 写入/中文检索/纠正/撤回/隔离/endpoint 生命周期） | 13/13 | `node evidence/release-interop/verify-core-flow.mjs` |
| 3 | MCP 工具协议（真实 stdio：initialize/tools/call/写入门禁/离线可见失败/空间绑定） | 7/7 | `cd packages/memory-atlas-mcp && npm test` |
| 4 | Portable 全新目录验证（中文+空格路径、无开发机路径、GUI 自检、HTTP 全流程、双开、优雅关闭无孤儿、安装目录零写入、重启持久化） | 31/31 | `node release/verify-portable.mjs`；GUI 截图 `evidence/release-interop/portable/` |
| 5 | DSH 0.2.1-rc.3：MCP server 被拉起 + 3 个读工具注册进模型工具列表 | PASS | 会话日志 `~/.dsh/sessions/--E-dsh--/session-cb45b619-…`（`request/header` 事件，31 个工具含 `mcp__atlas__*`） |
| 6 | DSH：Atlas 离线时不被拖垮 | PASS（harness 正常启动到模型调用阶段） | `evidence/release-interop/dsh/run3-offline.log` |
| 7 | DSH：实际模型调用 Atlas 工具 | **NOT TESTED** | `AUTH: 403 AccessDenied.Unpurchased`（账户无模型额度，无法购买/绕过） |
| 8 | MaiBot 1.3.6：自带 MCPConnection 连接/发现/health/search/get | 5/5 | `evidence/release-interop/maibot/run1-pre-retract.log` 等 |
| 9 | MaiBot：官方 `[[mcp.servers]]` 配置解析（不改核心） | PASS | `evidence/release-interop/maibot/config-parse.py` |
| 10 | MaiBot：完整聊天回路（QQ/模型） | **NOT TESTED** | 需要在线实例与模型密钥；避免真实群消息，未启动 |
| 11 | 三客户端一致性实验（同一空间 A/B/C：可见性/一致/纠正传播/撤回传播/隔离/断电恢复） | 23/23 | `evidence/release-interop/cross-client-results.json` |
| 12 | 20GB 规模 | **NOT VALIDATED**（本轮未压测，按纪律不重跑） | — |

## 明确的三级区分（不要混为一谈）

- **协议工具联调 PASS**：MCP 客户端能发现并调用工具、返回正确记录——第 3、5、8、11 项。
- **实际模型调用 PASS**：模型在对话回路里自主选择并调用工具——**本轮没有一端达到此级别**（DSH 403、MaiBot 未起在线实例）。
- **自动长期记忆体验 PASS**：Agent 无需指示即把该记的事写进长期记忆——**未实现也未宣称**；MCP 写入工具默认关闭，写入只发生在显式调用。

## 同义检索的诚实记录

同一空间内：`小林 电影` 命中 A；`老陈 还书` 命中 B。但 `约定 还书` **不命中** B（NO_MATCH）——「约定」与「答应」之间没有同义桥。这是词法检索的已知限制，本轮按纪律不扩展为语义检索研究。

## 环境与工件

- 版本 v0.1.0-alpha.1，分支 `release/alpha-interop-01`（基线 alpha 60b45aa）。
- 发行包：`release/dist/MemoryAtlas-v0.1.0-alpha.1-win-x64.zip`，SHA-256 见 `release/SHASUMS.txt`。
- 所有验证可复现：命令都在上表"证据"列。
