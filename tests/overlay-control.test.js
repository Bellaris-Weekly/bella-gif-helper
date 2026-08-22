'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateInnerOverlayPosition } = require('./load-userscript-api');

test('overlay control stays inside a full-size crop with corner clearance', () => {
  assert.deepEqual(
    calculateInnerOverlayPosition(
      { left: 0, top: 0, width: 360, height: 360 },
      40,
      28,
    ),
    { left: 296, top: 24 },
  );
});

test('overlay control centers within a crop smaller than the preferred insets', () => {
  assert.deepEqual(
    calculateInnerOverlayPosition(
      { left: 80, top: 60, width: 72, height: 52 },
      40,
      28,
    ),
    { left: 96, top: 72 },
  );
});
