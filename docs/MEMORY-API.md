# Memory API contract (Atlas v0.1)

Loopback HTTP, JSON, two bearer capabilities. `read` cannot write; `write` is
required for every mutation. There is no unauthenticated write path and no
unauthenticated data path (`/health` returns a name and a version only).

## Endpoints

| method | path | token | purpose |
|---|---|---|---|
| GET | `/health` | none | liveness: `{ ok, service, version }` |
| GET | `/atlas/health` | read | capacity, spaces, source and index state |
| GET | `/atlas/spaces` | read | list memory spaces |
| POST | `/atlas/spaces` | write | create a memory space |
| POST | `/atlas/record` | write | append a record |
| POST | `/atlas/correct` | write | append a correction of one record |
| POST | `/atlas/retract` | write | append a retraction of one record |
| GET | `/atlas/search` | read | query one space |
| GET | `/atlas/detail` | read | one record plus its correction neighbourhood |
| GET | `/atlas/operation` | read | what a caller-owned operation id actually did |
| GET | `/atlas/feedback` | read | review signals for a space (`status=pending\|dismissed\|actioned\|all`) |
| POST | `/atlas/feedback` | write | flag a record `useful`/`incorrect` (a report, not a verdict) |
| POST | `/atlas/feedback/resolve` | write | dismiss a signal or mark it actioned |

## Search parameters

`space` (required), `q`, `id`, `kind` (repeatable), `status`, `visibility`,
`since`, `until`, `timeField`, `limit` (max 200), `offset`, `order`, `content`.

An unknown parameter is refused with `ATLAS_QUERY_INVALID` naming it. A filter
that a server does not understand is never dropped silently - that is how a
renamed parameter turns into an unnarrowed result that looks filtered.

`status` defaults to `active`. The response echoes what ran:

```json
{ "outcome": "MATCHED", "appliedFilters": { "status": "active", "visibility": "all" },
  "timeField": null, "revision": 3,
  "totalCount": 2, "limit": 50, "offset": 0, "returned": 2, "hasMore": false,
  "records": [ ... ],
  "counts": { "total": 4, "active": 2, "effective": 1, "superseded": 1, "retracted": 0 },
  "searchPath": "atlas-authoritative-scan",
  "index": { "state": "NOT_WIRED", "reason": null } }
```
```

## Outcomes

| outcome | meaning | HTTP |
|---|---|---|
| `MATCHED` | found | 200 |
| `NO_MATCH` | the source was read in full and nothing matched | 200 |
| `SOURCE_UNAVAILABLE` | the source could not be read - space missing, document corrupt, authority unreachable | 503 |
| `UNINDEXED` | a derived index does not cover this yet; no claim is made either way | 200 |

`NO_MATCH` and `SOURCE_UNAVAILABLE` must never be rendered the same way. That
distinction is the point.

## Write receipts

```json
POST /atlas/record { "spaceId": "mira", "record": { ... }, "operationId": "op-1" }
→ { "ok": true, "accepted": true, "outcome": "RECORDED", "spaceId": "mira",
    "recordId": "tea", "sequence": 1, "recordedAt": "...", "revision": 1, "operationId": "op-1" }
```

| outcome | meaning |
|---|---|
| `RECORDED` | newly appended |
| `IDEMPOTENT_DUPLICATE` | this identity was already on record **with the same semantics**; `duplicateOf` names the original (id, kind, sequence, recordedAt, aboutRecordId). **Atlas answers 200 here; WhiteMoon's `POST /experience` answers 409 with the same `duplicateOf` body** - the two services differ on this one point because WhiteMoon's 409 is a pre-existing contract it may not quietly relax |
| `IDEMPOTENT_REPLAY` | the same `operationId` was already used **for the same operation**; the answer is the original receipt, and the archive still holds one row |

A receipt is only replayed when the submission means the same thing. Identity is
checked field by field - `kind`, `content`, `visibility`, `aboutRecordId`,
`occurredAt`, `source` and `attributes` - never by text similarity, so 「喜欢」
and 「不喜欢」 stay two records and a reused id carrying different content is a
refusal, not a success:

| code | status | meaning |
|---|---|---|
| `ATLAS_IDENTITY_CONFLICT` | 409 | `recordId` already exists with different content or a different source (no `operationId` was supplied). `differingFields` names the fields, `duplicateOf` names the incumbent. Nothing is written and the incumbent is unchanged |
| `ATLAS_OPERATION_CONFLICT` | 409 | `operationId` was already used for a different action, target or content. Reusing an operation id cannot smuggle a second operation into the first one's receipt |

The caller's remedy differs from a duplicate: mint a new identity, or send a
`correct` control against the existing record - do not resend the same id with
new text.

A control against a record that is no longer active is refused with
`ATLAS_CONTROL_TARGET_INACTIVE` (409) and writes nothing. A retraction carries
no replacement content - use a correction for that, so a deletion cannot
smuggle in an unreviewed assertion.

`GET /atlas/operation?space=&operationId=` answers
`{ recorded, recordId, status, revision }`, so a client whose response was lost
can ask what happened instead of guessing.

## Feedback (review signals)

Feedback is a governance side-channel, kept apart from the facts: an agent (or a
person) flags a record, and a human decides the outcome. Writing feedback never
changes a record's status, never enters search, and never becomes a memory.
*"The agent may report; only the person may convict."*

```
POST /atlas/feedback { "spaceId": "mira", "recordId": "dentist",
                       "signal": "incorrect", "note": "month may be wrong",
                       "source": { "kind": "mcp", "id": "agent" } }
