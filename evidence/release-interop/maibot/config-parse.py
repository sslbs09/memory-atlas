"""用 MaiBot 官方配置类解析 memory-atlas 的 [[mcp.servers]] 片段。

证明当前安装版本 (1.3.6) 的官方配置路径接受 Memory Atlas 的 stdio 接入——
用户只需在 bot_config.toml 追加配置，无需改 MaiBot 核心。
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.getcwd())

import tomllib

from src.config.official_configs import MCPConfig

EXAMPLE = r"<Memory Atlas checkout>\release\examples\maibot-mcp-config.toml"

with open(EXAMPLE, "rb") as handle:
    data = tomllib.load(handle)

mcp = MCPConfig(**data["mcp"])
server = mcp.servers[0]
print("PASS  official MCPConfig parses memory-atlas example" if (
    mcp.enable is True
    and server.name == "memory-atlas"
    and server.transport == "stdio"
    and server.command.endswith("node.exe")
    and server.args and server.args[0].endswith("atlas-mcp.mjs")
) else "FAIL  config parse")
print(json.dumps({
    "name": server.name,
    "enabled": server.enabled,
    "transport": server.transport,
    "command": server.command,
    "args": server.args,
    "env": server.env,
}, ensure_ascii=False, indent=1))
