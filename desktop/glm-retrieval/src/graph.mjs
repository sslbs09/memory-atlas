// Memory Atlas · Backend B Graph Projection（图投影）。
//
// 边界（新方向任务书）：
//   - 图是可重建的派生物，不是第二套正式事实权威；本模块不写正式 Experience。
//   - 每条关系必须能解释来源（edge.basis + edge.confidence）。
//   - confidence 只有两种：
//       confirmed   来源明确：来自调用方交付的结构化字段（supersedes / derivedFrom /
//                   mentions / sourceId / sourceSession / explicit_relation）。
//       speculative 推测关联：字段共现 + 时间邻近推断，永远标注“推测”，
//                   不冒充已确认事实或因果关系。
//   - 节点不携带正文（与 SearchAdapter 的候选边界一致）；label 只是 id/名称/时间。
//   - 有界子图查询：neighbors 深度 ≤2、每层有界；timeline 有 limit。
//   - 实例分区：node_key 全部带 instanceId 前缀，跨记忆空间永不连线。

export const NODE_KINDS = ['memory', 'correction', 'entity', 'source_session', 'event'];
export const EDGE_KINDS = ['derived_from', 'supersedes', 'mentions', 'same_source', 'explicit_relation'];

// 复合键分隔符 ':'：适配层校验过的 id 不含冒号；自由文本段（实体名、会话名）
// 一律 encodeURIComponent 转义。禁用 NUL——部分 node:sqlite 绑定（Node 22）
// 会按 C 字符串截断（GPT 验收复现的复合键兼容故障）。
const KEY_SEP = ':';
const enc = (value) => encodeURIComponent(String(value));
const memoryKey = (instanceId, recordId) => `memory${KEY_SEP}${instanceId}${KEY_SEP}${enc(recordId)}`;
const entityKey = (instanceId, name) => `entity${KEY_SEP}${instanceId}${KEY_SEP}${enc(name)}`;
const sessionKey = (instanceId, sid) => `source_session${KEY_SEP}${instanceId}${KEY_SEP}${enc(sid)}`;
const eventKey = (instanceId, eid) => `event${KEY_SEP}${instanceId}${KEY_SEP}${enc(eid)}`;

function decodeKey(key) {
  const [kind, instanceId, ...rest] = key.split(KEY_SEP);
  return { kind, instanceId, localId: rest.map((part) => decodeURIComponent(part)).join(KEY_SEP) };
}

export class GraphProjection {
  #db;
  #store;

