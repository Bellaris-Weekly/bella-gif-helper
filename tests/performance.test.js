'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GIF_TRANSPARENT_INDEX,
  calculateEncoderWorkerCount,
  calculateExportDecoderCount,
  calculateExportProgress,
  calculateExportFrameCount,
  calculateExtractionPlaybackRate,
  createTimelineSeekGate,
  createFrameCompositor,
  orderFrameChunks,
  partitionFrameRanges,
  selectEncoderWorker,
} = require('./load-userscript-api');

test('frame compositor can be embedded in the encoder worker', () => {
  const workerFactory = new Function(`return (${createFrameCompositor.toString()})();`);
  assert.doesNotThrow(() => workerFactory());
});

test('encoder worker pool uses nearly all cores and caps size-sensitive parallelism', () => {
  assert.equal(calculateEncoderWorkerCount(4), 3);
  assert.equal(calculateEncoderWorkerCount(8), 7);
  assert.equal(calculateEncoderWorkerCount(10), 8);
  assert.equal(calculateEncoderWorkerCount(12, 480), 10);
  assert.equal(calculateEncoderWorkerCount(12, 1080), 6);
  assert.equal(calculateEncoderWorkerCount(10, 720, 3), 6);
  assert.equal(calculateEncoderWorkerCount(12, 480, 3), 8);
});

test('long exports use multiple decoders without oversubscribing small jobs', () => {
  assert.equal(calculateExportDecoderCount(4, 900, 720), 1);
  assert.equal(calculateExportDecoderCount(8, 120, 720), 2);
  assert.equal(calculateExportDecoderCount(10, 300, 720), 3);
  assert.equal(calculateExportDecoderCount(10, 300, 1440), 2);
  assert.equal(calculateExportDecoderCount(10, 48, 720), 1);
});

test('parallel decoder ranges preserve every frame index exactly once', () => {
  const times = Array.from({ length: 10 }, (_, index) => index / 12);
  const ranges = partitionFrameRanges(times, 3);
  assert.deepEqual(ranges.map((range) => range.offset), [0, 3, 6]);
  assert.deepEqual(ranges.flatMap((range) => range.times), times);
  assert.deepEqual(ranges.flatMap((range) => (
    range.times.map((_, index) => range.offset + index)
  )), Array.from(times.keys()));
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
  }
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
