#!/usr/bin/env node
// 本地体验 CLI（activation-04 · 本地 dogfood）。
//
// 这是任务书 §四 的可运行本地体验工具：调用**真实** Memory Atlas（NativeAuthority
// + createMemoryService + RetrievalCoordinator，worktree 根逐字 master 4f112f2）
// 与**真实** glm-retrieval SearchAdapter（ATLAS_GLM_MODULE，只读导入），不是静态
// 假数据排序器。全部数据为本地合成（不连接真实私人聊天）。
//
// 运行：
//   node cli/dogfood.mjs                      # 交互模式（工作区 .dogfood/）
//   node cli/dogfood.mjs --demo               # 脚本化全流程演示（写解释 JSON）
//   node cli/dogfood.mjs --replay-check       # 独立进程：重放事件账本并输出状态哈希
//   node cli/dogfood.mjs --workspace <dir>    # 自定义工作区
//
// 红线（与 activation-03/04 一致）：
//   - 查询（query/browse）永不写事件：candidate_retrieved 不强化、影子查询不强化；
//   - 只有 revisit 命令经 Event Bridge 的合法重提准入（surface='user' 且
//     utteranceObserved=true）才产生 user_revisited（唯一强化类）；
//   - deliver 命令只在 deliveryConfirmed=true 时写 delivered_reference（只更新
//     最近投递，永不强化；生成 ≠ 投递）；
//   - 撤回走正式权威（svc.retract），激活状态存在 ≠ 候选复活；
//   - 重启后从 events.jsonl 重放（幂等：eventId / sourceEventId 折叠），结果一致。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXP_ROOT = path.resolve(HERE, '..');
const WORKTREE_ROOT = path.resolve(EXP_ROOT, '..', '..');
const REAL_GLM_MODULE = process.env.ATLAS_GLM_MODULE
  ?? ''; // 实验跑批器：必须经环境变量提供 ATLAS_GLM_MODULE

const DEFAULT_WORKSPACE = path.join(EXP_ROOT, '.dogfood');
const EXPLAIN_DIR = path.join(EXP_ROOT, 'results-v4', 'dogfood-explain');

