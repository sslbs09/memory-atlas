import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhiteMoonAuthority } from '../src/adapters/whitemoon-host.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ingress-token-synthetic';

/**
 * A stub of the WhiteMoon Runtime Host Memory API, shaped exactly like the
 * documented contract. It exists so this test proves the adapter speaks the
 * protocol - not that it links against anything.
 */
async function stubHost(t, { records, revision = 3 } = {}) {
  const seen = [];
  const bodies = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push(`${req.method} ${url.pathname}`);
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return reply(401, { ok: false, error: 'no token' });
    if (url.pathname === '/memory-search') {
      const status = url.searchParams.get('status');
      const list = status === 'all' ? records : records.filter((r) => r.status === 'active');
      return reply(200, { ok: true, status: 'OK', instanceId: 'sussurro-daily', revision, records: list, totalCount: list.length });
    }
    if (url.pathname === '/memory-detail') {
      const id = url.searchParams.get('id');
      const record = records.find((r) => r.recordId === id);
      return reply(200, { ok: true, status: 'OK', outcome: record ? 'MATCHED' : 'NO_MATCH', revision, record: record ?? null, related: [] });
    }
    if (url.pathname === '/memory-operation') {
      const derived = `memory-op-${'0'.repeat(32)}`;
      const record = records.find((r) => r.recordId === derived);
      return reply(200, { ok: true, status: 'OK', recorded: Boolean(record), derivedRecordId: derived, revision, record: record ?? null });
    }
    if (url.pathname === '/memory-control' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        bodies.push(parsed);
        reply(200, { ok: true, status: 'OK', instanceId: 'sussurro-daily', acceptedExperienceId: 'memory-op-' + '0'.repeat(32), outcome: 'RECORDED' });
      });
      return undefined;
    }
    return reply(404, { ok: false, error: 'no route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen, bodies };
}

test('AD1 the adapter reads a WhiteMoon instance as Atlas records, without inventing anything', async (t) => {
  const records = [
    { recordId: 'tea', instanceId: 'sussurro-daily', recordType: 'personal-note', status: 'active',
      summary: '用户喜欢无糖桂花乌龙', timestamp: '2026-10-01T02:00:00.000Z', acceptedAt: '2026-10-01T02:00:01.000Z',
      recordSequence: 1, originAvailable: true, origin: { type: 'explicit-preference', actionId: 'act-0001' }, declaredSource: 'user' },
    { recordId: 'desk', instanceId: 'sussurro-daily', recordType: 'personal-note', status: 'superseded',
      summary: '工位代号是铜雀-19', timestamp: '2026-10-02T02:00:00.000Z', acceptedAt: '2026-10-02T02:00:00.000Z',
      recordSequence: 2, originAvailable: false, origin: null, changedBy: 'memory-op-x' },
    { recordId: 'memory-op-x', instanceId: 'sussurro-daily', recordType: 'memory-control', action: 'correct',
      targetExperienceId: 'desk', status: 'active', summary: '工位代号是银杉-84',
      timestamp: '2026-10-03T02:00:00.000Z', acceptedAt: '2026-10-03T02:00:00.000Z', recordSequence: 3, originAvailable: false, origin: null }
  ];
  const stub = await stubHost(t, { records });
  const authority = createWhiteMoonAuthority({ baseUrl: stub.baseUrl, instanceId: 'sussurro-daily', token: TOKEN });
  const inspected = await authority.inspect('sussurro-daily');
  assert.equal(inspected.available, true);
  assert.equal(inspected.spaceDoc.records.length, 3);
  const tea = inspected.spaceDoc.records.find((r) => r.recordId === 'tea');
  assert.equal(tea.kind, 'experience');
  assert.equal(tea.source.id, 'act-0001', 'the source reference is carried across the protocol');
  const control = inspected.spaceDoc.records.find((r) => r.recordId === 'memory-op-x');
  assert.equal(control.kind, 'correction', 'a memory-control record maps to a correction');
  assert.equal(control.aboutRecordId, 'desk');
  // Validity is reported as the authority derived it, not recomputed here.
  assert.equal(inspected.validity.statuses.get('desk'), 'superseded');
  assert.equal(inspected.validity.revision, 3);
});

test('AD2 only the named instance is served, and a foreign space is refused', async (t) => {
  const stub = await stubHost(t, { records: [] });
  const authority = createWhiteMoonAuthority({ baseUrl: stub.baseUrl, instanceId: 'sussurro-daily', token: TOKEN });
  const foreign = await authority.inspect('someone-else');
  assert.equal(foreign.available, false);
  assert.equal(foreign.reason, 'SPACE_NOT_SERVED_BY_THIS_AUTHORITY');
  await assert.rejects(authority.control('someone-else', { aboutRecordId: 'x', action: 'correct', content: 'y' }),
    /serves instance/);
});

test('AD3 control and operation go through the documented endpoints and carry the operation id', async (t) => {
  const stub = await stubHost(t, { records: [] });
  const authority = createWhiteMoonAuthority({ baseUrl: stub.baseUrl, instanceId: 'sussurro-daily', token: TOKEN });
  const receipt = await authority.control('sussurro-daily', { aboutRecordId: 'desk', action: 'correct', content: '改成银杉', operationId: 'adapter-op-00001' });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.outcome, 'RECORDED');
  assert.ok(stub.seen.includes('POST /memory-control'));
  const forwarded = stub.bodies.at(-1);
  assert.equal(forwarded.instanceId, 'sussurro-daily');
  assert.equal(forwarded.targetExperienceId, 'desk');
  assert.equal(forwarded.action, 'correct');
  assert.equal(forwarded.operationId, 'adapter-op-00001',
    'the caller operation id is forwarded, so a lost response can be looked up');
  assert.equal(forwarded.text, '改成银杉', 'the replacement text is carried in the documented field');
  assert.deepEqual(Object.keys(forwarded).sort(),
    ['action', 'instanceId', 'operationId', 'targetExperienceId', 'text'].sort(),
    'no extra field is smuggled into the control request');
  const looked = await authority.resolveOperation('sussurro-daily', 'adapter-op-00001');
  assert.ok(stub.seen.includes('GET /memory-operation'));
  assert.equal(looked.outcome, 'NO_MATCH', 'the stub has no such record, and the adapter says so');
  assert.equal(looked.recorded, false);
});

