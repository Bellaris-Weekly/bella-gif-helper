'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  calculatePanelResize,
  constrainPanelGeometry,
} = require('./load-userscript-api');

test('east and south handles resize while anchoring the opposite edges', () => {
  const resized = calculatePanelResize(
    { left: 100, top: 80, width: 400, height: 600 },
    'se',
    120,
    90,
    1400,
    1000,
  );
  assert.deepEqual(resized, { left: 100, top: 80, width: 520, height: 690 });
});

test('west and north handles preserve the original right and bottom edges', () => {
  const resized = calculatePanelResize(
    { left: 220, top: 180, width: 460, height: 640 },
    'nw',
    -100,
    -80,
    1400,
    1000,
  );
  assert.deepEqual(resized, { left: 120, top: 100, width: 560, height: 720 });
});

test('all four edges and four corners follow their directional deltas', () => {
  const start = { left: 200, top: 100, width: 400, height: 600 };
  const expected = {
    n: { left: 200, top: 130, width: 400, height: 570 },
    s: { left: 200, top: 100, width: 400, height: 630 },
    e: { left: 200, top: 100, width: 420, height: 600 },
    w: { left: 220, top: 100, width: 380, height: 600 },
    nw: { left: 220, top: 130, width: 380, height: 570 },
    ne: { left: 200, top: 130, width: 420, height: 570 },
    sw: { left: 220, top: 100, width: 380, height: 630 },
    se: { left: 200, top: 100, width: 420, height: 630 },
  };
  for (const [handle, geometry] of Object.entries(expected)) {
    assert.deepEqual(calculatePanelResize(start, handle, 20, 30, 1400, 1000), geometry, handle);
  }
});

test('resize limits width, height, and viewport boundaries', () => {
  const resized = calculatePanelResize(
    { left: 100, top: 100, width: 400, height: 600 },
    'se',
    2000,
    2000,
    1200,
    900,
  );
  assert.deepEqual(resized, { left: 100, top: 100, width: 720, height: 786 });
});

test('north-west resize handles a minimum width and top safe boundary together', () => {
  const resized = calculatePanelResize(
    { left: 200, top: 200, width: 400, height: 650 },
    'nw',
    1000,
    -1000,
    1200,
    900,
  );
  assert.deepEqual(resized, { left: 440, top: 14, width: 160, height: 836 });
});

test('south-east resize reaches the reduced minimum width and height', () => {
  const resized = calculatePanelResize(
    { left: 200, top: 100, width: 400, height: 650 },
    'se',
    -1000,
    -1000,
    1200,
    900,
  );
  assert.deepEqual(resized, { left: 200, top: 100, width: 160, height: 360 });
});

test('temporary viewport constraints do not mutate the preferred geometry', () => {
  const preferred = { left: 500, top: 60, width: 700, height: 900 };
  const constrained = constrainPanelGeometry(preferred, 600, 500);
  assert.deepEqual(constrained, { left: 14, top: 14, width: 572, height: 472 });
  assert.deepEqual(preferred, { left: 500, top: 60, width: 700, height: 900 });
  assert.deepEqual(
    constrainPanelGeometry(preferred, 1600, 1100),
    { left: 500, top: 60, width: 700, height: 900 },
  );
});
