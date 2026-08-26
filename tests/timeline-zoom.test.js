'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
const marker = "\n  const IS_LIVE_PAGE = location.hostname === 'live.bilibili.com';";
const exportNames = [
  'calculateTimelineEdgeExpansion',
  'calculateTimelinePosition',
  'calculateTimelineTime',
  'calculateTimelineViewport',
];
if (!source.includes(marker)) throw new Error('无法定位用户脚本测试入口。');
vm.runInThisContext(source.replace(
  marker,
  `\n  globalThis.__timelineTestApi = { ${exportNames.join(', ')} };\n  return;${marker}`,
), { filename: userscriptPath });
const {
  calculateTimelineEdgeExpansion,
  calculateTimelinePosition,
  calculateTimelineTime,
  calculateTimelineViewport,
} = globalThis.__timelineTestApi;
delete globalThis.__timelineTestApi;

test('timeline precision depends on the visible selection instead of the source duration', () => {
  const longClipView = calculateTimelineViewport(41, 44, 60);
  const shortClipView = calculateTimelineViewport(2, 5, 8);
  const width = 400;
  const longClipStep = calculateTimelineTime(1, width, longClipView.start, longClipView.end)
    - longClipView.start;
  const shortClipStep = calculateTimelineTime(1, width, shortClipView.start, shortClipView.end)
    - shortClipView.start;

  assert.ok(Math.abs(longClipStep - shortClipStep) < 1e-12);
  assert.equal(calculateTimelinePosition(42.5, longClipView.start, longClipView.end), 0.5);
});

test('another long clip selection receives the same full-width mapping', () => {
  const view = calculateTimelineViewport(12.5, 17.5, 45);
  assert.deepEqual(view, { start: 12.5, end: 17.5 });
  assert.equal(calculateTimelinePosition(12.5, view.start, view.end), 0);
  assert.equal(calculateTimelinePosition(17.5, view.start, view.end), 1);
  assert.equal(calculateTimelineTime(300, 600, view.start, view.end), 15);
});

test('edge expansion reveals hidden time and remains inside the clip', () => {
  const earlier = calculateTimelineEdgeExpansion('start', 20, 24, 60, 0.5);
  const later = calculateTimelineEdgeExpansion('end', 20, 24, 60, 0.5);
  assert.ok(earlier.start < 20);
  assert.equal(earlier.end, 24);
  assert.equal(later.start, 20);
  assert.ok(later.end > 24);
  assert.deepEqual(calculateTimelineEdgeExpansion('start', 0.1, 3, 60, 10), { start: 0, end: 3 });
  assert.deepEqual(calculateTimelineEdgeExpansion('end', 57, 59.9, 60, 10), { start: 57, end: 60 });
});

test('thumbnail refresh waits one second and aborts stale work before rescheduling', () => {
  assert.match(source, /TIMELINE_THUMBNAIL_REFRESH_DELAY_MS\s*=\s*1_000/);
  const cancelBlock = source.match(/function cancelTimelineThumbnailRefresh\([\s\S]*?\n  \}/)?.[0] || '';
  const scheduleBlock = source.match(/function scheduleTimelineThumbnailRefresh\([\s\S]*?\n  \}/)?.[0] || '';
  assert.match(cancelBlock, /timelineThumbnailJob\?\.controller\.abort\(\)/);
  assert.match(scheduleBlock, /cancelTimelineThumbnailRefresh\(\)/);
  assert.match(scheduleBlock, /timelineThumbnailRefreshTimer\s*=\s*window\.setTimeout/);
  assert.ok(
    scheduleBlock.indexOf('cancelTimelineThumbnailRefresh()') < scheduleBlock.indexOf('window.setTimeout'),
    'stale thumbnail work must stop before the debounce timer starts',
  );
  assert.match(source, /dataset\?\.timelineHandle;\s*if \(handleType === 'start' \|\| handleType === 'end'\) cancelTimelineThumbnailRefresh\(\)/);
  assert.match(source, /function handleTimelinePointerDown\(event\) \{[\s\S]*?settleTimelineRefit\(\);/);
});

test('new thumbnails replace the old strip only after the requested range is ready', () => {
  const buildBlock = source.match(/async function buildTimelineThumbnails\([\s\S]*?\n  \}/)?.[0] || '';
  assert.match(buildBlock, /range\.start[\s\S]*?range\.end - range\.start/);
  assert.match(buildBlock, /controller\.signal\.aborted[\s\S]*?timelineThumbnailToken/);
  assert.ok(
    buildBlock.indexOf('await seekVideo') < buildBlock.indexOf('replaceChildren(...canvases)'),
    'the visible strip must remain until the replacement has been decoded',
  );
  assert.match(source, /const analysis = state\.timelineAnalysis \|\|/);
  assert.doesNotMatch(source, /state\.timelineThumbnails\?\.analysis/);
});
