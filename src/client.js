/**
 * client.js - a standalone Memory Atlas client. Plain Node http only: no
 * Electron, no desktop pet, no harness, no build step. This is what an external
 * agent, bot or MCP bridge would embed.
 *
 * A timeout resolves as a transport fault with the operation id attached; it is
 * never reported as success and never silently retried, because the write may
 * well have landed.
 */

import http from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_TIMEOUT_MS = 5000;

export class AtlasClient {
  constructor({ baseUrl = 'http://127.0.0.1:8791', readToken, writeToken, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:') throw new Error('Memory Atlas serves plain http on loopback in v0.1; baseUrl must be http://');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(hostname)) {
      throw new Error(`Refusing a non-loopback Memory Atlas host "${hostname}".`);
    }
    this.hostname = hostname;
    this.port = Number(url.port || 80);
    this.readToken = readToken ?? '';
    this.writeToken = writeToken ?? '';
    this.timeoutMs = timeoutMs;
  }

  #call(path, { pairs, body, method = 'GET', token } = {}) {
    const search = pairs && pairs.length ? `?${new URLSearchParams(pairs).toString()}` : '';
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => { if (settled) return; settled = true; resolve(result); };
      const req = http.request({
        hostname: this.hostname,
        port: this.port,
        method,
        path: `${path}${search}`,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
        },
        timeout: this.timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch {
            finish({ transport: 'RESPONDED', httpStatus: res.statusCode, ok: false, status: 'UNPARSEABLE_RESPONSE', raw: raw.slice(0, 400) });
            return;
          }
          finish({ transport: 'RESPONDED', httpStatus: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false, ...parsed });
        });
        res.on('error', (error) => finish({ transport: 'TRANSPORT_FAILED', ok: false, httpStatus: null, error: error.message }));
      });
      req.on('error', (error) => finish({
        transport: error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'UNREACHABLE',
        ok: false, httpStatus: null, code: error.code ?? 'TRANSPORT_ERROR', error: error.message
      }));
      req.on('timeout', () => req.destroy(Object.assign(new Error('Atlas request timed out.'), { code: 'ETIMEDOUT' })));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async health() { return this.#call('/atlas/health', { token: this.readToken }); }
  async liveness() { return this.#call('/health', {}); }
  async spaces() { return this.#call('/atlas/spaces', { token: this.readToken }); }
  async createSpace(spaceId, label) {
    return this.#call('/atlas/spaces', { method: 'POST', body: { spaceId, label }, token: this.writeToken });
  }

  search({ spaceId, query, recordId, kinds, status, visibility, limit, offset, order, since, until, timeField, includeContent } = {}) {
    const pairs = [['space', spaceId]];
    if (query !== undefined) pairs.push(['q', query]);
    if (recordId !== undefined) pairs.push(['id', recordId]);
    for (const kind of kinds ?? []) pairs.push(['kind', kind]);
    if (status !== undefined) pairs.push(['status', status]);
    if (visibility !== undefined) pairs.push(['visibility', visibility]);
    if (limit !== undefined) pairs.push(['limit', String(limit)]);
    if (offset !== undefined) pairs.push(['offset', String(offset)]);
    if (order !== undefined) pairs.push(['order', order]);
    if (since !== undefined) pairs.push(['since', since]);
    if (until !== undefined) pairs.push(['until', until]);
    if (timeField !== undefined) pairs.push(['timeField', timeField]);
    if (includeContent !== undefined) pairs.push(['content', includeContent ? '1' : '0']);
    return this.#call('/atlas/search', { pairs, token: this.readToken });
  }

  detail({ spaceId, recordId }) {
    return this.#call('/atlas/detail', { pairs: [['space', spaceId], ['id', recordId]], token: this.readToken });
  }

  operation({ spaceId, operationId }) {
    return this.#call('/atlas/operation', { pairs: [['space', spaceId], ['operationId', operationId]], token: this.readToken });
  }

  record({ spaceId, record, operationId }) {
    return this.#call('/atlas/record', { method: 'POST', body: { spaceId, record, operationId }, token: this.writeToken });
  }

  correct({ spaceId, aboutRecordId, content, operationId }) {
    return this.#call('/atlas/correct', { method: 'POST', body: { spaceId, aboutRecordId, content, operationId }, token: this.writeToken });
  }

  retract({ spaceId, aboutRecordId, operationId }) {
    return this.#call('/atlas/retract', { method: 'POST', body: { spaceId, aboutRecordId, operationId }, token: this.writeToken });
  }
}