function toFileUrl(p) {
  return pathToFileURL(path.isAbsolute(p) ? p : path.resolve(p)).href;
}
function sha256(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
const DAY_MS = 86_400_000;

// —— 真实模块加载（与 activation-03 real-harness 相同的接线，工作区持久化）——
async function openWorkspace(workspaceDir) {
  process.env.ATLAS_GLM_MODULE = REAL_GLM_MODULE;
  fs.mkdirSync(workspaceDir, { recursive: true });
  const atlasDir = path.join(workspaceDir, 'atlas');
  const eventsPath = path.join(workspaceDir, 'events.jsonl');
  const metaPath = path.join(workspaceDir, 'state.json');

  const serviceModule = await import(toFileUrl(path.join(WORKTREE_ROOT, 'src', 'service.js')));
  const factory = await import(toFileUrl(path.join(WORKTREE_ROOT, 'adapters', 'glm-retrieval.mjs')));
  const engine = await factory.createRetrievalAdapter({ dataDir: atlasDir });

  const authority = new serviceModule.NativeAuthority({ dataDir: atlasDir });
  const svc = serviceModule.createMemoryService({
    authority, retrieval: engine, derivedCacheDir: path.join(atlasDir, 'derived-cache')
  });

  // —— 事件账本：持久化 JSONL + 幂等重放（activation-01 EventLog / replayEvents）——
  const { EventLog, replayEvents } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-01', 'src', 'events.mjs')));
  const { createEventBridge, LIFECYCLE_KINDS } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-03', 'src', 'event-bridge.mjs')));
  const { createEventIdFactory } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-02', 'src', 'event-ids.mjs')));

  const log = new EventLog();
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)) {
      const outcome = log.recordEvent(JSON.parse(line));
      if (outcome.status === 'rejected') throw new Error(`事件账本损坏（${outcome.reason}）：${line}`);
    }
  }
  const bridge = createEventBridge({
    log, ids: createEventIdFactory({ prefix: 'dogfood' }), now: () => Date.now()
  });

  function stateHash() {
    const state = replayEvents(log.events());
    const canonical = [...state.entries()]
      .map(([key, v]) => ({ key, revisits: v.reinforceTimesMs, lastDeliveryMs: v.lastDeliveryMs }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    return sha256(canonical);
  }

  function appendEventLine(event) {
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
  }

  return {
    workspaceDir, svc, engine, bridge, log, metaPath, stateHash: stateHash,
    LIFECYCLE_KINDS,
    async ensureSpace(spaceId) {
      const listed = authority.listSpaces();
      const known = listed.available && listed.spaceIds.includes(spaceId);
      if (!known) await svc.createSpace({ spaceId });
      return spaceId;
    },
    async observe(lifecycle) {
      const result = bridge.observe(lifecycle);
      if (result.eventRecorded) {
        const events = log.events();
        appendEventLine(events[events.length - 1]);
      }
      return result;
    },
    close() {
      authority.close();
      if (typeof engine.close === 'function') engine.close();
    }
  };
}

// —— 候选获取（真实 coordinator 路径，一次取齐；查询不写任何事件）——
async function fetchCandidates(ws, spaceId, options) {
  const response = await ws.svc.search({ spaceId, limit: 50, ...options });
  const candidates = (response.records ?? []).map((record, position) => ({
    recordId: record.recordId,
    spaceId,
    position,
    a0Score: record.score ?? null,
    coverage: record.coverage ?? null,
    matchReason: Array.isArray(record.matchReason) ? record.matchReason : null,
    content: record.content ?? '',
    occurredAt: record.occurredAt ?? null,
    status: record.status,
    kind: record.kind
  }));
  return { response, candidates };
}

// —— 五策略并排（归因策略复用；同一候选集）——
async function rankWithStrategies(ws, spaceId, options, nowMs = Date.now()) {
  const { classifyEvidencePath } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-03', 'src', 'evidence.mjs')));
  const { rankA0V4, rankL, rankR, rankLR, rankD } = await import(toFileUrl(path.join(EXP_ROOT, 'src', 'attribution-strategies.mjs')));
  const { replayEvents } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-01', 'src', 'events.mjs')));
  const { termsForQuery, tokenizeForIndex } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-01', 'src', 'tokenizer.mjs')));

  const { response, candidates } = await fetchCandidates(ws, spaceId, options);
  const query = options.query ?? null;
  const mode = query ? 'explicit' : 'ambient';
  const queryTerms = query ? termsForQuery(query) : [];
  const collapsedQuery = query ? String(query).normalize('NFC').toLowerCase().replace(/\s+/g, '') : '';

  const inspected = ws.svc.authority.inspect(spaceId);
  const scope = { df: new Map(), scopeDocCount: 0 };
  if (inspected.available) {
    const statuses = inspected.validity.statuses;
    for (const rec of inspected.spaceDoc.records) {
      if ((rec.kind !== 'experience' && rec.kind !== 'correction') || statuses.get(rec.recordId) !== 'active') continue;
      scope.scopeDocCount += 1;
      for (const t of tokenizeForIndex(rec.content ?? '')) scope.df.set(t, (scope.df.get(t) ?? 0) + 1);
    }
  }
  for (const c of candidates) {
    c.evidenceClass = classifyEvidencePath({ matchReason: c.matchReason, coverage: c.coverage });
  }
  const state = replayEvents(ws.log.events());
  const common = {
    candidates, mode, state, now: nowMs, queryTerms, collapsedQuery,
    scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
  };
  const results = {
    A0: rankA0V4({ candidates }),
    L: rankL(common),
    R: rankR(common),
    LR: rankLR(common),
    D: rankD(common)
  };
  return { response, candidates, queryTerms, collapsedQuery, scope, state, results, mode };
}

// —— 渲染 ——
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
function shortId(id) { return id.length > 22 ? id.slice(0, 21) + '…' : id; }
function shortContent(s, n = 26) {
  s = String(s ?? '');
  return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s;
}
function ageOf(ms, now) {
  if (ms == null) return '—';
  const h = (now - ms) / 3_600_000;
  if (h < 1) return `${Math.max(0, Math.round(h * 60))}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function renderRankings({ candidates, results, state, now, mode, refused }) {
  const strategies = ['A0', 'L', 'R', 'LR', 'D'];
  const rankBy = {};
  for (const s of strategies) {
    const r = results[s];
    rankBy[s] = r.refused ? null : new Map(r.ranked.map((x, i) => [x.recordId, i + 1]));
  }
  const explain = new Map(candidates.map((c) => [c.recordId, c]));
  const header = `  ${pad('recordId', 24)} ${pad('内容', 28)} ${pad('证据', 26)} ${pad('act', 10)} ${pad('投递', 6)} | ${strategies.map((s) => pad(s, 5)).join('')}`;
  const lines = [header, `  ${'-'.repeat(header.length - 2)}`];
  for (const c of candidates) {
    const act = state.get(`${c.spaceId}::${c.recordId}`);
    const g2 = results.R.ranked.find((x) => x.recordId === c.recordId)?.g2
      ?? { multiplier: 1, count: 0 };
    const tierInfo = results.L.ranked.find((x) => x.recordId === c.recordId);
    const tierText = tierInfo ? `T${tierInfo.tier}${tierInfo.phraseHit ? '短语' : tierInfo.idHit ? 'id' : tierInfo.matchedBigrams?.length ? `${tierInfo.matchedBigrams.length}元` : '弱'}` : '—';
    const evidence = `${c.evidenceClass === 'lexical' ? tierText : c.evidenceClass === 'filter-only' ? 'filter' : c.evidenceClass === 'structural-association' ? 'assoc' : 'none'}/${c.a0Score?.toFixed(3) ?? '—'}`;
    const cells = strategies.map((s) => {
      if (rankBy[s] === null) return pad('拒', 4);
      const rank = rankBy[s].get(c.recordId);
      const a0Rank = rankBy.A0.get(c.recordId);
      const delta = a0Rank - rank;
      return pad(rank + (delta > 0 ? `(+${delta})` : delta < 0 ? `(${delta})` : ''), 5);
    }).join('');
    lines.push(`  ${pad(shortId(c.recordId), 24)} ${pad(shortContent(c.content), 28)} ${pad(evidence, 26)} ${pad(g2.multiplier === 1 ? '×1' : `×${g2.multiplier.toFixed(2)}(${g2.count})`, 10)} ${pad(act?.lastDeliveryMs ? ageOf(act.lastDeliveryMs, now) : '—', 6)} | ${cells}`);
  }
  for (const s of strategies) {
    if (refused[s]) lines.push(`  [${s}] 拒用：${refused[s]}`);
  }
  return lines.join('\n');
}

function rankChangeReasons({ results, state, now, mode, candidates }) {
  const notes = [];
  const a0Order = results.A0.ranked.map((r) => r.recordId);
  for (const s of ['L', 'R', 'LR', 'D']) {
    const r = results[s];
    if (r.refused) { notes.push(`${s}: 拒用（${r.fallbackReason}）`); continue; }
    const order = r.ranked.map((x) => x.recordId);
    if (JSON.stringify(order) === JSON.stringify(a0Order)) { notes.push(`${s}: 与 A0 同序`); continue; }
    for (const item of r.ranked) {
      const from = a0Order.indexOf(item.recordId) + 1;
      const to = order.indexOf(item.recordId) + 1;
      if (from === to) continue;
      let why = '';
      if (s === 'R' || s === 'LR') {
        const g2 = item.g2 ?? { multiplier: 1, count: 0 };
        why = g2.multiplier > 1 ? `user_revisited×${g2.count} → g2 乘数 ×${g2.multiplier.toFixed(3)}` : 'g2=1（无强化）';
        if (s === 'LR' && (r.gateMoves ?? []).some((m) => m.recordId === item.recordId)) {
          why += ` + tier 闸门：${(r.gateMoves.find((m) => m.recordId === item.recordId)).reason}`;
        }
        if (s === 'LR' && item.tier !== undefined) why += `（tier=T${item.tier}）`;
      }
      if (s === 'D') {
        const cand = candidates.find((x) => x.recordId === item.recordId);
        const act = cand ? state.get(`${cand.spaceId}::${item.recordId}`) : null;
        why = act?.lastDeliveryMs
          ? `最近投递 ${ageOf(act.lastDeliveryMs, now)} 前 → ${item.suppressed ? 'RecentDelivery 抑制生效' : '抑制窗外，未抑制'}（finalScore ${item.finalScore != null ? Number(item.finalScore).toFixed(3) : '后移表达'}）`
          : '未抑制';
      }
      if (s === 'L') {
        why = `tier=T${item.tier}（${item.tierName}）${item.phraseHit ? '·短语命中' : item.idHit ? '·id命中' : item.matchedBigrams?.length ? `·二元词元 ${item.matchedBigrams.join('/')}` : '·弱匹配'}`;
      }
      notes.push(`${s}: ${shortId(item.recordId)} #${from}→#${to} — ${why}`);
    }
  }
  return notes;
}

