/**
 * harness/api-atlas.js — 统一 Memory Atlas API Adapter
 *
 * 说话对象是 Memory Atlas 原生服务（<Memory Atlas repo>），不是 WhiteMoon Host。
 * 两种模式并存、互不依赖：
 *   --adapter=atlas  → 本文件（Atlas 独立运行，不启动 WhiteMoon 也成立）
 *   --adapter=http   → api-http.js（WhiteMoon Host，正式 Experience 权威）
 *
 * 边界：
 *   - 只调用 Atlas 文档里的 9 个端点，不读它的数据目录；
 *   - 空间（space）是显式的：适配器记住当前 space，Archive 与 Universe 共用它；
 *   - 失败有名字：NO_MATCH / SOURCE_UNAVAILABLE / UNINDEXED / NOT_WIRED 各自传递，
 *     不合并成"没有记忆"。
 *
 * Alpha-01 来源：逐字复制自 ds-ui src/harness/api-atlas.js（HEAD f3fcf69，
 * 2026-11-01 复制），仅本注释为新增。原始文件在 <WhiteMoon repo>\...\ds-ui 下保持只读。
 */

import {
  mapSearch,
  mapDetail,
  mapOperation,
  mapHealth,
  mapCapacity,
  mapControl,
  unimplementedContext
} from "./atlas-map.js";

const DEFAULT_TIMEOUT = 8000;

