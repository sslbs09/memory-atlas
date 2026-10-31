#!/usr/bin/env node
/**
 * atlas-query - the smallest standalone client: plain Node, one env token, no
 * Electron and no desktop pet anywhere in the path.
 *
 *   node bin/atlas-query.mjs --space mira --query 桂花
 *   node bin/atlas-query.mjs --space mira --id tea
 *   node bin/atlas-query.mjs --space mira --query 桂花 --status all --limit 20
 *   node bin/atlas-query.mjs --space mira --query 桂花 --since 2026-01-05 --until 2026-01-09 --time-field occurredAt
 *   node bin/atlas-query.mjs --health
 *
 * Exit codes: 0 answered, 1 refused or unreachable, 2 usage error.
 */

import { AtlasClient } from '../src/client.js';

const USAGE = `Usage: node bin/atlas-query.mjs [options]
  --space <id>        memory space (required unless --health / --spaces)
  --query <terms>     keyword search (Chinese short terms, names and ids work)
  --id <recordId>     exact stable record id
  --kind <k>          record kind filter, repeatable
  --status <s>        active (default) | superseded | retracted | recorded | all
  --visibility <v>    private | space | shared | all
  --since / --until   server-side time window (ISO or any parseable date)
  --time-field <f>    timestamp (default) | occurredAt | recordedAt
  --limit / --offset  pagination (limit max 200)
  --order <o>         newest (default) | oldest
  --no-content        return metadata without record text
  --health            capacity, sources and index state
  --spaces            list memory spaces
  --base-url <url>    default http://127.0.0.1:8791
  --token-env <NAME>  env var holding the read token (default ATLAS_READ_TOKEN)
`;

function parse(argv) {
  const out = { kinds: [], status: 'active' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--health' || arg === '--spaces' || arg === '--no-content') { out[arg.slice(2)] = true; continue; }
    if (arg === '--kind') { out.kinds.push(argv[++i]); continue; }
    if (!arg.startsWith('--')) return { error: `Unexpected argument "${arg}".` };
    const value = argv[++i];
    if (value === undefined) return { error: `Option "${arg}" needs a value.` };
    out[arg.slice(2)] = value;
  }
  return out;
}

const options = parse(process.argv.slice(2));
if (options.error) {
  process.stderr.write(`${options.error}\n\n${USAGE}`);
  process.exitCode = 2;
} else if (options.help) {
  process.stdout.write(USAGE);
} else {
  let client;
  try {
    client = new AtlasClient({
      baseUrl: options['base-url'] ?? 'http://127.0.0.1:8791',
      readToken: process.env[options['token-env'] ?? 'ATLAS_READ_TOKEN'] ?? ''
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (client) {
    const call = options.health
      ? client.health()
      : options.spaces
        ? client.spaces()
        : client.search({
            spaceId: options.space,
            query: options.query,
            recordId: options.id,
            kinds: options.kinds.length ? options.kinds : undefined,
            status: options.status,
            visibility: options.visibility,
            since: options.since,
            until: options.until,
            timeField: options['time-field'],
            limit: options.limit ? Number(options.limit) : undefined,
            offset: options.offset ? Number(options.offset) : undefined,
            order: options.order,
            includeContent: options['no-content'] ? false : undefined
          });
    const result = await call;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.transport !== 'RESPONDED' || !result.ok) process.exitCode = 1;
  }
}
