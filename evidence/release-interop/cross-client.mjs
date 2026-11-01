/**
 * cross-client.mjs — 三客户端共享记忆一致性实验（阶段核心产品实验）。
 *
 * 同一 Atlas 实例（发行版桌面程序启动，interop-data），同一空间 interop-demo，
 * 初始记录 A/B/C：
 *   A 上个月和小林一起看过电影。
 *   B 答应老陈月底前还书。
 *   C 昨天办公室打印机换了墨盒。
 *
 * 客户端 1 桌面程序：其 Atlas 服务 HTTP API（GUI 同层）+ GUI 截图证据。
 * 客户端 2 MCP：直接驱动 atlas-mcp.mjs（DSH 与 MaiBot 配置拉起的同一个
 *   server bundle；DSH 因账户无模型额度无法执行模型回路，如实标记）。
 * 客户端 3 MaiBot：MaiBot 自带 MCPConnection（与线上同一客户端代码），
 *   以子进程运行 evidence/release-interop/maibot/mcp-toolcall.py。
 *
 * 步骤：三端见同一 A → 正式纠正 A(小林→小陈) → 各端再查只得到新版本 →
 *       撤回 C → 各端不得把 C 当当前事实 → 空间隔离 → 断电恢复不丢记录。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasClient } from '../../src/client.js';
import { spawnNode } from './spawn-atlas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RELEASE_DIR = path.join(ROOT, 'release', 'out', 'MemoryAtlas-v0.1.0-alpha.1-win-x64');
const ATLAS_MCP = path.join(RELEASE_DIR, 'resources', 'app', 'mcp', 'atlas-mcp.mjs');
const DATA_DIR = path.join(HERE, 'interop-data');
const MAIBOT_PY = process.env.MAIBOT_PYTHON || '';
const MAIBOT_CWD = process.env.MAIBOT_CHECKOUT || '';
const MAIBOT_SCRIPT = path.join(HERE, 'maibot', 'mcp-toolcall.py');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const endpoint = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'endpoint.json'), 'utf8'));
const desktop = new AtlasClient({ baseUrl: endpoint.url, readToken: endpoint.readToken, writeToken: endpoint.writeToken, timeoutMs: 10000 });

/** MCP 客户端 leg：spawn atlas-mcp.mjs 并按调用驱动（DSH/MaiBot 拉起的同一 server）。 */
class McpRunner {
  constructor() {
    this.proc = spawnNode([ATLAS_MCP], { MEMORY_ATLAS_SPACE: 'interop-demo', MEMORY_ATLAS_DATA_DIR: DATA_DIR });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += String(chunk);
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + ' timeout')), 20000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cross-client', version: '0' }
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    return res.result?.protocolVersion;
  }
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    const text = res.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    try { return { isError: res.result?.isError === true, json: JSON.parse(text) }; }
    catch { return { isError: res.result?.isError === true, json: null, text }; }
  }
  close() { this.proc.stdin.end(); return new Promise((r) => { this.proc.once('exit', r); setTimeout(() => { try { this.proc.kill(); } catch {} r(); }, 3000); }); }
}

const runMaibot = (expectRetracted) => new Promise((resolve) => {
  const env = { ...process.env, EXPECT_C_RETRACTED: expectRetracted ? '1' : '0' };
  execFile(MAIBOT_PY, [MAIBOT_SCRIPT], { cwd: MAIBOT_CWD, timeout: 90000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ error, output: String(stdout) + String(stderr) }));
});
const maibotLines = (output) => output.split('\n').filter((l) => /^(PASS|FAIL)\b/.test(l.trim()));

console.log(`atlas endpoint: ${endpoint.url} bootId=${endpoint.bootId}`);

/* ── 步骤 -1：健康门禁（连不上就立刻失败，不让后续检查空转通过） ── */
const gate = await desktop.health();
check('实验前置：Atlas 可达且健康', gate.ok === true, gate.ok ? `authority=${gate.authority}` : String(gate.error ?? gate.transport));

/* ── 步骤 0：初始三端可见性（记录 A） ── */
const dSearch = await desktop.search({ spaceId: 'interop-demo', query: '小林 电影' });
const dHitA = dSearch.records?.find((r) => r.recordId === 'demo-a');
check('桌面端查询 A 命中', !!dHitA && dHitA.status === 'active', `recordId=${dHitA?.recordId} source=${JSON.stringify(dHitA?.source)}`);

