# Memory Atlas（中文说明）

**独立的本地记忆服务：原生记录、来源、纠正链、有效性、回执，以及任何 Agent 都能用的统一 Memory API。**

Memory Atlas 像档案员一样记事：每条记忆都是有稳定 ID、有来源、有效力状态的记录。纠正与撤回本身也是记录——"过去以为什么"始终可审计，"现在成立什么"始终干净。派生检索索引只负责快，永远不是事实权威。

- **当前状态：Alpha（v0.1.0-alpha.1）。** 提供 Windows 免安装发行包；不是人脑模拟，也不是向量数据库服务，而是记忆的**事实权威系统**。
- English: [README.md](README.md)。

## 它做什么

| 能力 | 位置 |
|---|---|
| 带来源的正式记忆记录（recordId / source / revision） | `src/` — 原生权威存储 |
| 纠正与撤回是一等记录（旧版本从不被悄悄改写） | `src/model.js`、`src/service.js` |
| 多空间隔离（一个 Atlas，多个互不串线的记忆空间） | `src/store.js` |
| 每次写入都有回执（operationId、幂等重放、冲突有名字） | `src/service.js` |
| 可按空间"失去信任"的 CJK 派生检索索引，失败时如实降级 | `adapters/glm-retrieval.mjs`、`desktop/glm-retrieval/` |
| 桌面工作台（查 / 管 / 维 / 宇宙视图 + 记忆对话实验） | `desktop/` |
| 给外部 Agent 的 MCP Server（DSH、MaiBot、任何 MCP 宿主） | `packages/memory-atlas-mcp/` |

## 快速开始（Windows，无需安装 Node/npm）

1. 下载 `MemoryAtlas-v0.1.0-alpha.1-win-x64.zip`，解压到任意目录。
2. 双击 `MemoryAtlas.exe`。数据存放在 `%APPDATA%\Memory Atlas Alpha\`，绝不写入解压目录。
3. 直接使用：写入、检索、纠正、撤回。GLM 检索索引首次启动自动构建。

Windows 包未做代码签名，首次运行 SmartScreen 会提示确认。详见[发行包安装与使用指南](release/docs/README-RELEASE.md)；把 DSH / MaiBot / 任意 MCP 客户端接到同一个正在运行的 Atlas 见 [MCP 接入指南](release/docs/MCP-GUIDE.md)。

## 架构一段话

桌面程序只是壳：它以 Node 24 子进程启动真正的 Atlas 服务；服务持有权威存储（每空间一份 JSON + 单写者锁）与可选的派生检索索引（node:sqlite）。所有访问走同一套环回 HTTP API，每次启动轮换 token，并通过发现文件 `endpoint.json` 发布给 MCP 桥。GUI、DSH 下的 MCP server、MaiBot 下的 MCP server 全部走同一个正式 API——没有任何客户端直接写数据文件，撤回/被取代的记录永远不会被当作当前事实返回。

## 如实声明：已知限制

- **本轮互操作未做真实模型端到端回路**（本机 DSH 账户无模型额度；MaiBot 验证到其自带 MCP 客户端层，未跑完整聊天）。工具协议层已验证，详见[验证报告](docs/VERIFICATION-v0.1.0-alpha.1.md)。
- **20GB 规模未验证**——容量目标是配置值，不是实测结论。
- 检索是词法级的（中文一元/二元词项）：**不做同义改写**。搜「约定」不会命中「答应」；服务如实返回 `NO_MATCH`，不猜。
- MCP 接入 ≠ 自动记忆捕获：工具在那里，但记忆只经显式调用写入；每个 MCP server 实例只服务一个被授权的空间。
- Windows 构建未签名；激活/强化实验面仍属实验性。

## 开发

```bash
npm test                                     # 核心服务测试
cd packages/memory-atlas-mcp && npm test     # MCP 协议测试（真实 stdio）
node evidence/release-interop/verify-core-flow.mjs
node release/package-portable.mjs            # 构建 Windows Portable ZIP
node release/verify-portable.mjs             # 全新目录 31 项验证
node evidence/release-interop/cross-client.mjs  # 三客户端一致性实验
```

## 许可证

**尚未决定**——候选方案与权衡见 [LICENSE-CANDIDATES.md](LICENSE-CANDIDATES.md)，不由本仓库替你做主。第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
