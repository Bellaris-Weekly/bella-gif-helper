'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateFlipTransform } = require('../bella-gif-helper.user.js');

test('FLIP transform preserves the starting frame while zooming in', () => {
  const transform = calculateFlipTransform(
    { left: 60, top: 80, width: 120, height: 90 },
    { left: 20, top: 30, width: 240, height: 180 },
  );

  assert.deepEqual(transform, {
    translateX: 40,
    translateY: 50,
    scaleX: 0.5,
    scaleY: 0.5,
  });
});

test('FLIP transform preserves the starting frame while zooming out', () => {
  const transform = calculateFlipTransform(
    { left: 10, top: 20, width: 300, height: 180 },
    { left: 40, top: 50, width: 150, height: 90 },
  );

  assert.deepEqual(transform, {
    translateX: -30,
    translateY: -30,
    scaleX: 2,
    scaleY: 2,
  });
});

test('FLIP transform captures an off-center viewport move', () => {
  const transform = calculateFlipTransform(
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

  assert.deepEqual(calculateFlipTransform(rect, rect), {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
  });
});