export function createAtlasApi({
  baseUrl = "http://127.0.0.1:8791",
  readToken = "",
  writeToken = "",
  spaceId = null,
  timeoutMs = DEFAULT_TIMEOUT
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const readBearer = typeof readToken === "string" ? readToken.trim() : "";
  const writeBearer = typeof writeToken === "string" ? writeToken.trim() : writeBearerOrFallback();
  let currentSpace = spaceId || null;

  function writeBearerOrFallback() {
    // 只给了一个 token 的部署很常见：写操作先用 read token，失败会明确报 401。
    return readBearer;
  }

  async function request(method, pathname, { params, body, token, write = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(pathname, base + "/");
    if (params) {
      for (const [key, value] of params) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
      }
    }
    const started = Date.now();
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      return { status: response.status, payload, latencyMs: Date.now() - started };
    } catch (error) {
      const aborted = error && (error.name === "AbortError" || /aborted/i.test(String(error.message)));
      const code = error && error.cause && error.cause.code ? error.cause.code : (error && error.code);
      if (aborted) {
        return { transport: write ? "ATLAS_WRITE_UNCONFIRMED" : "ATLAS_READ_TIMEOUT", latencyMs: Date.now() - started };
      }
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EPIPE") {
        return {
          transport: write && code === "ECONNRESET" ? "ATLAS_WRITE_UNCONFIRMED" : "ATLAS_UNAVAILABLE",
          latencyMs: Date.now() - started
        };
      }
      return { transport: write ? "ATLAS_WRITE_UNCONFIRMED" : "ATLAS_READ_FAILED", latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  function settle(result, { write = false } = {}) {
    if (result.transport) {
      return { ok: false, code: result.transport, error: "", httpStatus: 0, latencyMs: result.latencyMs };
    }
    const payload = result.payload;
    if (payload && typeof payload === "object" && payload.ok === false) {
      return { ...payload, ok: false, httpStatus: result.status, latencyMs: result.latencyMs };
    }
    if (result.status >= 200 && result.status < 300 && payload && typeof payload === "object") {
      return { ...payload, ok: payload.ok !== false, httpStatus: result.status, latencyMs: result.latencyMs };
    }
    return {
      ok: false,
      code: result.status === 401 || result.status === 403 ? "ATLAS_UNAUTHORIZED" : write ? "ATLAS_WRITE_FAILED" : "ATLAS_READ_FAILED",
      error: payload && payload.error ? String(payload.error) : "HTTP " + result.status,
      httpStatus: result.status,
      latencyMs: result.latencyMs
    };
  }

  function requireSpace() {
    return currentSpace;
  }

  async function listSpaces() {
    const result = await request("GET", "/atlas/spaces", { token: readBearer });
    const settled = settle(result);
    if (!settled.ok) {
      return { ok: false, status: settled.code || "ATLAS_UNAVAILABLE", error: settled.error || "", spaceIds: [] };
    }
    return {
      ok: true,
      spaceIds: Array.isArray(settled.spaceIds) ? settled.spaceIds.map(String) : [],
      available: settled.available !== false
    };
  }

  async function setSpace(id) {
    const next = String(id || "");
    if (!next) return { ok: false, status: "ATLAS_SPACE_REQUIRED" };
    currentSpace = next;
    return { ok: true, spaceId: currentSpace };
  }

  async function memorySearch(params) {
    const input = params && typeof params === "object" ? params : {};
    const space = requireSpace();
    if (!space) return { ok: false, status: "ATLAS_SPACE_REQUIRED", error: "No memory space is selected." };

    const search = [["space", space]];
    if (typeof input.query === "string" && input.query.trim()) search.push(["q", input.query.trim()]);
    if (typeof input.status === "string" && input.status) search.push(["status", input.status]);
    if (Number.isSafeInteger(input.limit)) search.push(["limit", input.limit]);
    if (Number.isSafeInteger(input.offset)) search.push(["offset", input.offset]);
    if (input.order === "oldest" || input.order === "newest") search.push(["order", input.order]);
    if (typeof input.since === "string" && input.since) search.push(["since", input.since]);
    if (typeof input.until === "string" && input.until) search.push(["until", input.until]);
    if (input.timeField) search.push(["timeField", input.timeField]);
    if (Array.isArray(input.types)) {
      // Atlas 用 kind；WhiteMoon 用 recordType。渲染层传的是 recordType（可能是
      // 'memory-control'），这里翻回 Atlas 的写法，否则筛选会静默失效。
      for (const type of input.types) {
        if (!type) continue;
        if (type === "memory-control") {
          search.push(["kind", "correction"]);
          search.push(["kind", "retraction"]);
        } else {
          search.push(["kind", type]);
        }
      }
    }

    const result = await request("GET", "/atlas/search", { params: search, token: readBearer });
    const settled = settle(result);
    const mapped = mapSearch(settled, { spaceId: space, authority: settled.authority, latencyMs: result.latencyMs });
    if (!mapped.ok && !mapped.status) mapped.status = "ATLAS_READ_FAILED";
    // 把 Atlas 的 outcome 语义映射成渲染层的故障语言
    if (!mapped.ok) {
      const code = mapped.status;
      mapped.status = code === "ATLAS_UNAUTHORIZED"
        ? "MEMORY_ACCESS_DENIED"
        : code === "ATLAS_UNAVAILABLE"
          ? "MEMORY_UNAVAILABLE"
          : code === "ATLAS_READ_TIMEOUT"
            ? "MEMORY_READ_TIMEOUT"
            : code;
    }
    mapped.spaceId = space;
    return mapped;
  }

  async function memoryDetail(recordId) {
    const space = requireSpace();
    if (!space) return { ok: false, status: "ATLAS_SPACE_REQUIRED" };
    const result = await request("GET", "/atlas/detail", {
      params: [["space", space], ["id", String(recordId || "")]],
      token: readBearer
    });
    const settled = settle(result);
    const mapped = mapDetail(settled, { spaceId: space, recordId, authority: settled.authority });
    if (!mapped.ok) mapped.status = translateReadFault(mapped.status);
    return mapped;
  }

  async function memoryOperation(operationId) {
    const space = requireSpace();
    if (!space) return { ok: false, status: "ATLAS_SPACE_REQUIRED" };
    const result = await request("GET", "/atlas/operation", {
      params: [["space", space], ["operationId", String(operationId || "")]],
      token: readBearer
    });
    const settled = settle(result);
    const mapped = mapOperation(settled, { spaceId: space, operationId });
    if (!mapped.ok) mapped.status = translateReadFault(mapped.status);
    return mapped;
  }

  async function memoryHealth() {
    const space = requireSpace();
    const result = await request("GET", "/atlas/health", { token: readBearer });
    const settled = settle(result);
    if (!settled.ok) {
      return { ok: false, status: translateReadFault(settled.code || "ATLAS_UNAVAILABLE"), error: settled.error || "" };
    }
    const mapped = mapHealth(settled, { spaceId: space });
    if (!space) {
      // 还没选空间：把可用的空间报出去，让界面自己挑一个，而不是假装"没有记忆"
      return { ...mapped, instanceId: null, needsSpace: mapped.spaces.length > 0 };
    }
    return mapped;
  }

  async function memoryCapacity() {
    const space = requireSpace();
    const result = await request("GET", "/atlas/health", { token: readBearer });
    const settled = settle(result);
    if (!settled.ok) {
      return { ok: false, status: translateReadFault(settled.code || "ATLAS_UNAVAILABLE"), error: settled.error || "" };
    }
    return mapCapacity(settled, { spaceId: space });
  }

  async function memoryContextSearch() {
    // Atlas 不提供聊天转写：这是 Body 的本地历史，不属于统一记忆服务。
    return unimplementedContext("NOT_PROVIDED_BY_ATLAS");
  }

  async function controlFormalMemory(control) {
    const input = control && typeof control === "object" ? control : {};
    const space = str(input.instanceId) || requireSpace();
    if (!space) return { ok: false, status: "ATLAS_SPACE_REQUIRED", error: "No memory space is selected." };
    const action = input.action === "correct" || input.action === "retract" ? input.action : null;
    if (!action) return { ok: false, status: "MEMORY_CONTROL_INVALID", error: "action must be correct or retract." };

    const body = {
      spaceId: space,
      aboutRecordId: String(input.targetExperienceId || ""),
      ...(typeof input.operationId === "string" && input.operationId ? { operationId: input.operationId } : {})
    };
    if (action === "correct") body.content = String(input.text || "");

    const result = await request("POST", action === "correct" ? "/atlas/correct" : "/atlas/retract", {
      body,
      token: writeBearer,
      write: true
    });
    const settled = settle(result, { write: true });
    const mapped = mapControl(settled, {
      operationId: input.operationId,
      targetExperienceId: input.targetExperienceId,
      action
    }, { httpStatus: result.status });
    if (!mapped.ok) {
      // 传输层没有回答 → 未确认；有回答的失败 → 按 code 归类
      if (settled.code === "ATLAS_WRITE_UNCONFIRMED" || settled.code === "MEMORY_RESULT_UNKNOWN") {
        mapped.status = "MEMORY_RESULT_UNKNOWN";
      } else if (settled.code === "ATLAS_UNAVAILABLE" || settled.code === "ATLAS_READ_TIMEOUT") {
        mapped.status = "MEMORY_UNAVAILABLE";
      } else if (settled.code === "ATLAS_UNAUTHORIZED") {
        mapped.status = "MEMORY_ACCESS_DENIED";
      }
    }
    return mapped;
  }

  /**
   * 图查询能力探测。Atlas v0.1 没有图端点（文档里没有，源码里也没有实现），
   * 所以这里诚实地返回 unsupported，界面据此显示"图：本地派生"。
   * 如果将来 Atlas 加了 GET /atlas/graph，这里改成真调用即可，界面不用动。
   */
  async function probeGraph() {
    const space = requireSpace();
    if (!space) return { ok: false, supported: false, reason: "ATLAS_SPACE_REQUIRED" };
    const result = await request("GET", "/atlas/graph", { params: [["space", space], ["depth", "1"]], token: readBearer });
    if (result.transport) return { ok: false, supported: false, reason: result.transport };
    if (result.status === 404 || result.status === 405) {
      return { ok: false, supported: false, reason: "ATLAS_GRAPH_NOT_IMPLEMENTED" };
    }
    if (result.status === 401) return { ok: false, supported: false, reason: "ATLAS_UNAUTHORIZED" };
    if (result.status >= 200 && result.status < 300) return { ok: true, supported: true, payload: result.payload };
    return { ok: false, supported: false, reason: "ATLAS_GRAPH_UNAVAILABLE" };
  }

  return {
    memorySearch,
    memoryDetail,
    memoryOperation,
    memoryHealth,
    memoryCapacity,
    memoryContextSearch,
    controlFormalMemory,
    listSpaces,
    setSpace,
    probeGraph,
    getSpace: () => currentSpace,
    probe: async () => {
      const result = await request("GET", "/health", {});
      if (result.transport) return { ok: false, status: result.transport };
      return { ok: result.status === 200, status: result.status === 200 ? "OK" : "ATLAS_READ_FAILED" };
    },
    meta: { adapter: "atlas", baseUrl: base, hasReadToken: Boolean(readBearer), hasWriteToken: Boolean(writeBearer), spaceId: currentSpace }
  };
}

function str(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** Atlas 的读失败码 → 渲染层的故障语言（渲染层只认那一套）。 */
function translateReadFault(code) {
  if (code === "ATLAS_UNAUTHORIZED") return "MEMORY_ACCESS_DENIED";
  if (code === "ATLAS_UNAVAILABLE") return "MEMORY_UNAVAILABLE";
  if (code === "ATLAS_READ_TIMEOUT") return "MEMORY_READ_TIMEOUT";
  if (code === "ATLAS_QUERY_INVALID") return "MEMORY_QUERY_INVALID";
  if (code === "SOURCE_UNAVAILABLE") return "SOURCE_UNAVAILABLE";
  return code || "MEMORY_READ_FAILED";
}
