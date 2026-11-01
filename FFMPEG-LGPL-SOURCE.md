# FFmpeg (ffmpeg.dll) — LGPL Corresponding Source Statement

The `ffmpeg.dll` shipped in `MemoryAtlas-v0.1.0-alpha.1-win-x64.zip` is the
unmodified shared-library build distributed by the official
**Electron v43.3.0 win-x64** release. Chromium's aggregated licensing page
(`LICENSES.chromium.html`, shipped in this package) states that this build of
FFmpeg is licensed **LGPL-2.1-or-later**. This file documents where the
corresponding source is, and offers it under LGPL §6.

## Exact provenance chain (version-pinned)

| What | Where |
|---|---|
| Binary | `ffmpeg.dll` (3,067,904 bytes) from https://github.com/electron/electron/releases/tag/v43.3.0 — asset `electron-v43.3.0-win32-x64.zip` |
| Build configuration | https://github.com/electron/electron/blob/v43.3.0/build/args/release.gn — `is_component_ffmpeg = true` (FFmpeg is built as a shared library, which is why it appears as a separate redistributable DLL) |
| Chromium base | Electron v43.3.0 `DEPS` pins `chromium_version = 150.0.7871.212` (https://github.com/electron/electron/blob/v43.3.0/DEPS) |
| FFmpeg source revision | Chromium `DEPS` at tag `150.0.7871.212` pins `ffmpeg_revision = ad41607c61898cf7150e0fb20fe4bbabd44922a3` — i.e. https://chromium.googlesource.com/chromium/third_party/ffmpeg.git/+/ad41607c61898cf7150e0fb20fe4bbabd44922a3 (GitHub mirror: https://github.com/chromium/chromium/tree/150.0.7871.212 is the parent tree; the FFmpeg subtree is fetched separately per the `DEPS` entry `'src/third_party/ffmpeg'`) |
| Electron's FFmpeg patches at this tag | https://github.com/electron/electron/tree/v43.3.0/patches/ffmpeg (`link_with_loader_path.patch` and the `.patches` series file) |

## How to obtain the complete corresponding source

1. `git clone https://chromium.googlesource.com/chromium/third_party/ffmpeg.git`
   and `git checkout ad41607c61898cf7150e0fb20fe4bbabd44922a3`.
2. Apply Electron's FFmpeg patch series from
   `https://github.com/electron/electron/tree/v43.3.0/patches/ffmpeg`
   (the `.patches` file lists the order).
3. Build with the GN argument `is_component_ffmpeg = true` as configured in
   `https://github.com/electron/electron/blob/v43.3.0/build/args/release.gn`
   (see Electron's build instructions at
   https://github.com/electron/electron/blob/v43.3.0/docs/development/build-instructions.md).

All three links above are version-pinned and permanent; they identify the
exact source this binary was produced from.

## Written offer (LGPL-2.1 §6)

For any copy of this distribution you possess, the complete corresponding
source of `ffmpeg.dll` — as identified by the pinned revisions above — is and
remains publicly retrievable at zero charge through the permanent links above.
Should any link become unreachable during the copyright-relevant period, you
may request the source in writing and it will be provided on a medium
customarily used for software interchange at a charge no more than the cost
of distribution; contact via an issue on
https://github.com/sslbs09/memory-atlas/issues.

## Replacement

`ffmpeg.dll` is dynamically linked and loaded by name from the application
directory; replacing it with an LGPL-compatible FFmpeg build of your own is
technically straightforward and permitted by the LGPL.