→ { ok, feedbackId, type: "feedback", signal, createdAt, ... }
```

- `signal` is `useful` or `incorrect`; `note` ≤ 1000 chars; the target record must
  exist (`ATLAS_FEEDBACK_TARGET_MISSING`, 409) but may be in any validity state.
- Storage is append-only JSONL under `<dataDir>/feedback/<spaceId>.jsonl`. A
  resolution is a second appended entry; current state is replayed from the log.
- `GET /atlas/feedback?space=&status=` lists signals (default `pending`; also
  `dismissed`, `actioned`, `all`), newest first.
- `POST /atlas/feedback/resolve { spaceId, feedbackId, resolution, by }` closes a
  signal (`dismissed` or `actioned`). A successful `correct`/`retract` on the
  target record auto-marks its pending signals `actioned`.
- The desktop surfaces pending signals in the manage view (open / dismiss); the
  MCP tool `atlas_feedback` (write-gated) is how agents submit them.

## Time windows

`since` / `until` are evaluated on the server over the whole history, and
`timeField` names the clock: `timestamp` (default - the moment the record
entered history), `occurredAt` (when it happened), `recordedAt` (when it was
learned). The response echoes `timeField`. A record with no value for the chosen
clock is excluded rather than guessed in.

## Retrieval adapter (SEARCH-DTO-v1)

Atlas can attach a derived index. The adapter is any module exporting
`createRetrievalAdapter({ dataDir, derivedCacheDir })`, wired at start-up:

```
node bin/atlas-server.mjs --data-dir <dir> --retrieval-module ./my-index.mjs
{"event":"listening","port":…,"index":{"state":"REBUILT","engine":"…","spaces":[{"spaceId":"mira","synced":true,"upserted":12,"removed":1}]}}
```

The engine is spoken to with **SEARCH-DTO-v1**, the same contract as the WhiteMoon
Runtime Host, so one index implementation serves either service. What Atlas sends:
`instanceId` (the space - always), `q` (canonical keyword field, only when
non-blank), `recordId`, `since`/`until`, `limit` (overfetch by 4, clamped to the
DTO ceiling of 200) and `offset`. What it never sends: `query` (Core's synonym,
which the DTO refuses when it disagrees with `q`), `cursor` (mutually exclusive
with `offset`), `status`, `kinds`, `types` or `visibility` - the DTO's `types` is a
source-kind whitelist, not a record kind, and filtering the wrong axis loses right
answers while looking like a narrowing.

What comes back is reduced to identifiers and ranking. A candidate contributes
`recordId`, `score`, `matchReason` (an array, as frozen), `coverage`,
`indexRevision` and `indexState`; any `text`, adapter internals, or a
response-level `coverage` claim is discarded, because content is the store's to
hand out. A candidate whose `indexState` is not `INDEXED` is refused by name.

| `index.state` | meaning |
|---|---|
| `NOT_WIRED` | no adapter attached; the exhaustive scan answered |
| `NOT_APPLICABLE` | an adapter is attached but cannot represent this question (`index.reason` says which: `NON_ACTIVE_VIEW_NOT_INDEXED`, `NO_INDEXABLE_TERM`, `ORDER_REQUESTED`, `KEYWORD_AND_EXACT_ID`) |
| `WIRED` | candidates ranked the answer; membership was still decided by the store |
| `INDEX_REBUILDING` | the index is rebuilding and answered nothing, so the store did |
| `ADAPTER_FAILED` / `ADAPTER_REFUSED` | the index threw / rejected the request shape; the store answered anyway, and `index.fault.code` names it |

Served records on the wired path carry `score`, `matchReason`, `coverage`,
`indexRevision` and `indexStale`. `index.residue` lists every candidate that was
offered and refused, with the reason (`NOT_IN_FORMAL_HISTORY`, `NOT_EFFECTIVE`,
`KIND_FILTERED`, `VISIBILITY_FILTERED`, `TIME_FILTERED`, `STALE_PROJECTION`), and
`index.rejectedCandidates` lists candidates refused before the store was consulted.
Deep pages are reached by walking successive index windows (`index.windows`,
`index.windowCapReached`) - a bounded walk that announces its own bound through
`hasMore` rather than claiming a complete listing.

## Relationship to the WhiteMoon Memory API

The two surfaces are deliberately the same shape, so one client can talk to
either and a future Linux server can serve both without clients changing:

| Atlas | WhiteMoon Runtime Host |
|---|---|
| `GET /atlas/search` | `GET /memory-search` |
| `GET /atlas/detail` | `GET /memory-detail` |
| `GET /atlas/operation` | `GET /memory-operation` |
| `GET /atlas/health` | `GET /memory-health` |
| `POST /atlas/correct` / `/atlas/retract` | `POST /memory-control` (`action: correct\|retract`) |
| `spaceId` | `instanceId` |
| `recordId` | `recordId` |
| `kind: correction\|retraction` | `recordType: memory-control` + `action` |
| `source: {kind,id}` | `origin: {type,actionId}` |
| `status` | `status` (same four values) |

Differences that matter: WhiteMoon additionally exposes `/memory-inspect` (its
full formal view) and `/character-projection`; Atlas additionally exposes space
creation and bare record append, which WhiteMoon reserves to its own ingress
path. `src/adapters/whitemoon-host.js` performs this mapping and is the only
place in Atlas that knows WhiteMoon exists.
