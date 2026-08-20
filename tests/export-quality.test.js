'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  GIF_QUALITY_PRESETS,
  buildGifsicleCommand,
  calculateCropViewport,
  normalizeGifDelay,
} = require('../bella-gif-helper.user.js');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');

test('quality presets only control palette and compression', () => {
  assert.deepEqual(GIF_QUALITY_PRESETS, {
    nai: { maxColors: 255, dither: 'floyd-steinberg', lossy: 0, estimateFactor: 0.30 },
    bei: { maxColors: 255, dither: null, lossy: 25, estimateFactor: 0.22 },
    ran: { maxColors: 192, dither: null, lossy: 50, estimateFactor: 0.16 },
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

test('GIF delay follows the user frame rate and speed at GIF precision', () => {
  assert.equal(normalizeGifDelay(12, 1), 80);
  assert.equal(normalizeGifDelay(12, 1.5), 60);
  assert.equal(normalizeGifDelay(8, 0.75), 170);
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
  assert.match(source, /@version\s+1\.3\.2/);
  assert.match(source, /modern-palette@2\.0\.0\/dist\/index\.mjs/);
  assert.match(source, /gifenc@1\.0\.3\/dist\/gifenc\.esm\.js/);
  assert.match(source, /gifsicle-wasm-browser@1\.5\.19\/dist\/gifsicle\.min\.js/);
  assert.match(source, /colorSpace: 'srgb'/);
  assert.match(source, /new VideoFrame\(video/);
  assert.match(source, /source\.displayWidth \|\| source\.width/);
  assert.match(source, /selectEncoderWorker\(workers\.map/);
  assert.match(source, /calculateEncoderWorkerCount\(navigator\.hardwareConcurrency\)/);
  assert.match(source, /navigation\?\.addEventListener\('currententrychange'/);
  assert.match(source, /<option value="nai">\u4e43<\/option>/);
  assert.match(source, /<option value="bei" selected>\u8d1d<\/option>/);
  assert.match(source, /<option value="ran">\u7136<\/option>/);
  assert.doesNotMatch(source, /modern-gif@|gif\.js@|GIF_WORKER/);
  assert.doesNotMatch(source, /setInterval\(updateVideoStatus/);
  assert.doesNotMatch(source, /estimateGifBytesBySampling|scheduleSampledSizeEstimate/);
});
