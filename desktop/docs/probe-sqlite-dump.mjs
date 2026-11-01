// 临时探针：直接读派生索引 SQLite 的文档表。不属于交付面。
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const db = new DatabaseSync(file);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("tables:", tables.map((t) => t.name).join(", "));
for (const t of ["documents", "docs", "records"]) {
  try {
    const rows = db.prepare(`SELECT * FROM ${t} LIMIT 5`).all();
    console.log(`${t} count:`, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    for (const row of rows) console.log(`  ${t}:`, JSON.stringify(row).slice(0, 300));
  } catch { /* 表不存在 */ }
}
db.close();
