// B2 派生索引存储：node:sqlite（Node 24 内置）+ 自建 CJK 倒排。
//
// 边界声明（任务书 B2）：
//   - 本存储是派生索引，不是第二套事实数据库。documents.text 只为分词而保留的
//     投影副本，可随时从正式 Instance 文档全量重建（rebuildIndex）。
//   - 所有 SQL 一律参数绑定，不拼接。
//   - WAL + 事务保证：rebuild 原子提交（中断即回滚，旧代际完好）；每次写入对应
//     真实提交；失败不伪装成功。
//   - 不用 FTS5：unicode61 不切分中文、trigram 无法命中 1~2 字短词；倒排由本
//     模块自建（CJK 一元+二元、ASCII 词元，见 tokenize.mjs）。

import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { tokenizeForIndex } from './tokenize.mjs';

// SCHEMA v2：复合键分隔符由 NUL 改为 ':'。NUL 分隔的 TEXT 键在部分
// node:sqlite 绑定（Node 22 已复现）会按 C 字符串截断，导致复合键兼容性
// 故障。':' 不可能出现在通过适配层校验的 id 中（[A-Za-z0-9._-]*）；
// 自由文本段（如实体名）一律 encodeURIComponent 转义。升版强制旧库重建。
const SCHEMA_VERSION = '2';
export const KEY_SEP = ':';
const REMOVED_STATUSES = new Set(['superseded', 'retracted', 'recorded']);

function docKeyOf(instanceId, recordId) {
  return `${instanceId}${KEY_SEP}${recordId}`;
}

export class IndexStore {
  #db = null;
  #path = null;
  #generation = 0;

  constructor({ path = null } = {}) {
    this.#path = path ?? null; // null → :memory:
  }

