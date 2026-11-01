// 临时探针：in-process 复现 Atlas 服务 + GLM 适配器的写入同步。不属于交付面。
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const root = "<Memory Atlas checkout>";
const dataDir = root + "/data-alpha-test/probe-service";
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const serviceModule = await import(pathToFileURL(root + "/src/service.js").href);
const factory = await import(pathToFileURL(root + "/adapters/glm-retrieval.mjs").href);
process.env.ATLAS_GLM_MODULE = root + "/desktop/glm-retrieval/src/adapter.mjs";

const engine = await factory.createRetrievalAdapter({
  dataDir,
  derivedCacheDir: dataDir + "/derived-cache"
});
console.log("engine indexFile:", engine.indexFile, "isOpen:", engine.isOpen);

const authority = new serviceModule.NativeAuthority({ dataDir });
const svc = serviceModule.createMemoryService({
  authority,
  retrieval: engine,
  derivedCacheDir: dataDir + "/derived-cache"
});

await svc.createSpace({ spaceId: "t1" });
const receipt = await svc.record("t1", {
  recordId: "r1",
  kind: "experience",
  content: "和大学室友一起看了电影《流浪地球2》",
  source: { kind: "manual", id: "x" }
});
console.log("receipt:", JSON.stringify(receipt));

const direct = await engine.searchCandidates({ instanceId: "t1", q: "电影", limit: 10 });
console.log("direct engine search:", direct.totalCount, JSON.stringify((direct.candidates || []).map((c) => c.recordId)));

const view = await svc.search({ spaceId: "t1", query: "电影", limit: 10 });
console.log("svc.search:", JSON.stringify({
  searchPath: view.searchPath,
  outcome: view.outcome,
  indexState: view.index?.state,
  adapterTotal: view.index?.adapterTotalCount,
  records: (view.records || []).map((r) => r.recordId)
}));
authority.close();
engine.close();
