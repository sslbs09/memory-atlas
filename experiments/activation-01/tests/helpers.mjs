// 测试辅助：临时文件路径。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function mktemp(name) {
  const dir = mkdtempSync(join(tmpdir(), 'activation-01-'));
  return join(dir, name);
}
