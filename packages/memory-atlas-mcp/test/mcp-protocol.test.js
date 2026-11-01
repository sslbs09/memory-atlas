/**
 * mcp-protocol.test.js — 通过真实 stdio 驱动打包后的 dist/atlas-mcp.mjs：
 *   initialize → tools/list → tools/call（health/search/get/写入门禁）。
 * 这是"工具协议联调"层：不依赖任何模型。
 * 子进程一律由 spawn-atlas.mjs 的辅助函数以参数数组启动（无 shell、无拼接）。
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnAtlas, spawnNode } from '../../../evidence/release-interop/spawn-atlas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const BUNDLE = path.join(HERE, '..', 'dist', 'atlas-mcp.mjs');

/** 极简 MCP stdio 客户端：换行 JSON-RPC。 */
class McpStdioClient {
  constructor({ space, dataDir, allowWrites = false }) {
    this.proc = spawnNode([BUNDLE], {
      MEMORY_ATLAS_SPACE: space,
      MEMORY_ATLAS_DATA_DIR: dataDir,
      ...(allowWrites ? { MEMORY_ATLAS_ALLOW_WRITES: '1' } : {})
    });
    this.stderr = [];
    this.proc.stderr.on('data', (c) => this.stderr.push(String(c)));
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += String(chunk);
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. stderr: ${this.stderr.join('')}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'atlas-mcp-test', version: '0.0.1' }
    });
    this.notify('notifications/initialized', {});
    return res;
  }
  async listTools() {
    const res = await this.request('tools/list', {});
    return res.result?.tools ?? [];
  }
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call ${name} protocol error: ${JSON.stringify(res.error)}`);
    const text = res.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    let json = null;
    try { json = JSON.parse(text); } catch { /* isError 工具返回纯文本错误说明 */ }
    return { isError: res.result?.isError === true, json, text };
  }
  close() {
    this.proc.stdin.end();
    return new Promise((resolve) => {
      this.proc.once('exit', resolve);
      setTimeout(() => { try { this.proc.kill(); } catch {} resolve(); }, 4000);
    });
  }
}

let atlas;
let conn;

beforeEach(async () => {
  if (atlas) return;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mcp-test-'));
  atlas = spawnAtlas({ dataDir, port: 0, repoRoot: REPO_ROOT });
  const ready = await atlas.ready;
  const { AtlasClient } = await import('../../../src/client.js');
  conn = new AtlasClient({ baseUrl: `http://127.0.0.1:${ready.port}`, readToken: atlas.readToken, writeToken: atlas.writeToken });
  await conn.createSpace('interop-demo', 'MCP 测试空间');
  await conn.createSpace('other-space', '别的空间');
  await conn.record({ spaceId: 'interop-demo', record: { recordId: 'demo-a', kind: 'experience', content: '上个月和小林一起看过电影。', source: { kind: 'manual', id: 'seed' } } });
  await conn.record({ spaceId: 'other-space', record: { recordId: 'secret-1', kind: 'note', content: '这是别的空间的小林秘密。', source: { kind: 'manual', id: 'seed' } } });
  await conn.record({ spaceId: 'interop-demo', record: { recordId: 'demo-c', kind: 'observation', content: '昨天办公室打印机换了墨盒。', source: { kind: 'manual', id: 'seed' } } });
  await conn.retract({ spaceId: 'interop-demo', aboutRecordId: 'demo-c' });
});

after(async () => { if (atlas) await atlas.stop(); });

test('initialize negotiates a supported protocol version', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile) });
  try {
    const res = await c.initialize();
    assert.ok(res.result?.protocolVersion, 'server returned a protocolVersion');
    assert.equal(res.result?.serverInfo?.name, 'memory-atlas-mcp');
  } finally { await c.close(); }
});

test('read-only mode: health/search/get present, write tools absent', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile) });
  try {
    await c.initialize();
    const names = (await c.listTools()).map((t) => t.name);
    for (const required of ['atlas_health', 'atlas_search', 'atlas_get']) {
      assert.ok(names.includes(required), `${required} registered`);
    }
    for (const forbidden of ['atlas_remember', 'atlas_correct', 'atlas_retract']) {
      assert.ok(!names.includes(forbidden), `${forbidden} NOT registered in read-only mode`);
    }
  } finally { await c.close(); }
});

