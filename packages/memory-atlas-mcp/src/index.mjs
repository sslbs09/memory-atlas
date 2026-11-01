#!/usr/bin/env node
/**
 * memory-atlas-mcp — Memory Atlas 的统一 MCP Server。
 *
 * 让外部 Agent 宿主（DSH、MaiBot、任何 MCP 客户端）通过标准 MCP 工具查询
 * （或在显式启用时写入）同一个正在运行的 Memory Atlas 服务。它只是桥：
 *   - 不持有任何记忆数据，不建第二套数据库；
 *   - 只走 Atlas 正式 HTTP API（复用 src/client.js，与桌面端同一客户端）；
 *   - 派生索引不是事实权威：输出一律携带 Atlas 的正式状态与来源；
 *   - 撤回/被取代的记录绝不作为当前事实输出（默认 status=active 查询，
 *     atlas_get 明确标注 currentFact）。
 *
 * 绑定与授权：
 *   MEMORY_ATLAS_SPACE            必填。本服务器实例被授权读写的唯一记忆空间；
 *                                 工具参数不提供 space，模型无法越权选择空间。
 *   MEMORY_ATLAS_DATA_DIR         endpoint.json 所在目录（桌面端数据目录）。
 *   MEMORY_ATLAS_URL/_READ_TOKEN/_WRITE_TOKEN
 *                                 直连模式（覆盖 endpoint.json；用于显式配置）。
 *   MEMORY_ATLAS_ALLOW_WRITES=1   显式启用写入工具（atlas_remember/correct/
 *                                 retract）。默认只读：MCP 接入 ≠ 自动记忆捕获。
 *
 * 日志走 stderr；stdout 只承载 MCP 协议。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { AtlasClient } from '../../../src/client.js';

const SERVER_NAME = 'memory-atlas-mcp';
const SERVER_VERSION = '0.1.0-alpha.1';

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/* ---------------- 配置 ---------------- */

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key.slice(2)] = true; continue; }
    out[key.slice(2)] = next;
    i += 1;
  }
  return out;
}

const argv = parseArgv(process.argv.slice(2));

const config = {
  space: argv.space ?? process.env.MEMORY_ATLAS_SPACE ?? '',
  dataDir: argv['data-dir'] ?? process.env.MEMORY_ATLAS_DATA_DIR ?? '',
  url: argv.url ?? process.env.MEMORY_ATLAS_URL ?? '',
  readToken: argv['read-token'] ?? process.env.MEMORY_ATLAS_READ_TOKEN ?? '',
  writeToken: argv['write-token'] ?? process.env.MEMORY_ATLAS_WRITE_TOKEN ?? '',
  allowWrites: (argv['allow-writes'] ?? process.env.MEMORY_ATLAS_ALLOW_WRITES ?? '') === '1'
    || String(argv['allow-writes'] ?? process.env.MEMORY_ATLAS_ALLOW_WRITES ?? '').toLowerCase() === 'true'
};

if (!config.space || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.space)) {
  log('FATAL: MEMORY_ATLAS_SPACE（或 --space）必须是非空的合法空间 id。本服务器只服务一个被授权的空间。');
  process.exit(2);
}
if (!config.dataDir && !config.url) {
  log('FATAL: 需要 MEMORY_ATLAS_DATA_DIR（endpoint.json 所在目录）或 MEMORY_ATLAS_URL（直连）。');
  process.exit(2);
}

/* ---------------- 连接管理 ---------------- */

// 桌面端每次启动会轮换端口与 token，endpoint.json 是唯一的发现契约。
// 每次调用都重读该文件：bootId 变了就换新客户端，旧连接自动作废。
let cached = { bootId: null, pid: null, client: null, provenance: null };

