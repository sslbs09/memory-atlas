# Third-Party Notices

This distribution includes third-party software. Each component is used under
the terms listed below. Full license texts ship inside the package next to the
binaries (`LICENSE`, `LICENSES.chromium.html`) and are reproduced here in
summary. This project is UNLICENSED pending an owner decision (see
LICENSE-CANDIDATES.md); the notices below govern the third-party components.

## Electron 43.3.0

- Used by: the desktop shell (`MemoryAtlas.exe`).
- License: MIT. Copyright (c) Electron contributors.
- Source: https://www.electronjs.org/ (built from https://github.com/electron/electron).
- The packaged directory includes Electron's own `LICENSE` and
  `LICENSES.chromium.html` (Chromium and bundled libraries licensing, including
  font and codec notices) verbatim.

## Node.js 24.22.2 (bundled runtime, `resources/app/runtime/node.exe`)

- Used by: the Atlas service child process and the MCP server under chat hosts.
- License: MIT. Copyright Node.js contributors.
- Source: official binary distribution from https://nodejs.org/dist/v24.22.2/
  (unmodified `node.exe`; the Node license and README ship alongside it as
  `node-LICENSE` / `node-README.md`).

## MCP TypeScript SDK (`@modelcontextprotocol/server` 2.4.0)

- Used by: `packages/memory-atlas-mcp` (bundled into `mcp/atlas-mcp.mjs`).
- License: MIT. Copyright (c) 2024 Anthropic, PBC and contributors.
- Source: https://github.com/modelcontextprotocol/typescript-sdk

## esbuild 0.28.2

- Used by: build tooling only (bundling the MCP server); not shipped as a
  runtime component.
- License: MIT. Copyright (c) 2020 Evan Wallace.

## zod 4.6.7

- Used by: MCP tool input schema validation (bundled into `mcp/atlas-mcp.mjs`).
- License: MIT. Copyright (c) 2020 Colin McDonnell.

## glm-retrieval (derived index engine)

- Used by: the optional retrieval index (`resources/app/glm-retrieval/`).
- Provenance: developed within this project's own engineering line (see
  `resources/app/PROVENANCE.md` and the WhiteMoon-referencing provenance notes
  in the repository history). Not a third-party component; its licensing
  follows the project license once decided.

## MIT license text (for the components above)

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
