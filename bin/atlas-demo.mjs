#!/usr/bin/env node
/**
 * atlas-demo - a walkthrough of the whole service against real HTTP on
 * loopback, with synthetic data in a throwaway directory. Run it to see the
 * behaviour rather than read about it:
 *
 *   node bin/atlas-demo.mjs
 *
 * Nothing here talks to a model, so nothing here demonstrates model
 * understanding; it demonstrates record authority, provenance and validity.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { createAtlasServer } from '../src/http.js';
import { AtlasClient } from '../src/client.js';

const dir = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'atlas-demo-'));
const readToken = randomUUID();
const writeToken = randomUUID();
const authority = new NativeAuthority({ dataDir: dir });
const service = createMemoryService({ authority });
const server = createAtlasServer({ service, readToken, writeToken });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const client = new AtlasClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, readToken, writeToken });

const step = (label, value) => console.log(`\n— ${label}\n${JSON.stringify(value, null, 2)}`);

await client.createSpace('mira', 'Mira');
await client.createSpace('atelier', 'Atelier');

const written = await client.record({
  spaceId: 'mira',
  record: { recordId: 'tea', kind: 'experience', content: '用户喜欢无糖桂花乌龙', source: { kind: 'chat', id: 'msg-0001' } }
});
step('record a memory (receipt)', written);

step('recall by a two-character Chinese term', await client.search({ spaceId: 'mira', query: '桂花' }));

const corrected = await client.correct({
  spaceId: 'mira', aboutRecordId: 'tea', content: '用户后来改喝银杉茶', operationId: `demo-${randomUUID()}`
});
step('correct it (receipt)', corrected);

step('effective recall only returns the correction', await client.search({ spaceId: 'mira', query: '喝' }));
step('the audit view still shows the superseded original', await client.search({ spaceId: 'mira', query: '喝', status: 'all' }));
step('the correction chain from the original record', await client.detail({ spaceId: 'mira', recordId: 'tea' }));

const replay = await client.correct({
  spaceId: 'mira', aboutRecordId: 'tea', content: '用户后来改喝银杉茶', operationId: corrected.operationId ?? undefined
});
step('replaying the same operation id resolves onto the same record', replay);

step('the other memory space sees nothing of this', await client.search({ spaceId: 'atelier', query: '喝', status: 'all' }));
step('capacity, sources and index state', await client.health());

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });
console.log('\ndemo data directory removed; the service wrote nothing outside it.');
