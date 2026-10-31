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
  "index": { "state": "NOT_WIRED", "coverage": "NOT_APPLICABLE" } }
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
| `IDEMPOTENT_DUPLICATE` | this identity was already on record; `duplicateOf` names the original (id, sequence, recordedAt) |
| `IDEMPOTENT_REPLAY` | the same `operationId` was already used; `recordId` is the original record and `status` its current standing |

A control against a record that is no longer active is refused with
`ATLAS_CONTROL_TARGET_INACTIVE` (409) and writes nothing. A retraction carries
no replacement content - use a correction for that, so a deletion cannot
smuggle in an unreviewed assertion.

`GET /atlas/operation?space=&operationId=` answers
`{ recorded, recordId, status, revision }`, so a client whose response was lost
can ask what happened instead of guessing.

## Time windows

`since` / `until` are evaluated on the server over the whole history, and
`timeField` names the clock: `timestamp` (default - the moment the record
entered history), `occurredAt` (when it happened), `recordedAt` (when it was
learned). The response echoes `timeField`. A record with no value for the chosen
clock is excluded rather than guessed in.

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
