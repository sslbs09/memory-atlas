/**
 * http.js - the unified Memory API.
 *
 * Loopback by default, two local capabilities (read and write), no framework,
 * no CORS, no TLS. A write is never reachable without a token, and a read token
 * cannot write. This is the same protocol shape the WhiteMoon Runtime Host
 * already uses, on purpose: one client can speak to either, and a future Linux
 * server can serve the same surface without any client changing.
 *
 *   GET  /health                 liveness, unauthenticated, no data
 *   GET  /atlas/spaces           list memory spaces                 (read)
 *   POST /atlas/spaces           create a memory space              (write)
 *   POST /atlas/record           append a record                    (write)
 *   POST /atlas/correct          append a correction                (write)
 *   POST /atlas/retract          append a retraction                 (write)
 *   GET  /atlas/search           query one space                     (read)
 *   GET  /atlas/detail           one record plus its chain           (read)
 *   GET  /atlas/operation        what a caller-owned operation did   (read)
 *   GET  /atlas/health           capacity, sources and index state   (read)
 *   GET  /atlas/feedback         review signals for a space          (read)
 *   POST /atlas/feedback         flag a record useful/incorrect      (write)
 *   POST /atlas/feedback/resolve dismiss or mark a signal actioned   (write)
 *
 * Feedback is a governance side-channel: it never changes a record's status,
 * never enters search, and never becomes a fact. A human decides the outcome.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 256 * 1024;

function send(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Body is not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function authorized(req, token) {
  if (!token) return false;
  const match = String(req.headers.authorization ?? '').match(/^Bearer (.+)$/s);
  if (!match) return false;
  const presented = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function statusFor(error) {
  if (error && Number.isInteger(error.status)) return error.status;
  const code = error && error.code ? String(error.code) : '';
  const message = error && error.message ? error.message : '';
  if (code === 'ATLAS_QUERY_INVALID' || code === 'ATLAS_RECORD_INVALID' || code === 'ATLAS_ID_INVALID' ||
      code === 'ATLAS_CONTROL_INVALID' || code === 'ATLAS_OPERATION_INVALID' || code === 'ATLAS_OPERATION_MISMATCH' ||
      code === 'ATLAS_FEEDBACK_INVALID') return 400;
  if (code === 'ATLAS_SPACE_EXISTS' || code === 'ATLAS_IDENTITY_CONFLICT' || code === 'ATLAS_OPERATION_CONFLICT') return 409;
  if (code === 'ATLAS_SPACE_UNAVAILABLE') return /unknown record|no longer active/.test(message) ? 409 : 404;
  if (code === 'ATLAS_CONTROL_TARGET_MISSING' || code === 'ATLAS_CONTROL_TARGET_INACTIVE' || code === 'ATLAS_FEEDBACK_TARGET_MISSING') return 409;
  if (code === 'ATLAS_FEEDBACK_NOT_FOUND') return 404;
  if (code === 'ATLAS_PERSIST_FAILED' || code === 'ATLAS_PERSIST_UNVERIFIED' || code === 'ATLAS_SAVE_CONFLICT' ||
      code === 'ATLAS_FEEDBACK_UNAVAILABLE') return 503;
  return 500;
}

const SEARCH_PARAMS = ['q', 'id', 'kind', 'status', 'visibility', 'limit', 'offset', 'order',
  'since', 'until', 'timeField', 'content'];

function searchOptions(url) {
  const known = new Set([...SEARCH_PARAMS, 'space']);
  const unknown = [...new Set([...url.searchParams.keys()])].filter((key) => !known.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown query parameter(s): ${unknown.join(', ')}`), { code: 'ATLAS_QUERY_INVALID' });
  }
  const options = {};
  const get = (key) => url.searchParams.get(key);
  if (get('q') !== null) options.query = get('q');
  if (get('id') !== null) options.recordId = get('id');
  if (url.searchParams.getAll('kind').length) options.kinds = url.searchParams.getAll('kind');
  if (get('status') !== null) options.status = get('status');
  if (get('visibility') !== null) options.visibility = get('visibility');
  if (get('limit') !== null) options.limit = Number(get('limit'));
  if (get('offset') !== null) options.offset = Number(get('offset'));
  if (get('order') !== null) options.order = get('order');
  if (get('since') !== null) options.since = get('since');
  if (get('until') !== null) options.until = get('until');
  if (get('timeField') !== null) options.timeField = get('timeField');
  if (get('content') !== null) options.includeContent = get('content') === '1';
  return options;
}

export function createAtlasServer({ service, readToken, writeToken }) {
  if (!service) throw new Error('createAtlasServer requires a memory service.');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        send(res, 200, { ok: true, service: 'memory-atlas', version: service.version });
        return;
      }
      if (url.pathname === '/atlas/spaces' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        send(res, 200, { ok: true, ...service.spaces() });
        return;
      }
      if (url.pathname === '/atlas/health' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        send(res, 200, { ok: true, ...service.health() });
        return;
      }
      if (url.pathname === '/atlas/search' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        const spaceId = url.searchParams.get('space');
        if (!spaceId) return send(res, 400, { ok: false, error: '"space" is required.' });
        const view = await service.search({ spaceId, ...searchOptions(url) });
        send(res, view.outcome === 'SOURCE_UNAVAILABLE' ? 503 : 200, { ok: view.outcome !== 'SOURCE_UNAVAILABLE', ...view });
        return;
      }
      if (url.pathname === '/atlas/detail' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        const spaceId = url.searchParams.get('space');
        const recordId = url.searchParams.get('id');
        if (!spaceId || !recordId) return send(res, 400, { ok: false, error: '"space" and "id" are required.' });
        const detail = await service.detail({ spaceId, recordId });
        send(res, detail.outcome === 'SOURCE_UNAVAILABLE' ? 503 : 200, { ok: detail.outcome !== 'SOURCE_UNAVAILABLE', ...detail });
        return;
      }
      if (url.pathname === '/atlas/operation' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        const spaceId = url.searchParams.get('space');
        const operationId = url.searchParams.get('operationId');
        if (!spaceId || !operationId) return send(res, 400, { ok: false, error: '"space" and "operationId" are required.' });
        send(res, 200, { ok: true, spaceId, operationId, ...(await service.operation(spaceId, operationId)) });
        return;
      }
      if (url.pathname === '/atlas/feedback' && req.method === 'GET') {
        if (!authorized(req, readToken)) return send(res, 401, { ok: false, error: 'read token required' });
        const spaceId = url.searchParams.get('space');
        if (!spaceId) return send(res, 400, { ok: false, error: '"space" is required.' });
        const status = url.searchParams.get('status') || 'pending';
        send(res, 200, { ok: true, ...service.feedbackList(spaceId, { status }) });
        return;
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: `${url.pathname} accepts ${url.pathname.startsWith('/atlas/') ? 'POST' : 'GET'} only.` });
        return;
      }
      if (!authorized(req, writeToken)) {
        send(res, 401, { ok: false, error: 'Unauthorized: a write Bearer token is required.' });
        return;
      }
      const body = await readBody(req);
      const spaceId = body.spaceId;
      if (!spaceId) {
        send(res, 400, { ok: false, error: '"spaceId" is required.' });
        return;
      }
      if (url.pathname === '/atlas/spaces') {
        send(res, 201, { ok: true, ...(await service.createSpace({ spaceId, label: body.label })) });
        return;
      }
      if (url.pathname === '/atlas/record') {
        const receipt = await service.record(spaceId, { ...body.record, spaceId: undefined }, { operationId: body.operationId });
        send(res, 200, { ok: true, ...receipt });
        return;
      }
      if (url.pathname === '/atlas/correct' || url.pathname === '/atlas/retract') {
        const call = url.pathname === '/atlas/correct' ? service.correct : service.retract;
        const receipt = await call(spaceId, {
          aboutRecordId: body.aboutRecordId,
          content: body.content,
          operationId: body.operationId
        });
        send(res, 200, { ok: true, ...receipt });
        return;
      }
      if (url.pathname === '/atlas/feedback') {
        const entry = await service.feedback(spaceId, {
          recordId: body.recordId, signal: body.signal, note: body.note, source: body.source
        });
        send(res, 200, { ok: true, ...entry });
        return;
      }
      if (url.pathname === '/atlas/feedback/resolve') {
        const entry = await service.resolveFeedback(spaceId, {
          feedbackId: body.feedbackId, resolution: body.resolution, by: body.by
        });
        send(res, 200, { ok: true, ...entry });
        return;
      }
      send(res, 404, { ok: false, error: `No such endpoint: ${route}.` });
    } catch (error) {
      send(res, statusFor(error), {
        ok: false,
        error: error && error.message ? error.message : String(error),
        ...(error && error.code ? { code: error.code } : {}),
        // A refused reuse says what it collided with and on which fields, so the
        // caller can tell "already stored" from "identity already taken".
        ...(error && error.duplicateOf ? { duplicateOf: error.duplicateOf } : {}),
        ...(error && error.differingFields ? { differingFields: error.differingFields } : {})
      });
    } finally {
      // Method, path, status only. Never tokens, never record content.
      process.stderr.write(`[atlas] ${route} -> ${res.statusCode}\n`);
    }
  });
}
