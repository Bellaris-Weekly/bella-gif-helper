'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  GIF_TRANSPARENT_INDEX,
  calculateEncoderWorkerCount,
  calculateExportProgress,
  calculateExportFrameCount,
  calculateExportFrameTime,
  calculateExtractionPlaybackRate,
  calculatePreviewCacheProfile,
  orderFrameChunks,
  selectEncoderWorker,
} = require('../bella-gif-helper.user.js');

const userscriptSource = fs.readFileSync(path.join(__dirname, '..', 'bella-gif-helper.user.js'), 'utf8');

test('encoder worker pool keeps two page cores free and caps parallelism', () => {
  assert.equal(calculateEncoderWorkerCount(4), 2);
  assert.equal(calculateEncoderWorkerCount(8), 4);
  assert.equal(calculateEncoderWorkerCount(10), 4);
});

test('encoder scheduling applies per-worker backpressure', () => {
  assert.equal(selectEncoderWorker([2, 0, 1]), 1);
  assert.equal(selectEncoderWorker([1, 1, 1]), 0);
  assert.equal(selectEncoderWorker([2, 2, 2]), -1);
  assert.equal(selectEncoderWorker([]), -1);
});

test('extraction playback rate scales with requested FPS without changing timing', () => {
  for (const [fps, rate] of [[8, 6], [12, 4], [20, 2.4]]) {
    assert.equal(calculateExtractionPlaybackRate(fps), rate);
    assert.equal(calculateExportFrameCount(10, fps), 10 * fps);
    assert.equal(calculateExportFrameTime(2, 12, 1, fps), 2 + 1 / fps);
  }
});

test('preview cache stays inside the fixed memory budget for landscape and square clips', () => {
  const landscape = calculatePreviewCacheProfile(1920, 1080, 60);
  const square = calculatePreviewCacheProfile(1080, 1080, 60);
  const portrait = calculatePreviewCacheProfile(720, 1280, 37);
  assert.ok(landscape.frameCount <= 121);
  assert.ok(square.frameCount <= 121);
  assert.ok(landscape.bytes <= 32 * 1024 * 1024);
  assert.ok(square.bytes <= 32 * 1024 * 1024);
  assert.ok(portrait.bytes <= 32 * 1024 * 1024);
  assert.ok(Math.max(landscape.width, landscape.height) <= 260);
  assert.equal(Math.max(square.width, square.height), 260);
});

test('timeline scrubbing replaces the responsive cache frame with a full-resolution seek', () => {
  assert.match(userscriptSource, /function renderCachedPreviewFrame[\s\S]*?imageSmoothingQuality = 'high'/);
  assert.match(userscriptSource, /renderCachedPreviewFrame\(settings, target\);[\s\S]*?el\.scrubVideo\.currentTime = target/);
  assert.match(userscriptSource, /function renderTimelinePreviewIfCurrent[\s\S]*?renderExportPreviewFrame\(\)/);
  assert.doesNotMatch(userscriptSource, /function renderTimelinePreviewIfCurrent[\s\S]*?hasPreviewCacheFrames\(\)[\s\S]*?return;/);
  assert.match(userscriptSource, /el\.scrubVideo\.addEventListener\('seeked'[\s\S]*?if \(state\.timelineDrag\) renderTimelinePreviewIfCurrent/);
});

test('export progress uses stable phase ranges', () => {
  assert.equal(calculateExportProgress('palette', 1, 2), 6);
  assert.equal(calculateExportProgress('extracting', 1, 2), 40);
  assert.equal(calculateExportProgress('encoding', 1, 2), 78);
  assert.equal(calculateExportProgress('compressing', 1, 2), 93.5);
});

test('parallel frame chunks are assembled in source order with a reserved transparent index', () => {
  const chunks = orderFrameChunks([
    { index: 2, bytes: new Uint8Array([2]) },
    { index: 0, bytes: new Uint8Array([0]) },
    { index: 1, bytes: new Uint8Array([1]) },
  ]);
  assert.deepEqual(chunks.map((bytes) => bytes[0]), [0, 1, 2]);
  assert.equal(GIF_TRANSPARENT_INDEX, 255);
});

test('cancellation stops cache analysis and encoder work before restoring the editor', () => {
  assert.match(userscriptSource, /function cancelExport\(\)[\s\S]*?pausePreviewFrameCache\(\);[\s\S]*?exportEncodingSession\?\.cancel/);
  assert.match(userscriptSource, /cache\.stopRun\?\.\(\)/);
  assert.match(userscriptSource, /await completePreviewFrameCacheForExport\(\)/);
  assert.match(userscriptSource, /void resumePreviewFrameCache\(\)/);
});

test('route and video changes use events instead of a permanent status scan', () => {
  assert.match(userscriptSource, /new MutationObserver/);
  assert.match(userscriptSource, /attributeFilter: \['src'\]/);
  assert.match(userscriptSource, /addEventListener\('loadedmetadata', handleVideoIdentityChange/);
  assert.match(userscriptSource, /navigation\?\.addEventListener\('currententrychange'/);
  assert.doesNotMatch(userscriptSource, /setInterval\(updateVideoStatus/);
});
