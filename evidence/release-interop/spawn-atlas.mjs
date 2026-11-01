/**
 * spawn-atlas.mjs — 测试辅助：以子进程启动 atlas-server（stdin 保持打开），
 * 等待就绪行，返回 { child, port, readToken, writeToken, endpointFile, stop() }。
 * 仅用于发行验证脚本；不是产品代码。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function spawnAtlas({ dataDir, port = 0, repoRoot }) {
  const readToken = randomBytes(8).toString('hex');
  const writeToken = randomBytes(8).toString('hex');
  const child = spawn(process.execPath, [
    path.join(repoRoot, 'bin', 'atlas-server.mjs'),
    '--data-dir', dataDir,
    '--port', String(port),
    '--retrieval-module', path.join(repoRoot, 'adapters', 'glm-retrieval.mjs')
  ], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ATLAS_GLM_MODULE: path.join(repoRoot, 'desktop', 'glm-retrieval', 'src', 'adapter.mjs'),
      ATLAS_READ_TOKEN: readToken,
      ATLAS_WRITE_TOKEN: writeToken
    }
  });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(String(c)));
  const endpointFile = path.join(dataDir, 'endpoint.json');
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('atlas not ready in 30s: ' + stderr.join(''))), 30000);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx).trim();
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'listening') {
          clearTimeout(timer);
          resolve({ port: parsed.port, index: parsed.index });
        }
      } catch { /* not the ready line */ }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('atlas exited early code=' + code + ': ' + stderr.join(''))); });
  });
  return { child, ready, readToken, writeToken, endpointFile,
    stop: () => new Promise((resolve) => {
      child.stdin.end();
      child.once('exit', resolve);
      setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5000);
    }) };
}
