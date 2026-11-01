/**
 * harness/atlas-map.js — Atlas 响应 → 渲染层契约的映射（纯函数，可单测）
 *
 * 渲染层（memory-workbench.js / memory-universe.js）只认识一套形状，那套形状
 * 原本是照 WhiteMoon Host 的返回定的。Atlas 的字段名不同（kind/content/source/
 * sequence/recordedAt/spaceId），所以映射必须集中在这一个文件里，并且：
 *
 *   - 不改写语义：Atlas 说 NOT_WIRED 就传 NOT_WIRED，绝不翻成 NOT_REQUIRED；
 *   - 不补字段：Atlas 没有的（聊天转写、派生索引）就标成"此模式不提供"；
 *   - 冲突就是冲突：Atlas 的 409 映射成渲染层认识的 CONTROL_CONFLICT，
 *     不会被抹平成"写入失败"，更不会变成成功。
 *
 * Alpha-01 来源：逐字复制自 ds-ui src/harness/atlas-map.js（HEAD f3fcf69，
 * 2026-11-01 复制），仅本注释为新增。原始文件在 <WhiteMoon repo>\...\ds-ui 下保持只读。
 */

export const ATLAS_AUTHORITY_LABEL = "ATLAS_NATIVE";

function str(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function int(value, fallback = null) {
  return Number.isSafeInteger(value) ? value : fallback;
}

/** Atlas 的控制记录用 kind 表达，渲染层用 recordType + action。 */
export function controlActionOf(record) {
  if (!record || typeof record !== "object") return null;
  if (record.kind === "correction") return "correct";
  if (record.kind === "retraction") return "retract";
  return null;
}

function mapSource(record) {
  const source = record && typeof record.source === "object" && record.source ? record.source : null;
  if (!source) return { originAvailable: false, origin: null, declaredSource: null };
  // 渲染层的 origin 是「任意键值对」展示；这里保留 Atlas 的原字段名，
  // 不做语义翻译，免得读的人以为是 WhiteMoon 的 turnId。
  const origin = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    origin[key] = value;
  }
  return {
    originAvailable: Object.keys(origin).length > 0,
    origin: Object.keys(origin).length ? origin : null,
    declaredSource: typeof source.kind === "string" ? source.kind : null
  };
}

export function mapRecord(record, { authority = ATLAS_AUTHORITY_LABEL } = {}) {
  const item = record && typeof record === "object" ? record : {};
  const action = controlActionOf(item);
  const provenance = mapSource(item);
  const recordId = str(item.recordId);
  const mapped = {
    recordId,
    recordType: action ? "memory-control" : str(item.kind) || "experience",
    status: ["active", "superseded", "retracted", "recorded"].includes(item.status) ? item.status : "unknown",
    summary: str(item.content),
    timestamp: str(item.timestamp) || str(item.recordedAt),
    acceptedAt: str(item.recordedAt),
    recordSequence: int(item.sequence, null),
    source: authority,
    ...provenance,
    changedBy: str(item.changedBy) || null,
    action,
    targetExperienceId: str(item.aboutRecordId) || null,
    target: item.about
      ? {
          recordId: str(item.about.recordId),
          recordType: controlActionOf(item.about) ? "memory-control" : str(item.about.kind),
          status: ["active", "superseded", "retracted", "recorded"].includes(item.about.status) ? item.about.status : "unknown",
          summary: str(item.about.content),
          available: true
        }
      : null,
    // Atlas 专有字段，原样带给界面（可见范围、发生时间）
    visibility: str(item.visibility) || null,
    occurredAt: str(item.occurredAt) || null,
    kind: str(item.kind) || null
  };
  return mapped;
}