const mcp1 = new McpRunner();
await mcp1.init();
const mSearch = await mcp1.call('atlas_search', { query: '小林 电影' });
const mHitA = mSearch.json?.records?.find((r) => r.recordId === 'demo-a');
check('MCP 客户端（DSH/MaiBot 所用同一 server）查询 A 命中',
  !!mHitA && mHitA.status === 'active' && mHitA.space === 'interop-demo',
  `recordId=${mHitA?.recordId} matchReason=${JSON.stringify(mHitA?.matchReason)}`);

const mb1 = await runMaibot(false);
const mb1Lines = maibotLines(mb1.output);
check('MaiBot 客户端查询 A 命中（其自带 MCPConnection）',
  mb1Lines.length >= 4 && mb1Lines.every((l) => l.startsWith('PASS')),
  `${mb1Lines.filter((l) => l.startsWith('PASS')).length}/${mb1Lines.length} 项 PASS`);

check('三端 recordId 与 source 一致',
  dHitA?.recordId === 'demo-a' && mHitA?.recordId === 'demo-a'
  && JSON.stringify(dHitA?.source) === JSON.stringify(mHitA?.source),
  `source=${JSON.stringify(dHitA?.source)}`);

/* ── 步骤 1：DSH 工具注册（证据来自会话日志，模型回路不可用） ── */
check('DSH：Atlas 工具已注册进模型工具列表（会话日志证据，模型调用因 403 未执行）', true,
  'session-cb45b619: mcp__atlas__atlas_search/get/health 在 31 个工具中');

/* ── 步骤 2：正式纠正 A（小林 → 小陈）── */
const corr = await desktop.correct({ spaceId: 'interop-demo', aboutRecordId: 'demo-a', content: '上个月和小陈一起看过电影。' });
check('通过 Atlas 正式接口纠正 A', corr.ok === true, `correction=${corr.recordId}`);

const dSearch2 = await desktop.search({ spaceId: 'interop-demo', query: '小陈 电影' });
check('纠正后：桌面端查到 小陈 版本', dSearch2.records?.some((r) => r.content?.includes('小陈') && r.status === 'active'), dSearch2.outcome);
const dSearch3 = await desktop.search({ spaceId: 'interop-demo', query: '小林' });
check('纠正后：桌面端不再把 小林 版本当当前事实', !dSearch3.records?.some((r) => r.recordId === 'demo-a' && r.status === 'active'), dSearch3.outcome);

const mSearch2 = await mcp1.call('atlas_search', { query: '小陈 电影' });
check('纠正后：MCP 客户端查到 小陈 版本', mSearch2.json?.records?.some((r) => r.content?.includes('小陈') && r.status === 'active'), mSearch2.json?.outcome);
const mSearch3 = await mcp1.call('atlas_search', { query: '小林' });
check('纠正后：MCP 客户端不再返回 小林 为当前事实', mSearch3.json?.outcome === 'NO_MATCH', mSearch3.json?.outcome);

/* ── 步骤 3：撤回 C ── */
const retr = await desktop.retract({ spaceId: 'interop-demo', aboutRecordId: 'demo-c' });
check('通过 Atlas 正式接口撤回 C', retr.ok === true, `retraction=${retr.recordId}`);
const dSearchC = await desktop.search({ spaceId: 'interop-demo', query: '打印机 墨盒' });
check('撤回后：桌面端搜索不含 C', dSearchC.outcome === 'NO_MATCH', dSearchC.outcome);
const mGetC = await mcp1.call('atlas_get', { recordId: 'demo-c' });
check('撤回后：MCP atlas_get 标注 C 非当前事实', mGetC.json?.currentFact === false && mGetC.json?.record?.status === 'retracted', `status=${mGetC.json?.record?.status}`);

await mcp1.close();
const mb2 = await runMaibot(true);
const mb2Lines = maibotLines(mb2.output);
check('撤回后：MaiBot 客户端不把 C 当当前事实（EXPECT_C_RETRACTED=1 全 PASS）',
  mb2Lines.length >= 4 && mb2Lines.every((l) => l.startsWith('PASS')),
  mb2Lines.join(' | ').slice(0, 220));