// —— 解释 JSON ——
function explainRecord(recordId, ctx) {
  const { candidates, results, state, now, mode, response } = ctx;
  const c = candidates.find((x) => x.recordId === recordId);
  if (!c) return null;
  const act = state.get(`${c.spaceId}::${c.recordId}`);
  const out = {
    recordId,
    generatedAt: new Date().toISOString(),
    searchPath: response.searchPath,
    mode,
    content: c.content,
    occurredAt: c.occurredAt,
    evidence: {
      evidenceClass: c.evidenceClass,
      a0Score: c.a0Score,
      coverage: c.coverage,
      matchReason: c.matchReason,
      L: results.L.ranked.find((x) => x.recordId === recordId) ?? null,
      lexicalTierNote: 'tier=词面证据等级（T0 id-hit / T1 phrase / T2 multi-bigram / T3 bigram+residual / T4 weak）'
    },
    activation: {
      revisitCount: act?.reinforceTimesMs?.length ?? 0,
      revisitTimesIso: (act?.reinforceTimesMs ?? []).map((ms) => new Date(ms).toISOString()),
      g2Multiplier: results.R.ranked.find((x) => x.recordId === recordId)?.g2 ?? null,
      lastDeliveryMs: act?.lastDeliveryMs ?? null,
      lastDeliveryIso: act?.lastDeliveryMs != null ? new Date(act.lastDeliveryMs).toISOString() : null,
      note: '激活只由合法 user_revisited 驱动；查询本身（candidate_retrieved）永不强化'
    },
    rankBy: Object.fromEntries(['A0', 'L', 'R', 'LR', 'D'].map((s) => {
      const r = results[s];
      return [s, r.refused ? 'refused' : r.ranked.findIndex((x) => x.recordId === recordId) + 1];
    }))
  };
  return out;
}

