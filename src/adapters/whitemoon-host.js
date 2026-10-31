/**
 * adapters/whitemoon-host.js - a delegated authority over a WhiteMoon Runtime
 * Host, speaking its documented Memory API over HTTP.
 *
 * Why this exists in the independent project: WhiteMoon Core keeps the
 * adjudication of Identity, accepted Experience, State and Relationship. Atlas
 * must not copy those facts into a second database and must not decide what
 * WhiteMoon believes. So this adapter reads and controls through the Host and
 * maps the shapes onto Atlas's own record model, in memory, per request.
 *
 * There is no code dependency on WhiteMoon here - only the protocol - which is
 * what keeps Memory Atlas standalone: remove this file and Atlas still runs on
 * its native authority.
 *
 * Capabilities are deliberately narrower than the native authority: no bare
 * record append (formal acceptance is WhiteMoon's ingress path, not a query
 * API's), and no space creation.
 */

const DEFAULT_TIMEOUT_MS = 5000;

function statusToReason(status) {
  if (status === 503) return 'HOST_OR_INSTANCE_UNAVAILABLE';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 409) return 'AUTHORITY_CONFLICT';
  return `HTTP_${status}`;
}

export function createWhiteMoonAuthority({
  baseUrl = 'http://127.0.0.1:8790',
  instanceId,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl
} = {}) {
  if (!token) throw new Error('A WhiteMoon authority needs the Host ingress Bearer token.');
  if (!instanceId) throw new Error('A WhiteMoon authority names one instanceId (an Atlas space).');
  const url = new URL(baseUrl);
  const root = `${url.protocol}//${url.host}`.replace(/\/+$/, '');

  async function request(path, { pairs, body, method = 'GET' } = {}) {
    const search = pairs && pairs.length ? `?${new URLSearchParams(pairs).toString()}` : '';
    const target = new URL(`${root}${path}${search}`);
    const doFetch = fetchImpl ?? fetch;
    const response = await doFetch(target.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, payload };
  }

  /** One WhiteMoon record -> one Atlas record. Nothing is invented in transit. */
  function toAtlasRecord(record) {
    if (!record) return null;
    return {
      recordId: record.recordId,
      spaceId: record.instanceId ?? instanceId,
      kind: record.recordType === 'memory-control' ? (record.action === 'retract' ? 'retraction' : 'correction') : 'experience',
      content: record.summary ?? '',
      status: record.status,
      visibility: 'space',
      source: record.originAvailable && record.origin
        ? { kind: String(record.origin.type ?? 'unknown'), id: record.origin.actionId ? String(record.origin.actionId) : undefined }
        : null,
      sourceAvailable: Boolean(record.originAvailable),
      occurredAt: record.timestamp ?? null,
      recordedAt: record.acceptedAt ?? record.timestamp ?? null,
      timestamp: record.timestamp ?? null,
      sequence: record.recordSequence ?? null,
      aboutRecordId: record.targetExperienceId ?? null,
      changedBy: record.changedBy ?? null,
      authority: 'whitemoon-core'
    };
  }

  return {
    name: 'whitemoon-host',
    instanceId,
    capabilities() {
      return { write: false, correct: true, retract: true, spaces: false, visibility: false };
    },
    listSpaces() {
      // The Host serves one instance; the inventory comes from its health view.
      return { available: false, spaceIds: [], reason: 'INVENTORY_REQUIRES_HEALTH_CALL' };
    },

    async inspect(spaceId) {
      if (spaceId !== instanceId) return { available: false, reason: 'SPACE_NOT_SERVED_BY_THIS_AUTHORITY' };
      const { status, payload } = await request('/memory-search', { pairs: [['status', 'all'], ['limit', '200']] });
      if (status !== 200 || !payload || payload.ok !== true) {
        return { available: false, reason: statusToReason(status) };
      }
      const records = (payload.records ?? []).map((record) => ({
        recordId: record.recordId,
        kind: toAtlasRecord(record).kind,
        content: record.summary ?? '',
        visibility: 'space',
        occurredAt: record.timestamp ?? null,
        recordedAt: record.acceptedAt ?? null,
        sequence: record.recordSequence ?? 0,
        aboutRecordId: record.targetExperienceId ?? null,
        source: toAtlasRecord(record).source ?? undefined
      }));
      const statuses = new Map((payload.records ?? []).map((record) => [record.recordId, record.status]));
      const changedBy = new Map((payload.records ?? []).filter((record) => record.changedBy)
        .map((record) => [record.recordId, record.changedBy]));
      return {
        available: true,
        spaceDoc: { spaceId, records, revision: payload.revision },
        // WhiteMoon already derived validity; Atlas reports it rather than
        // recomputing it, because the adjudication belongs to the authority.
        validity: {
          statuses,
          changedBy,
          revision: payload.revision ?? 0,
          active: records.filter((record) => statuses.get(record.recordId) === 'active'),
          effective: records.filter((record) => statuses.get(record.recordId) === 'active' &&
            record.kind !== 'correction' && record.kind !== 'retraction')
        }
      };
    },

    async control(spaceId, { aboutRecordId, action, content, operationId }) {
      if (spaceId !== instanceId) {
        throw Object.assign(new Error(`This authority serves instance "${instanceId}" only.`), { code: 'ATLAS_SPACE_UNAVAILABLE' });
      }
      const body = { instanceId, targetExperienceId: aboutRecordId, action };
      if (content !== undefined) body.text = content;
      if (operationId !== undefined) body.operationId = operationId;
      const { status, payload } = await request('/memory-control', { method: 'POST', body });
      if (status !== 200 || !payload || payload.ok !== true) {
        throw Object.assign(
          new Error((payload && payload.error) || `WhiteMoon refused the control (HTTP ${status}).`),
          { code: (payload && payload.status) || 'ATLAS_AUTHORITY_REFUSED' }
        );
      }
      return {
        accepted: true,
        outcome: payload.outcome ?? 'RECORDED',
        spaceId: instanceId,
        recordId: payload.acceptedExperienceId,
        revision: null
      };
    },

    async resolveOperation(spaceId, operationId) {
      const { status, payload } = await request('/memory-operation', { pairs: [['operationId', operationId]] });
      if (status !== 200 || !payload || payload.ok !== true) return { outcome: 'SOURCE_UNAVAILABLE', recorded: false, reason: statusToReason(status) };
      return {
        outcome: payload.recorded ? 'MATCHED' : 'NO_MATCH',
        recorded: Boolean(payload.recorded),
        recordId: payload.derivedRecordId,
        status: payload.record?.status ?? null,
        revision: payload.revision ?? null
      };
    },

    async detail(spaceId, recordId) {
      const { status, payload } = await request('/memory-detail', { pairs: [['id', recordId]] });
      if (status !== 200 || !payload || payload.ok !== true) {
        return { outcome: 'SOURCE_UNAVAILABLE', reason: statusToReason(status), record: null, related: [] };
      }
      return {
        outcome: payload.outcome,
        spaceId,
        revision: payload.revision,
        record: toAtlasRecord(payload.record),
        related: (payload.related ?? []).map(toAtlasRecord).filter(Boolean)
      };
    }
  };
}