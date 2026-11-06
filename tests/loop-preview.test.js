'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoopPreviewClock, prepareLoopPreviewFrames } = require('../src/loop-preview');
const { createExportTiming, createLoopFramePlan } = require('./load-userscript-api');

function closable(properties = {}) {
  return { ...properties, closed: 0, close() { this.closed += 1; } };
}

function fixture(count = 4, overrides = {}) {
  const decoded = Array.from({ length: count }, () => closable({ displayWidth: 1920, displayHeight: 1080 }));
  const bitmaps = [];
  const controller = new AbortController();
  const source = {
    disposals: 0,
    dispose() { this.disposals += 1; },
    async *framesAt(times, { signal }) {
      assert.equal(signal, controller.signal);
      assert.deepEqual(times, options.frameTimes);
      for (let index = 0; index < decoded.length; index += 1) yield { index, frame: decoded[index] };
    },
  };
  const options = {
    clip: { width: 1920, height: 1080 },
    frameTimes: Array.from({ length: count }, (_, index) => index / 30),
    signal: controller.signal,
    createSource: async () => source,
    createBitmap: async (_frame, size) => {
      const bitmap = closable({ width: size.resizeWidth, height: size.resizeHeight });
      bitmaps.push(bitmap);
      return bitmap;
    },
    ...overrides,
  };
  return { options, source, controller, decoded, bitmaps };
}

test('preview clock follows exported order, blend weights and variable delays exactly', () => {
  for (const mode of ['pingpong', 'crossfade']) {
    for (const end of [0.02, 0.18, 0.83, 4]) {
      const timing = createExportTiming(0, end, 12, 1.3);
      const plan = createLoopFramePlan(timing.frameDelays, mode);
      const clock = createLoopPreviewClock(plan);
      clock.setRunning(true, 0);
      let now = 0;
      plan.forEach((expected, index) => {
        const sample = clock.sample(now);
        assert.equal(sample.index, index);
        assert.equal(sample.frame, expected);
        assert.equal(sample.reverse, index > 0 && expected.sourceIndex < plan[index - 1].sourceIndex);
        assert.equal(clock.sample(now + expected.delay - 0.01).index, index);
        now += expected.delay;
      });
      assert.equal(clock.sample(now).elapsed, 0);
      assert.equal(clock.sample(now).index, 0);
      assert.equal(clock.sample(now).duration, plan.reduce((sum, frame) => sum + frame.delay, 0));
    }
  }
});

test('pause and hidden intervals preserve reverse position and resume without wall-clock jumps', () => {
  const clock = createLoopPreviewClock(createLoopFramePlan([80, 90, 80, 90], 'pingpong'));
  clock.setRunning(true, 1000);
  clock.setRunning(false, 1405);
  const paused = clock.sample(1405);
  assert.equal(paused.reverse, true);
  assert.equal(paused.elapsed, 405);
  assert.deepEqual(clock.sample(90_000), paused);
  clock.setRunning(true, 95_000);
  assert.equal(clock.sample(95_010).elapsed, 415);
  clock.setRunning(false, 95_010);
  clock.setRunning(true, 100_000);
  assert.equal(clock.sample(100_005).elapsed, 420);
});

test('cache bounds image memory, closes decoded frames and disposes owned bitmaps exactly once', async () => {
  const f = fixture(1800);
  const cache = await prepareLoopPreviewFrames(f.options);
  assert.equal(cache.frames.length, 1800);
  assert.ok(cache.frames.every((frame) => Math.max(frame.width, frame.height) <= 320));
  assert.ok(cache.frames.reduce((sum, frame) => sum + frame.width * frame.height * 4, 0) <= 24 * 1024 * 1024);
  assert.ok(f.decoded.every((frame) => frame.closed === 1));
  assert.equal(f.source.disposals, 1);
  assert.ok(f.bitmaps.every((frame) => frame.closed === 0));
  cache.dispose();
  cache.dispose();
  f.controller.abort();
  assert.ok(f.bitmaps.every((frame) => frame.closed === 1));
  assert.equal(f.source.disposals, 1);
});

test('cancellation before opening or during the source factory never starts decoding', async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(prepareLoopPreviewFrames(f.options), { name: 'AbortError' });
  assert.equal(f.source.disposals, 0);

  const pending = Promise.withResolvers();
  const late = fixture();
  late.options.createSource = () => pending.promise;
  const preparation = prepareLoopPreviewFrames(late.options);
  late.controller.abort();
  pending.resolve(late.source);
  await assert.rejects(preparation, { name: 'AbortError' });
  assert.equal(late.source.disposals, 1);
  assert.ok(late.decoded.every((frame) => frame.closed === 0));
});

test('cancellation during bitmap conversion closes the late bitmap and current decoded frame', async () => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const f = fixture(2, { createBitmap: () => { started.resolve(); return pending.promise; } });
  const preparation = prepareLoopPreviewFrames(f.options);
  await started.promise;
  f.controller.abort();
  assert.equal(f.source.disposals, 1);
  const bitmap = closable();
  pending.resolve(bitmap);
  await assert.rejects(preparation, { name: 'AbortError' });
  assert.equal(bitmap.closed, 1);
  assert.equal(f.decoded[0].closed, 1);
  assert.equal(f.source.disposals, 1);
});

test('conversion failure and incomplete decoding release all accumulated resources', async () => {
  const f = fixture();
  const convert = f.options.createBitmap;
  f.options.createBitmap = async (frame, size) => {
    if (frame === f.decoded[2]) throw new Error('conversion failed');
    return convert(frame, size);
  };
  await assert.rejects(prepareLoopPreviewFrames(f.options), /conversion failed/);
  assert.ok(f.bitmaps.every((frame) => frame.closed === 1));
  assert.ok(f.decoded.slice(0, 3).every((frame) => frame.closed === 1));
  assert.equal(f.source.disposals, 1);

  const short = fixture(3);
  short.options.frameTimes.push(0.1);
  await assert.rejects(prepareLoopPreviewFrames(short.options), /不完整/);
  assert.ok(short.bitmaps.every((frame) => frame.closed === 1));
  assert.ok(short.decoded.every((frame) => frame.closed === 1));
  assert.equal(short.source.disposals, 1);
});
