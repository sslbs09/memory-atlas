# Changelog

All notable changes to Memory Atlas are documented here. Dates are ISO 8601.

## [Unreleased]

- Changed: README rebuilt for first-time readers (download, two-minute tutorial,
  agent connection configs, honest capability table, real screenshots and a
  screen-capture GIF from synthetic data). The previous developer-oriented
  README moved to `docs/ARCHITECTURE.md`.
- Changed: desktop interaction rework. Writing a record now auto-refreshes the
  list and selects it (the manual "refresh list" step is gone). Space creation
  is a permanent ＋ entry next to the space dropdown, also reachable from the
  capture panel (fixes #1). Retract asks for a second click within 4 s.
  Capture/space/service panels close on Esc or an outside click, restore focus,
  and no longer reset when their toolbar button is clicked again. `n` opens the
  capture panel; ↑/↓ (and j/k) navigate the result list with the selected row
  kept in view. Atlas mode shows one live connection indicator (30 s service
  poll) instead of two. An empty space guides you to write the first record.
  zh/en/ja strings updated.
- Added: `--selfcheck demo` media driver over the real UI (9 frames, synthetic
  alpha-demo data only). The flow selfcheck now asserts the new interaction
  paths: 10 UI regression checks (shortcut, Esc, auto-select, two-step retract,
  permanent space creation, outside-click close).
- Changed: full visual redesign of the workbench ("reading room"): a 216px
  sidebar with brand, space switcher and labelled navigation replaces the
  single-character rail; the top bar carries a view title plus telemetry;
  larger type scale (14px base, 11px labels, 12px mono IDs); status-colored
  record rows and correction-chain timeline; cinnabar/amber stamps for changed
  records; light and dark themes reworked. All element IDs, test hooks and the
  universe view are unchanged; demo and flow selfchecks pass on both themes.
- Added: `docs/MNEMOSYNE-INTEROP.md` — study of canyueY/dsh-mnemosyne: shared
  trust philosophy, capability gaps, ranked absorption proposals (agent
  feedback channel, token-budget context tool), DSH 0.2.1 host contract notes,
  and read-only interop boundaries. Research only; no runtime integration.

## [0.1.0-alpha.1] — 2026-11-01

First distributable Alpha: Windows portable build + unified MCP bridge.

### Added

- **Windows portable packaging** (`release/package-portable.mjs`): Electron 43.3.0 shell + official Node 24.22.2 runtime + Atlas service + GLM retrieval adapter + MCP server bundle in one zip. No system Node/npm required on target machines; user data never written into the install directory.
- **Endpoint discovery contract**: `bin/atlas-server.mjs` publishes `<dataDir>/endpoint.json` (loopback URL, per-boot tokens, pid, bootId) on listen and removes it on graceful shutdown — the join point for MCP bridges that never saw the ready line. Crash-left files are stale by construction; readers verify via `/atlas/health`.
- **Unified MCP server** (`packages/memory-atlas-mcp`, MCP TypeScript SDK v2.4.0): `atlas_health` / `atlas_search` / `atlas_get` always; `atlas_remember` / `atlas_correct` / `atlas_retract` only with `MEMORY_ATLAS_ALLOW_WRITES=1`. One authorized space per instance (`MEMORY_ATLAS_SPACE`); the model cannot choose spaces. Discovers the running Atlas via `endpoint.json` (bootId-tracked) or explicit `MEMORY_ATLAS_URL`/tokens. esbuild-bundled to a single zero-dependency `dist/atlas-mcp.mjs`.
- **Bundled runtime support in the desktop shell**: `AtlasService` prefers the package's own `runtime/node.exe` over PATH; `main.mjs` resolves the service tree inside the packaged layout; packaged self-check screenshots go to the OS temp dir.
- **Interoperability evidence suite** (`evidence/release-interop/`): core-flow (13 checks), DSH overlay + session-log tool-registration evidence, MaiBot MCPConnection runs, and the three-client consistency experiment (23 checks).
- Release documentation: release notes, verification report, install & usage guide (zh-CN), MCP integration guide (zh-CN), third-party notices, license candidates.

### Changed

- Desktop provenance comments no longer embed developer-machine absolute paths; the unwired `glm-retrieval/src/integrations` helpers are excluded from the shipped package. `desktop/PROVENANCE.md` references upstreams by repository-relative descriptions instead of local disk paths.

### Verified

- Portable fresh-dir verification: **31/31** (`release/verify-portable.mjs`).
- MCP protocol tests over real stdio: **7/7**.
- Core service suite: **51 pass / 0 fail / 6 skipped**.
- Three-client consistency experiment: **23/23**.

### Not tested / not validated (honesty section)

- Real-model tool-use loops (DSH account had no model quota — AUTH 403; MaiBot chat loop requires a live instance and was not started).
- 20 GB scale (deliberately not re-run this round).
- Synonym retrieval: lexical index does not bridge 约定→答应; `NO_MATCH` is reported honestly.

## [0.1.0] and earlier

Pre-release development (see git history on `master` and the Alpha/QA branches).
