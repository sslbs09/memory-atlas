# Architecture & developer guide

Memory Atlas 的服务端架构、数据模型、检索索引与验证方式。产品介绍见根目录
[README](../README.md)（中文：[README.zh-CN](../README.zh-CN.md)）。

服务端只依赖 Node 20+，无构建步骤，无运行时第三方依赖。

```
npm test                      # node --test "test/*.test.js" - see Verification below
node bin/atlas-demo.mjs       # full walkthrough against real HTTP on loopback
node bin/atlas-server.mjs --data-dir D:\MemoryAtlasData --port 8791
node bin/atlas-server.mjs --retrieval-module ./my-index.mjs   # attach a derived index
node bin/atlas-server.mjs --retrieval-module ./adapters/glm-retrieval.mjs
                                                              # attach the GLM (Backend B) index;
                                                              # needs ATLAS_GLM_MODULE pointing at
                                                              # glm-retrieval/src/adapter.mjs
ATLAS_READ_TOKEN=... node bin/atlas-query.mjs --space mira --query 桂花
```

## What a record is

| field | meaning |
|---|---|
| `recordId` | stable identity. Supplied by the caller when the source event has one, so a replay lands on the same record |
| `spaceId` | the memory space it belongs to. Spaces are isolated: no query crosses them |
| `kind` | `experience` \| `observation` \| `note` \| `correction` \| `retraction` |
| `content` | what is remembered |
| `source` | where it came from: `{ kind, id?, href? }`. Absence is reported as absence |
| `visibility` | `private` \| `space` \| `shared` |
| `occurredAt` / `recordedAt` | when it happened vs. when it was learned - two different clocks, never conflated |
| `status` | `active` \| `superseded` \| `retracted` \| `recorded`, **derived** from the ordered history |
| `revision` | the history revision a query was judged against |

Nothing is overwritten. A correction appends; the earlier text stays readable
and is marked `superseded`. A retraction removes a fact from recall without
deleting its record or its source reference.

## Three rules the code enforces rather than recommends

1. **Duplication is decided by identity, never by text similarity.** The same
   sentence said twice is two events, and 「喜欢」/「不喜欢」 are never merged -
   similarity de-duplication silently eats corrections.
2. **A write answers with a receipt.** Supply an `operationId` and it resolves
   deterministically onto one record: retry after a lost response returns
   `IDEMPOTENT_REPLAY`, and `/atlas/operation` tells you what actually landed.
3. **An unreadable source is `SOURCE_UNAVAILABLE`, never an empty result.**
   Damage and forgetting are different facts and get different answers.

## Recall vs. audit

Search defaults to `status: active` - what currently stands. The audit view is
explicit (`status=all`). A retrieval index may rank candidates but may not admit
them: candidates are identifiers only, and every one is re-read through the
authority and filtered by space, validity, kind and time before it is shown.

`adapters/glm-retrieval.mjs` is the shipped factory for Backend B's index. It
exists because the engine exports a class while `--retrieval-module` asks a
module for a `createRetrievalAdapter` (or `default`) factory; the factory reads
`ATLAS_GLM_MODULE` (the engine's `src/adapter.mjs`) and `ATLAS_GLM_INDEX`
(optional SQLite path, default inside the data dir's `derived-cache/`). The
index is derived data: the store always admits, and deleting the SQLite file
loses nothing but speed. If a sync or rebuild fails, that ONE space's index is
taken out of service - answers come from the authoritative scan and say so
(`searchPath: atlas-authoritative-scan`, `index.state: INDEX_INVALID`,
`recovery: reindex`) - and only a complete reindex restores index service. A
later successful write does not restore trust, and neither does a restart: the
startup rebuild must complete first.

## Authorities

`src/service.js` talks to an authority, not to a file format:

- `NativeAuthority` (default) - Atlas owns the records. This is the standalone
  path.
- `src/adapters/whitemoon-host.js` - delegates to a WhiteMoon Runtime Host over
  its documented Memory API. WhiteMoon Core keeps adjudicating Identity,
  accepted Experience, State and Relationship; Atlas reads and controls through
  it and copies nothing into a second database.

The adapter speaks HTTP only. Nothing in `src/` imports anything from a
character runtime, and `test/adapter.test.js` fails if that ever stops being
true.

## Layout

```
src/model.js      record shape, validation, derived validity, operation ids
src/store.js      per-space JSON documents: atomic replace, compare-and-swap,
                  one writer per data directory, bounded retry for transient
                  Windows lock failures
src/query.js      the read view: keyword / id / kind / status / visibility /
                  time window / pagination, and the outcome vocabulary
src/service.js    the Memory Service and the native authority
src/retrieval.js  the SEARCH-DTO-v1 seam: an attached index ranks, the store admits
src/http.js       the unified Memory API (loopback, two bearer capabilities)
src/client.js     standalone Node client - no Electron, no harness
src/adapters/     delegated authorities (WhiteMoon Host over HTTP)
adapters/         retrieval factories for --retrieval-module (the GLM index)
bin/              server, query CLI, demo
test/             the suite: `node --test "test/*.test.js"`
docs/             API contract, extraction map, limitations
```

## Honest limits

Read `docs/LIMITATIONS.md` before planning on scale. In short: one JSON document
per space is rewritten on every write, measured at 717 ms per write and 971 ms
per scan at 100,000 records / 32 MiB, so the cumulative 20 GB target is
**NOT VALIDATED** at that size. A data directory has **one writer process**; a
second service pointed at the same directory is refused at startup rather than
allowed to double-acknowledge writes. No model is involved anywhere here, so
nothing in this repository demonstrates semantic understanding.

## 从源码构建 Windows Portable

各子包按序安装依赖：

```bash
npm install                                        # 根包（核心服务，零运行时依赖）
cd packages/memory-atlas-mcp && npm install        # MCP SDK + esbuild + zod
```

打包脚本（`node release/package-portable.mjs`）需要一个构建期输入：官方
Node v24.22.2 win-x64 运行时压缩包，放到 `release/vendor/`（该目录不入库）：

- 下载：https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip
- SHA-256（官方 SHASUMS256.txt 值）：
  `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`

Electron 43.3.0 由 `@electron/packager` 在打包时自动下载（可用 `ELECTRON_MIRROR` 换镜像）。

```bash
node release/package-portable.mjs                  # 产物 release/dist/…-win-x64.zip
node release/verify-portable.mjs                   # 全新目录 36 项验证
node evidence/release-interop/verify-core-flow.mjs # 核心流程 13 项
node evidence/release-interop/cross-client.mjs     # 三客户端一致性实验
```

## License

MIT — see [LICENSE](LICENSE). Third-party components keep their own licenses:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with full texts in
[`licenses/`](licenses/README.md). FFmpeg corresponding-source statement:
[FFMPEG-LGPL-SOURCE.md](FFMPEG-LGPL-SOURCE.md).
