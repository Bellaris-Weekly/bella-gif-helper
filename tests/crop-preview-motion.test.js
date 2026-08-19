'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateViewportTransitionTransform,
  mergeEditorBackgroundIntent,
} = require('../bella-gif-helper.user.js');

test('viewport transition reaches the fitted frame while zooming in', () => {
  const transform = calculateViewportTransitionTransform(
    { left: 60, top: 80, width: 120, height: 90 },
    { left: 20, top: 30, width: 240, height: 180 },
  );

  assert.deepEqual(transform, {
    translateX: -100,
    translateY: -130,
    scaleX: 2,
    scaleY: 2,
  });
});

test('viewport transition reaches the fitted frame while zooming out', () => {
  const transform = calculateViewportTransitionTransform(
    { left: 10, top: 20, width: 300, height: 180 },
    { left: 40, top: 50, width: 150, height: 90 },
  );

  assert.deepEqual(transform, {
    translateX: 35,
    translateY: 40,
    scaleX: 0.5,
    scaleY: 0.5,
  });
});

test('viewport transition captures an off-center move', () => {
  const transform = calculateViewportTransitionTransform(
    { left: 12, top: 96, width: 160, height: 120 },
    { left: 72, top: 24, width: 160, height: 120 },
  );

  assert.deepEqual(transform, {
    translateX: 60,
    translateY: -72,
    scaleX: 1,
    scaleY: 1,
  });
});

test('viewport transition is identity when the viewport does not change', () => {
  const rect = { left: 32, top: 48, width: 256, height: 144 };

  assert.deepEqual(calculateViewportTransitionTransform(rect, rect), {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
  });
});

test('viewport transition maps every child point through the parent transform', () => {
  const first = { left: -120, top: 40, width: 640, height: 360 };
  const last = { left: -360, top: -80, width: 1280, height: 720 };
  const transform = calculateViewportTransitionTransform(first, last);
  const childPoint = { x: 360, y: 220 };

  assert.equal(childPoint.x * transform.scaleX + transform.translateX, 600);
  assert.equal(childPoint.y * transform.scaleY + transform.translateY, 280);
});

test('repeated crop interactions preserve deferred cache work', () => {
  const firstDrag = mergeEditorBackgroundIntent(null, {
    resumeCache: true,
  });
  const interruptedDrag = mergeEditorBackgroundIntent(firstDrag, {
    resumeCache: false,
  });

  assert.deepEqual(interruptedDrag, {
    resumeCache: true,
  });
});

test('crop interaction does not invent background work that was inactive', () => {
  assert.deepEqual(mergeEditorBackgroundIntent(null, null), {
    resumeCache: false,
  });
});
