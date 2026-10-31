/**
 * adapters/glm-retrieval.mjs - a thin factory that attaches the WhiteMoon
 * retrieval index (Backend B, `glm-retrieval/src/adapter.mjs`) to Memory Atlas.
 *
 * It exists because the engine exports a class while the Atlas server asks a
 * module for a factory: pointing `--retrieval-module` straight at `adapter.mjs`
 * exits 1. This file is the whole bridge - about sixty lines, no logic.
 *
 * What it is: a derived, rebuildable index. It authors nothing. Atlas keeps the
 * only copy of what a memory actually is, and every answer still passes through
 * that store (src/retrieval.js), so this index can be deleted at any time and
 * rebuilt from the authoritative documents. Nothing here writes to a memory
 * space, and nothing outside the configured index file is touched.
 *
 * Configuration is explicit and comes from the environment:
 *   ATLAS_GLM_MODULE  path to glm-retrieval/src/adapter.mjs (or a file: URL)
 *   ATLAS_GLM_INDEX   optional SQLite path; defaults inside the derived cache dir
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function moduleUrl(specifier) {
  if (!specifier) {
    throw Object.assign(
      new Error('ATLAS_GLM_MODULE is not set. Point it at glm-retrieval/src/adapter.mjs, e.g. ' +
        'ATLAS_GLM_MODULE=<WhiteMoon repo>/work/universal-memory-v0.1\\glm-retrieval\\src\\adapter.mjs'),
      { code: 'ATLAS_GLM_MODULE_MISSING' });
  }
  if (/^file:/i.test(specifier)) return specifier;
  const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(process.cwd(), specifier);
  if (!fs.existsSync(absolute)) {
    throw Object.assign(new Error(`ATLAS_GLM_MODULE "${specifier}" is not readable at ${absolute}`),
      { code: 'ATLAS_GLM_MODULE_NOT_FOUND' });
  }
  return pathToFileURL(absolute).href;
}

export async function createRetrievalAdapter({ dataDir, derivedCacheDir } = {}) {
  const url = moduleUrl(process.env.ATLAS_GLM_MODULE ?? null);
  const imported = await import(url);
  const SearchAdapter = imported.SearchAdapter ?? (typeof imported.default === 'function' ? imported.default : null);
  if (typeof SearchAdapter !== 'function') {
    throw Object.assign(new Error(`${url} exports no SearchAdapter class`), { code: 'ATLAS_GLM_MODULE_INVALID' });
  }

  const indexFile = process.env.ATLAS_GLM_INDEX
    ? path.resolve(process.env.ATLAS_GLM_INDEX)
    : path.join(derivedCacheDir ?? path.join(dataDir ?? process.cwd(), 'derived-cache'), 'glm-retrieval-index.sqlite');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });

  const engine = new SearchAdapter({ path: indexFile });
  for (const method of ['searchCandidates', 'upsertRecords', 'removeRecords']) {
    if (typeof engine[method] !== 'function') {
      throw Object.assign(new Error(`GLM engine does not provide ${method}()`), { code: 'ATLAS_GLM_API_MISMATCH' });
    }
  }

  return {
    name: 'glm-retrieval',
    indexFile,
    sourceModule: url,
    // The Atlas side reads these two for its health report; they are read from the
    // engine, never assumed from the fact that an object was constructed.
    get indexGeneration() { return engine.indexGeneration; },
    get isOpen() { return engine.isOpen; },
    // DTO v1 surface, delegated unchanged: candidates out, ids back in.
    searchCandidates: (params) => engine.searchCandidates(params),
    upsertRecords: (records) => engine.upsertRecords(records),
    removeRecords: (ids) => engine.removeRecords(ids),
    // Backend B keeps a graph projection in the same SQLite transaction. Rebuilding
    // it is theirs; Atlas only asks after a crash, and never reads it as memory.
    recoverGraph: typeof engine.recoverGraph === 'function' ? () => engine.recoverGraph() : null,
    close: () => engine.close()
  };
}

export default createRetrievalAdapter;
