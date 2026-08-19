'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  GIF_QUALITY_PRESETS,
  buildGifsicleCommand,
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
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.nai), '-O1 input.gif -o /out/output.gif');
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.bei), '-O1 --lossy=25 input.gif -o /out/output.gif');
  assert.equal(buildGifsicleCommand(GIF_QUALITY_PRESETS.ran), '-O1 --lossy=50 input.gif -o /out/output.gif');
});

test('GIF delay follows the user frame rate and speed at GIF precision', () => {
  assert.equal(normalizeGifDelay(12, 1), 80);
  assert.equal(normalizeGifDelay(12, 1.5), 60);
  assert.equal(normalizeGifDelay(8, 0.75), 170);
});

test('userscript uses pinned modern encoder resources and sRGB canvases', () => {
  const source = fs.readFileSync(userscriptPath, 'utf8');
  assert.match(source, /modern-gif@2\.1\.0\/dist\/index\.js/);
  assert.match(source, /gifsicle-wasm-browser@1\.5\.19\/dist\/gifsicle\.min\.js/);
  assert.match(source, /colorSpace: 'srgb'/);
  assert.match(source, /\u4e43 \u00b7 \u9ad8画质/);
  assert.match(source, /\u8d1d \u00b7 \u5747衡/);
  assert.match(source, /\u7136 \u00b7 体积优先/);
  assert.doesNotMatch(source, /gif\.js@|GIF_WORKER|globalPalette/);
});
