# 验证说明（随包）

本包发布前执行的验证与复现方法。完整报告见仓库
`docs/VERIFICATION-v0.1.0-alpha.1.md`。

## 随包验证结论

| 项 | 结论 |
|---|---|
| 全新目录解压启动（中文+空格路径，无全局 Node/npm） | PASS（31/31） |
| 写入 / 中文检索 / 纠正 / 撤回 / 重启持久化 | PASS |
| 双开保护 / 优雅关闭 / 无孤儿进程 / 安装目录零写入 | PASS |
| MCP 工具协议（stdio：发现、调用、写入门禁、离线可见失败、空间绑定） | PASS（7/7） |
| DSH 0.2.1-rc.3 工具注册 | PASS（会话日志证据） |
| DSH 实际模型调用 | **NOT TESTED**（发布机账户 403 无模型额度） |
| MaiBot 1.3.6 自带 MCP 客户端 + 官方配置解析 | PASS |
| MaiBot 完整聊天回路 | **NOT TESTED**（避免真实 QQ 流量） |
| 三客户端一致性（纠正/撤回跨端传播、隔离、断电恢复） | PASS（23/23） |
| 20GB 规模 | NOT VALIDATED |

## 复现（需要仓库与 Node 24）

```bash
node release/verify-portable.mjs                        # 重新解压验证本包
cd packages/memory-atlas-mcp && npm test                # MCP 协议测试
node evidence/release-interop/verify-core-flow.mjs      # 核心流程
node evidence/release-interop/cross-client.mjs          # 三客户端实验（需 DSH/MaiBot 环境）
```

## 环境差异提示

- DSH 的模型额度与本机账户绑定；在有额度的机器上，`--patch` overlay + 一条
  "调用 mcp__atlas__atlas_search" 的任务即可补做真实模型调用测试。
- MaiBot 完整回路需要隔离实例 + 适配器；本包只验证到其自带 MCP 客户端层。
