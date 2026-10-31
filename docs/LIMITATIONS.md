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

- Search is lexical substring matching over the whole space document. Chinese
  short terms, names, codes and stable ids work; synonyms and paraphrases do
  not. Recall quality beyond that is the retrieval backend's job.
- Time filtering is server-side and exhaustive (verified: a fixed 7-day window
  matched 12,502 of 50,000 and 25,004 of 100,000 records - the window narrows the
  whole history, not a page).
- No index is claimed when none is wired: `index.state` is `NOT_WIRED`.

## Concurrency

- Writes to the same space from **one process** are serialized and re-applied on
  conflict; verified 8 concurrent writes → 8 persisted (was 1 of 8 before the
  fix).
- Two processes over the same data directory are protected by compare-and-swap
  plus retry, which prevents silent loss but can end in a refused write after
  the retry budget. A multi-process deployment needs one writer per space, or a
  real transactional store. This is stated, not hidden.
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
