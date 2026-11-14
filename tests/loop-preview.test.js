'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoopPreviewClock, createPreviewFrameStore, planPreviewStorage, prepareLoopPreviewFrames } = require('../src/loop-preview');
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

test('the reported case: a 259×420 crop of 1080p over 313 frames is cached at full crop resolution', () => {
  const storage = planPreviewStorage({
    sourceWidth: 1920, sourceHeight: 1080, frameCount: 313, maxEdge: 660,
    region: { x: 0.4, y: 0.1, w: 259 / 1920, h: 420 / 1080 },
  });
  assert.deepEqual([storage.size.resizeWidth, storage.size.resizeHeight], [259, 420]);
  assert.equal(storage.mode, 'compressed', '136 MB of raw bitmaps would exceed the raw budget');
  assert.deepEqual(storage.rect, { sx: 768, sy: 108, sw: 259, sh: 420 });
  // The old cache kept the whole 1920×1080 frame at 189×106, i.e. about 25×41 pixels for this crop.
});

test('storage size follows the displayed size, is bounded, and stays raw for short clips', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const short = planPreviewStorage({ sourceWidth: 1920, sourceHeight: 1080, frameCount: 30, maxEdge: 500, region: full });
  assert.equal(short.mode, 'raw');
  assert.deepEqual([short.size.resizeWidth, short.size.resizeHeight], [500, 281]);
  const huge = planPreviewStorage({ sourceWidth: 3840, sourceHeight: 2160, frameCount: 900, maxEdge: 5000, region: full });
  assert.ok(Math.max(huge.size.resizeWidth, huge.size.resizeHeight) <= 960, 'longest edge capped at 960');
  assert.equal(huge.mode, 'compressed');
  assert.ok(huge.size.resizeWidth * huge.size.resizeHeight * 0.35 * 900 <= 96 * 1024 * 1024, 'compressed estimate within budget');
  const tiny = planPreviewStorage({ sourceWidth: 1920, sourceHeight: 1080, frameCount: 10, maxEdge: 10, region: full });
  assert.equal(tiny.size.resizeWidth, 240, 'a collapsed preview box still gets a usable cache');
});

test('raw cache crops to the region, reports each frame and disposes owned bitmaps exactly once', async () => {
  const f = fixture(6);
  const rects = [];
  const progress = [];
  const convert = f.options.createBitmap;
  f.options.createBitmap = (frame, options) => { rects.push(options); return convert(frame, options); };
  f.options.region = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
  f.options.maxEdge = 480;
  f.options.onFrame = (store) => progress.push(store.filled);
  const cache = await prepareLoopPreviewFrames(f.options);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]);
  assert.equal(cache.mode, 'raw');
  assert.deepEqual(cache.region, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
  assert.deepEqual({ ...rects[0], resizeQuality: undefined }, { sx: 480, sy: 540, sw: 960, sh: 270, resizeWidth: 480, resizeHeight: 135, resizeQuality: undefined });
  assert.ok([0, 1, 2, 3, 4, 5].every((index) => cache.has(index) && cache.get(index) === f.bitmaps[index]));
  assert.ok(f.decoded.every((frame) => frame.closed === 1));
  assert.equal(f.source.disposals, 1);
  cache.request([0, 1]);
  assert.ok(f.bitmaps.every((frame) => frame.closed === 0), 'raw frames are never evicted');
  cache.dispose();
  cache.dispose();
  assert.ok(f.bitmaps.every((frame) => frame.closed === 1));
  assert.equal(cache.has(0), false);
});

test('compressed cache keeps JPEG blobs, decodes only requested frames and evicts outside the window', async () => {
  const f = fixture(200);
  const decodedBlobs = [];
  f.options.encodeBitmap = async (bitmap) => ({ blob: bitmap.width });
  f.options.decodeBlob = async (blob) => { const bitmap = closable({ blob }); decodedBlobs.push(bitmap); return bitmap; };
  f.options.maxEdge = 960;
  f.options.rawBudgetBytes = 1024;
  const repaint = [];
  f.options.onDecoded = (index) => repaint.push(index);
  const cache = await prepareLoopPreviewFrames(f.options);
  assert.equal(cache.mode, 'compressed');
  assert.ok(f.bitmaps.every((frame) => frame.closed === 1), 'conversion bitmaps are released after encoding');
  assert.equal(cache.has(0), false);
  assert.ok(cache.stored(199));
  cache.request([10, 11, 12, 13, 14]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(repaint, [10, 11, 12], 'at most three decodes in flight');
  cache.request([10, 11, 12, 13, 14]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([10, 11, 12, 13, 14].every((index) => cache.has(index)));
  for (let start = 20; start < 120; start += 3) {
    cache.request([start, start + 1, start + 2]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const live = decodedBlobs.filter((bitmap) => bitmap.closed === 0).length;
  assert.ok(live <= 12, `decoded window stays bounded (${live})`);
  assert.ok(cache.has(119) && !cache.has(10));
  cache.dispose();
  assert.ok(decodedBlobs.every((bitmap) => bitmap.closed === 1));
});

test('the clock holds on the last ready frame, reports waiting, and resumes without jumping', () => {
  const plan = createLoopFramePlan([100, 100, 100, 100, 100], 'pingpong');
  let ready = 2;
  const clock = createLoopPreviewClock(plan, { isReady: (index) => plan[index].sourceIndex < ready || index >= 5 && ready > 4 });
  clock.setRunning(true, 0);
  let sample = clock.sample(5000);
  assert.equal(sample.index, 1);
  assert.equal(sample.waiting, true);
  assert.equal(clock.sample(5000).waiting, true, 'a repeated sample at the same instant is still waiting');
  ready = 5;
  sample = clock.sample(5050);
  assert.equal(sample.waiting, false);
  assert.equal(sample.index, 2, 'continues from the held frame instead of wall-clock time');
  sample = clock.sample(5050 + 500);
  assert.ok(sample.reverse, 'reaches the reverse half once every frame is ready');
  const blocked = createLoopPreviewClock(plan, { isReady: () => false });
  blocked.setRunning(true, 0);
  assert.deepEqual([blocked.sample(1000).index, blocked.sample(1000).waiting], [0, true]);
});

test('frame store ignores late decodes after disposal', async () => {
  const pending = Promise.withResolvers();
  const store = createPreviewFrameStore({ count: 2, region: { x: 0, y: 0, w: 1, h: 1 }, decodeBlob: () => pending.promise });
  store.setMode('compressed');
  store.putBlob(0, 'jpeg');
  store.request([0]);
  store.dispose();
  const late = closable();
  pending.resolve(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.closed, 1);
  assert.equal(store.has(0), false);
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
