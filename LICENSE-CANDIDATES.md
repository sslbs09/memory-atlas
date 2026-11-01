# 许可证候选说明（尚未决定）

> **本仓库当前不带开源许可证（`UNLICENSED`）。这不是疏忽，而是等待项目所有者做决定。**
> 在许可证确定之前，法律上任何人（包括你之外的所有人）都无权复制、分发或修改本代码。
> 以下列出三个现实候选与权衡，**本文件不构成决定，也不替你决定。**

## 候选 A：MIT

- **适合**：希望被尽量多的 Agent 项目与发行版采用，不在乎别人闭源商用。
- **代价**：任何人可以拿去闭源。对"记忆数据的事实权威"这类基础设施通常是正确选择——采用率比控制力重要。
- **义务**：保留版权与许可声明即可。

## 候选 B：Apache-2.0

- **适合**：同 MIT 的宽松取向，外加显式专利授权与贡献条款——如果未来接受外部贡献，更稳。
- **代价**：文本长；对个人项目略重。
- **注意**：需要为每个贡献者保留 NOTICE 机制（本仓库已有 THIRD_PARTY_NOTICES 习惯，兼容）。

## 候选 C：AGPL-3.0

- **适合**：希望任何托管/改造本项目的服务也开源（防止云厂商拿去闭源卖）。
- **代价**：显著降低第三方集成意愿——DSH/MaiBot 本身不是 AGPL，接入方式是独立进程 + MCP（不构成派生作品，通常安全），但发行包再分发者会需要理解 AGPL。如果目标是"被尽量多的 Agent 用"，这个候选与目标相悖。

## 与本发行包相关的既有事实

- `desktop/glm-retrieval/` 的检索引擎源自本项目的 Backend B 工作（provenance 见 `desktop/PROVENANCE.md`），与 WhiteMoon 主仓库同源；若 WhiteMoon 已有许可证，这里需要保持一致或在决定时一并处理。
- 第三方组件（Electron、Node.js、MCP TypeScript SDK、esbuild、zod）均为 MIT/Apache 兼容，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，任何候选都不冲突。

## 决定动作清单（一旦决定）

1. 添加 `LICENSE` 文件（全文）。
2. 更新根 `package.json` / `desktop/package.json` / `packages/memory-atlas-mcp/package.json` 的 `license` 字段。
3. 在 README 与发行包 `README-RELEASE.md` 声明。
4. GitHub 仓库设置中选择同一许可证。
