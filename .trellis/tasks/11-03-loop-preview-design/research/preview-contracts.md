# Loop preview research

## Repository findings

- `src/main.js:258`, `createLoopFramePlan`: the output plan is the existing source of truth. Ping-pong emits `0..N-1, N-2..1`; crossfade emits `F..N-1` with the last F frames blended with `0..F-1`, using `(step + 1) / (F + 1)`.
- `src/main.js:4957`, `previewTrimmedClip`: current preview ignores the loop mode and plays the source range forward, seeking to the start at its end.
- `src/main.js:4682`, `updateTimelinePlayhead`: the playhead follows source `clipVideo.currentTime` within a source-coordinate viewport.
- `src/main.js:4801` and `4873`: dragging uses `scrubVideo`; previously playing sessions resume, paused sessions stay paused. Boundary drags resume from the new trim start; playhead drags resume from the selected source position.
- `src/main.js:5399`: output preview currently draws one source video, including crop/corners/text via the compositor.
- `src/main.js:6463`: mode changes redraw but do not rebuild preview playback.
- `src/main.js:6583`: video events can redraw; all preview painters must agree on the current owner when introducing cached frames and blends.
- `tests/export-pipeline.test.js:126`: turnaround frames must not be duplicated. At 10 FPS, a four-second / 40-frame source produces a 7.8-second ping-pong cycle, not 8 seconds.
- `tests/export-pipeline.test.js:135`: crossfade uses overlap, shortening the output. With 40 frames at 100 ms, F=8 and the output lasts 3.2 seconds, beginning at source 0.8 s.
- `.trellis/spec/frontend/quality-guidelines.md`: protected frame-source consumers use ascending timestamp requests, sequential decoding, explicit cancellation and frame disposal. Reuse existing contracts without rewriting decoder internals.

## External references (reviewed 2026-11-03)

1. [MDN HTMLMediaElement.playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate): negative playback rates are not widely supported. A portable reverse preview cannot rely on assigning `playbackRate = -1`.
2. [Kdenlive Project Monitor](https://docs.kdenlive.org/en/user_interface/monitors/project_monitor.html): separates source/project position, selected zones, and commands for playing versus looping a zone.
3. [Kdenlive Clip Monitor](https://docs.kdenlive.org/en/user_interface/monitors/clip_monitor.html): the source clip monitor uses a source-position caret and selected zone for playback. This supports keeping trim semantics attached to the source axis.

## Design inference

The references support maintaining an explicit coordinate system and separating playback behavior from trim boundaries. The single source timeline plus phase/cycle-time labels, ghost blend marker, and source-to-output mapping are our own proposed design, not a convention claimed from those tools.

## Implementation risks to validate later

- A source frame may occur twice in a ping-pong cycle, or only as a blend input in crossfade. Scrubbing needs a deterministic inverse mapping.
- Cache playback cannot infer whether it is running from `video.paused`. Own the play state and cycle clock explicitly.
- Cancel old preparation, seeks, frame callbacks and paints when mode/trim changes, starting an export, closing the panel or replacing the clip.
- Compose two source images before applying captions and rounded corners once, matching the current export order.
- Maintain bounded preview cache memory, reduce bitmap resolution before changing frame order/timing, and keep preparing/failed previews visibly distinct from an active loop preview.
- Do not use unsupported reverse playback, repeated full GIF encodes, or changes to protected decoder/encoder implementations to obtain the preview.
