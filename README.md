# Memory Atlas

A standalone memory service. It remembers things, says where each memory came
from, keeps the record of what used to be believed, and lets a client ask what
currently stands.

It runs on its own: no desktop pet, no character runtime, no model, no build
step. Node 20+ and nothing else.

```
npm test                      # node --test "test/*.test.js" - see Verification below
node bin/atlas-demo.mjs       # full walkthrough against real HTTP on loopback
node bin/atlas-server.mjs --data-dir <Memory Atlas repo>Data --port 8791
node bin/atlas-server.mjs --retrieval-module ./my-index.mjs   # attach a derived index
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
