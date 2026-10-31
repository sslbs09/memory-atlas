/**
 * writer-loop - child-process helper for the writer-lock test.
 *
 * Writes N records into one data directory and reports, as one JSON line, what
 * it acknowledged and whether it was refused the writer lock. Deliberately
 * prints no stack: the parent asserts on the summary.
 */
import { NativeAuthority, createMemoryService } from '../../src/service.js';

const [, , dataDir, tag, countArg] = process.argv;
const count = Number(countArg || 40);

const report = { tag, acknowledged: 0, lockRefused: false, lockCode: null, errors: [] };
try {
  const authority = new NativeAuthority({ dataDir });
  if (!authority.store.exists('race')) await authority.createSpace({ spaceId: 'race' });
  const service = createMemoryService({ authority });
  let announced = false;
  for (let i = 0; i < count; i += 1) {
    try {
      const receipt = await service.record('race', { recordId: `${tag}-${i}`, content: `${tag} 第 ${i} 条` });
      if (receipt.accepted) report.acknowledged += 1;
      // Two kinds of output line: this one is the synchronisation signal, the last
      // one is the report. A test that wants to kill a live writer has to know the
      // claim is really held - the lock file exists, names this pid, and at least
      // one record has landed - instead of guessing from a sleep or from the first
      // byte of stdout.
      if (!announced && receipt.accepted) {
        announced = true;
        process.stdout.write(`${JSON.stringify({ event: 'locked', tag, pid: process.pid,
          recordId: receipt.recordId, acknowledged: report.acknowledged })}\n`);
      }
    } catch (error) {
      report.errors.push(error.code ?? error.message);
    }
  }
  authority.close();
} catch (error) {
  if (error.code === 'ATLAS_WRITE_LOCK_HELD') {
    report.lockRefused = true;
    report.lockCode = error.code;
  } else {
    report.errors.push(error.code ?? error.message);
  }
}
process.stdout.write(`${JSON.stringify(report)}\n`);
