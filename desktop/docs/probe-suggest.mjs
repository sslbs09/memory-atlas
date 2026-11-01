// 临时探针：隔离 suggestKeywords 的行为。不属于交付面。
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = await import(pathToFileURL(root + "/desktop/activation-explain.mjs").href);

// 用与 main.mjs 相同的 rawSearch 实现，指向一个手动的 Atlas（这里用 8795 之类外部端口时改这里）。
// 为了自包含：直接在进程内搭一个最小 Atlas service。
import fs from "node:fs";
import path from "node:path";
const dataDir = root + "/data-alpha-test/probe-suggest";
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const serviceModule = await import(pathToFileURL(root + "/src/service.js").href);
const authority = new serviceModule.NativeAuthority({ dataDir });
const svc = serviceModule.createMemoryService({ authority, derivedCacheDir: dataDir + "/derived-cache" });
await svc.createSpace({ spaceId: "alpha-demo" });
await svc.record("alpha-demo", { recordId: "demo-movie", kind: "experience", content: "和大学室友一起看了电影《流浪地球2》，散场后在路边摊聊到半夜。", source: { kind: "synthetic-seed", id: "alpha-01-acceptance" } });

async function rawSearch(params) {
  // 复刻 main.mjs 的调用面：HTTP 层把 q→query、content=1→includeContent
  const options = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "space") continue;
    if (k === "q") options.query = v;
    else if (k === "content") options.includeContent = String(v) === "1";
    else options[k] = v;
  }
  const view = await svc.search({ spaceId: params.space, ...options });
  return { payload: view };
}

const ledgerStub = { events: () => [] };
const explain = await mod.createActivationExplain({ repoRoot: root, ledger: ledgerStub, rawSearch });

const suggested = await explain.suggestKeywords("alpha-demo", "我以前看过什么电影？");
console.log("suggest:", JSON.stringify(suggested, null, 1));

const explainResult = await explain.explainSearch({
  spaceId: "alpha-demo",
  query: "电影",
  raw: (await rawSearch({ space: "alpha-demo", q: "电影", status: "active", limit: 20 })).payload
});
console.log("explain rows:", JSON.stringify(explainResult.rows?.map((r) => ({ id: r.recordId, rankBy: r.rankBy, tier: r.tier, evidenceClass: r.evidenceClass })), null, 1));
console.log("refused:", JSON.stringify(explainResult.refused));
authority.close();
