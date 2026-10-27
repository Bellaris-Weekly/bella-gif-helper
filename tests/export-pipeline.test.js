'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GIF_QUALITY_PRESETS,
  buildGifsicleCommand,
  calculateEncoderWorkerCount,
  calculateTimelinePlaybackTarget,
  createExportTiming,
  createLoopFramePlan,
  createTimelineSeekGate,
  orderFrameChunks,
  selectEncoderWorker,
} = require('./load-userscript-api');

test('quality presets only change palette and compression behavior', () => {
  const expectedCommands = {
    nai: '-O1 -Okeep-empty input.gif -o /out/output.gif',
    bei: '-O1 -Okeep-empty --lossy=25 input.gif -o /out/output.gif',
    ran: '-O1 -Okeep-empty --lossy=50 input.gif -o /out/output.gif',
  };

  assert.deepEqual(Object.keys(GIF_QUALITY_PRESETS), Object.keys(expectedCommands));
  for (const [name, preset] of Object.entries(GIF_QUALITY_PRESETS)) {
    assert.equal(buildGifsicleCommand(preset), expectedCommands[name]);
    assert.equal('fps' in preset, false);
    assert.equal('width' in preset, false);
    assert.equal('height' in preset, false);
  }
});

test('every quality preset preserves the full 256-entry GIF palette', () => {
  for (const preset of Object.values(GIF_QUALITY_PRESETS)) {
    assert.equal(preset.maxColors, 255);
  }
});

test('export timing stays inside the selection and preserves rounded duration', () => {
  const cases = [
    [0, 1.01, 12, 1],
    [0.35, 2.17, 17, 1.5],
    [2, 12, 60, 10],
  ];

  for (const [start, end, fps, speed] of cases) {
    const timing = createExportTiming(start, end, fps, speed);
    const expectedDuration = Math.round(((end - start) / speed) * 100) * 10;
    assert.equal(timing.durationMs, expectedDuration);
    assert.equal(timing.frameDelays.reduce((sum, delay) => sum + delay, 0), expectedDuration);
    assert.ok(timing.frameDelays.every((delay) => delay >= 20 && delay % 10 === 0));
    assert.ok(timing.frameTimes.every((time) => time >= start && time < end));
    assert.ok(timing.frameTimes.at(-1) > start + (end - start) / 2);
  }
});

test('timeline playback resumes from the correct interaction target', () => {
  assert.equal(calculateTimelinePlaybackTarget('handle', 1.7, 0.2), 0.2);
  assert.equal(calculateTimelinePlaybackTarget('handle', 1.7, 0.6), 0.6);
  assert.equal(calculateTimelinePlaybackTarget('playhead', 1.7, 0.2), 1.7);
});

test('encoder worker count preserves main-thread and decoder capacity', () => {
  const cases = [
    [2, undefined, 1],
    [4, undefined, 2],
    [8, undefined, 6],
    [12, 480, 10],
    [12, 1080, 6],
  ];
  for (const [cores, height, expected] of cases) {
    assert.equal(calculateEncoderWorkerCount(cores, height), expected);
  }
});

test('encoder scheduling applies per-worker backpressure', () => {
  const cases = [
    [[2, 0, 1], 1],
    [[1, 1, 1], 0],
    [[2, 2, 2], -1],
    [[], -1],
  ];
  for (const [loads, expected] of cases) {
    assert.equal(selectEncoderWorker(loads), expected);
  }
});

test('timeline seek gate keeps only the latest request active', () => {
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

test('parallel frame chunks are restored to source order', () => {
  const chunks = orderFrameChunks([
    { index: 2, bytes: new Uint8Array([2]) },
    { index: 0, bytes: new Uint8Array([0]) },
    { index: 1, bytes: new Uint8Array([1]) },
  ]);

  assert.deepEqual(chunks.map((bytes) => bytes[0]), [0, 1, 2]);
});

test('loop plan keeps the original frame order when looping is off', () => {
  const delays = [80, 90, 80, 90];
  for (const mode of ['none', undefined, 'bogus']) {
    const plan = createLoopFramePlan(delays, mode);
    assert.deepEqual(plan.map((item) => item.sourceIndex), [0, 1, 2, 3]);
    assert.deepEqual(plan.map((item) => item.delay), delays);
    assert.ok(plan.every((item) => item.blend === null));
  }
});

test('pingpong loop plays forward then back without repeating either turnaround frame', () => {
  const delays = [80, 90, 80, 90, 80];
  const plan = createLoopFramePlan(delays, 'pingpong');
  assert.deepEqual(plan.map((item) => item.sourceIndex), [0, 1, 2, 3, 4, 3, 2, 1]);
  assert.deepEqual(plan.map((item) => item.delay), plan.map((item) => delays[item.sourceIndex]));
  assert.ok(plan.every((item) => item.blend === null));
  assert.deepEqual(createLoopFramePlan([80, 80], 'pingpong').map((item) => item.sourceIndex), [0, 1]);
});

test('crossfade loop blends the head into the tail and drops the head frames', () => {
  const delays = Array(20).fill(100);
  const plan = createLoopFramePlan(delays, 'crossfade');
  // 上限：20 帧的 25% = 5 帧，且 5 × 100ms ≤ 800ms。
  assert.equal(plan.length, 15);
  assert.deepEqual(plan.map((item) => item.sourceIndex), Array.from({ length: 15 }, (_, i) => i + 5));
  const blended = plan.filter((item) => item.blend);
  assert.deepEqual(blended.map((item) => item.sourceIndex), [15, 16, 17, 18, 19]);
  assert.deepEqual(blended.map((item) => item.blend.sourceIndex), [0, 1, 2, 3, 4]);
  const alphas = blended.map((item) => item.blend.alpha);
  assert.ok(alphas.every((alpha, i) => alpha > 0 && alpha < 1 && (i === 0 || alpha > alphas[i - 1])));
});

test('crossfade length is capped by duration and short clips stay untouched', () => {
  // 40 帧的 25% = 10 帧，但 800ms 只够 8 帧。
  const plan = createLoopFramePlan(Array(40).fill(100), 'crossfade');
  assert.equal(40 - plan.length, 8);
  const short = createLoopFramePlan([100, 100, 100], 'crossfade');
  assert.deepEqual(short.map((item) => item.sourceIndex), [0, 1, 2]);
  assert.ok(short.every((item) => item.blend === null));
});