test('AD4 an unreachable authority is unavailable, never an empty memory', async (t) => {
  const stub = await stubHost(t, { records: [] });
  const authority = createWhiteMoonAuthority({ baseUrl: stub.baseUrl, instanceId: 'sussurro-daily', token: 'wrong-token-000000' });
  const inspected = await authority.inspect('sussurro-daily');
  assert.equal(inspected.available, false);
  assert.equal(inspected.reason, 'UNAUTHORIZED');
  const detail = await authority.detail('sussurro-daily', 'tea');
  assert.equal(detail.outcome, 'SOURCE_UNAVAILABLE');
  assert.equal(detail.record, null);
});

test('AD5 Memory Atlas does not depend on WhiteMoon in code', async () => {
  const core = ['src/model.js', 'src/store.js', 'src/query.js', 'src/service.js', 'src/http.js', 'src/client.js'];
  for (const file of core) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Prose may name WhiteMoon (the adapter docs do); code may not. The check
    // is on what the module loads, because that is what creates a dependency.
    for (const specifier of fromImports(source)) {
      assert.ok(!/whitemoon|suzuran|sussurro/i.test(specifier), `${file} imports ${specifier} from a character runtime`);
    }
    assert.ok(!/require\(\s*['\"](whitemoon|@whitemoon)/.test(source), `${file} requires a character runtime`);
    assert.ok(!fromImports(source).some((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../')),
      `${file} may only import node builtins and Atlas files`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'Atlas has no runtime dependencies');
  // The adapter is the one place allowed to know about WhiteMoon, and it knows
  // it only as an HTTP protocol.
  const adapter = fs.readFileSync(path.join(ROOT, 'src/adapters/whitemoon-host.js'), 'utf8');
  assert.ok(!fromImports(adapter).some((spec) => !spec.startsWith('node:')), 'the adapter imports nothing from WhiteMoon');
  assert.match(adapter, /\/memory-search|\/memory-control/);
});

function fromImports(source) {
  return [...source.matchAll(/^\s*import\s(?:.+?\sfrom\s)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}
