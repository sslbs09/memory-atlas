# Third-Party Notices

This distribution includes third-party software. Each component remains under
its own license; the MIT license of this project (`LICENSE`) covers only the
original content of Memory Atlas and does not relicense any third-party
component. Complete license texts that must accompany redistributions live in
the [`licenses/`](licenses/README.md) directory (also shipped in the Windows
package under `licenses/`).

## Runtime components in the Windows package (`MemoryAtlas-v0.1.0-alpha.1-win-x64.zip`)

### Electron 43.3.0 — MIT

Used by the desktop shell (`MemoryAtlas.exe`). Copyright (c) Electron
contributors. Source: https://github.com/electron/electron/tree/v43.3.0.
Electron's own `LICENSE` and Chromium's aggregated
`LICENSES.chromium.html` ship verbatim at the package root; the latter covers
Chromium and its bundled libraries (including font and codec notices).

### FFmpeg (`ffmpeg.dll`, built by Electron as a shared library) — LGPL-2.1-or-later

The `ffmpeg.dll` in the package is the unmodified build shipped by the
official Electron v43.3.0 win-x64 distribution; the corresponding LGPL
obligations are satisfied per
[FFMPEG-LGPL-SOURCE.md](FFMPEG-LGPL-SOURCE.md) (version-pinned corresponding
source, patches, build configuration, and a written offer). The LGPL-2.1 text
itself ships in the package inside `LICENSES.chromium.html`. Because the
library is dynamically linked, you may replace `ffmpeg.dll` with a
LGPL-compatible build of your own.

### Node.js 24.22.2 (bundled runtime, `resources/app/runtime/node.exe`) — MIT

Copyright Node.js contributors. This is the unmodified official binary
distribution from https://nodejs.org/dist/v24.22.2/; the Node license and
README ship alongside it as `node-LICENSE` / `node-README.md`.
Source: https://github.com/nodejs/node/blob/v24.22.2/

### MCP TypeScript SDK (`@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/core` 2.4.0) — Apache-2.0

Bundled into `resources/app/mcp/atlas-mcp.mjs` (and built from
`packages/memory-atlas-mcp`). **Note:** earlier drafts of this file wrongly
called the SDK "MIT"; the actual license of the 2.4.0 packages is Apache-2.0,
with contributions whose relicensing consent was not obtained remaining under
MIT — see the complete license and transition notice in
[`licenses/mcp-typescript-sdk-Apache-2.0.txt`](licenses/mcp-typescript-sdk-Apache-2.0.txt).
Source: https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.4.0

### 3d-force-graph v1.80.1 (vendored UMD) and its embedded dependencies — MIT and friends

`desktop/renderer/vendor/universe/3d-force-graph.min.js` is a verbatim copy of
the upstream `dist/3d-force-graph.min.js` at v1.80.1 (see
`desktop/PROVENANCE.md`), which inlines its dependency graph. License and
copyright for the bundle: MIT, Copyright (c) 2017 Vasco Asturiano — full text
in [`licenses/3d-force-graph-v1.80.1-MIT.txt`](licenses/3d-force-graph-v1.80.1-MIT.txt).
Components embedded inside that UMD (per upstream's dependency declarations at
v1.80.1): three.js (MIT, © 2010–2025 three.js authors), three-forcegraph,
three-render-objects, kapsule, accessor-fn, d3-force-3d (MIT, © Vasco
Asturiano), d3-array / d3-scale / d3-scale-chromatic (ISC, © Mike Bostock),
tinycolor2 (MIT, © Brian Grinstead), ngraph.graph / ngraph.forcelayout
(BSD-3-Clause, © Andrei Kashcha). Full texts and the dependency table:
[`licenses/README.md`](licenses/README.md).
Source: https://github.com/vasturiano/3d-force-graph/tree/v1.80.1

## Build-time-only components (not shipped as runtime parts)

| Component | License | Notes |
|---|---|---|
| esbuild 0.28.2 | MIT | Bundles the MCP server; © 2020 Evan Wallace |
| zod 4.6.7 | MIT | MCP tool input schemas; bundled into `atlas-mcp.mjs` |
| @electron/packager | MIT | Release packaging tool |

## glm-retrieval (derived index engine)

Developed within this project's own engineering line (see
`desktop/PROVENANCE.md` for provenance and version references). Not a
third-party component; licensed under the project license.

## Chromium aggregated licensing

`LICENSES.chromium.html` (package root) is the authoritative aggregated notice
for Chromium and the libraries inside the Electron binaries, including the
FFmpeg LGPL-2.1 text referenced above.

## MIT license text (for the MIT components above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