function writeExplain(name, obj) {
  fs.mkdirSync(EXPLAIN_DIR, { recursive: true });
  const p = path.join(EXPLAIN_DIR, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

// —— 一次查询的完整展示 ——
async function doQuery(ws, spaceId, options, label, now) {
  const ctx = await rankWithStrategies(ws, spaceId, options, now);
  const refused = Object.fromEntries(['L', 'R', 'LR', 'D'].map((s) => [s, ctx.results[s].refused ? ctx.results[s].fallbackReason : null]));
  console.error(`\n【${label}】 ${options.query ? `查询「${options.query}」` : '浏览（filter-only）'} · 路径=${ctx.response.searchPath} · 候选=${ctx.candidates.length} · mode=${ctx.mode}`);
  if (ctx.candidates.length === 0) {
    console.error('  （零候选）');
    return ctx;
  }
  console.error(renderRankings({ ...ctx, now, refused }));
  for (const line of rankChangeReasons({ ...ctx, now, candidates: ctx.candidates })) console.error(`  · ${line}`);
  return ctx;
}

// —— demo 种子（任务书 §四 的三类合成示例 + 一个近期弱相关候选）——
const DEMO_SEEDS = [
  { text: '和小周一起看了电影沙丘第二部，全程都在讨论分镜', daysAgo: 45, key: 'movie' },
  { text: '标记了一部想看的科幻电影，周末有空去看', daysAgo: 3, key: 'towatch' },
  { text: '昨天在楼下便利店买了一把透明伞', daysAgo: 1, key: 'yesterday' },
  { text: '答应老陈月底前还书给他，约好周六交接', daysAgo: 90, key: 'commitment' },
  { text: '办公室打印机换过墨盒', daysAgo: 20, key: 'noise' }
];

async function runDemo(ws, spaceId) {
  const now = Date.now();
  console.error(`=== dogfood demo · 工作区 ${ws.workspaceDir} · 空间 ${spaceId} ===`);
  await ws.ensureSpace(spaceId);

  // 1. 写入不同时间的记忆（幂等：state.json 记录已种子化）
  if (!fs.existsSync(ws.metaPath)) {
    const ids = {};
    for (const seed of DEMO_SEEDS) {
      const occurredAt = new Date(now - seed.daysAgo * DAY_MS).toISOString();
      const recordId = `df-${seed.key}`;
      const receipt = await ws.svc.record(spaceId, {
        recordId, kind: 'experience', content: seed.text,
        source: { kind: 'chat', id: `src-${recordId}` }, occurredAt
      });
      ids[seed.key] = receipt.recordId ?? recordId;
      console.error(`  + 写入 ${recordId}（${seed.daysAgo} 天前）→ ${receipt.accepted ? 'accepted' : JSON.stringify(receipt)}`);
    }
    fs.writeFileSync(ws.metaPath, JSON.stringify({ spaceId, ids, seededAt: new Date().toISOString() }), 'utf8');
  } else {
    console.error('  种子已存在（state.json）——跳过写入（重启幂等）');
  }
  const ids = JSON.parse(fs.readFileSync(ws.metaPath, 'utf8')).ids;

  // 2. 基线查询（查询不写事件）
  const q1 = await doQuery(ws, spaceId, { query: '电影' }, '基线查询', now);
  writeExplain('query-1-baseline.json', {
    query: '电影',
    rankings: Object.fromEntries(['A0', 'L', 'R', 'LR', 'D'].map((s) => [s, q1.results[s].refused ? 'refused' : q1.results[s].ranked.map((r) => r.recordId)])),
    candidates: q1.candidates.map((c) => ({ recordId: c.recordId, a0Score: c.a0Score, evidenceClass: c.evidenceClass })),
    stateHash: ws.stateHash()
  });

  // 3. 合法重提（经 Event Bridge 准入）：电影被再次提起 ×2
  for (const i of [1, 2]) {
    const outcome = await ws.observe({
      kind: ws.LIFECYCLE_KINDS.USER_REMENTION,
      spaceId, recordId: ids.movie,
      provenance: { surface: 'user', utteranceObserved: true, utterance: '我们之前一起看沙丘来着' }
    });
    console.error(`  + user_revisited(#${i}) → ${outcome.eventRecorded ? `recorded ${outcome.eventId}` : `REJECTED: ${outcome.reason}`}`);
  }
  // 反例：影子式观测（无用户话语）必须被拒
  const rejected = await ws.observe({
    kind: ws.LIFECYCLE_KINDS.INTERNAL_CANDIDATES, spaceId, recordId: ids.movie
  });
  console.error(`  + candidate_retrieved 观测 → eventRecorded=${rejected.eventRecorded}（${rejected.reason ?? 'recorded'}）—— candidate_retrieved 不强化`);

  // 4. 重查：电影应上移（g2 乘数），并打印原因
  const q2 = await doQuery(ws, spaceId, { query: '电影' }, '重提后查询', now);
  writeExplain('query-2-after-revisit.json', {
    query: '电影',
    rankings: Object.fromEntries(['A0', 'L', 'R', 'LR', 'D'].map((s) => [s, q2.results[s].refused ? 'refused' : q2.results[s].ranked.map((r) => r.recordId)])),
    movieExplain: explainRecord(ids.movie, q2),
    stateHash: ws.stateHash(),
    note: '与 query-1-baseline.json 对比 = 事件前后排序变化示例（LR/R 上移电影，A0/L 不变）'
  });

  // 5. 投递 + 浏览（ambient）：D 应抑制刚投递的电影
  const delivered = await ws.observe({
    kind: ws.LIFECYCLE_KINDS.DELIVERY_ACK, spaceId, recordId: ids.movie,
    provenance: { deliveryConfirmed: true }
  });
  console.error(`  + delivered_reference → ${delivered.eventRecorded ? 'recorded' : `REJECTED: ${delivered.reason}`}（只更新最近投递，永不强化）`);
  const since = new Date(now - 120 * DAY_MS).toISOString();
  await doQuery(ws, spaceId, { since, timeField: 'occurredAt' }, '浏览（最近 120 天，filter-only）', now);
  writeExplain('browse-after-delivery.json', {
    since,
    note: 'D（RecentDelivery 抑制）只在此类 ambient 浏览生效；explicit 追问恒绕过',
    stateHash: ws.stateHash()
  });

  // 6. 撤回"昨天的小事"并验证不再是有效事实（幂等：已撤回则跳过）
  const validityNow = ws.svc.authority.inspect(spaceId).validity.statuses;
  if (validityNow.get(ids.yesterday) !== 'retracted') {
    const retr = await ws.svc.retract(spaceId, {
      aboutRecordId: ids.yesterday, content: '伞已经找到，撤回', operationId: `df-retr-${Date.now()}`
    });
    console.error(`  + retract(${ids.yesterday}) → ${retr.accepted ? 'accepted' : JSON.stringify(retr)}`);
  } else {
    console.error(`  + retract(${ids.yesterday}) 已在先前会话完成（重启幂等）——跳过`);
  }
  const q3 = await doQuery(ws, spaceId, { query: '便利店 透明伞' }, '撤回后关键词查询（预期零候选）', now);
  const q3b = await doQuery(ws, spaceId, { since: new Date(now - 120 * DAY_MS).toISOString(), timeField: 'occurredAt' }, '撤回后浏览（全窗，强断言）', now);
  const stillThere = q3.candidates.some((c) => c.recordId === ids.yesterday)
    || q3b.candidates.some((c) => c.recordId === ids.yesterday);
  console.error(`  ${stillThere ? '✗ 失败：撤回记录仍可达' : '✓ 撤回记录不再作为有效事实（关键词与浏览两条路径均结构性缺席）'}`);
  writeExplain('query-3-after-retract.json', {
    query: '便利店 透明伞',
    browseCandidates: q3b.candidates.map((c) => c.recordId),
    candidateCount: q3.candidates.length,
    retractedRecordPresent: stillThere,
    rankings: Object.fromEntries(['A0', 'L', 'R', 'LR', 'D'].map((s) => [s, q3.results[s].refused ? 'refused' : q3.results[s].ranked.map((r) => r.recordId)])),
    stateHash: ws.stateHash()
  });

  // 7. 事件账本 + 状态哈希（重启重放一致性由 --replay-check 独立进程复核）
  console.error(`\n事件账本：${ws.log.size} 条（events.jsonl）`);
  for (const e of ws.log.events()) {
    console.error(`  ${e.eventId} ${e.eventType} ${shortId(e.recordId)} @ ${e.occurredAt}`);
  }
  const hash = ws.stateHash();
  console.error(`激活状态哈希：${hash}`);
  return hash;
}

async function replayCheck(ws) {
  // 独立重放：从磁盘事件账本重建派生态（幂等：重复 eventId / 同 sourceEventId 折叠）
  const { replayEvents } = await import(toFileUrl(path.join(WORKTREE_ROOT, 'experiments', 'activation-01', 'src', 'events.mjs')));
  const eventsPath = path.join(ws.workspaceDir, 'events.jsonl');
  const raw = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const state = replayEvents(raw);
  const canonical = [...state.entries()]
    .map(([key, v]) => ({ key, revisits: v.reinforceTimesMs, lastDeliveryMs: v.lastDeliveryMs }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const hash = sha256(canonical);
  const summary = {
    events: raw.length,
    uniqueAfterIdempotence: ws.log.size,
    stateHash: hash,
    replayedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(summary));
  return summary;
}

// —— 交互 REPL ——
async function repl(ws, spaceId) {
  console.error(`dogfood CLI · 工作区 ${ws.workspaceDir} · 空间 ${spaceId}`);
  console.error(`命令：add <文本> [--days-ago N] | query <文本> | browse | revisit <id|#名次> | deliver <id|#名次> |`);
  console.error(`      retract <id|#名次> [原因] | explain <id|#名次> | events | replay-check | state | help | exit`);
  console.error('红线：query/browse 永不写事件（candidate_retrieved 不强化）；只有 revisit 是合法强化。');
  const lastQuery = { ctx: null };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'dogfood> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');
    const now = Date.now();
    try {
      if (cmd === 'exit' || cmd === 'quit') { rl.close(); return; }
      else if (cmd === 'help') { console.error('见上方命令列表；<id|#名次> 中的名次指最近一次查询的 A0 名次。'); }
      else if (cmd === 'add') {
        const m = arg.match(/^(.*?)\s*(?:--days-ago\s+(\d+(?:\.\d+)?))?$/);
        const text = m[1];
        const daysAgo = m[2] ? Number(m[2]) : 0;
        const recordId = `df-u-${Date.now()}`;
        const receipt = await ws.svc.record(spaceId, {
          recordId, kind: 'experience', content: text,
          source: { kind: 'chat', id: `src-${recordId}` },
          occurredAt: new Date(now - daysAgo * DAY_MS).toISOString()
        });
        console.error(`+ ${recordId}（${daysAgo} 天前）→ ${receipt.accepted ? 'accepted' : JSON.stringify(receipt)}`);
      }
      else if (cmd === 'query') lastQuery.ctx = await doQuery(ws, spaceId, { query: arg }, '查询', now);
      else if (cmd === 'browse') {
        const since = new Date(now - 120 * DAY_MS).toISOString();
        lastQuery.ctx = await doQuery(ws, spaceId, { since, timeField: 'occurredAt' }, '浏览（最近 120 天）', now);
      }
      else if (cmd === 'revisit' || cmd === 'deliver' || cmd === 'retract') {
        const recordId = await resolveTarget(arg, lastQuery.ctx);
        if (!recordId) { console.error('找不到目标（先 query 一次，或给完整 recordId）'); rl.prompt(); return; }
        if (cmd === 'revisit') {
          const outcome = await ws.observe({
            kind: ws.LIFECYCLE_KINDS.USER_REMENTION, spaceId, recordId,
            provenance: { surface: 'user', utteranceObserved: true, utterance: arg }
          });
          console.error(outcome.eventRecorded ? `+ user_revisited ${outcome.eventId}` : `✗ 拒绝：${outcome.reason}`);
        } else if (cmd === 'deliver') {
          const outcome = await ws.observe({
            kind: ws.LIFECYCLE_KINDS.DELIVERY_ACK, spaceId, recordId,
            provenance: { deliveryConfirmed: true }
          });
          console.error(outcome.eventRecorded ? `+ delivered_reference（只更新最近投递，永不强化）` : `✗ 拒绝：${outcome.reason}`);
        } else {
          const reason = rest.slice(1).join(' ') || '用户撤回';
          const receipt = await ws.svc.retract(spaceId, { aboutRecordId: recordId, content: reason, operationId: `df-retr-${Date.now()}` });
          console.error(receipt.accepted ? `+ retract ${recordId} accepted（激活状态保留，但不再作为有效事实可达）` : `✗ ${JSON.stringify(receipt)}`);
        }
      }
      else if (cmd === 'explain') {
        const recordId = await resolveTarget(arg, lastQuery.ctx);
        const ex = recordId && lastQuery.ctx ? explainRecord(recordId, lastQuery.ctx) : null;
        console.error(ex ? JSON.stringify(ex, null, 2) : '先 query 一次再 explain <id|#A0名次>');
      }
      else if (cmd === 'events') {
        for (const e of ws.log.events()) console.error(`  ${e.eventId} ${e.eventType} ${shortId(e.recordId)} @ ${e.occurredAt}`);
        console.error(`共 ${ws.log.size} 条`);
      }
      else if (cmd === 'replay-check') {
        const s = await replayCheck(ws);
        console.error(`重放一致：账本 ${s.events} 行 → 唯一事件 ${s.uniqueAfterIdempotence} → 状态哈希 ${s.stateHash}`);
      }
      else if (cmd === 'state') {
        console.error(`激活状态哈希 ${ws.stateHash()}；事件 ${ws.log.size} 条`);
      }
      else console.error(`未知命令 ${cmd}（help 查看命令）`);
    } catch (error) {
      console.error(`✗ ${error.message ?? error}`);
    }
    rl.prompt();
  });
  rl.on('close', () => { console.error('bye'); ws.close(); process.exit(0); });
}

async function resolveTarget(arg, ctx) {
  if (!arg) return null;
  const m = arg.match(/^#(\d+)$/);
  if (m && ctx) {
    const rank = Number(m[1]);
    return ctx.results.A0.ranked[rank - 1]?.recordId ?? null;
  }
  return arg;
}

// —— 入口 ——
const args = process.argv.slice(2);
const workspaceArg = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
const spaceArg = args.includes('--space') ? args[args.indexOf('--space') + 1] : 'dogfood';
const ws = await openWorkspace(workspaceArg ?? DEFAULT_WORKSPACE);

if (args.includes('--demo')) {
  const hash = await runDemo(ws, spaceArg);
  ws.close();
  // 独立进程重放复核（真正的"重启"）：新进程从磁盘重放并输出哈希
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--replay-check',
    '--workspace', workspaceArg ?? DEFAULT_WORKSPACE, '--space', spaceArg], { encoding: 'utf8' });
  const second = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  const ok = second.stateHash === hash;
  console.error(`\n=== 重启重放一致性（独立进程）：${ok ? '✓ 一致' : '✗ 不一致'} ===`);
  console.error(`  进程1 哈希 ${hash}`);
  console.error(`  进程2 哈希 ${second.stateHash}（重放 ${second.uniqueAfterIdempotence} 条唯一事件）`);
  writeExplain('replay-check.json', { process1Hash: hash, process2: second, identical: ok });
  process.exit(ok ? 0 : 1);
} else if (args.includes('--replay-check')) {
  await replayCheck(ws);
  ws.close();
} else {
  await repl(ws, spaceArg);
}