test('atlas_search returns the active record with provenance fields', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile) });
  try {
    await c.initialize();
    const r = await c.call('atlas_search', { query: '小林 电影' });
    assert.equal(r.isError, false);
    assert.equal(r.json.space, 'interop-demo');
    const hit = r.json.records.find((x) => x.recordId === 'demo-a');
    assert.ok(hit, 'search found demo-a');
    assert.equal(hit.status, 'active');
    assert.equal(hit.space, 'interop-demo');
    assert.ok(hit.source, 'source preserved');
    assert.ok(Array.isArray(hit.matchReason) || hit.matchReason === null, 'matchReason preserved');
    assert.ok(hit.content.includes('小林'));
  } finally { await c.close(); }
});

test('atlas_get labels a retracted record as not a current fact', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile) });
  try {
    await c.initialize();
    const r = await c.call('atlas_get', { recordId: 'demo-c' });
    assert.equal(r.json.currentFact, false, 'retracted record is not a current fact');
    assert.equal(r.json.record.status, 'retracted');
    const s = await c.call('atlas_search', { query: '打印机 墨盒' });
    assert.ok(!s.json.records.some((x) => x.recordId === 'demo-c'), 'retracted record not returned as active');
  } finally { await c.close(); }
});

test('write tools appear only when enabled and work end-to-end', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile), allowWrites: true });
  try {
    await c.initialize();
    const names = (await c.listTools()).map((t) => t.name);
    for (const required of ['atlas_remember', 'atlas_correct', 'atlas_retract']) {
      assert.ok(names.includes(required), `${required} registered when writes enabled`);
    }
    const remembered = await c.call('atlas_remember', { content: '答应老陈月底前还书。' });
    assert.equal(remembered.isError, false);
    assert.ok(remembered.json.recordId, 'write returns recordId');
    assert.equal(remembered.json.space, 'interop-demo');

    const corrected = await c.call('atlas_correct', { recordId: remembered.json.recordId, content: '答应老陈下月三号前还书。' });
    assert.equal(corrected.isError, false);
    assert.ok(corrected.json.correctionRecordId, 'correction receipt names the new active record');

    const search = await c.call('atlas_search', { query: '老陈 还书' });
    assert.ok(search.json.records.some((x) => x.content.includes('下月三号')), 'corrected content is the active fact');
    assert.ok(!search.json.records.some((x) => x.content.includes('月底前') && x.status === 'active'), 'old version no longer active');

    // Atlas 语义：只能撤回当前 active 的记录（被取代的原记录不能再撤回）。
    const retracted = await c.call('atlas_retract', { recordId: corrected.json.correctionRecordId });
    assert.equal(retracted.isError, false, `retract failed: ${retracted.text}`);
    const after = await c.call('atlas_search', { query: '老陈' });
    assert.equal(after.json.outcome, 'NO_MATCH', 'retracted memory no longer returned');
  } finally { await c.close(); }
});

test('atlas server offline: tools fail visibly instead of pretending', async () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mcp-empty-'));
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: missingDir });
  try {
    await c.initialize();
    const health = await c.call('atlas_health', {});
    assert.equal(health.json.available, false, 'health reports unavailable');
    const search = await c.call('atlas_search', { query: 'anything' });
    assert.equal(search.isError, true, 'search fails visibly');
    assert.match(search.text, /Atlas 服务未运行|找不到 endpoint\.json/, 'error names the cause');
  } finally { await c.close(); }
});

test('space binding is enforced: another space is invisible even if the model asks', async () => {
  const c = new McpStdioClient({ space: 'interop-demo', dataDir: path.dirname(atlas.endpointFile) });
  try {
    await c.initialize();
    const r = await c.call('atlas_search', { query: '小林 秘密' });
    assert.ok(!r.json.records.some((x) => x.recordId === 'secret-1'), 'other space record never leaks');
    const health = await c.call('atlas_health', {});
    assert.equal(health.json.space, 'interop-demo');
    assert.equal(health.json.spaceExists, true);
    // R7 回归：健康工具不得向模型暴露其他空间的名称或全局容量信息。
    assert.equal(health.json.spaces, undefined, 'no cross-space name list');
    assert.equal(health.json.health, undefined, 'no global capacity/sources dump');
  } finally { await c.close(); }
});