export function mapSearch(payload, { spaceId, authority, latencyMs } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.ok === false) {
    return {
      ok: false,
      status: str(body.code) || "ATLAS_READ_FAILED",
      error: str(body.error),
      servedInstanceId: spaceId || null,
      latencyMs: int(latencyMs, null)
    };
  }
  const records = Array.isArray(body.records) ? body.records.map((r) => mapRecord(r, { authority })) : [];
  return {
    ok: true,
    status: "OK",
    servedInstanceId: str(body.spaceId) || spaceId || null,
    outcome: str(body.outcome) || (records.length ? "MATCHED" : "NO_MATCH"),
    // 把 Atlas 自己的口径一起带上去，界面可以直接显示，不必猜
    searchPath: str(body.searchPath) || null,
    index: body.index && typeof body.index === "object"
      ? { state: str(body.index.state) || null, coverage: str(body.index.coverage) || null }
      : null,
    appliedFilters: body.appliedFilters && typeof body.appliedFilters === "object"
      ? { status: str(body.appliedFilters.status) || "active", visibility: str(body.appliedFilters.visibility) || "all" }
      : null,
    revision: int(body.revision, null),
    totalCount: int(body.totalCount, records.length),
    limit: int(body.limit, records.length),
    offset: int(body.offset, 0),
    returned: int(body.returned, records.length),
    hasMore: body.hasMore === true,
    counts: body.counts && typeof body.counts === "object"
      ? {
          active: int(body.counts.active, null),
          effective: int(body.counts.effective, null),
          superseded: int(body.counts.superseded, null),
          retracted: int(body.counts.retracted, null),
          total: int(body.counts.total, null)
        }
      : null,
    records,
    latencyMs: int(latencyMs, null)
  };
}

export function mapDetail(payload, { spaceId, recordId, authority } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.ok === false) {
    return {
      ok: false,
      status: str(body.code) || "ATLAS_READ_FAILED",
      error: str(body.error),
      recordId: recordId || null
    };
  }
  return {
    ok: true,
    status: "OK",
    servedInstanceId: str(body.spaceId) || spaceId || null,
    outcome: str(body.outcome) || (body.record ? "MATCHED" : "NO_MATCH"),
    revision: int(body.revision, null),
    record: body.record ? mapRecord(body.record, { authority }) : null,
    related: Array.isArray(body.related) ? body.related.map((r) => mapRecord(r, { authority })) : []
  };
}

export function mapOperation(payload, { spaceId, operationId } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.ok === false) {
    return { ok: false, status: str(body.code) || "ATLAS_READ_FAILED", error: str(body.error), operationId };
  }
  return {
    ok: true,
    status: "OK",
    spaceId: str(body.spaceId) || spaceId || null,
    operationId: str(body.operationId) || operationId,
    // Atlas 的 recorded 是权威判断；没有它时按 outcome 推断也只在 MATCHED 上成立
    recorded: body.recorded === true,
    outcome: str(body.outcome) || null,
    derivedRecordId: str(body.recordId) || null,
    recordStatus: str(body.status) || null,
    revision: int(body.revision, null),
    record: null
  };
}

export function mapHealth(payload, { spaceId } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.ok === false) {
    return { ok: false, status: str(body.code) || "ATLAS_UNAVAILABLE", error: str(body.error) };
  }
  const spaces = Array.isArray(body.spaces) ? body.spaces : [];
  const current = spaces.find((item) => item && item.spaceId === spaceId) || null;
  return {
    ok: true,
    status: "OK",
    instanceId: spaceId || null,
    service: str(body.version) || "memory-atlas",
    authority: str(body.authority) || null,
    capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : null,
    spaces: spaces.map((item) => ({
      spaceId: str(item.spaceId),
      records: int(item.records, null),
      bytes: int(item.bytes, null)
    })),
    spacesAvailable: body.spacesAvailable === true,
    revision: null,
    formalRevision: null,
    recordCount: current ? int(current.records, null) : null
  };
}

/**
 * 维护页要的是复合视图（正式 + 本地 + 目标）。Atlas 只有正式那一半，
 * 本地聊天转写它根本不提供——这里必须说"不提供"，而不是"0"。
 */
