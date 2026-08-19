'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateViewportFlipTransform } = require('../bella-gif-helper.user.js');

test('FLIP transform preserves the starting frame while zooming in', () => {
  const transform = calculateViewportFlipTransform(
    { left: 60, top: 80, width: 120, height: 90 },
    { left: 20, top: 30, width: 240, height: 180 },
  );

  assert.deepEqual(transform, {
    translateX: 50,
    translateY: 65,
    scaleX: 0.5,
    scaleY: 0.5,
  });
});

test('FLIP transform preserves the starting frame while zooming out', () => {
  const transform = calculateViewportFlipTransform(
    { left: 10, top: 20, width: 300, height: 180 },
    { left: 40, top: 50, width: 150, height: 90 },
  );

  assert.deepEqual(transform, {
    translateX: -70,
    translateY: -80,
    scaleX: 2,
    scaleY: 2,
  });
});

test('FLIP transform captures an off-center viewport move', () => {
  const transform = calculateViewportFlipTransform(
    { left: 12, top: 96, width: 160, height: 120 },
    { left: 72, top: 24, width: 160, height: 120 },
  );

  assert.deepEqual(transform, {
    translateX: -60,
    translateY: 72,
    scaleX: 1,
    scaleY: 1,
  });
});

test('FLIP transform is identity when the viewport does not change', () => {
  const rect = { left: 32, top: 48, width: 256, height: 144 };

  assert.deepEqual(calculateViewportFlipTransform(rect, rect), {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
  });
});

test('viewport FLIP maps every child point through the same parent transform', () => {
  const first = { left: -120, top: 40, width: 640, height: 360 };
  const last = { left: -360, top: -80, width: 1280, height: 720 };
  const transform = calculateViewportFlipTransform(first, last);
  const childPoint = { x: 480, y: 220 };

  assert.equal(childPoint.x * transform.scaleX + transform.translateX, 300);
  assert.equal(childPoint.y * transform.scaleY + transform.translateY, 190);
});
