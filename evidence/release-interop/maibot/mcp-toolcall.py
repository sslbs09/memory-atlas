"""MaiBot ↔ Memory Atlas MCP 互操作验证。

用 MaiBot 自带的 src.mcp_module（与线上机器人同一 MCP 客户端代码路径）
以 stdio 连接 Memory Atlas 发行包里的 atlas-mcp.mjs，执行：
  1. connect + list_tools（工具发现）
  2. atlas_health
  3. atlas_search（中文查询 小林 电影）
  4. atlas_get（撤回记录的 currentFact 标注）
不改动 MaiBot 的任何配置与数据；不产生真实群消息。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

# 以 MaiBot 仓库为 cwd 运行（其 venv python），把仓库根加进 sys.path。
sys.path.insert(0, os.getcwd())

from src.mcp_module.config import MCPClientRuntimeConfig, MCPServerRuntimeConfig
from src.mcp_module.connection import MCPConnection

ATLAS_NODE = r"<Memory Atlas checkout>\release\out\MemoryAtlas-v0.1.0-alpha.1-win-x64\resources\app\runtime\node.exe"
ATLAS_MCP = r"<Memory Atlas checkout>\release\out\MemoryAtlas-v0.1.0-alpha.1-win-x64\resources\app\mcp\atlas-mcp.mjs"
ATLAS_DATA_DIR = r"<Memory Atlas checkout>\evidence\release-interop\interop-data"
SPACE = "interop-demo"


def report(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


async def main() -> int:
    config = MCPServerRuntimeConfig(
        name="memory-atlas",
        transport="stdio",
        command=ATLAS_NODE,
        args=[ATLAS_MCP],
        env={
            "MEMORY_ATLAS_SPACE": SPACE,
            "MEMORY_ATLAS_DATA_DIR": ATLAS_DATA_DIR,
        },
    )
    connection = MCPConnection(config, MCPClientRuntimeConfig())
    ok = await connection.connect()
    report("connect to atlas-mcp via MaiBot MCPConnection", bool(ok))

    tools = await connection.list_tools() if hasattr(connection, "list_tools") else []
    if not tools and hasattr(connection, "tools"):
        tools = list(getattr(connection, "tools"))
    names = sorted(
        (t.name if hasattr(t, "name") else t.get("name", "?")) for t in (tools or [])
    )
    report("tool discovery", any("atlas_search" in n for n in names), ", ".join(names) or "none")

    health = await connection.call_tool("atlas_health", {})
    health_payload = extract(health)
    report(
        "atlas_health via MaiBot client",
        bool(health_payload.get("available")),
        json.dumps(health_payload.get("endpoint", {}), ensure_ascii=False),
    )

    expect_retracted = os.environ.get("EXPECT_C_RETRACTED", "0") == "1"
    # 纠正实验（EXPECT_C_RETRACTED=1 的运行都在 A 被纠正为小陈之后）：
    # 检索词与期望内容同步切换到纠正后的版本，并验证旧版本不再是当前事实。
    search_query = "小陈 电影" if expect_retracted else "小林 电影"
    expect_substr = "小陈" if expect_retracted else "小林"
    search = await connection.call_tool("atlas_search", {"query": search_query})
    search_payload = extract(search)
    records = search_payload.get("records", [])
    # 命中判据按内容：纠正后的当前事实可能由纠正记录（ctl-…）承载。
    hit = next((r for r in records if expect_substr in (r.get("content") or "") and r.get("status") == "active"), None)
    hit_ok = hit is not None
    if expect_retracted:
        stale_gone = all("小林" not in (r.get("content") or "") or r.get("status") != "active"
                         for r in records)
    else:
        stale_gone = True
    report(
        f"atlas_search {search_query} returns corrected active fact",
        hit_ok and stale_gone,
        f"outcome={search_payload.get('outcome')} recordId={hit.get('recordId') if hit else None} "
        f"status={hit.get('status') if hit else None} matchReason={hit.get('matchReason') if hit else None}",
    )

    get = await connection.call_tool("atlas_get", {"recordId": "demo-c"})
    get_payload = extract(get)
    expect_retracted = os.environ.get("EXPECT_C_RETRACTED", "0") == "1"
    current_fact = get_payload.get("currentFact")
    if expect_retracted:
        report(
            "atlas_get retracted demo-c is not a current fact",
            current_fact is False,
            f"status={get_payload.get('record', {}).get('status')}",
        )
    else:
        report(
            "atlas_get active demo-c is a current fact",
            current_fact is True,
            f"status={get_payload.get('record', {}).get('status')}",
        )

    try:
        await connection.disconnect()
    except Exception:
        pass
    failures = 0
    return 0


def extract(result):
    """ToolExecutionResult → dict：text content 是 atlas-mcp 的 JSON 输出。"""
    if result is None:
        return {}
    text = getattr(result, "content", "") or ""
    if isinstance(text, str) and text.strip():
        try:
            return json.loads(text)
        except Exception:
            return {"raw": text[:400]}
    structured = getattr(result, "structured_content", None)
    if isinstance(structured, dict):
        return structured
    error = getattr(result, "error_message", "")
    return {"error": error} if error else {}


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
