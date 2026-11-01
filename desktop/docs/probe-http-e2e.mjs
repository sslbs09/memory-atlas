// 临时探针：UTF-8 安全的 HTTP 端到端测试（写入→索引搜索→扫描搜索）。不属于交付面。
const PORT = process.argv[2] || "8795";
const base = `http://127.0.0.1:${PORT}`;
const READ = "rt123";
const WRITE = "wt123";

async function call(method, pathname, { params = {}, body = null, write = false } = {}) {
  const url = new URL(pathname, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + (write ? WRITE : READ),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return response.json();
}

const space = "t1";
console.log("record:", JSON.stringify(await call("POST", "/atlas/record", {
  write: true,
  body: {
    spaceId: space,
    record: {
      recordId: "r3",
      kind: "experience",
      content: "答应老陈月底前还书给他，约好周六交接",
      source: { kind: "manual", id: "alpha" }
    }
  }
})));

for (const q of ["电影", "还书", "老陈"]) {
  const view = await call("GET", "/atlas/search", { params: { space, q, status: "active", limit: 20 } });
  console.log(JSON.stringify({
    q,
    searchPath: view.searchPath,
    outcome: view.outcome,
    adapterTotal: view.index?.adapterTotalCount,
    records: (view.records || []).map((r) => ({
      id: r.recordId, score: r.score, coverage: r.coverage, reason: r.matchReason
    }))
  }));
}
