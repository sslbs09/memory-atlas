# What belongs where

The instruction was to identify three things, not to move code around until it
looks generic. This is that classification, as actually implemented.

## 1. Generic Memory Service — now in Memory Atlas

Extracted into `<Memory Atlas repo>\src\` and runnable with no character runtime
present:

| concern | Atlas file | extracted from | what changed in the move |
|---|---|---|---|
| record shape + validation | `model.js` | Core `memory-control.js` readable/validate logic | character-specific payload labels (`主题`/`状态` rendering) dropped; content is one text field with an explicit source object |
| validity derivation | `model.js: deriveValidity` | Core `memoryHistory()` | same append-only semantics, renamed kinds (`correction`/`retraction` instead of a `memory-control` payload action) |
| durable persistence | `store.js` | Core `instance-store.js` | one document per **memory space** instead of per character instance; same atomic replace, same compare-and-swap, same bounded transient-rename retry |
| read view | `query.js` | Core `memory-query.js` | adds `visibility` and a named time clock; drops character vocabulary |
| operation receipts | `model.js: operationRecordId`, `service.js` | Host `memory-api.js` + Core control path | generalised: any append may carry an `operationId`, not only corrections |
| HTTP surface | `http.js` | Host `server.js` | two bearer capabilities renamed `read`/`write`; same loopback-only, same never-log-tokens-or-bodies rule |
| client | `client.js` | Host `clients/whitemoon-memory-client.mjs` | same transport rules; no authority-specific fields |

## 2. WhiteMoon-specific — stays in WhiteMoon, or is an adapter

- **The formal acceptance path.** WhiteMoon decides what becomes an accepted
  Experience through its ingress (`/integration-input`, the Adapter's
  `actionId`-derived ids). Atlas does not reimplement that: its native append is
  for Atlas-owned spaces, and the delegated adapter deliberately reports
  `write: false`.
- **Character semantics.** Identity, State, Relationship, the Character Package
  and its projection hooks, semantics-version gating, intent/observation
  lifecycle. None of it moved, none of it is duplicated.
- **The desktop surface.** The pet, its settings, the archive workbench window.
- **`src/adapters/whitemoon-host.js`** is the only place in Atlas that knows
  WhiteMoon exists, and it knows it as an HTTP protocol, not as imported code.

## 3. WhiteMoon Core's formal adjudication — untouched and not copied

`<WhiteMoon repo>/work/universal-memory-v0.1\whitemoon-core` remains the authority
for a WhiteMoon character: what was accepted, what a correction superseded, what
is currently effective, and what a client may be told. When Atlas talks to a
WhiteMoon space it asks, and reports the answer including the answer "I cannot
read this". It never caches a copy that could disagree later.

## Deliberately not done

- No shared-code extraction by moving files out of WhiteMoon. The v0.1 tree is
  the one that passed the correctness work; pulling its guts out would have made
  both trees untested at the same time.
- No second formal database. Atlas native spaces are a *different* system's
  memory, not a mirror of WhiteMoon's.
- No reverse dependency: `test/adapter.test.js` fails if anything in
  `src/` imports a character runtime, and that check was verified to actually
  fire when a fake import was added.
