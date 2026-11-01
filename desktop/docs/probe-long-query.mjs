// 临时探针：长问句在 GLM 引擎上的匹配语义。不属于交付面。
import { pathToFileURL } from "node:url";

const engineModule = await import(pathToFileURL(path.resolve(root, "desktop/glm-retrieval/src/adapter.mjs")).href);
const SearchAdapter = engineModule.SearchAdapter;
const adapter = new SearchAdapter({ indexFile: path.join(root, "data-alpha-test/probe-long.sqlite") });

await adapter.upsertRecords([
  { recordId: "demo-movie", instanceId: "s", revision: 1, text: "和大学室友一起看了电影《流浪地球2》，散场后在路边摊聊到半夜。", status: "active", sourceKind: "synthetic-seed", sourceId: "x", occurredAt: new Date().toISOString(), acceptedAt: new Date().toISOString() },
  { recordId: "demo-chat", instanceId: "s", revision: 1, text: "昨天下午和同事临时商量了周一例会由谁来主持。", status: "active", sourceKind: "synthetic-seed", sourceId: "x", occurredAt: new Date().toISOString(), acceptedAt: new Date().toISOString() },
  { recordId: "demo-promise", instanceId: "s", revision: 1, text: "几个月前答应表妹生日时送她一本精装诗集，到现在还没有兑现。", status: "active", sourceKind: "synthetic-seed", sourceId: "x", occurredAt: new Date().toISOString(), acceptedAt: new Date().toISOString() }
]);

const queries = [
  "电影",
  "我以前看过什么电影？",
  "看过什么电影",
  "电影 流浪地球",
  "约定",
  "我有没有什么没兑现的约定"
];
for (const q of queries) {
  const r = await adapter.searchCandidates({ instanceId: "s", q, limit: 10 });
  console.log(JSON.stringify({ q, total: r.totalCount, ids: (r.candidates || []).map((c) => c.recordId), top: r.candidates?.[0]?.matchReason }));
}
await adapter.close();
