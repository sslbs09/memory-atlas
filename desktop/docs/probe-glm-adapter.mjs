// 临时探针：直接驱动 GLM 适配器，隔离 Atlas 与引擎之间的同步问题。不属于交付面。
import { pathToFileURL } from "node:url";

const adapterUrl = pathToFileURL(path.resolve(root, "desktop/glm-retrieval/src/adapter.mjs")).href;
const engineModule = await import(adapterUrl);
const SearchAdapter = engineModule.SearchAdapter ?? engineModule.default;

const indexFile = path.join(root, "data-alpha-test/probe-index.sqlite");
const adapter = new SearchAdapter({ indexFile });
await adapter.open?.();

const record = {
  recordId: "r1",
  instanceId: "t1",
  revision: 1,
  text: "和大学室友一起看了电影《流浪地球2》",
  status: "active",
  sourceKind: "manual",
  sourceId: "x",
  occurredAt: new Date().toISOString(),
  acceptedAt: new Date().toISOString()
};

try {
  await adapter.upsertRecords([record]);
  console.log("upsert ok");
} catch (error) {
  console.log("upsert FAILED:", error.code, error.message);
}

for (const q of ["电影", "流浪", "流浪地球"]) {
  const result = await adapter.searchCandidates({ instanceId: "t1", q, limit: 10 });
  console.log(JSON.stringify({ q, indexState: result.indexState, outcome: result.outcome, total: result.totalCount, candidates: (result.candidates || []).map((c) => ({ id: c.recordId, score: c.score, reason: c.matchReason })) }));
}
await adapter.close?.();
