# Implementation verification

- Version: 1.5.21; source, built metadata and README are consistent.
- `npm run verify`: passed build, syntax, version check and all 87 tests (72 existing, 15 new).
- New tests cover exact timing/blend plan reuse, partial-frame pause/resume, bounded cache memory, decoder/bitmap cancellation and cleanup, late ordinary scrub completion, duplicate input/change events and retry clearing.
- Chromium 156: actual VP9 WebM and fragmented AVC MP4 passed forward/reverse playhead, increasing cycle time, pause/cache reuse, playing/paused drag and trim restart, crossfade, caption/crop redraw, FPS/speed changes, ordinary playback, failure/retry and cancellation/close checks. Zero page errors.
- Additional 640×360 VP9 fixture cached to 320×180 while output remained 360×360. One-frame 0.10-second selection retained frame zero while cycle labels updated. Viewports 190–360 px had no horizontal overflow.
- Browser tooling, generated test media and screenshots stayed in `/tmp/bella-loop-browser`; no runtime dependencies or repository browser tooling were added.
- Independent review reproduced and verified the fix for an obsolete ordinary scrub callback toggling the replacement paused loop.
- Byte comparison confirmed the complete pre-application library section (including live rewind, fMP4 parsers and media frame decoder), worker source and encoding session unchanged. Metadata changed only @version.
- Built userscript: 352,400 -> 365,026 bytes (+12,626 bytes / 3.58%). Loop bitmap pixel budget: 24 MiB; maximum preview edge: 320 px; ordinary preview keeps native playback.
- `git diff --check` passed. No commit or push performed; all changes remain available for review.
