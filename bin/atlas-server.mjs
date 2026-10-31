#!/usr/bin/env node
/**
 * atlas-server - start and stop the Memory Atlas service.
 *
 *   node bin/atlas-server.mjs --data-dir <Memory Atlas repo>Data --port 8791
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
  // Ephemeral tokens are fine for a demo and useless to a caller, so say where
  // they are instead of leaving an operator to guess why every request 401s.
  process.stderr.write('[atlas] generated one-shot tokens for this process only:\n');
  process.stderr.write(`[atlas]   ATLAS_READ_TOKEN=${readToken}\n`);
  process.stderr.write(`[atlas]   ATLAS_WRITE_TOKEN=${writeToken}\n`);
}

const authority = new NativeAuthority({ dataDir });
const service = createMemoryService({
  authority,
  capacityTargetBytes: Number(process.env.ATLAS_CAPACITY_TARGET_BYTES ?? 20_000_000_000),
  derivedCacheDir: process.env.ATLAS_CACHE_DIR ? path.resolve(process.env.ATLAS_CACHE_DIR) : path.join(dataDir, 'derived-cache')
});
const server = createAtlasServer({ service, readToken, writeToken });
const wantedPort = Number(args.port ?? process.env.ATLAS_PORT ?? 8791);

server.listen(wantedPort, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ event: 'listening', service: 'memory-atlas', dataDir, port })}\n`);
});

let closing = false;
function shutdown(via) {
  if (closing) return;
  closing = true;
  process.stderr.write(`[atlas] shutting down (${via})\n`);
  server.closeAllConnections();
  server.close(() => process.exit(0));
  // A hung connection must not turn a clean shutdown into a hung process.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.stdin.on('close', () => shutdown('stdin closed'));
process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.resume();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
