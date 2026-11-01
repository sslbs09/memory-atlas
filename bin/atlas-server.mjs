#!/usr/bin/env node
/**
 * atlas-server - start and stop the Memory Atlas service.
 *
 *   node bin/atlas-server.mjs --data-dir D:\\MemoryAtlasData --port 8791
 *   node bin/atlas-server.mjs --retrieval-module ./my-index.mjs
 *
 * With --retrieval-module (or ATLAS_RETRIEVAL_MODULE) the service attaches a
 * derived index speaking SEARCH-DTO-v1 and rebuilds it from the authoritative
 * store on startup. Without one, every answer comes from the exhaustive scan;
 * with a broken module path the server refuses to start rather than pretend the
 * configuration took.
 *
 * Tokens come from the environment, never from argv (argv is visible to other
 * processes and to shell history). On readiness it prints exactly one
 * machine-readable line, the same convention a supervisor already knows:
 *   {"event":"listening","port":8791}
 *
 * Shutdown: close stdin (graceful, the way the WhiteMoon Host is stopped) or
 * send SIGINT/SIGTERM. Nothing is cached in memory that is not on disk.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeAuthority, createMemoryService } from '../src/service.js';
import { createAtlasServer } from '../src/http.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args['data-dir'] ?? process.env.ATLAS_DATA_DIR ?? path.join(process.cwd(), 'atlas-data'));
fs.mkdirSync(dataDir, { recursive: true });

const readToken = process.env.ATLAS_READ_TOKEN ?? randomBytes(24).toString('hex');
const writeToken = process.env.ATLAS_WRITE_TOKEN ?? randomBytes(24).toString('hex');
if (!process.env.ATLAS_READ_TOKEN || !process.env.ATLAS_WRITE_TOKEN) {
  // One-shot tokens are fine for a demo but useless to a caller, so say where
  // they live instead of printing them: saved terminal output would otherwise
  // preserve still-valid local credentials. The endpoint file written on
  // listen holds the same tokens, beside the data it describes.
  process.stderr.write('[atlas] tokens were not provided via ATLAS_READ_TOKEN/ATLAS_WRITE_TOKEN;\n');
  process.stderr.write('[atlas] one-shot tokens generated for this process - read them from the\n');
  process.stderr.write('[atlas] endpoint file written next to the data once the service is listening.\n');
}

const authority = new NativeAuthority({ dataDir });
const derivedCacheDir = process.env.ATLAS_CACHE_DIR
  ? path.resolve(process.env.ATLAS_CACHE_DIR)
  : path.join(dataDir, 'derived-cache');

/**
 * An optional derived index. The module is loaded by path so Atlas keeps no
 * dependency on any particular retrieval engine: it owes only the SEARCH-DTO-v1
 * shape. The factory receives the directories and returns
 * { searchCandidates, upsertRecords?, removeRecords?, close?, name?, indexGeneration? }.
 *
 * adapters/glm-retrieval.mjs is the shipped factory for Backend B's index; it
 * reads ATLAS_GLM_MODULE (and optionally ATLAS_GLM_INDEX) from the environment.
 */

/** A path the operator typed, a file: URL, or a bare package specifier. */
function resolveModuleUrl(specifier) {
  if (/^file:/i.test(specifier) || /^node:/i.test(specifier)) return specifier;
  if (path.isAbsolute(specifier)) return pathToFileURL(specifier).href;
  const local = path.resolve(process.cwd(), specifier);
  if (specifier.startsWith('.') || specifier.includes('/') || specifier.includes('\\')) {
    if (!fs.existsSync(local)) {
      throw new Error(`--retrieval-module "${specifier}" is not readable at ${local}`);
    }
    return pathToFileURL(local).href;
  }
  // "adapters/glm-retrieval.mjs" typed without a leading ./ is still a path here;
  // anything else stays a bare specifier so node_modules resolution can work.
  return fs.existsSync(local) ? pathToFileURL(local).href : specifier;
}

