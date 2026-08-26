'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateCropViewport,
  calculateInnerOverlayPosition,
  calculatePanelResize,
  calculateTimelineDraggedViewport,
  calculateTimelineDragTime,
  calculateTimelinePosition,
  calculateTimelineSelectionViewport,
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

test('timeline coordinates keep equal precision and short context around equal selections', () => {
  const longClip = calculateTimelineSelectionViewport(41, 44, 60);
  const shortClip = calculateTimelineSelectionViewport(2, 5, 8);
  const width = 400;
  const longStep = calculateTimelineTime(1, width, longClip.start, longClip.end) - longClip.start;
  const shortStep = calculateTimelineTime(1, width, shortClip.start, shortClip.end) - shortClip.start;

  assert.ok(Math.abs(longStep - shortStep) < 1e-12);
  assert.ok(longClip.start < 41);
  assert.ok(longClip.end > 44);
  assert.equal(calculateTimelinePosition(42.5, longClip.start, longClip.end), 0.5);
  assert.ok(calculateTimelinePosition(2, shortClip.start, shortClip.end) > 0);
  assert.ok(calculateTimelinePosition(5, shortClip.start, shortClip.end) < 1);
});

test('selection context stays inside the clip and shifts at source boundaries', () => {
  const atStart = calculateTimelineSelectionViewport(0, 3, 60);
  const atEnd = calculateTimelineSelectionViewport(57, 60, 60);
  assert.equal(atStart.start, 0);
  assert.ok(Math.abs(atStart.end - 3.36) < 1e-12);
  assert.ok(Math.abs(atEnd.start - 56.64) < 1e-12);
  assert.equal(atEnd.end, 60);
  assert.deepEqual(calculateTimelineSelectionViewport(0, 60, 60), { start: 0, end: 60 });
});

test('outward handle dragging is linear at the scale captured on pointer down', () => {
  const view = calculateTimelineSelectionViewport(20, 24, 60);
  const oneStep = calculateTimelineDragTime(20, -30, 300, view.start, view.end, 60);
  const twoSteps = calculateTimelineDragTime(20, -60, 300, view.start, view.end, 60);
  assert.ok(Math.abs((20 - twoSteps) - (20 - oneStep) * 2) < 1e-12);

  const otherView = calculateTimelineSelectionViewport(12.5, 17.5, 45);
  assert.equal(
    calculateTimelineDragTime(17.5, 120, 600, otherView.start, otherView.end, 45),
    18.62,
  );
});

test('dragged viewport reveals only the distance crossed beyond its current edge', () => {
  const view = calculateTimelineSelectionViewport(20, 24, 60);
  assert.deepEqual(
    calculateTimelineDraggedViewport('start', view.start - 0.2, view.start, view.end, 60),
    { start: view.start - 0.2, end: view.end },
  );
  assert.deepEqual(
    calculateTimelineDraggedViewport('end', view.end + 0.35, view.start, view.end, 60),
    { start: view.start, end: view.end + 0.35 },
  );
  assert.deepEqual(calculateTimelineDraggedViewport('start', 21, view.start, view.end, 60), view);
});
