# Memory Atlas MCP 接入指南

让 DSH、MaiBot 或任何 MCP 客户端查询（或在显式启用时写入）**同一个正在运行的**
Memory Atlas。一个统一的 MCP server（`resources\app\mcp\atlas-mcp.mjs`），
不是两套记忆插件。

## 先决条件

1. **Memory Atlas 桌面程序正在运行**（它拥有 Atlas 服务与数据）。
   MCP server 不自己起服务、不直接碰数据文件——Atlas 不在时工具会明确报错，
   不会假装"没有记忆"。
2. 记下两个路径（下面的示例都用它们）：
   - 发行包内：`<安装目录>\resources\app\mcp\atlas-mcp.mjs`
   - 随包 Node：`<安装目录>\resources\app\runtime\node.exe`
3. 决定给这个客户端哪个**记忆空间**（一个 MCP 实例只服务一个空间；
   推荐每个客户端一个专属空间，例如 `dsh-space`、`maibot-space`）。

## 配置项（环境变量）

| 变量 | 含义 |
|---|---|
| `MEMORY_ATLAS_SPACE` | **必填**。授权本实例访问的唯一空间 id |
| `MEMORY_ATLAS_DATA_DIR` | 桌面端数据目录（默认 `%APPDATA%\Memory Atlas Alpha\atlas-data`），从中读取 `endpoint.json` |
| `MEMORY_ATLAS_URL` + `MEMORY_ATLAS_READ_TOKEN`（+ `MEMORY_ATLAS_WRITE_TOKEN`） | 直连模式，跳过 endpoint.json（显式配置时用） |
| `MEMORY_ATLAS_ALLOW_WRITES` | `1` 才注册写入工具；默认只读 |

## 工具一览

| 工具 | 默认 | 说明 |
|---|---|---|
| `atlas_health` | 可用 | Atlas 是否可达、绑定空间是否存在、写入是否开放 |
| `atlas_search` | 可用 | 检索当前有效记忆（默认只返回 status=active）；带 recordId/status/source/matchReason |
| `atlas_get` | 可用 | 按 recordId 读详情与纠正链；明确标注 `currentFact` |
| `atlas_context` | 可用 | 按 token 预算把检索结果组装成上下文信封；预算标注 `estimated`（非实测），超预算记录计入 `omitted` |
| `atlas_remember` | 关闭 | 显式写入一条记忆（仅在用户明确要求记住时调用） |
| `atlas_correct` | 关闭 | 正式纠正（旧版本自动失效） |
| `atlas_retract` | 关闭 | 正式撤回（不再作为当前事实） |
| `atlas_feedback` | 关闭 | 标记一条记忆 useful/incorrect。这是审查信号，不是裁决：不改状态、不自动撤回；incorrect 进桌面端待审查队列，由人决定 |

## DSH（DeepSeek Harness）

不改内核、不改你现有 Profile 文件——用 `--patch` 叠加：

```bat
dsh --profile headless --patch "%USERPROFILE%\dsh-atlas-patch.yml" "你的任务"
```

`dsh-atlas-patch.yml`（完整示例随包在 `mcp\examples\dsh-atlas-patch.yml`）：

```yaml
- insert:
    - id: mcp-atlas
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: atlas
        transport: stdio
        command: "C:\\path\\to\\MemoryAtlas-v0.1.0-alpha.1-win-x64\\resources\\app\\runtime\\node.exe"
        args:
          - "C:\\path\\to\\MemoryAtlas-v0.1.0-alpha.1-win-x64\\resources\\app\\mcp\\atlas-mcp.mjs"
        env:
          MEMORY_ATLAS_SPACE: dsh-space
          MEMORY_ATLAS_DATA_DIR: "C:\\Users\\你\\AppData\\Roaming\\Memory Atlas Alpha\\atlas-data"
        failOnStartupError: false
```

工具以 `mcp__atlas__atlas_search` 等名字出现在模型工具列表。已实测版本：
DSH 0.2.1-rc.3（stdio，2026-07-28 协议回退）。

## MaiBot

在 `bot_config.toml` 的 `[mcp]` 段追加（完整示例 `mcp\examples\maibot-mcp-config.toml`；
已用 1.3.6 官方配置类验证解析）：

```toml
[[mcp.servers]]
name = "memory-atlas"
transport = "stdio"
command = "C:\\path\\to\\MemoryAtlas-v0.1.0-alpha.1-win-x64\\resources\\app\\runtime\\node.exe"
args = ["C:\\path\\to\\MemoryAtlas-v0.1.0-alpha.1-win-x64\\resources\\app\\mcp\\atlas-mcp.mjs"]
env = { MEMORY_ATLAS_SPACE = "maibot-space", MEMORY_ATLAS_DATA_DIR = "C:\\Users\\你\\AppData\\Roaming\\Memory Atlas Alpha\\atlas-data" }
```

MaiBot 按原名使用工具（`atlas_search` 等）。麦麦原有记忆系统不受影响；
不建议给聊天机器人开写入（见下）。

## 通用 MCP 客户端（Claude 式 mcpServers）

```json
{ "mcpServers": { "memory-atlas": {
    "command": "C:\\path\\to\\...\\runtime\\node.exe",
    "args": ["C:\\path\\to\\...\\mcp\\atlas-mcp.mjs"],
    "env": { "MEMORY_ATLAS_SPACE": "my-space", "MEMORY_ATLAS_DATA_DIR": "..." } } } }
```

## 安全与纪律（本 server 强制）

- **空间绑定**：模型传不了 space 参数；一切读写都发生在绑定的那一个空间。
- **写入默认关闭**：没有 `MEMORY_ATLAS_ALLOW_WRITES=1` 时写入工具根本不存在。
  打开也请只在"用户明确要求记住/纠正/撤回"时调用——**MCP ≠ 自动记忆捕获**。
- **不串数据**：不同客户端配不同空间；多个客户端写同一空间同一事实会形成重复权威，
  这是配置错误。
- **撤回即失效**：status=active 之外的记录不作为当前事实返回；`atlas_get` 对
  撤回/被取代记录明确标注。
- **本机环回**：Atlas 只监听 127.0.0.1；endpoint.json 与数据同目录、同信任域。
  MaiBot 若在容器内而 Atlas 在宿主机，stdio 不可用——先核对网络拓扑；
  如需跨机，请使用带认证的 Streamable HTTP 方案，不要开放无认证端口。
- **凭据**：token 走环境变量；示例与代码中没有、也不应该有字面量密钥。

## 故障排查

- 工具报 "Atlas 服务未运行…找不到 endpoint.json" → 桌面程序没开；先开它。
- health 显示 `spaceExists: false` → 空间还没建；先在桌面端创建该空间。
- 桌面端重启后 MCP 自动跟随（新端口/新 bootId），无需重配。
