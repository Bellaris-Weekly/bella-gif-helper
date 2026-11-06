# Lightweight loop preview

## Approved scope

The user approved a simplified implementation on 2026-11-03 after explicitly prioritizing a small, maintainable plugin. This document supersedes the earlier full design/demo. Implement the feature; do not commit or push without an explicit request.

## Requirements

- Keep one source-time filmstrip and the existing trim handles.
- Preview existing ping-pong and crossfade modes using the existing export frame plan, delays and blend weights. No new algorithms or dependencies.
- Retain ordinary native video preview for loop mode `none` where practical; allocate a small, bounded frame cache only when a loop effect needs it.
- Add compact direction/phase and numeric cycle-time labels beside play/pause. No new progress bar, ghost markers, overlap highlights or source-to-output inverse mapping.
- Pause/resume preserves cycle position and direction. Source dragging shows raw source frames; after a drag or trim change, loop preview restarts at cycle start, respecting the previous playing/paused state. Ordinary preview may keep its existing source-position behavior.
- Mode/FPS/speed changes invalidate the effect preview and start its new cycle at zero, preserving play/pause state. Text/corner/crop changes reuse cached source frames and the existing compositor.
- Composite the two raw frames before drawing crop, corners and captions once.
- Show preparation or failure clearly; do not pretend forward playback is a working reverse/fade preview.
- Cancel obsolete preparation and callbacks; close cached bitmaps and decoder sources on failure, new selection, mode change, close, new clip and export. Retain cache across a simple pause/resume.
- Keep background/crop interactions coherent without introducing an elaborate new player state framework.

## Technical boundary

- Reuse `createExportTiming`, `createLoopFramePlan`, `createExportFrameSource` and the current canvas compositor.
- Never modify `createGifEncodingSession`, `makeEncodingWorkerSource`, `createExportFrameSourceFromMediaApi`, `LiveRewindTrack`, fMP4 parsers, dependency versions, matches or distribution.
- If a small new module makes frame timing/cache ownership testable, scope it to those responsibilities. Do not restructure `startApp`.
- Bounded bitmap cache may lower preview resolution for longer selections. Keep real export resolution unchanged.
- Existing preferences are unchanged.

## Acceptance and verification

- Verify exact forward/reverse order and crossfade weights against the current plan, including variable delays and short clips.
- Verify pause/resume, restart on drag/settings changes, cancellation races, cache budget and closing all owned resources.
- Browser smoke-test real media when tooling is available, including recorded WebM and live fragmented MP4, crop/caption redraw and narrow panel layout.
- Pass `npm run verify`; bump metadata and README version consistently with rebuilt userscript.
- Report final production diff size and test results so the user can assess complexity.

## Reference

- [Existing preview/export contracts](research/preview-contracts.md)
- `preview-demo.html` is the earlier, broader design demonstration and is not the implementation acceptance target.