async function loadRetrieval(specifier) {
  if (!specifier) return null;
  const module = await import(resolveModuleUrl(specifier));
  const factory = module.createRetrievalAdapter ?? module.default;
  if (typeof factory !== 'function') {
    throw new Error(`Retrieval module "${specifier}" exports no createRetrievalAdapter (or default) factory. ` +
      'An engine module that exports a class needs a thin factory: for Backend B use ' +
      './adapters/glm-retrieval.mjs with ATLAS_GLM_MODULE set to its src/adapter.mjs.');
  }
  const adapter = await factory({ dataDir, derivedCacheDir });
  if (!adapter || typeof adapter.searchCandidates !== 'function') {
    throw new Error(`Retrieval module "${specifier}" returned an adapter without searchCandidates(params).`);
  }
  return adapter;
}

let retrieval = null;
try {
  retrieval = await loadRetrieval(args['retrieval-module'] ?? process.env.ATLAS_RETRIEVAL_MODULE ?? null);
} catch (error) {
  // Starting without an index is a supported mode; starting with a broken one
  // is not, and silently dropping it would make the operator's configuration a
  // lie the service agrees with.
  process.stderr.write(`[atlas] retrieval module failed to load: ${error.message}\n`);
  process.exit(1);
}

const service = createMemoryService({
  authority,
  capacityTargetBytes: Number(process.env.ATLAS_CAPACITY_TARGET_BYTES ?? 20_000_000_000),
  derivedCacheDir,
  retrieval
});
const server = createAtlasServer({ service, readToken, writeToken });
const wantedPort = Number(args.port ?? process.env.ATLAS_PORT ?? 8791);

// Endpoint discovery for callers that were not handed the ready line (an MCP
// bridge under a chat host, a desktop shell restarting the service): the file
// lives beside the data it describes, holds the same tokens the environment
// already gave this process, and is removed on graceful shutdown. A file left
// behind by a crash is stale by construction - readers must verify liveness
// through /atlas/health before trusting it.
const endpointFile = process.env.ATLAS_ENDPOINT_FILE === '0'
  ? null
  : path.resolve(args['endpoint-file'] ?? process.env.ATLAS_ENDPOINT_FILE ?? path.join(dataDir, 'endpoint.json'));

function writeEndpointFile(port) {
  if (!endpointFile) return;
  fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
  fs.writeFileSync(endpointFile, `${JSON.stringify({
    service: 'memory-atlas',
    endpointVersion: 1,
    url: `http://127.0.0.1:${port}`,
    readToken,
    writeToken,
    pid: process.pid,
    bootId: randomBytes(8).toString('hex'),
    dataDir,
    startedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

function removeEndpointFile() {
  if (!endpointFile) return;
  try { fs.unlinkSync(endpointFile); } catch { /* already gone */ }
}

server.listen(wantedPort, '127.0.0.1', async () => {
  const { port } = server.address();
  let indexReport = { state: 'NOT_WIRED' };
  if (retrieval) {
    // A rebuild that did not finish is reported as such, and the affected spaces
    // are answered from the store until a complete one lands: service.reindex()
    // records the failure per space instead of throwing past the server.
    const rebuilt = await service.reindex();
    indexReport = { state: rebuilt.complete ? 'REBUILT' : 'REBUILD_INCOMPLETE', ...rebuilt };
    if (!rebuilt.complete) {
      const bad = rebuilt.spaces.filter((s) => !s.synced).map((s) => `${s.spaceId}:${s.reason}`).join(', ');
      process.stderr.write(`[atlas] index rebuild incomplete (${bad}) - those spaces are answered from the store\n`);
    }
  }
  writeEndpointFile(port);
  process.stdout.write(`${JSON.stringify({ event: 'listening', service: 'memory-atlas', dataDir, port, index: indexReport })}\n`);
});

let closing = false;
function shutdown(via) {
  if (closing) return;
  closing = true;
  process.stderr.write(`[atlas] shutting down (${via})\n`);
  removeEndpointFile();
  server.closeAllConnections();
  server.close(() => {
    try { retrieval?.close?.(); } catch (error) { process.stderr.write(`[atlas] index close failed: ${error.message}\n`); }
    authority.close();
    process.exit(0);
  });
  // A hung connection must not turn a clean shutdown into a hung process.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.stdin.on('close', () => shutdown('stdin closed'));
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.resume();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