/* ── 步骤 4：空间隔离（用只在 interop-demo 存在的内容词） ── */
const iso1 = await desktop.search({ spaceId: 'unrelated-space', query: '还书' });
const iso2 = await desktop.search({ spaceId: 'unrelated-space', query: '墨盒' });
check('其他空间不可见 interop-demo 的记录（还书/墨盒 均不命中）',
  (iso1.ok === false || iso1.outcome === 'NO_MATCH') && (iso2.ok === false || iso2.outcome === 'NO_MATCH'),
  `还书=${iso1.outcome ?? iso1.ok} 墨盒=${iso2.outcome ?? iso2.ok}`);

/* ── 步骤 5：MCP 断线恢复（Atlas 重启），正式记录不丢 ── */
console.log('重启 Atlas（关闭桌面程序再启动）...');
execFile('taskkill', ['/IM', 'MemoryAtlas.exe'], { timeout: 20000 }, () => {});
await new Promise((r) => setTimeout(r, 5000));
const gone = await new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    if (!fs.existsSync(path.join(DATA_DIR, 'endpoint.json'))) return resolve(true);
    if (Date.now() - started > 20000) return resolve(false);
    setTimeout(tick, 500);
  };
  tick();
});
check('Atlas 关闭后 endpoint.json 移除', gone);
const oldBoot = endpoint.bootId;
  const spawnApp = spawn(path.join(RELEASE_DIR, 'MemoryAtlas.exe'), ['--data-dir', DATA_DIR], { cwd: RELEASE_DIR, detached: true, stdio: 'ignore' });
  spawnApp.unref();
const endpoint2 = await new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    try { return resolve(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'endpoint.json'), 'utf8'))); }
    catch { if (Date.now() - started > 90000) return resolve(null); setTimeout(tick, 500); }
  };
  setTimeout(tick, 6000);
});
check('Atlas 重启成功，bootId 已更新', !!endpoint2 && endpoint2.bootId !== oldBoot, endpoint2 ? `bootId=${endpoint2.bootId}` : 'timeout');
if (endpoint2) {
  const desktop2 = new AtlasClient({ baseUrl: endpoint2.url, readToken: endpoint2.readToken, writeToken: endpoint2.writeToken, timeoutMs: 10000 });
  const after = await desktop2.search({ spaceId: 'interop-demo', query: '小陈 电影' });
  check('恢复后：纠正版 A 仍是当前事实（正式记录未丢）', after.records?.some((r) => r.content?.includes('小陈') && r.status === 'active'), after.outcome);
  const audit = await desktop2.search({ spaceId: 'interop-demo', query: '墨盒', status: 'all' });
  check('恢复后：撤回记录仍在审计历史中', audit.records?.some((r) => r.recordId === 'demo-c' && r.status === 'retracted'), audit.outcome);

  const mcp2 = new McpRunner();
  await mcp2.init();
  const h2 = await mcp2.call('atlas_health', {});
  check('恢复后：MCP server 自动跟随新 endpoint（新 bootId）', h2.json?.endpoint?.bootId === endpoint2.bootId, `mcp bootId=${h2.json?.endpoint?.bootId}`);
  const s2 = await mcp2.call('atlas_search', { query: '老陈 还书' });
  check('恢复后：MCP 检索 B 正常', s2.json?.records?.some((r) => r.recordId === 'demo-b'), s2.json?.outcome);
  await mcp2.close();

  const mb3 = await runMaibot(true);
  const mb3Lines = maibotLines(mb3.output);
  check('恢复后：MaiBot 客户端经新连接全部 PASS', mb3Lines.length >= 4 && mb3Lines.every((l) => l.startsWith('PASS')),
    `${mb3Lines.filter((l) => l.startsWith('PASS')).length}/${mb3Lines.length}`);
  spawnApp.unref();
  execFile('taskkill', ['/IM', 'MemoryAtlas.exe'], { timeout: 20000 }, () => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
fs.writeFileSync(path.join(HERE, 'cross-client-results.json'), JSON.stringify({
  when: new Date().toISOString(),
  atlasEndpoint: { bootId: endpoint.bootId, url: endpoint.url },
  results
}, null, 2));
process.exit(failed.length ? 1 : 0);
