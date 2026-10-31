// 真实候选路径 harness（activation-03）。
//
// 唯一目的：让影子评价运行在**真实生产代码**上，而不是 activation-01/02 的
// 实验候选池上。三条路径的接线方式全部照抄生产接线：
//
//   A. explicit 关键词检索
//      Atlas NativeAuthority + createMemoryService + RetrievalCoordinator
//      （src/service.js / src/retrieval.js，worktree 根 = master 4f112f2 逐字）
//      + adapters/glm-retrieval.mjs 工厂 + 真 glm-retrieval SearchAdapter
//      （<WhiteMoon repo>/work/universal-memory-v0.1\glm-retrieval\src\adapter.mjs，
//       生产 ATLAS_GLM_MODULE 指向的同一个文件，只读导入）。
//      候选 = coordinator.search() 的返回顺序（生产 A0 排序原样）。
//
//   B. ambient 结构关联（association.mjs）
//      生产中**没有任何调用方**：Atlas 的 buildRetrievalRequest 与 Host 的
//      buildAdapterRequest 都不设置 associate=true，且 Atlas 的 projectRecord
//      不投影 subject/sourceSession（association 的全部输入字段）。因此路径 B
//      只能以「索引引擎自身的 DTO 能力」为被测对象：直接驱动真 SearchAdapter
//      （upsertRecords 带 subject/sourceSession —— whitemoon-sync.mjs 交付的字段
//       形状；searchCandidates({ associate: true })）。
//      这一条在报告里明确标注为“休眠路径的影子探测”，不是生产调用路径。
//
//   C. Atlas 权威扫描回退
//      同一条 coordinator，把 retrieval 引擎换成 null（NOT_WIRED）或
//      searchCandidates 恒抛错的包装（ADAPTER_FAILED），回退答案由生产
//      querySpace 产生（无 score / 无 matchReason，sequence 降序）。
//
// 红线（activation-03 任务书 §三）：
//   - 相同查询只取一次候选集，三条策略共用；
//   - 影子运行不向任何正式事件账本写入；
//   - candidate_retrieved 永不记作 user_revisited，未真实投递永不写
//     delivered_reference —— 本模块根本不构造事件，事件只来自 fixtures
//     的场景剧本，由 event-bridge.test 单独验证。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKTREE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/(?=[A-Za-z]:)/, ''), '..', '..', '..');

export const REAL_GLM_MODULE = process.env.ATLAS_GLM_MODULE
  ?? '<WhiteMoon repo>/work/universal-memory-v0.1/glm-retrieval/src/adapter.mjs';

function toFileUrl(p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  return pathToFileURL(abs).href;
}

export async function loadAtlasModules(root = WORKTREE_ROOT) {
  const service = await import(toFileUrl(path.join(root, 'src', 'service.js')));
  const retrieval = await import(toFileUrl(path.join(root, 'src', 'retrieval.js')));
  return { service, retrieval };
}

export const PATH_A = 'explicit-index';
export const PATH_B = 'ambient-association';
export const PATH_C = 'authoritative-scan-fallback';

export const PATH_LABELS = Object.freeze({
  [PATH_A]: 'A · explicit 关键词检索（Atlas coordinator + 真 GLM 索引）',
  [PATH_B]: 'B · ambient 结构关联（association.mjs，生产休眠路径的影子探测）',
  [PATH_C]: 'C · Atlas 权威扫描回退（querySpace，无索引）'
});

// 一个场景空间的完整接线。每个场景独立 dataDir / 独立索引文件，互不污染。
// records 里每条可用 spaceId 覆写所属空间（跨空间隔离场景用）。
export async function createPathAHarness({
  spaceId, records = [], engineMode = 'glm', indexDir
} = {}) {
  process.env.ATLAS_GLM_MODULE = REAL_GLM_MODULE;
  const { service } = await loadAtlasModules();
  fs.mkdirSync(indexDir, { recursive: true });

  let engine = null;
  if (engineMode === 'glm') {
    const factory = await import(toFileUrl(path.join(WORKTREE_ROOT, 'adapters', 'glm-retrieval.mjs')));
    engine = await factory.createRetrievalAdapter({ dataDir: indexDir });
  } else if (engineMode === 'broken') {
    // ADAPTER_FAILED 路径：一个“存在但检索时抛错”的适配器——与生产故障注入
    // 形状一致（coordinator 走 scan(fault) 回退分支）。
    engine = {
      name: 'broken-glm',
      async searchCandidates() { throw Object.assign(new Error('injected index failure'), { code: 'SEARCH_ADAPTER_FAILED' }); },
      async upsertRecords() { return []; },
      async removeRecords() { return []; },
      get indexGeneration() { return 0; },
      get isOpen() { return false; },
      close() {}
    };
  } // 'none' → engine = null（NOT_WIRED）

  const authority = new service.NativeAuthority({ dataDir: indexDir });
  const spaceIds = [...new Set([spaceId, ...records.map((r) => r.spaceId).filter(Boolean)])];
  for (const sid of spaceIds) await authority.createSpace({ spaceId: sid });
  const svc = service.createMemoryService({
    authority, retrieval: engine, derivedCacheDir: path.join(indexDir, 'derived-cache')
  });

  const createdIds = new Map(); // key → recordId（control 记录的派生 id 由回执确定）
  for (const rec of records) {
    const sid = rec.spaceId ?? spaceId;
    if (rec.controlAction === 'retract') {
      const receipt = await svc.retract(sid, {
        aboutRecordId: rec.aboutRecordId,
        content: rec.content ?? '撤回',
        operationId: rec.operationId
      });
      if (rec.key) createdIds.set(rec.key, receipt.recordId);
    } else if (rec.controlAction === 'correct') {
      const receipt = await svc.correct(sid, {
        aboutRecordId: rec.aboutRecordId,
        content: rec.content,
        operationId: rec.operationId
      });
      if (rec.key) createdIds.set(rec.key, receipt.recordId);
    } else {
      await svc.record(sid, {
        recordId: rec.recordId,
        kind: rec.kind ?? 'experience',
        content: rec.content,
        source: rec.source ?? { kind: 'chat', id: `src-${rec.recordId}` },
        occurredAt: rec.occurredAt
      });
      if (rec.key) createdIds.set(rec.key, rec.recordId);
    }
  }

  let closed = false;
  return {
    spaceId,
    engineMode,
    svc,
    createdIds,
    async query(options = {}) {
      if (closed) throw new Error('harness closed');
      const result = await svc.search({ spaceId, ...options });
      return normalizeCoordinatorResult(result, { spaceId, query: options.query ?? null, path: PATH_A, engineMode });
    },
    close() {
      closed = true;
      if (engine && typeof engine.close === 'function') engine.close();
    }
  };
}

