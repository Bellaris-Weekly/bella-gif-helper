# Quality Guidelines

## Scenario: Offline Video Frame Export

### 1. Scope / Trigger

This contract applies whenever recorded WebM or live-rewind fragmented MP4 is decoded for GIF export. Editor preview is outside this contract and may continue to use HTMLVideoElement and MediaSource.

### 2. Signatures

```text
framesAt(targetTimes, { signal })
  -> AsyncIterable<{ index, targetTime, frame: VideoFrame }>

dispose() -> void
```

### 3. Contracts

- `targetTimes` contains finite, non-negative seconds in ascending order.
- Both WebM blobs and fragmented MP4 parts enter the same frame-source adapter.
- Export decoding uses one `VideoSampleSink.samples()` iterator at a time. Do not use timestamp-based random sample lookup, MediaSource, video playback, or `currentTime` in the export path.
- Each target receives the last presentation-ordered source frame whose timestamp is not later than the target. A low-rate source frame may therefore be converted to several independent `VideoFrame` objects.
- The consumer owns every yielded `VideoFrame` and must close it. The frame source owns and closes all `VideoSample` objects.
- Palette extraction and full export run serially. Calling `framesAt` concurrently is invalid.
- Release builds must not collect export diagnostics, publish reports on `window`, or emit diagnostic console output. Temporary instrumentation must be removed before the userscript version is released.

### 4. Validation & Error Matrix

- Unsorted, negative, or non-finite target -> reject before decoding.
- Target before the first decoded presentation frame -> reject explicitly.
- Target at or beyond an incomplete media tail -> reject explicitly instead of repeating the last frame.
- Decoder output moving backward in presentation time -> reject explicitly.
- Abort signal -> dispose the media input and throw `CancelledError`.
- Unsupported codec or missing WebCodecs -> reject with a user-facing capability error.

### 5. Good / Base / Bad Cases

- Good: a 30 FPS long-GOP stream split into 0.25-second fragments is decoded once in sequence and sampled at 12 or 20 FPS.
- Base: a 12 FPS source exported at 20 FPS naturally reuses displayed frames while producing the requested output count.
- Bad: calling `samplesAtTimestamps()` for every target re-enters fragmented MP4 key-packet lookup and can fail after crossing into a fragment without an IDR.

### 6. Tests Required

- Unit test WebM and fragmented MP4 through the same source factory.
- Assert output count, index order, presentation-time selection, and natural reuse for 12/25/30/60 FPS sources.
- Assert maximum decode concurrency is one across palette and export passes.
- Assert random timestamp lookup is never called.
- Assert cancellation and early failure close every owned sample and dispose the input.
- Before release, scan the userscript for diagnostic globals, stage/event collectors, and diagnostic console output.
- Browser-test AVC B-frames, VP9 WebM, AV1 fragmented MP4, mid-GOP input, and a multi-fragment AVC long-GOP fixture.

### 7. Wrong vs Correct

```javascript
// Wrong: fragmented random access repeats key-packet lookup for target times.
for await (const sample of sink.samplesAtTimestamps(targetTimes)) {
  // ...
}

// Correct: decode in presentation order and match ascending targets while scanning.
for await (const sample of sink.samples(undefined, undefined, { skipLiveWait: true })) {
  // Emit targets covered by the previously displayed sample, then advance.
}
```

## Scenario: Version Badge and Update Detection

### 1. Scope / Trigger
Changes to the title version badge, metadata, or update transport.

### 2. Signatures
`bindVersionButton({ button, version, updateUrl, downloadUrl, request, openTab })` binds one main-page badge. `compareVersions(left, right)` returns -1, 0, or 1.

### 3. Contracts
Build injects version and both URLs from `src/header.txt`. Startup sends one anonymous request with a 15-second timeout. Clicks during a request are coalesced. Only a newer numeric/prerelease version sets the update badge; clicking that badge opens the existing installation URL. Never execute downloaded source or auto-navigate.

### 4. Validation & Error Matrix
Non-200, missing/invalid metadata, network errors and timeout restore retry ability without an update badge or popup. Same/older versions remain neutral.

### 5. Good/Base/Bad Cases
Good: 1.5.12 exceeds 1.5.9; beta.10 exceeds beta.2. Base: identical versions do not update. Bad: HTML error response must not be interpreted as a version.

### 6. Tests Required
Version ordering, metadata extraction, startup request, duplicate clicks, failed request retry, update click destination. Browser-check compact title and update badge. Full project smoke checklist remains mandatory before release.

### 7. Wrong vs Correct
Wrong: compare version strings lexically or duplicate the version in UI source. Correct: compare numeric components and prerelease identifiers; derive the displayed version from the metadata at build time.
