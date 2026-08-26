'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateCropViewport,
  calculateInnerOverlayPosition,
  calculatePanelResize,
  calculateTimelineEdgeExpansion,
  calculateTimelinePosition,
  calculateTimelineTime,
  calculateTimelineViewport,
  calculateViewportTransitionTransform,
  constrainPanelGeometry,
} = require('./load-userscript-api');

test('crop viewport centers the selected area and scales with its size', () => {
  const small = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.375, y: 0.25, w: 0.25, h: 0.5 },
    18,
  );
  const expanded = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.25, y: 0.125, w: 0.5, h: 0.75 },
    18,
  );
  const offAxis = calculateCropViewport(
    360, 360, 1920, 1080,
    { x: 0.75, y: 0, w: 0.25, h: 0.5 },
    18,
  );

  assert.equal(small.width * 0.25, 288);
  assert.equal(small.left + small.width * 0.5, 180);
  assert.ok(expanded.scale < small.scale);
  assert.equal(expanded.left + expanded.width * 0.5, 180);
  assert.equal(expanded.top + expanded.height * 0.5, 180);
  assert.equal(offAxis.left + offAxis.width * 0.75, 36);
  assert.equal(offAxis.left + offAxis.width, 324);
});

test('viewport transitions cover zoom, movement, and identity transforms', () => {
  const cases = [
    [
      { left: 60, top: 80, width: 120, height: 90 },
      { left: 20, top: 30, width: 240, height: 180 },
      { translateX: -100, translateY: -130, scaleX: 2, scaleY: 2 },
    ],
    [
      { left: 10, top: 20, width: 300, height: 180 },
      { left: 40, top: 50, width: 150, height: 90 },
      { translateX: 35, translateY: 40, scaleX: 0.5, scaleY: 0.5 },
    ],
    [
      { left: 12, top: 96, width: 160, height: 120 },
      { left: 72, top: 24, width: 160, height: 120 },
      { translateX: 60, translateY: -72, scaleX: 1, scaleY: 1 },
    ],
    [
      { left: 32, top: 48, width: 256, height: 144 },
      { left: 32, top: 48, width: 256, height: 144 },
      { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    ],
  ];

  for (const [first, last, expected] of cases) {
    assert.deepEqual(calculateViewportTransitionTransform(first, last), expected);
  }
});

test('overlay controls stay usable in both large and small crops', () => {
  const cases = [
    [
      { left: 0, top: 0, width: 360, height: 360 },
      { left: 296, top: 24 },
    ],
    [
      { left: 80, top: 60, width: 72, height: 52 },
      { left: 96, top: 72 },
    ],
  ];

  for (const [crop, expected] of cases) {
    assert.deepEqual(calculateInnerOverlayPosition(crop, 40, 28), expected);
  }
});

test('panel handles resize along their declared edges', () => {
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

test('panel resizing and viewport constraints enforce shared boundaries', () => {
  const resizeCases = [
    [
      { left: 100, top: 100, width: 400, height: 600 }, 'se', 2000, 2000,
      { left: 100, top: 100, width: 720, height: 786 },
    ],
    [
      { left: 200, top: 200, width: 400, height: 650 }, 'nw', 1000, -1000,
      { left: 440, top: 14, width: 160, height: 836 },
    ],
    [
      { left: 200, top: 100, width: 400, height: 650 }, 'se', -1000, -1000,
      { left: 200, top: 100, width: 160, height: 360 },
    ],
  ];
  for (const [start, handle, dx, dy, expected] of resizeCases) {
    assert.deepEqual(calculatePanelResize(start, handle, dx, dy, 1200, 900), expected);
  }

  const preferred = { left: 500, top: 60, width: 700, height: 900 };
  assert.deepEqual(
    constrainPanelGeometry(preferred, 600, 500),
    { left: 14, top: 14, width: 572, height: 472 },
  );
  assert.deepEqual(preferred, { left: 500, top: 60, width: 700, height: 900 });
  assert.deepEqual(constrainPanelGeometry(preferred, 1600, 1100), preferred);
});

test('timeline coordinates depend on the visible selection', () => {
  const longClip = calculateTimelineViewport(41, 44, 60);
  const shortClip = calculateTimelineViewport(2, 5, 8);
  const width = 400;
  const longStep = calculateTimelineTime(1, width, longClip.start, longClip.end) - longClip.start;
  const shortStep = calculateTimelineTime(1, width, shortClip.start, shortClip.end) - shortClip.start;

  assert.ok(Math.abs(longStep - shortStep) < 1e-12);
  assert.equal(calculateTimelinePosition(42.5, longClip.start, longClip.end), 0.5);
  assert.equal(calculateTimelinePosition(shortClip.start, shortClip.start, shortClip.end), 0);
  assert.equal(calculateTimelinePosition(shortClip.end, shortClip.start, shortClip.end), 1);
});

test('timeline edge expansion reveals time without leaving the clip', () => {
  const earlier = calculateTimelineEdgeExpansion('start', 20, 24, 60, 0.5);
  const later = calculateTimelineEdgeExpansion('end', 20, 24, 60, 0.5);

  assert.ok(earlier.start < 20);
  assert.equal(earlier.end, 24);
  assert.equal(later.start, 20);
  assert.ok(later.end > 24);
  assert.deepEqual(
    calculateTimelineEdgeExpansion('start', 0.1, 3, 60, 10),
    { start: 0, end: 3 },
  );
  assert.deepEqual(
    calculateTimelineEdgeExpansion('end', 57, 59.9, 60, 10),
    { start: 57, end: 60 },
  );
});
