# Limitations, stated as measured

## Scale: 20 GB is NOT VALIDATED

The cumulative memory target is 20,000,000,000 bytes. Nothing in this repository
proves the current persistence shape reaches it. Measured on this machine
(Windows, Node 24, a local drive, synthetic records, probe
`<WhiteMoon repo>/work/universal-memory-v0.1\evidence\capacity-probe-a7.mjs`,
result `capacity-probe-a7-result.json`):

| records | space document | one write | parse whole document | full scan |
|---|---|---|---|---|
| 500 | 0.16 MiB | 6 ms | 1.1 ms | 7.7 ms |
| 2,000 | 0.63 MiB | 16.4 ms | 4 ms | 12.5 ms |
| 8,000 | 2.55 MiB | 52.8 ms | 13.1 ms | 45.3 ms |
| 20,000 | 6.40 MiB | 120.9 ms | 31.2 ms | 108.3 ms |
| 50,000 | 16.04 MiB | 321.3 ms | 84.5 ms | 260.9 ms |
| 100,000 | 32.11 MiB | **717.3 ms** | 255.3 ms | **970.7 ms** |

Write cost grows with the size of the document because every write replaces the
whole document: 119.5x the write time for 200x the records. Process RSS reached
694 MiB at 100,000 records.

What follows honestly:

- **20 GB SCALE NOT VALIDATED.** The probe stopped at 32 MiB per space. Reaching
  20 GB as one document per space is not supported by these numbers, and no
  linear extrapolation is offered as a substitute for measuring it.
- The target is **cumulative across spaces**, so many small spaces behave far
  better than one large one. That is a reason the limit is per-space document
  size, not total bytes - but the per-space ceiling is not measured either.
- Fixing this means changing persistence (segmented/append-only files, or a real
  index with a compact document), which is an architecture decision, not a
  patch. It is deliberately out of this round, whose subject was correctness.
- The capacity target is an **observation budget**. Reaching it never discards,
  truncates or refuses a record; `policy.autoDiscardOriginals` is `false` in the
  health response and there is no code path that deletes on threshold.

## Retrieval

- Search without an index is lexical substring matching over the whole space
  document. Chinese short terms, names, codes and stable ids work; synonyms and
  paraphrases do not.
- **A retrieval index can be attached** (`--retrieval-module`, see
  `docs/MEMORY-API.md`). It ranks; it does not admit. Every candidate is
  re-checked against the authoritative document, so an index that is stale,
  drifted or dishonest cannot serve a record the store would not serve - measured
  by `test/retrieval.test.js` (E4, E5, E14).
- The index is a projection, not a second memory: it is rebuilt from the store at
  start-up and reconciled after each accepted write, and its bytes are reported
  as `capacity.derivedCacheBytes`, separately from
  `capacity.authoritativeBytes` (E11). Deleting it loses speed only.
- Pagination over an index-assisted answer walks successive windows and stops at
  `RETRIEVAL_MAX_WINDOWS` (4). A page beyond that bound is reported by
  `index.windowCapReached` and `hasMore: true`, not as an empty end of the list.
- The candidate ceiling is the DTO's 200 per window. A space with far more
  effective matches than that, for one query, is narrowed by the walk limit rather
  than by relevance - stated here because the number is a real boundary.
- Time filtering is server-side and exhaustive (verified: a fixed 7-day window
  matched 12,502 of 50,000 and 25,004 of 100,000 records - the window narrows the
  whole history, not a page). On the index-assisted path the same window is applied
  to candidates after the authoritative re-read, never trusted from the index.
- A derived index holds a copy of the space's text - that is what makes matching
  fast. It is inside the operator's own cache directory, and it carries the same
  secrets as the store; deleting the store does not delete it until the projection
  is dropped, which is why a retraction removes the record from the index in the
  same request (E5).
- Attaching an index to a **delegated** authority (a WhiteMoon-backed space, whose
  records stay in that store) has not been run: the projection would copy another
  service's formal text into this directory's cache. Nothing here claims that
  combination works or is safe; the tested wiring is a native Atlas space.

## Concurrency

- Writes to the same space from **one process** are serialized and re-applied on
  conflict; verified 8 concurrent writes → 8 persisted (was 1 of 8 before the
  fix).
- **The compare-and-swap in `src/store.js` is not a cross-process guarantee, and
  the earlier claim that it was is retracted.** CAS checks the document digest
  and then renames; another process can rename inside that window, and the loser
  does not notice. Measured with two processes making 40 writes each into one
  data directory: **79 receipts were handed out, 73 records were on disk** (one
  `ATLAS_PERSIST_UNVERIFIED`). Acknowledged writes were lost, which is the one
  thing this service may not do.
- The boundary is therefore structural: **one data directory has one writer.**
  A second `SpaceStore`/`NativeAuthority` over the same directory is refused at
  construction with `ATLAS_WRITE_LOCK_HELD` and writes nothing, so it cannot
  hand out a receipt for something it did not store. `writer.lock` names the
  owning pid and start time; a lock left by a killed process is reclaimed and
  the takeover is announced on stderr rather than silent. Verified by
  `test/writer-lock.test.js` (L1-L5), including that two stores opened in one
  process share the write queue, and that a junction alias or a case-flipped
  spelling of the directory resolves to the same writer instead of starting a
  competing one.
- The lock is **cooperative**: it stops two Atlas writers, not a text editor or
  a hand-run script writing the JSON directly. For that case CAS remains as a
  second line of defence - it detects the collision, and the retry budget turns
  an unresolvable one into `ATLAS_SAVE_CONFLICT` / `ATLAS_PERSIST_UNVERIFIED`
  with the previous document intact. Multi-writer on one directory needs a real
  transactional store, which is out of scope and not claimed.
- A transient Windows sharing violation on rename (`EPERM`/`EBUSY`/`EACCES`) is
  retried with a bounded wait; exhausted retries fail as
  `ATLAS_PERSIST_FAILED` with the previous document intact.

## What this proves and what it does not

- Nothing here involves a model. No test in this repository demonstrates
  semantic understanding, paraphrase recall, or that a character "gets it".
  Fixed synthetic replies are not evidence of comprehension and are not counted
  as such.
- No user data was used. Every fixture is synthetic, written into a temporary
  directory, and deleted.
- The visual/UX layer is not this repository's claim; the archive workbench and
  the memory universe view live elsewhere and are judged on their own.
