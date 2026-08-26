'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GIF_QUALITY_PRESETS,
  buildGifsicleCommand,
  calculateEncoderWorkerCount,
  calculateTimelinePlaybackTarget,
  createExportTiming,
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
