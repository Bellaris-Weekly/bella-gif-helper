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
  createTimelineSeekGate,
  orderFrameChunks,
  requiresPreciseFrameSeek,
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

test('continuous extraction falls back for dropped frames and every endpoint crossing', () => {
  assert.equal(requiresPreciseFrameSeek(2.04, 2, 8, 0.05), false);
  assert.equal(requiresPreciseFrameSeek(2.051, 2, 8, 0.05), true);
  assert.equal(requiresPreciseFrameSeek(2.999, 2.95, 3, 0.05), false);
  assert.equal(requiresPreciseFrameSeek(3, 2.95, 3, 0.05), true);
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

test('timeline seek gate accepts only the latest request', () => {
  const gate = createTimelineSeekGate();
  const first = gate.start();
  const second = gate.start();
  const third = gate.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), false);
  assert.equal(third.isCurrent(), true);
  gate.cancel();
  assert.equal(third.signal.aborted, true);
  assert.equal(third.isCurrent(), false);
});

test('timeline scrubbing uses a paused exact source instead of cached substitutes', () => {
  const queueSource = userscriptSource.match(/function queueTimelinePreview[\s\S]*?function hideTimelineHandlePreview/)?.[0] || '';
  const cacheSource = userscriptSource.match(/async function buildPreviewFrameCache[\s\S]*?function openPanel/)?.[0] || '';
  assert.match(queueSource, /timelineSeekGate\.start\(\)[\s\S]*?seekVideo\(el\.scrubVideo/);
  assert.match(queueSource, /request\.isCurrent\(\)[\s\S]*?renderExportPreviewFrame\(\)/);
  assert.doesNotMatch(queueSource, /renderCachedPreviewFrame|getCachedPreviewFrame|\.play\(\)/);
  assert.match(cacheSource, /createDetachedClipVideo\(clip\)/);
  assert.doesNotMatch(cacheSource, /video:\s*el\.scrubVideo/);
  assert.doesNotMatch(userscriptSource, /function renderCachedPreviewFrame|function getCachedPreviewFrame/);
  assert.match(userscriptSource, /function stopTrimPreview[\s\S]*?trimPreviewToken \+= 1/);
  assert.match(userscriptSource, /function previewTrimmedClip[\s\S]*?previewToken !== state\.trimPreviewToken/);
});

test('steady editor preview has one visible picture and all visual settings share its compositor', () => {
  assert.match(userscriptSource, /function setOutputPreviewVisible[\s\S]*?classList\.toggle\('output-previewing', visible\)/);
  assert.match(userscriptSource, /output-previewing #clipVideo[\s\S]*?visibility: hidden/);
  assert.match(userscriptSource, /function renderExportPreviewFrame[\s\S]*?drawExportCanvasFrame\(ctx, nextSettings, sourceVideo\)/);
  assert.match(userscriptSource, /function drawExportCanvasFrame[\s\S]*?drawTextLayers\(ctx, width, height, settings\.textLayers\)[\s\S]*?normalizeTransparentCorners/);
  assert.doesNotMatch(userscriptSource, /const includeText = mode !== 'preview'/);
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
  assert.match(userscriptSource, /function cancelSizeEstimate[\s\S]*?job\.controller\.abort\(\)[\s\S]*?job\.session\?\.cancel/);
  assert.match(userscriptSource, /function cancelExport\(\)[\s\S]*?exportAbortController\?\.abort\(\)[\s\S]*?exportEncodingSession\?\.cancel/);
  assert.match(userscriptSource, /beforeunload[\s\S]*?exportAbortController\?\.abort\(\)[\s\S]*?exportEncodingSession\?\.destroy/);
  assert.match(userscriptSource, /estimateExportSize\(plan, signature, job\)\.catch\([\s\S]*?\.finally\([\s\S]*?state\.sizeEstimateJob === job/);
  assert.match(userscriptSource, /cache\.stopRun\?\.\(\)/);
  assert.match(userscriptSource, /createDetachedClipVideo\(clip\)/);
  assert.doesNotMatch(userscriptSource, /await completePreviewFrameCacheForExport\(\)/);
  assert.match(userscriptSource, /void resumePreviewFrameCache\(\)/);
});

test('size estimation and export share continuous extraction without legacy sampled seeks', () => {
  const estimateSource = userscriptSource.match(/async function estimateExportSize[\s\S]*?function updateEstimatedFileSize/)?.[0] || '';
  const exportSource = userscriptSource.match(/async function generateGif[\s\S]*?function cancelExport/)?.[0] || '';
  assert.match(userscriptSource, /async function extractFramesContinuously[\s\S]*?requestVideoFrameCallback[\s\S]*?extractPrecisely/);
  assert.match(estimateSource, /captureSampleFrames/);
  assert.equal((estimateSource.match(/createGifEncodingSession/g) || []).length, 1);
  assert.match(exportSource, /extractFramesContinuously\(exportVideo, frameTimes, clip/);
  assert.doesNotMatch(userscriptSource, /calculateEstimatedSizeRange|flattenSampleTimes|captureImageBitmapsAtTimes/);
});

test('export owns a detached source and pauses when the encoder queue is full', () => {
  assert.match(userscriptSource, /onBackpressure: \(full\) =>/);
  assert.match(userscriptSource, /if \(full\) exportVideo\.pause\(\)/);
  assert.match(userscriptSource, /async function extractFramesContinuously[\s\S]*?await extractPrecisely\(extractedFrames\)/);
  assert.doesNotMatch(userscriptSource, /fillRemainingWithCurrentFrame/);
  assert.doesNotMatch(userscriptSource, /settings\.video/);
});

test('route and video changes use events instead of a permanent status scan', () => {
  assert.match(userscriptSource, /new MutationObserver/);
  assert.match(userscriptSource, /attributeFilter: \['src'\]/);
  assert.match(userscriptSource, /addEventListener\('loadedmetadata', handleVideoIdentityChange/);
  assert.match(userscriptSource, /navigation\?\.addEventListener\('currententrychange'/);
  assert.doesNotMatch(userscriptSource, /setInterval\(updateVideoStatus/);
});
