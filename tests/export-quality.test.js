'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  GIF_QUALITY_PRESETS,
  buildGifsicleCommand,
  calculateCropViewport,
  calculateTimelinePlaybackTarget,
  createExportTiming,
} = require('./load-userscript-api');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');

test('quality presets only control palette and compression', () => {
  assert.deepEqual(GIF_QUALITY_PRESETS, {
    nai: { maxColors: 255, dither: 'floyd-steinberg', lossy: 0 },
    bei: { maxColors: 255, dither: null, lossy: 25 },
    ran: { maxColors: 192, dither: null, lossy: 50 },
  });
  for (const preset of Object.values(GIF_QUALITY_PRESETS)) {
    assert.equal('fps' in preset, false);
    assert.equal('width' in preset, false);
    assert.equal('height' in preset, false);
  }
});

test('quality presets produce the intended Gifsicle commands', () => {
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.nai), '-O1 -Okeep-empty input.gif -o /out/output.gif');
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.bei), '-O1 -Okeep-empty --lossy=25 input.gif -o /out/output.gif');
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.ran), '-O1 -Okeep-empty --lossy=50 input.gif -o /out/output.gif');
});

test('export plans keep every frame inside the selected interval', () => {
  for (const [start, end, fps] of [[2, 8, 12], [0.5, 3, 8]]) {
    const times = createExportTiming(start, end, fps).frameTimes;
    assert.equal(times.length, Math.ceil((end - start) * fps));
    assert.ok(times.every((time) => time >= start && time < end));
    assert.ok(times[times.length - 1] < end);
  }
});

test('export timing preserves the selected playback duration at GIF precision', () => {
  for (const [start, end, fps, speed] of [
    [0, 1.01, 12, 1],
    [0.35, 2.17, 17, 1.5],
    [2, 12, 60, 10],
  ]) {
    const timing = createExportTiming(start, end, fps, speed);
    const expectedDuration = Math.round(((end - start) / speed) * 100) * 10;
    assert.equal(timing.durationMs, expectedDuration);
    assert.equal(timing.frameDelays.reduce((sum, delay) => sum + delay, 0), expectedDuration);
    assert.ok(timing.frameDelays.every((delay) => delay >= 20 && delay % 10 === 0));
    assert.ok(timing.frameTimes.every((time) => time >= start && time < end));
    assert.ok(timing.frameTimes[timing.frameTimes.length - 1] > start + (end - start) / 2);
  }
});

test('timeline handles restart from the selected range while the playhead resumes at its target', () => {
  assert.equal(calculateTimelinePlaybackTarget('handle', 1.7, 0.2), 0.2);
  assert.equal(calculateTimelinePlaybackTarget('handle', 1.7, 0.6), 0.6);
  assert.equal(calculateTimelinePlaybackTarget('playhead', 1.7, 0.2), 1.7);
});

test('crop-aware preview fills the viewport and zooms out as the crop expands', () => {
  const smallCrop = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.375, y: 0.25, w: 0.25, h: 0.5 },
    18,
  );
  const expandedCrop = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.25, y: 0.125, w: 0.5, h: 0.75 },
    18,
  );

  assert.equal(smallCrop.width * 0.25, 288);
  assert.equal(smallCrop.left + smallCrop.width * 0.5, 180);
  assert.ok(expandedCrop.scale < smallCrop.scale);
  assert.equal(expandedCrop.left + expandedCrop.width * 0.5, 180);
  assert.equal(expandedCrop.top + expandedCrop.height * 0.5, 180);
});

test('crop-aware preview centers an off-axis crop instead of the whole video', () => {
  const fitted = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.75, y: 0, w: 0.25, h: 0.5 },
    18,
  );

  const cropLeft = fitted.left + fitted.width * 0.75;
  const cropRight = cropLeft + fitted.width * 0.25;
  assert.equal(cropLeft, 36);
  assert.equal(cropRight, 324);
});

test('userscript uses pinned parallel encoder resources and sRGB canvases', () => {
  const source = fs.readFileSync(userscriptPath, 'utf8');
  assert.match(source, /@version\s+1\.4\.2/);
  assert.match(source, /modern-palette@2\.0\.0\/dist\/index\.mjs/);
  assert.match(source, /gifenc@1\.0\.3\/dist\/gifenc\.esm\.js/);
  assert.match(source, /gifsicle-wasm-browser@1\.5\.19\/dist\/gifsicle\.min\.js/);
  assert.match(source, /colorSpace: 'srgb'/);
  assert.match(source, /new VideoFrame\(exportVideo/);
  assert.match(source, /source\.displayWidth \|\| source\.width/);
  assert.match(source, /selectEncoderWorker\(workers\.map/);
  assert.match(source, /calculateEncoderWorkerCount\(\s*navigator\.hardwareConcurrency,/);
  assert.match(source, /navigation\?\.addEventListener\('currententrychange'/);
  assert.doesNotMatch(source, /@noframes/);
  assert.match(source, /bella-gif-helper-live-frame-v1/);
  assert.match(source, /action === 'start-recording'/);
  assert.match(source, /kind: 'recording-complete'/);
  assert.match(source, /<option value="nai">\u4e43<\/option>/);
  assert.match(source, /<option value="bei" selected>\u8d1d<\/option>/);
  assert.match(source, /<option value="ran">\u7136<\/option>/);
  assert.doesNotMatch(source, /modern-gif@|gif\.js@|GIF_WORKER/);
  assert.doesNotMatch(source, /setInterval\(updateVideoStatus/);
  assert.doesNotMatch(source, /estimateGifBytesBySampling|scheduleSampledSizeEstimate|estimateFactor|completePreviewFrameCacheForExport/);
});