function readEndpointFile() {
  if (!config.dataDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'endpoint.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resolveConnection() {
  const endpoint = readEndpointFile();
  const source = config.url
    ? { url: config.url, readToken: config.readToken, writeToken: config.writeToken, bootId: 'static-config', pid: null, origin: 'env-config' }
    : endpoint
      ? { url: endpoint.url, readToken: endpoint.readToken, writeToken: endpoint.writeToken, bootId: endpoint.bootId, pid: endpoint.pid, origin: 'endpoint-file' }
      : null;
  if (!source) {
    return { error: `Atlas 服务未运行：${config.dataDir ? '在 ' + config.dataDir + ' 找不到 endpoint.json。' : '未配置 MEMORY_ATLAS_URL。'}请先启动 Memory Atlas 桌面程序（或 atlas-server）。` };
  }
  if (!cached.client || cached.bootId !== source.bootId || cached.url !== source.url) {
    cached = {
      bootId: source.bootId,
      pid: source.pid,
      url: source.url,
      client: new AtlasClient({ baseUrl: source.url, readToken: source.readToken, writeToken: source.writeToken, timeoutMs: 10000 }),
      provenance: { origin: source.origin, url: source.url, bootId: source.bootId, pid: source.pid }
    };
    log(`connected via ${source.origin}: ${source.url} (bootId=${source.bootId})`);
  }
  return { client: cached.client, provenance: cached.provenance };
}

/* ---------------- 输出整形 ---------------- */

const KINDS = ['experience', 'observation', 'note'];
const STATUSES = ['active', 'superseded', 'retracted', 'recorded', 'all'];

// 只保留 Atlas 正式字段；空间永远来自服务器绑定，绝不回显模型可控的输入。
function projectRecord(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    recordId: record.recordId,
    space: record.spaceId ?? config.space,
    revision: record.revision ?? record.sequence ?? null,
    status: record.status ?? null,
    kind: record.kind ?? null,
    content: record.content ?? null,
    source: record.source ?? null,
    visibility: record.visibility ?? null,
    aboutRecordId: record.aboutRecordId ?? null,
    occurredAt: record.occurredAt ?? null,
    recordedAt: record.recordedAt ?? null,
    score: record.score ?? null,
    matchReason: record.matchReason ?? null,
    indexState: record.indexState ?? null
  };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toolJson(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/* ---------------- 工具注册 ---------------- */

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool('atlas_health', {
  title: 'Atlas 健康检查',
  description: '检查 Memory Atlas 服务是否可用、绑定空间是否存在，以及写入是否开放。不产生任何副作用。',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  const resolved = resolveConnection();
  if (resolved.error) return toolJson({ atlas: SERVER_NAME, space: config.space, available: false, error: resolved.error });
  const health = await resolved.client.health();
  if (!health.ok) {
    return toolJson({ atlas: SERVER_NAME, space: config.space, available: false,
      endpoint: resolved.provenance, error: health.error ?? `HTTP ${health.httpStatus}` });
  }
  const spaces = await resolved.client.spaces();
  const spaceIds = spaces.ok ? (spaces.spaceIds ?? []) : null;
  // 越权信息不外泄：只回答绑定空间是否存在，不列出其他空间的名称，
  // 也不转发全局容量/来源统计——模型用它无益，却会暴露部署形状。
  return toolJson({
    atlas: SERVER_NAME,
    space: config.space,
    spaceBound: true,
    spaceExists: spaceIds === null ? null : spaceIds.includes(config.space),
    available: true,
    endpoint: resolved.provenance,
    writesEnabled: config.allowWrites,
    writeToolsNote: config.allowWrites
      ? '写入工具已开放：atlas_remember / atlas_correct / atlas_retract 只应由用户明确要求的对话调用。'
      : '本实例为只读接入；写入请使用 Memory Atlas 桌面程序。',
    note: '本工具只报告绑定空间的状态；其他记忆空间的存在与否不在此工具的输出里。'
  });
});

server.registerTool('atlas_search', {
  title: '搜索 Atlas 记忆',
  description: '在绑定的记忆空间里检索当前有效的记忆。默认只返回 status=active 的记录（撤回与被取代的不出现）；'
    + '每条记录带 recordId、status、source、matchReason。同义改写可能搜不到（词法检索），此时如实返回 NO_MATCH，不要编造记忆。',
  inputSchema: {
    query: z.string().min(1).describe('检索词（支持中文与 ASCII 词项；多词按 AND 组合）'),
    limit: z.number().int().min(1).max(32).optional().describe('最多返回条数，默认 8'),
    status: z.enum(STATUSES).optional().describe('记录状态过滤，默认 active（仅当前有效）。audit 时可用 all'),
    kinds: z.array(z.enum(KINDS)).optional().describe('按记录类型过滤'),
    includeContent: z.boolean().optional().describe('是否包含正文，默认 true')
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ query, limit, status, kinds, includeContent }) => {
  const resolved = resolveConnection();
  if (resolved.error) return toolError(resolved.error);
  const view = await resolved.client.search({
    spaceId: config.space,
    query,
    limit: limit ?? 8,
    status: status ?? 'active',
    kinds,
    includeContent: includeContent ?? true
  });
  if (!view.ok) return toolError(`Atlas 查询失败：${view.error ?? `HTTP ${view.httpStatus}`}`);
  const records = (view.records ?? []).map(projectRecord);
  return toolJson({
    atlas: SERVER_NAME,
    space: config.space,
    query,
    outcome: view.outcome,
    appliedFilters: view.appliedFilters ?? null,
    records,
    note: view.outcome === 'NO_MATCH'
      ? '没有命中的当前有效记录。词法检索不做同义改写：换用记忆中的原词重试，或承认没有这条记忆。'
      : (view.indexing === 'AUTHORITATIVE_SCAN_FALLBACK'
        ? '派生索引暂不可用，结果来自正式存储全量扫描（事实权威不受影响）。'
        : null)
  });
});

server.registerTool('atlas_get', {
  title: '读取 Atlas 记录详情',
  description: '按 recordId 读取一条记忆的完整详情与纠正/撤回链。返回 currentFact 表明它是否仍是当前有效事实；'
    + 'status 不是 active 的记录不得作为当前事实引用。',
  inputSchema: {
    recordId: z.string().min(1).describe('稳定的记录 id（来自 atlas_search 或 atlas_remember 的回执）')
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ recordId }) => {
  const resolved = resolveConnection();
  if (resolved.error) return toolError(resolved.error);
  const detail = await resolved.client.detail({ spaceId: config.space, recordId });
  if (!detail.ok) return toolError(`Atlas 读取失败：${detail.error ?? `HTTP ${detail.httpStatus}`}`);
  const record = detail.record ?? detail;
  const status = record.status ?? null;
  return toolJson({
    atlas: SERVER_NAME,
    space: config.space,
    record: projectRecord(record),
    currentFact: status === 'active',
    chain: detail.chain ?? detail.history ?? null,
    note: status === 'active' ? null
    : status === 'retracted' ? '该记录已被撤回，不能作为当前事实引用。'
      : status === 'superseded' ? '该记录已被更新的版本取代，请以纠正链中 active 的版本为准。'
        : `记录状态为 ${status}。`
  });
});

const writeGate = () => config.allowWrites ? null
  : '写入未开放：本 MCP 实例以只读方式接入（设置 MEMORY_ATLAS_ALLOW_WRITES=1 才启用）。'
  + '请不要用其他方式改动记忆；正式写入请通过 Memory Atlas 桌面程序。';

if (config.allowWrites) {
  server.registerTool('atlas_remember', {
    title: '写入 Atlas 记忆',
    description: '把一条明确的事实/经验写入绑定的记忆空间。只在用户明确要求记住时调用；'
      + '不要自动保存整段聊天。每条记录有稳定 recordId，可被纠正与撤回。',
    inputSchema: {
      content: z.string().min(1).max(2000).describe('要记住的内容（一句话级别的明确陈述）'),
      kind: z.enum(KINDS).optional().describe('记录类型，默认 experience'),
      occurredAt: z.string().optional().describe('事件发生时间（可选，ISO 8601）')
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ content, kind, occurredAt }) => {
    const resolved = resolveConnection();
    if (resolved.error) return toolError(resolved.error);
    const receipt = await resolved.client.record({
      spaceId: config.space,
      record: {
        recordId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        kind: kind ?? 'experience',
        content,
        source: { kind: 'mcp', id: SERVER_NAME },
        ...(occurredAt ? { occurredAt } : {})
      }
    });
    if (!receipt.ok) return toolError(`Atlas 写入失败：${receipt.error ?? `HTTP ${receipt.httpStatus}`}`);
    return toolJson({
      atlas: SERVER_NAME, space: config.space, outcome: receipt.outcome,
      recordId: receipt.recordId, revision: receipt.revision ?? receipt.sequence ?? null,
      recordedAt: receipt.recordedAt ?? null, status: 'active',
      note: receipt.outcome === 'IDEMPOTENT_DUPLICATE' || receipt.outcome === 'IDEMPOTENT_REPLAY'
        ? '相同内容此前已写入，未产生重复记录。' : null
    });
  });

  server.registerTool('atlas_correct', {
    title: '纠正 Atlas 记忆',
    description: '对一条已存在的记忆提交正式纠正（生成纠正记录，旧版本自动失效）。只在用户明确纠正时调用。',
    inputSchema: {
      recordId: z.string().min(1).describe('要纠正的记录 id'),
      content: z.string().min(1).max(2000).describe('纠正后的正确内容（完整替换陈述）')
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ recordId, content }) => {
    const resolved = resolveConnection();
    if (resolved.error) return toolError(resolved.error);
    const receipt = await resolved.client.correct({ spaceId: config.space, aboutRecordId: recordId, content });
    if (!receipt.ok) return toolError(`Atlas 纠正失败：${receipt.error ?? `HTTP ${receipt.httpStatus}`}`);
    return toolJson({
      atlas: SERVER_NAME, space: config.space, outcome: receipt.outcome,
      correctionRecordId: receipt.recordId, aboutRecordId: recordId,
      revision: receipt.revision ?? receipt.sequence ?? null,
      recordedAt: receipt.recordedAt ?? null,
      note: '纠正已生效：旧版本不再是当前事实，后续检索只返回纠正后的内容。'
    });
  });

  server.registerTool('atlas_retract', {
    title: '撤回 Atlas 记忆',
    description: '撤回一条已存在的记忆（生成撤回记录，该内容不再作为当前事实）。只在用户明确要求撤回时调用。',
    inputSchema: {
      recordId: z.string().min(1).describe('要撤回的记录 id')
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }, async ({ recordId }) => {
    const resolved = resolveConnection();
    if (resolved.error) return toolError(resolved.error);
    const receipt = await resolved.client.retract({ spaceId: config.space, aboutRecordId: recordId });
    if (!receipt.ok) return toolError(`Atlas 撤回失败：${receipt.error ?? `HTTP ${receipt.httpStatus}`}`);
    return toolJson({
      atlas: SERVER_NAME, space: config.space, outcome: receipt.outcome,
      retractionRecordId: receipt.recordId, aboutRecordId: recordId,
      recordedAt: receipt.recordedAt ?? null,
      note: '撤回已生效：该内容不再作为当前事实被检索返回。'
    });
  });
} else {
  log('read-only mode: write tools not registered (set MEMORY_ATLAS_ALLOW_WRITES=1 to enable)');
}

/* ---------------- 启动 ---------------- */

const transport = new StdioServerTransport();
await server.connect(transport);
log(`serving space "${config.space}" (writes ${config.allowWrites ? 'enabled' : 'disabled'})`);