  // 打开。数据库文件损坏时抛出带 code 的错误，由调用方决定走 rebuildIndex；
  // 本模块绝不伪造“空索引正常打开”。SQLite 是懒打开：文件损坏往往在首次
  // 语句时才暴露，因此整个打开过程（构造、pragma、建表）都在同一守卫内。
  open() {
    try {
      this.#db = new DatabaseSync(this.#path ?? ':memory:');
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL');
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        doc_key TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        index_generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_kind TEXT,
        source_id TEXT,
        event_id TEXT,
        subject TEXT,
        source_session TEXT,
        occurred_at TEXT,
        accepted_at TEXT,
        text TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        supersedes_target TEXT,
        derived_from TEXT,
        mentions_json TEXT,
        relations_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_documents_instance ON documents(instance_id);
      CREATE TABLE IF NOT EXISTS postings (
        term TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        PRIMARY KEY (term, doc_key)
      );
      CREATE TABLE IF NOT EXISTS removed_ledger (
        doc_key TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        removed_at TEXT NOT NULL,
        index_generation INTEGER NOT NULL
      );
    `);
    const version = this.#getMeta('schemaVersion');
    if (version !== null && version !== SCHEMA_VERSION) {
      const err = new Error(`索引 schema 版本不匹配: 库内 ${version}，代码 ${SCHEMA_VERSION}。请重建索引。`);
      err.code = 'INDEX_SCHEMA_MISMATCH';
      throw err;
    }
    this.#setMeta('schemaVersion', SCHEMA_VERSION);
    const gen = this.#getMeta('indexGeneration');
    this.#generation = gen === null ? 0 : Number(gen);
    } catch (error) {
      this.#db?.close?.();
      this.#db = null;
      // 本模块自己的业务失败（如 schema 不匹配）原样上抛——它们不是
      // "来源不可用"，调用方对两者的处置不同。SQLite 原生错误（带
      // ERR_ 前缀）仍包装为 INDEX_STORE_UNAVAILABLE。
      if (typeof error?.code === 'string' && error.code.startsWith('INDEX_')) throw error;
      const err = new Error(`索引数据库无法打开（不是空索引）: ${error.message}`);
      err.code = 'INDEX_STORE_UNAVAILABLE';
      err.cause = error;
      throw err;
    }
    return this;
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }

  get isOpen() { return this.#db !== null; }
  get indexGeneration() { return this.#generation; }
  // 仅供本模块内的派生投影（如 GraphProjection）在同一个数据库上建自己的表。
  // 不暴露给外部调用方。
  get rawDb() { return this.#db; }

  fileSizeBytes() {
    if (!this.#path) return null;
    try { return statSync(this.#path).size; } catch { return null; }
  }

  #getMeta(key) {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }
  #setMeta(key, value) {
    this.#db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  #txDepth = 0;

  // 手写事务（node:sqlite 没有 transaction 辅助）。支持嵌套：只有最外层
  // BEGIN/COMMIT/ROLLBACK，内层失败沿异常传播给最外层整体回滚。
  transaction(fn) {
    if (this.#txDepth === 0) this.#db.exec('BEGIN');
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#txDepth -= 1;
      if (this.#txDepth === 0) {
        this.#db.exec('COMMIT');
        this.#resyncGeneration();
      }
      return result;
    } catch (error) {
      this.#txDepth -= 1;
      if (this.#txDepth === 0) {
        this.#db.exec('ROLLBACK');
        this.#resyncGeneration();
      }
      throw error;
    }
  }

  // 事务结束（提交或回滚）后，从持久化的 meta 再同步内存代际计数器：
  // 内存在事务中途 +1 而事务被回滚时，计数器必须回到落盘真相。
  #resyncGeneration() {
    const gen = this.#getMeta('indexGeneration');
    if (gen !== null) this.#generation = Number(gen);
  }

  #bumpGeneration() {
    this.#generation += 1;
    this.#setMeta('indexGeneration', this.#generation);
  }

  // 事务内重建应使用的代际：提交时由 transaction() 从 meta 再同步为同一值。
  peekNextGeneration() {
    return this.#generation + 1;
  }

  #termsOf(record) {
    return tokenizeForIndex(record.text ?? '');
  }

  // 增量 upsert（幂等）：同 revision 同内容 → UNCHANGED；更旧 revision → STALE_SKIP；
  // 非 active 状态 → 删除投影并记入 removed_ledger。全部在单事务内提交。
  upsert(record, { indexGeneration = this.#generation } = {}) {
    const key = docKeyOf(record.instanceId, record.recordId);
    const now = new Date().toISOString();
    return this.transaction(() => {
      const existing = this.#db.prepare('SELECT revision, text, status FROM documents WHERE doc_key = ?').get(key);
      if (REMOVED_STATUSES.has(record.status)) {
        this.#deleteProjection(key);
        this.#db.prepare(`INSERT INTO removed_ledger (doc_key, record_id, instance_id, status, removed_at, index_generation)
                          VALUES (?, ?, ?, ?, ?, ?)
                          ON CONFLICT(doc_key) DO UPDATE SET status = excluded.status, removed_at = excluded.removed_at,
                            index_generation = excluded.index_generation`)
          .run(key, record.recordId, record.instanceId, record.status, now, indexGeneration);
        return { outcome: 'PROJECTION_REMOVED', status: record.status };
      }
      if (existing) {
        if (Number(record.revision) < Number(existing.revision)) {
          return { outcome: 'STALE_SKIP' };
        }
        if (Number(record.revision) === Number(existing.revision) && record.text === existing.text
            && record.status === existing.status) {
          return { outcome: 'UNCHANGED' };
        }
        this.#deleteProjection(key);
      }
      this.#db.prepare(`INSERT INTO documents (doc_key, record_id, instance_id, revision, index_generation, status,
                          source_kind, source_id, event_id, subject, source_session, occurred_at, accepted_at, text, indexed_at,
                          supersedes_target, derived_from, mentions_json, relations_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, record.recordId, record.instanceId, Number(record.revision), indexGeneration, record.status,
          record.sourceKind ?? null, record.sourceId ?? null, record.eventId ?? null, record.subject ?? null,
          record.sourceSession ?? null, record.occurredAt ?? null, record.acceptedAt ?? null,
          record.text ?? '', now,
          record.supersedes ?? null, record.derivedFrom ?? null,
          record.mentions ? JSON.stringify(record.mentions) : null,
          record.relations ? JSON.stringify(record.relations) : null);
      const insertPosting = this.#db.prepare('INSERT OR IGNORE INTO postings (term, doc_key) VALUES (?, ?)');
      for (const term of this.#termsOf(record)) insertPosting.run(term, key);
      return { outcome: 'INDEXED' };
    });
  }