export function mapCapacity(payload, { spaceId } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.ok === false) {
    return {
      ok: false,
      status: str(body.code) || "ATLAS_UNAVAILABLE",
      error: str(body.error),
      instanceId: spaceId || null
    };
  }
  const capacity = body.capacity && typeof body.capacity === "object" ? body.capacity : {};
  const index = body.index && typeof body.index === "object" ? body.index : {};
  const spaces = Array.isArray(body.spaces) ? body.spaces : [];
  const current = spaces.find((item) => item && item.spaceId === spaceId) || null;
  const storeTotalBytes = int(capacity.authoritativeBytes, null);
  // 这是"一个空间"的界面：主数字用当前空间的实测字节；整库总量只作为说明出现，
  // 两者相加或替换都会让"占用"这个词失去意义。
  const authoritativeBytes = current && Number.isSafeInteger(current.bytes) ? current.bytes : storeTotalBytes;
  const derivedCacheBytes = int(capacity.derivedCacheBytes, null);
  const target = int(capacity.capacityTargetBytes, null);

  const percentOfTarget = Number.isSafeInteger(authoritativeBytes) && Number.isSafeInteger(target) && target > 0
    ? (authoritativeBytes / target) * 100
    : null;

  return {
    ok: true,
    instanceId: spaceId || null,
    formal: {
      ok: true,
      status: "OK",
      // 界面的"索引状态"表就是这张 sources 表：Atlas 的 NOT_WIRED 原样进来
      sources: [{
        id: str(body.authority) ? "ATLAS_" + str(body.authority).toUpperCase() : "ATLAS",
        availability: current && Number.isSafeInteger(current.bytes) ? "AVAILABLE" : "UNKNOWN",
        indexing: str(index.state) || "UNKNOWN",
        coverage: str(index.coverage) || null,
        note: str(index.state) === "NOT_WIRED"
          ? "Atlas 尚未接入检索索引（NOT_WIRED）；当前查询走权威全量扫描（searchPath=atlas-authoritative-scan）。"
          : ""
      }],
      searchPath: "atlas-authoritative-scan",
      measureLabelKey: "set.wbMeasureAtlas",
      storeTotalBytes,
      indexState: str(index.state) || null,
      indexCoverage: str(index.coverage) || null,
      revision: null,
      recordCount: current ? int(current.records, null) : null
    },
    local: {
      available: false,
      // 明确的原因码：界面据此显示"此模式不提供"，而不是"读不出来"
      reason: "NOT_PROVIDED_BY_ATLAS"
    },
    capacity: {
      formalAvailable: Number.isSafeInteger(authoritativeBytes),
      authoritativeBytes,
      derivedCacheBytes,
      localTranscriptBytes: null,
      localDerivedIndexBytes: null,
      capacityTargetBytes: target,
      percentOfTarget,
      policy: capacity.policy && typeof capacity.policy === "object" ? capacity.policy : { enforceLimit: false, autoDiscardOriginals: false },
      unreadable: {
        formal: !Number.isSafeInteger(authoritativeBytes),
        localTranscript: false, // 不是"读不出来"，是"不提供"——两个不同的事实
        unindexedSegments: []
      },
      note: str(capacity.note) || null,
      scope: current ? "space" : "store"
    }
  };
}

/** Atlas 的写入回执 → 渲染层的控制结果。409 必须是冲突，不能是成功，也不能是泛化失败。 */
export function mapControl(payload, request = {}, { httpStatus = 200 } = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  const base = {
    operationId: str(request.operationId) || null,
    targetExperienceId: str(request.targetExperienceId) || null,
    action: str(request.action) || null
  };
  if (body.ok === false) {
    const code = str(body.code);
    const status = code === "ATLAS_CONTROL_TARGET_INACTIVE" || code === "ATLAS_CONTROL_TARGET_MISSING" || httpStatus === 409
      ? "MEMORY_CONTROL_CONFLICT"
      : code === "ATLAS_OPERATION_MISMATCH" || httpStatus === 400
        ? "MEMORY_CONTROL_INVALID"
        : "MEMORY_CONTROL_FAILED";
    return { ok: false, status, code: code || null, error: str(body.error), ...base };
  }
  const outcome = str(body.outcome) || "RECORDED";
  const known = ["RECORDED", "IDEMPOTENT_REPLAY"];
  return {
    ok: true,
    status: "OK",
    // 渲染层用 IDEMPOTENT_REPLAY 判断"这次是重放"，其余一律当一次成功写入
    outcome: known.includes(outcome) ? outcome : "RECORDED",
    rawOutcome: outcome,
    acceptedExperienceId: str(body.recordId) || null,
    sequence: int(body.sequence, null),
    revision: int(body.revision, null),
    duplicateOf: body.duplicateOf && typeof body.duplicateOf === "object" ? body.duplicateOf : null,
    ...base
  };
}

/** 旧后端没有的能力，用一句话说清楚，而不是给一个空数组让人误以为"查了但没有"。 */
export function unimplementedContext(reason = "NOT_PROVIDED_BY_ATLAS") {
  return { outcome: "SOURCE_UNAVAILABLE", reason, authority: "NON_FORMAL_CONTEXT", rows: [] };
}
