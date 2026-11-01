/**
 * build.mjs — 把 MCP server 与它复用的 Atlas 客户端（../../src/client.js）
 * 打成单个无依赖 bundle：目标机器只需要一个 node.exe，不需要 npm install。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

mkdirSync(fileURLToPath(new URL('./dist/', import.meta.url)), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./src/index.mjs', import.meta.url))],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: fileURLToPath(new URL('./dist/atlas-mcp.mjs', import.meta.url)),
  banner: { js: '/*! memory-atlas-mcp — bundled with esbuild; includes Memory Atlas client (same repo) */' },
  logLevel: 'info'
});