  // 批量 upsert：全部成功或全部回滚（单事务）。
  upsertMany(records, options = {}) {
    const results = [];
    this.transaction(() => {
      for (const record of records) results.push(this.upsert(record, options));
    });
    return results;
  }

  #deleteProjection(key) {
    this.#db.prepare('DELETE FROM documents WHERE doc_key = ?').run(key);
    this.#db.prepare('DELETE FROM postings WHERE doc_key = ?').run(key);
  }

  removeRecords(ids, { indexGeneration = this.#generation } = {}) {
    const removed = [];
    this.transaction(() => {
      for (const id of ids) {
        const instanceId = id.instanceId;
        const recordId = id.recordId ?? id;
        if (instanceId === undefined) {
          const rows = this.#db.prepare('SELECT instance_id, record_id FROM documents WHERE record_id = ?').all(recordId);
          for (const row of rows) this.#removeOne(row.instance_id, row.record_id, indexGeneration);
          removed.push(...rows.map((r) => ({ instanceId: r.instance_id, recordId: r.record_id })));
        } else {
          const key = docKeyOf(instanceId, recordId);
          const existed = this.#db.prepare('SELECT 1 AS x FROM documents WHERE doc_key = ?').get(key);
          this.#removeOne(instanceId, recordId, indexGeneration);
          if (existed) removed.push({ instanceId, recordId });
        }
      }
    });
    return removed;
  }

  #removeOne(instanceId, recordId, indexGeneration) {
    const key = docKeyOf(instanceId, recordId);
    const row = this.#db.prepare('SELECT status FROM documents WHERE doc_key = ?').get(key);
    this.#deleteProjection(key);
    if (row) {
      this.#db.prepare(`INSERT INTO removed_ledger (doc_key, record_id, instance_id, status, removed_at, index_generation)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(doc_key) DO UPDATE SET status = excluded.status, removed_at = excluded.removed_at,
                          index_generation = excluded.index_generation`)
        .run(key, recordId, instanceId, row.status ?? 'removed', new Date().toISOString(), indexGeneration);
    }
  }

  // 候选收集：按词元倒排求交（最小集合优先），再按过滤条件裁剪。
  // 返回的是“证据行”，排序与打分由 adapter 负责（职责分离）。
  collectCandidates({ terms, instanceIds, since, until, sourceKind, sourceId, sourceSession, subject, types }) {
    let keys = null;
    for (const { term, kind } of terms) {
      const rows = instanceIds.length === 1
        ? this.#db.prepare(`SELECT p.doc_key AS doc_key FROM postings p
                            JOIN documents d ON d.doc_key = p.doc_key
                            WHERE p.term = ? AND d.instance_id = ?`).all(term, instanceIds[0])
        : this.#db.prepare(`SELECT p.doc_key AS doc_key FROM postings p
                            JOIN documents d ON d.doc_key = p.doc_key
                            WHERE p.term = ? AND d.instance_id IN (${instanceIds.map(() => '?').join(',')})`)
            .all(term, ...instanceIds);
      const set = new Set(rows.map((r) => r.doc_key));
      if (set.size === 0) return { docKeys: [], rows: [], matchedTerms: [] };
      keys = keys === null ? set : new Set([...keys].filter((k) => set.has(k)));
      if (keys.size === 0) return { docKeys: [], rows: [], matchedTerms: [{ term, kind }] };
    }
    // 无词元查询（纯过滤浏览）→ 从 documents 直接取
    let candidates;
    if (keys === null) {
      const filters = [];
      const params = [];
      if (instanceIds.length === 1) { filters.push('instance_id = ?'); params.push(instanceIds[0]); }
      else if (instanceIds.length > 1) { filters.push(`instance_id IN (${instanceIds.map(() => '?').join(',')})`); params.push(...instanceIds); }
      if (sourceKind !== undefined) { filters.push('source_kind = ?'); params.push(sourceKind); }
      if (sourceId !== undefined) { filters.push('source_id = ?'); params.push(sourceId); }
      if (sourceSession !== undefined) { filters.push('source_session = ?'); params.push(sourceSession); }
      if (subject !== undefined) { filters.push('subject = ?'); params.push(subject); }
      if (types?.length) { filters.push(`source_kind IN (${types.map(() => '?').join(',')})`); params.push(...types); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      candidates = this.#db.prepare(`SELECT * FROM documents ${where}`).all(...params);
      candidates = candidates.filter((d) => this.#inTimeRange(d, since, until));
      return { docKeys: candidates.map((d) => d.doc_key), rows: candidates, matchedTerms: [] };
    }
    const rows = [];
    const selectDoc = this.#db.prepare('SELECT * FROM documents WHERE doc_key = ?');
    for (const key of keys) {
      const doc = selectDoc.get(key);
      if (!doc) continue;
      if (sourceKind !== undefined && doc.source_kind !== sourceKind) continue;
      if (sourceId !== undefined && doc.source_id !== sourceId) continue;
      if (sourceSession !== undefined && doc.source_session !== sourceSession) continue;
      if (subject !== undefined && doc.subject !== subject) continue;
      if (types?.length && !types.includes(doc.source_kind)) continue;
      if (!this.#inTimeRange(doc, since, until)) continue;
      rows.push(doc);
    }
    return { docKeys: [...keys], rows, matchedTerms: terms };
  }

  #inTimeRange(doc, since, until) {
    const at = doc.occurred_at ?? doc.accepted_at ?? null;
    if (since !== undefined && (at === null || at < since)) return false;
    if (until !== undefined && (at === null || at > until)) return false;
    return true;
  }

  getDoc(key) {
    return this.#db.prepare('SELECT * FROM documents WHERE doc_key = ?').get(key) ?? null;
  }

  allDocuments() {
    return this.#db.prepare('SELECT * FROM documents').all();
  }

  getByRecordId(recordId) {
    return this.#db.prepare('SELECT * FROM documents WHERE record_id = ?').all(recordId);
  }

  bySubject(instanceId, subject, { excludeKey = null, limit = 10 } = {}) {
    return this.#db.prepare(`SELECT * FROM documents
      WHERE instance_id = ? AND subject = ? AND doc_key != ?
      ORDER BY COALESCE(occurred_at, accepted_at) DESC LIMIT ?`)
      .all(instanceId, subject, excludeKey ?? '', limit);
  }

  bySourceSession(instanceId, sourceSession, { excludeKey = null, limit = 10 } = {}) {
    return this.#db.prepare(`SELECT * FROM documents
      WHERE instance_id = ? AND source_session = ? AND doc_key != ?
      ORDER BY COALESCE(occurred_at, accepted_at) DESC LIMIT ?`)
      .all(instanceId, sourceSession, excludeKey ?? '', limit);
  }

  docKey(instanceId, recordId) { return docKeyOf(instanceId, recordId); }

  // 全量重建：单事务内清空并写入，代际 +1。任何一步抛错 → 整体回滚，
  // 旧代际保持完好可查（onBeforeCommit 钩子仅供故障注入测试）。
  rebuild(records, { onBeforeCommit } = {}) {
    return this.transaction(() => this.rebuildWithin(records, { onBeforeCommit }));
  }

  // 事务内重建体：供 SearchAdapter 将索引重建与图重建组合进同一个事务。
  // 调用方必须已经处于事务中（或接受无原子性）。内存代际计数器在事务
  // 结束（提交或回滚）时由 transaction() 从落盘 meta 再同步。
  rebuildWithin(records, { onBeforeCommit, generation = this.#generation + 1 } = {}) {
    this.#db.prepare('DELETE FROM documents').run();
    this.#db.prepare('DELETE FROM postings').run();
    this.#db.prepare('DELETE FROM removed_ledger').run();
    this.#setMeta('indexGeneration', generation);
    const results = this.upsertMany(records, { indexGeneration: generation });
    onBeforeCommit?.();
    return results;
  }

  // 索引自检：SQLite 完整性 + 倒排与文档逐条互证（全文重算词元比对）。
  verify() {
    const anomalies = [];
    const integrity = this.#db.prepare('PRAGMA integrity_check').get();
    if (integrity && integrity.integrity_check && integrity.integrity_check !== 'ok') {
      anomalies.push({ kind: 'SQLITE_INTEGRITY', detail: integrity.integrity_check });
    }
    const docs = this.#db.prepare('SELECT * FROM documents').all();
    const postingRows = this.#db.prepare('SELECT term, doc_key FROM postings').all();
    const postingsByDoc = new Map();
    for (const row of postingRows) {
      if (!postingsByDoc.has(row.doc_key)) postingsByDoc.set(row.doc_key, new Set());
      postingsByDoc.get(row.doc_key).add(row.term);
    }
    for (const doc of docs) {
      const expected = this.#termsOf(doc);
      const actual = postingsByDoc.get(doc.doc_key) ?? new Set();
      for (const term of expected) {
        if (!actual.has(term)) anomalies.push({ kind: 'MISSING_POSTING', docKey: doc.doc_key, term });
      }
      for (const term of actual) {
        if (!expected.has(term)) anomalies.push({ kind: 'ORPHAN_POSTING', docKey: doc.doc_key, term });
      }
      postingsByDoc.delete(doc.doc_key);
    }
    for (const [docKey] of postingsByDoc) {
      anomalies.push({ kind: 'POSTINGS_WITHOUT_DOCUMENT', docKey });
    }
    const orphans = this.#db.prepare(`SELECT p.doc_key AS doc_key FROM postings p
      LEFT JOIN documents d ON d.doc_key = p.doc_key WHERE d.doc_key IS NULL`).all();
    for (const row of orphans) anomalies.push({ kind: 'POSTINGS_WITHOUT_DOCUMENT', docKey: row.doc_key });
    return {
      ok: anomalies.length === 0,
      anomalies,
      checkedDocuments: docs.length,
      checkedPostings: postingRows.length
    };
  }

  stats() {
    const documents = this.#db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
    const postings = this.#db.prepare('SELECT COUNT(*) AS n FROM postings').get().n;
    const distinctTerms = this.#db.prepare('SELECT COUNT(DISTINCT term) AS n FROM postings').get().n;
    const removed = this.#db.prepare('SELECT COUNT(*) AS n FROM removed_ledger').get().n;
    const perInstance = this.#db.prepare(
      'SELECT instance_id AS instanceId, COUNT(*) AS documents FROM documents GROUP BY instance_id ORDER BY instanceId').all();
    const byStatus = this.#db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all()
      .reduce((acc, row) => { acc[row.status] = row.n; return acc; }, {});
    return {
      documents, postings, distinctTerms, removedLedger: removed,
      perInstance, byStatus,
      indexGeneration: this.#generation,
      schemaVersion: SCHEMA_VERSION,
      fileSizeBytes: this.fileSizeBytes()
    };
  }
}
