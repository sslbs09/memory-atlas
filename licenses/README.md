# Third-party license texts (full copies)

This directory holds the complete license texts of third-party code that this
project redistributes verbatim or bundles, as required by those licenses.
`THIRD_PARTY_NOTICES.md` in the repository root is the index and explains what
is used where.

| File | Component | License |
|---|---|---|
| `mcp-typescript-sdk-Apache-2.0.txt` | `@modelcontextprotocol/server` 2.4.0 (+ `@modelcontextprotocol/core`), bundled into `packages/memory-atlas-mcp/dist/atlas-mcp.mjs` and shipped as `resources/app/mcp/atlas-mcp.mjs` | Apache-2.0 (legacy contributions remain MIT; see the file's transition notice) |
| `3d-force-graph-v1.80.1-MIT.txt` | `3d-force-graph` v1.80.1 UMD bundle, vendored at `desktop/renderer/vendor/universe/3d-force-graph.min.js` | MIT © 2017 Vasco Asturiano |

## Components embedded inside the vendored 3d-force-graph v1.80.1 UMD

The upstream UMD bundle inlines its dependency graph. Upstream's dependency
declaration at v1.80.1 plus `three-forcegraph` 1.43.6's dependencies determine
what is inside. Permissive licenses; copyright and license lists follow.

| Component | License | Copyright |
|---|---|---|
| three.js (bundled into the UMD; upstream dependency `three >=0.179 <1`) | MIT | © 2010–2025 three.js authors |
| three-forcegraph 1.x | MIT | © Vasco Asturiano |
| three-render-objects 1.x | MIT | © Vasco Asturiano |
| kapsule 1.x | MIT | © Vasco Asturiano |
| accessor-fn 1.x | MIT | © Vasco Asturiano |
| d3-force-3d 2–3 | MIT | © Vasco Asturiano |
| d3-array, d3-scale, d3-scale-chromatic (1–4 ranges) | ISC | © Mike Bostock |
| tinycolor2 1.x | MIT | © Brian Grinstead |
| ngraph.graph 20.x | BSD-3-Clause | © Andrei Kashcha |
| ngraph.forcelayout 3.x | BSD-3-Clause | © Andrei Kashcha |

All MIT components use the same license text as
`3d-force-graph-v1.80.1-MIT.txt` with their own copyright lines. The ISC and
BSD-3-Clause texts are reproduced below once.

## ISC (d3-array, d3-scale, d3-scale-chromatic)

```
Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## BSD-3-Clause (ngraph.graph, ngraph.forcelayout)

```
Copyright (c) 2014-2023, Andrei Kashcha
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