  constructor(store) {
    this.#db = store.rawDb;
    this.#store = store;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        node_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        indexed INTEGER NOT NULL DEFAULT 1,
        occurred_at TEXT,
        generation INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_instance ON graph_nodes(instance_id);
      CREATE TABLE IF NOT EXISTS graph_edges (
        edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_key TEXT NOT NULL,
        to_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence TEXT NOT NULL,
        basis TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        UNIQUE (from_key, to_key, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_key);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_key);
    `);
  }

  // 图代际与索引代际统一（单一代际状态，杜绝两套计数漂移）。
  get generation() { return this.#store.indexGeneration; }

  #ensureNode(key, kind, label, instanceId, { indexed = 1, occurredAt = null, generation } = {}) {
    this.#db.prepare(`INSERT INTO graph_nodes (node_key, kind, label, instance_id, indexed, occurred_at, generation)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(node_key) DO UPDATE SET
                        label = excluded.label, indexed = MAX(graph_nodes.indexed, excluded.indexed),
                        occurred_at = COALESCE(excluded.occurred_at, graph_nodes.occurred_at)`)
      .run(key, kind, label, instanceId, indexed, occurredAt, generation);
  }

  #ensureEdge(fromKey, toKey, kind, confidence, basis, instanceId, generation) {
    this.#db.prepare(`INSERT INTO graph_edges (from_key, to_key, kind, confidence, basis, instance_id, generation)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(from_key, to_key, kind) DO UPDATE SET
                        confidence = excluded.confidence, basis = excluded.basis`)
      .run(fromKey, toKey, kind, confidence, basis, instanceId, generation);
  }

  // 由同一条规范化记录流驱动（与 SearchAdapter 相同的输入）。
  upsertRecord(record, { generation = this.generation } = {}) {
    this.#store.transaction(() => {
      const isCorrection = typeof record.supersedes === 'string' && record.supersedes.length > 0;
      const selfKey = memoryKey(record.instanceId, record.recordId);
      this.#ensureNode(selfKey, isCorrection ? 'correction' : 'memory', record.recordId, record.instanceId,
        { occurredAt: record.occurredAt ?? record.acceptedAt, generation });
      if (record.subject) {
        const eKey = entityKey(record.instanceId, record.subject);
        this.#ensureNode(eKey, 'entity', record.subject, record.instanceId, { generation });
        this.#ensureEdge(selfKey, eKey, 'mentions', 'confirmed', 'field:subject', record.instanceId, generation);
      }
      for (const mention of record.mentions ?? []) {
        const eKey = entityKey(record.instanceId, mention);
        this.#ensureNode(eKey, 'entity', mention, record.instanceId, { generation });
        this.#ensureEdge(selfKey, eKey, 'mentions', 'confirmed', 'field:mentions', record.instanceId, generation);
      }
      const sessionId = record.sourceSession ?? record.sourceId;
      if (sessionId) {
        const sKey = sessionKey(record.instanceId, sessionId);
        this.#ensureNode(sKey, 'source_session', String(sessionId), record.instanceId, { generation });
        this.#ensureEdge(selfKey, sKey, 'same_source', 'confirmed', 'field:sourceSession|sourceId', record.instanceId, generation);
      }
      if (record.eventId) {
        const evKey = eventKey(record.instanceId, record.eventId);
        this.#ensureNode(evKey, 'event', String(record.eventId), record.instanceId, { generation });
        this.#ensureEdge(selfKey, evKey, 'derived_from', 'confirmed', 'field:eventId', record.instanceId, generation);
      }
      if (typeof record.derivedFrom === 'string' && record.derivedFrom.length > 0) {
        const fromKey = memoryKey(record.instanceId, record.derivedFrom);
        this.#ensureNode(fromKey, 'memory', record.derivedFrom, record.instanceId, { indexed: 0, generation });
        this.#ensureEdge(selfKey, fromKey, 'derived_from', 'confirmed', 'field:derivedFrom', record.instanceId, generation);
      }
      if (isCorrection) {
        const targetKey = memoryKey(record.instanceId, record.supersedes);
        this.#ensureNode(targetKey, 'memory', record.supersedes, record.instanceId, { indexed: 0, generation });
        this.#ensureEdge(selfKey, targetKey, 'supersedes', 'confirmed', 'field:supersedes', record.instanceId, generation);
      }
      for (const rel of record.relations ?? []) {
        if (typeof rel?.to !== 'string' || !rel.to) continue;
        const toKey = memoryKey(record.instanceId, rel.to);
        this.#ensureNode(toKey, 'memory', rel.to, record.instanceId, { indexed: 0, generation });
        this.#ensureEdge(selfKey, toKey, 'explicit_relation', 'confirmed',
          `caller:explicit_relation${rel.note ? `:${rel.note}` : ''}`, record.instanceId, generation);
      }
    });
  }

  upsertRecords(records) {
    for (const record of records) this.upsertRecord(record);
  }

  // 删除记录节点及其所有出边/入边；共享节点（实体/会话/事件）若还有其他
  // 边引用则保留，否则一并移除。
  removeRecord(instanceId, recordId) {
    this.#store.transaction(() => {
      const selfKey = memoryKey(instanceId, recordId);
      const incident = this.#db.prepare(
        'SELECT from_key, to_key FROM graph_edges WHERE from_key = ? OR to_key = ?').all(selfKey, selfKey);
      this.#db.prepare('DELETE FROM graph_edges WHERE from_key = ? OR to_key = ?').run(selfKey, selfKey);
      this.#db.prepare('DELETE FROM graph_nodes WHERE node_key = ?').run(selfKey);
      const stillReferenced = new Set(this.#db.prepare(
        'SELECT from_key AS k FROM graph_edges UNION SELECT to_key FROM graph_edges').all().map((r) => r.k));
      for (const row of incident) {
        for (const key of [row.from_key, row.to_key]) {
          if (key === selfKey) continue;
          const node = this.#db.prepare('SELECT kind, indexed FROM graph_nodes WHERE node_key = ?').get(key);
          if (!node) continue;
          // 文档投影节点（indexed=1 的 memory/correction）与其记录同生命周期，
          // 由显式删除路径负责；其余节点失去最后一条边即移除。
          const documentBacked = node.indexed === 1 && (node.kind === 'memory' || node.kind === 'correction');
          if (!stillReferenced.has(key) && !documentBacked) {
            this.#db.prepare('DELETE FROM graph_nodes WHERE node_key = ?').run(key);
          }
        }
      }
    });
  }

  // 事务外包装（独立使用时的默认形态）。
  rebuild(records) {
    this.#store.transaction(() => this.rebuildWithin(records));
    return { graphGeneration: this.generation };
  }

  // 事务内重建体：由 SearchAdapter 与索引重建组合进同一事务。
  // 代际跟随 store.indexGeneration（单一代际状态，GPT 验收修复轮要求）。
  rebuildWithin(records, { generation = this.generation } = {}) {
    void generation; // 行级代际由 ensureNode/ensureEdge 的调用链传入('DELETE FROM graph_edges').run();
    this.#db.prepare('DELETE FROM graph_nodes').run();
    for (const record of records) this.upsertRecord(record, { generation });
    return { graphGeneration: generation };
  }

  #nodeRow(key) {
    return this.#db.prepare('SELECT * FROM graph_nodes WHERE node_key = ?').get(key) ?? null;
  }

  #publicNode(row) {
    if (!row) return null;
    // kind 以列值为准（self 节点的 key 统一用 memory 前缀作稳定身份）。
    const { instanceId, localId } = decodeKey(row.node_key);
    return { key: row.node_key, kind: row.kind, instanceId, localId, label: row.label, indexed: row.indexed === 1, occurredAt: row.occurred_at };
  }

  #publicEdge(row) {
    return { from: row.from_key, to: row.to_key, kind: row.kind, confidence: row.confidence, basis: row.basis };
  }

  overview({ instanceId } = {}) {
    const nodesByKind = this.#db.prepare(
      'SELECT kind, COUNT(*) AS n FROM graph_nodes WHERE (? IS NULL OR instance_id = ?) GROUP BY kind').all(instanceId ?? null, instanceId ?? null);
    const edgesByKind = this.#db.prepare(
      'SELECT kind, confidence, COUNT(*) AS n FROM graph_edges WHERE (? IS NULL OR instance_id = ?) GROUP BY kind, confidence').all(instanceId ?? null, instanceId ?? null);
    return {
      graphGeneration: this.generation,
      nodes: nodesByKind.reduce((acc, r) => { acc[r.kind] = r.n; return acc; }, {}),
      totalNodes: nodesByKind.reduce((a, r) => a + r.n, 0),
      edges: edgesByKind.reduce((acc, r) => { acc[`${r.kind}(${r.confidence})`] = r.n; return acc; }, {}),
      totalEdges: edgesByKind.reduce((a, r) => a + r.n, 0),
      speculativeNote: 'overview 只统计来源明确的 confirmed 边；推测关联仅在 neighbors(includeSpeculative) 中按需计算并显式标注'
    };
  }

  // 有界子图：BFS，depth ≤ 2。speculative=true 时叠加“同实体/同时段”推测边，
  // 且每条推测边都带 confidence:'speculative' 与 basis 说明。
  neighbors(recordId, { instanceId, depth = 1, limit = 20, includeSpeculative = false, speculativeWindowDays = 7 } = {}) {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 2) {
      throw Object.assign(new Error('depth 必须在 1~2 之间（有界子图）'), { code: 'GRAPH_DEPTH_INVALID' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw Object.assign(new Error('limit 必须在 1~50 之间（有界子图）'), { code: 'GRAPH_LIMIT_INVALID' });
    }
    const keys = instanceId ? [memoryKey(instanceId, recordId)] : null;
    const centerRows = keys
      ? keys.map((k) => this.#nodeRow(k)).filter(Boolean)
      : this.#db.prepare("SELECT * FROM graph_nodes WHERE node_key LIKE 'memory' || char(0) || '%' || char(0) || ? "
        + "OR (kind IN ('memory','correction') AND label = ?)").all(recordId, recordId);
    if (centerRows.length === 0) {
      return { found: false, center: null, nodes: [], edges: [], note: '图内无此记录节点（该记录可能从未入图或为非 active 投影）' };
    }
    const nodes = new Map();
    const edges = new Map();
    let frontier = centerRows.map((r) => r.node_key);
    for (const row of centerRows) { nodes.set(row.node_key, row); }
    const seenKeys = new Set(frontier);
    for (let d = 0; d < depth; d += 1) {
      const next = [];
      for (const key of frontier) {
        const incident = this.#db.prepare(
          'SELECT * FROM graph_edges WHERE from_key = ? OR to_key = ?').all(key, key);
        for (const edge of incident) {
          const edgeId = `${edge.from_key}->${edge.to_key}:${edge.kind}`;
          if (!edges.has(edgeId)) edges.set(edgeId, edge);
          const other = edge.from_key === key ? edge.to_key : edge.from_key;
          if (!seenKeys.has(other) && nodes.size < limit) {
            seenKeys.add(other);
            const nodeRow = this.#nodeRow(other);
            if (nodeRow) { nodes.set(other, nodeRow); next.push(other); }
          }
        }
        if (nodes.size >= limit) break;
      }
      if (nodes.size >= limit) break;
      frontier = next;
    }
    // 推测关联：仅对返回的实体节点，找同实体其他记录 + 时间邻近。
    if (includeSpeculative) {
      for (const row of [...nodes.values()]) {
        if (row.kind !== 'entity' || nodes.size >= limit) continue;
        const records = this.#db.prepare(
          `SELECT DISTINCT ge.from_key AS key FROM graph_edges ge
           WHERE ge.kind = 'mentions' AND ge.to_key = ?`).all(row.node_key);
        for (const rec of records) {
          if (nodes.size >= limit) break;
          if (nodes.has(rec.key)) continue;
          const recNode = this.#nodeRow(rec.key);
          if (!recNode) continue;
          nodes.set(rec.key, recNode);
          edges.set(`spec->${rec.key}:${row.node_key}`, {
            from_key: row.node_key, to_key: rec.key, kind: 'mentions',
            confidence: 'speculative',
            basis: `speculative:同实体「${row.label}」共现推断，无调用方字段证据；不构成因果或既证关联`
          });
        }
      }
    }
    return {
      found: true,
      graphGeneration: this.generation,
      center: this.#publicNode(centerRows[0]),
      nodes: [...nodes.values()].map((r) => this.#publicNode(r)),
      edges: [...edges.values()].map((e) => this.#publicEdge(e)),
      speculativeIncluded: includeSpeculative === true
    };
  }

  timeline({ instanceId, since, until, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw Object.assign(new Error('limit 必须在 1~200 之间'), { code: 'GRAPH_LIMIT_INVALID' });
    }
    const rows = this.#db.prepare(`SELECT * FROM graph_nodes
      WHERE kind IN ('memory','correction')
        AND (? IS NULL OR instance_id = ?)
        AND occurred_at IS NOT NULL
        AND (? IS NULL OR occurred_at >= ?)
        AND (? IS NULL OR occurred_at <= ?)
      ORDER BY occurred_at DESC LIMIT ?`)
      .all(instanceId ?? null, instanceId ?? null, since ?? null, since ?? null, until ?? null, until ?? null, limit);
    return {
      graphGeneration: this.generation,
      entries: rows.map((r) => ({ ...this.#publicNode(r), correction: r.kind === 'correction' })),
      hasMore: rows.length === limit
    };
  }

  stats({ instanceId } = {}) {
    return this.overview({ instanceId });
  }

  // 图自检：边的两端必须存在节点；节点数与文档投影一致（对 indexed=1 的
  // memory/correction 节点）。损坏或漂移如实报告。
  verify({ documentCount } = {}) {
    const anomalies = [];
    const missing = this.#db.prepare(`SELECT ge.edge_id AS id, ge.from_key AS f, ge.to_key AS t
      FROM graph_edges ge LEFT JOIN graph_nodes a ON a.node_key = ge.from_key
      LEFT JOIN graph_nodes b ON b.node_key = ge.to_key
      WHERE a.node_key IS NULL OR b.node_key IS NULL`).all();
    for (const row of missing) anomalies.push({ kind: 'EDGE_WITH_MISSING_NODE', edgeId: row.id, from: row.f, to: row.t });
    const crossInstance = [];
    for (const row of this.#db.prepare('SELECT edge_id, from_key, to_key FROM graph_edges').all()) {
      const a = decodeKey(row.from_key);
      const b = decodeKey(row.to_key);
      if (a.instanceId !== b.instanceId) {
        crossInstance.push({ kind: 'CROSS_INSTANCE_EDGE', edgeId: row.edge_id, from: row.from_key, to: row.to_key });
      }
    }
    anomalies.push(...crossInstance);
    const counts = this.#db.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE kind IN ('memory','correction') AND indexed = 1").get().n;
    const result = {
      ok: anomalies.length === 0,
      anomalies,
      graphNodes: this.#db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get().n,
      graphEdges: this.#db.prepare('SELECT COUNT(*) AS n FROM graph_edges').get().n,
      indexedRecordNodes: counts,
      graphGeneration: this.generation
    };
    if (documentCount !== undefined) {
      result.indexedRecordNodesMatchesDocuments = counts === documentCount;
      if (!result.indexedRecordNodesMatchesDocuments) {
        anomalies.push({ kind: 'NODE_DOCUMENT_COUNT_MISMATCH', graphNodes: counts, documents: documentCount });
        result.ok = false;
      }
    }
    return result;
  }
}