// coordinator 响应 → 影子候选集（一次取齐，三策略共用；不做任何成员增删）。
function normalizeCoordinatorResult(result, { spaceId, query, path, engineMode }) {
  const searchPath = result.searchPath;
  const indexState = result.index?.state ?? null;
  const fellBack = Boolean(result.index?.fellBack) || searchPath === 'atlas-authoritative-scan';
  const candidates = (result.records ?? []).map((record, position) => ({
    recordId: record.recordId,
    spaceId,
    position,                        // 生产 A0 顺序（coordinator 返回顺序）
    a0Score: record.score ?? null,   // 索引路径的原生分；scan 路径无
    coverage: record.coverage ?? null,
    matchReason: Array.isArray(record.matchReason) ? record.matchReason : null,
    content: record.content ?? '',
    occurredAt: record.occurredAt ?? null,
    sequence: record.sequence ?? null,
    status: record.status,
    kind: record.kind
  }));
  return {
    pathLabel: fellBack && path === PATH_A ? PATH_C : path,
    searchPath,
    indexState,
    engineMode,
    query,
    revision: result.revision,
    outcome: result.outcome,
    candidates,                      // A0 排序原样
    indexReport: result.index ?? null
  };
}

// 路径 B：直接驱动真 SearchAdapter 的 DTO 关联能力（见文件头说明）。
// records 可带 spaceId 覆写所属实例（跨空间关联隔离场景）。
export async function createPathBHarness({ spaceId, records = [], indexDir, situation }) {
  process.env.ATLAS_GLM_MODULE = REAL_GLM_MODULE;
  fs.mkdirSync(indexDir, { recursive: true });
  const factory = await import(toFileUrl(path.join(WORKTREE_ROOT, 'adapters', 'glm-retrieval.mjs')));
  const engine = await factory.createRetrievalAdapter({ dataDir: indexDir });

  // whitemoon-sync.mjs 的字段形状：text/status/subject/sourceSession/occurredAt/acceptedAt。
  const projections = records
    .filter((r) => r.status !== 'retracted')
    .map((rec, i) => ({
      recordId: rec.recordId,
      instanceId: rec.spaceId ?? spaceId,
      revision: i + 1,
      text: rec.content,
      status: rec.status ?? 'active',
      sourceKind: rec.source?.kind ?? 'chat',
      sourceId: rec.source?.id ?? `src-${rec.recordId}`,
      sourceSession: rec.sourceSession ?? rec.source?.id ?? `sess-${i}`,
      subject: rec.subject ?? null,
      occurredAt: rec.occurredAt ?? null,
      acceptedAt: rec.acceptedAt ?? rec.occurredAt ?? null
    }));
  engine.upsertRecords(projections);

  // 关联锚点：生产语义是「以当前情境/最近命中为锚」；影子以情境词元查询得到
  // 的 top3 作为锚（adapter.mjs:262-264 的生产形状）。
  const terms = situation ?? '';
  let payload;
  try {
    payload = engine.searchCandidates({
      instanceId: spaceId, q: terms, limit: 50, associate: true
    });
  } catch (error) {
    if (error && error.code === 'SEARCH_EMPTY_QUERY') payload = null;
    else throw error;
  }

  const candidates = (payload?.candidates ?? []).map((candidate, position) => ({
    recordId: candidate.recordId,
    spaceId,
    position,
    a0Score: candidate.score ?? null,
    coverage: candidate.coverage ?? null,
    matchReason: Array.isArray(candidate.matchReason) ? candidate.matchReason : null,
    content: records.find((r) => r.recordId === candidate.recordId)?.content ?? '',
    occurredAt: candidate.occurredAt ?? null,
    status: candidate.status ?? 'active',
    kind: 'experience'
  }));

  return {
    spaceId,
    pathLabel: PATH_B,
    searchPath: 'glm-adapter-associate-direct',
    indexState: payload?.indexState ?? 'READY',
    engineMode: 'glm-associate',
    query: terms,
    outcome: candidates.length > 0 ? 'MATCHED' : 'NO_MATCH',
    candidates,
    indexReport: {
      note: '真 SearchAdapter associate=true 直连；生产（Atlas/Host）无调用方、Atlas 投影不传 subject/sourceSession',
      associationCandidates: candidates.filter((c) => (c.matchReason ?? []).some((m) => String(m).startsWith('association:'))).length
    },
    close: () => engine.close()
  };
}

// 便捷：临时索引目录。
export function makeTempDir(prefix) {
  const base = path.join(WORKTREE_ROOT, 'experiments', 'activation-03', '.tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}
