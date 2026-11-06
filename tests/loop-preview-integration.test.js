'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createLoopPreviewClock } = require('../src/loop-preview');
const { createExportTiming, createLoopFramePlan, createTimelineSeekGate, calculateTimelinePlaybackTarget } = require('./load-userscript-api');

// Exercise the actual editor closures without adding a shipped diagnostic API.
const source = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing editor section: ${start}`);
  return source.slice(from, to);
}
const editor = section('  function loopPreviewSettingsKey()', '  function getActiveTextLayer()')
  + section('  function settleTimelinePreview(', '  function applyTimelineDrag(')
  + section('  function handleExportInputChange(', '  const videoObserver');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const jobs = [], seeks = [], statuses = [], rafs = new Map();
  let now = 0, nextRaf = 0, paints = 0;
  const element = () => {
    const classes = new Set();
    return { textContent: '', pause() {}, classList: {
      contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    } };
  };
  const el = {
    panel: element(), previewPlaybackInfo: element(), previewDirection: element(),
    previewCycleTime: element(), previewTrimBtn: element(), scrubVideo: element(),
    clipVideo: { currentTime: 0, paused: true, pause() { this.paused = true; } },
    fpsSelect: { value: '10' }, speedSelect: { value: '1' }, loopModeSelect: { value: 'pingpong' },
  };
  const state = { clip: { duration: 2 }, mode: 'edit', trimStart: 0, trimEnd: 2,
    trimPreviewToken: 0, timelineSettleToken: 0, timelineSeekGate: createTimelineSeekGate(), loopPreview: null };
  const context = {
    state, el, AbortController, createExportTiming, createLoopFramePlan, createLoopPreviewClock, calculateTimelinePlaybackTarget,
    normalizeLoopMode: value => value,
    clamp: (n, min, max) => Math.max(min, Math.min(max, n)),
    performance: { now: () => now }, document: { hidden: false },
    requestAnimationFrame(callback) { rafs.set(++nextRaf, callback); return nextRaf; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    prepareLoopPreviewFrames(options) {
      const job = deferred();
      const cache = { frames: [], closed: 0, dispose() { this.closed++; } };
      jobs.push({ ...job, options, cache });
      return job.promise;
    },
    createExportFrameSource() { throw new Error('Fixture must not decode real media'); },
    cancelTimelinePreview() { state.timelineSeekGate.cancel(); },
    seekVideo() { const seek = deferred(); seeks.push(seek); return seek.promise; },
    renderExportPreviewFrame() { paints++; }, updateTimelinePlayhead() {},
    saveExportPreference() {}, updateEstimatedFileSize() {},
    setStatus(message) { statuses.push(message); }, friendlyError: error => error.message,
  };
  vm.runInNewContext(editor + '\nthis.api = { startLoopPreview, stopTrimPreview, previewTrimmedClip, settleTimelinePreview, handleExportInputChange, updateLoopPreviewClock };', context);
  return { ...context, jobs, seeks, statuses, rafs, setTime: value => { now = value; },
    get paints() { return paints; } };
}

async function ready(f, playing = true) {
  const pending = f.api.startLoopPreview(playing);
  const job = f.jobs.at(-1);
  job.resolve(job.cache);
  await pending;
  return job.cache;
}

test('closing during preparation aborts work and disposes a late cache without repainting', async () => {
  const f = fixture();
  const pending = f.api.startLoopPreview(true);
  f.api.stopTrimPreview();
  const paints = f.paints;
  assert.equal(f.jobs[0].options.signal.aborted, true);
  f.jobs[0].resolve(f.jobs[0].cache);
  await pending;
  assert.equal(f.jobs[0].cache.closed, 1);
  assert.equal(f.state.loopPreview, null);
  assert.equal(f.paints, paints);
  assert.equal(f.rafs.size, 0);
});

test('an obsolete preparation failure cannot clear or report an error over its replacement', async () => {
  const f = fixture();
  const old = f.api.startLoopPreview(true);
  f.el.loopModeSelect.value = 'crossfade';
  const cache = await ready(f, false);
  const replacement = f.state.loopPreview;
  f.jobs[0].reject(new Error('obsolete decoder'));
  await old;
  assert.equal(f.state.loopPreview, replacement);
  assert.equal(replacement.cache, cache);
  assert.equal(replacement.playing, false);
  assert.equal(f.statuses.some(message => message.includes('obsolete decoder')), false);
});

test('pause and resume retain the reverse phase, partial frame time and cached images', async () => {
  const f = fixture();
  const cache = await ready(f);
  f.setTime(2250);
  await f.api.previewTrimmedClip();
  assert.equal(f.state.loopPreview.playing, false);
  assert.equal(f.state.loopPreview.position.reverse, true);
  const elapsed = f.state.loopPreview.position.elapsed;
  const sourceIndex = f.state.loopPreview.frame.sourceIndex;
  f.setTime(8000);
  await f.api.previewTrimmedClip();
  assert.equal(f.state.loopPreview.playing, true);
  assert.equal(f.state.loopPreview.position.elapsed, elapsed);
  assert.equal(f.state.loopPreview.frame.sourceIndex, sourceIndex);
  assert.equal(f.state.loopPreview.cache, cache);
  assert.equal(f.jobs.length, 1);
  f.api.stopTrimPreview();
  assert.equal(cache.closed, 1);
});

test('pausing while preparing prevents autoplay when frames arrive', async () => {
  const f = fixture();
  const pending = f.api.startLoopPreview(true);
  await f.api.previewTrimmedClip();
  f.jobs[0].resolve(f.jobs[0].cache);
  await pending;
  assert.equal(f.state.loopPreview.playing, false);
  assert.equal(f.state.loopPreview.position.elapsed, 0);
  assert.equal(f.rafs.size, 0);
});

test('an already queued animation callback cannot paint after its session is destroyed', async () => {
  const f = fixture();
  await ready(f);
  const staleCallback = [...f.rafs.values()][0];
  assert.equal(typeof staleCallback, 'function');
  f.api.stopTrimPreview();
  const paints = f.paints;
  staleCallback();
  assert.equal(f.paints, paints);
  assert.equal(f.rafs.size, 0);
});

test('source dragging restarts effect preview at cycle start and respects paused state', async () => {
  const f = fixture();
  const oldCache = await ready(f, false);
  f.el.loopModeSelect.value = 'crossfade';
  f.api.settleTimelinePreview('playhead', 1.8, false);
  const job = f.jobs.at(-1);
  job.resolve(job.cache);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oldCache.closed, 1);
  assert.equal(f.state.loopPreview.position.elapsed, 0);
  assert.equal(f.state.loopPreview.frame.sourceIndex, 5);
  assert.equal(f.state.loopPreview.playing, false);
});

test('duplicate input/change events prepare once and keep the previous play state', async () => {
  const f = fixture();
  await ready(f, false);
  f.el.speedSelect.value = '1.5';
  f.api.handleExportInputChange({ currentTarget: f.el.speedSelect });
  f.api.handleExportInputChange({ currentTarget: f.el.speedSelect });
  assert.equal(f.jobs.length, 2);
  const job = f.jobs.at(-1);
  job.resolve(job.cache);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.loopPreview.playing, false);
  assert.equal(f.state.loopPreview.position.elapsed, 0);
});

test('a delayed ordinary scrub cannot resume or obscure the replacement paused loop', async () => {
  const f = fixture();
  f.el.loopModeSelect.value = 'none';
  f.api.settleTimelinePreview('playhead', 1.2, true);
  assert.equal(f.el.scrubVideo.classList.contains('active'), true);
  f.el.loopModeSelect.value = 'pingpong';
  const cache = await ready(f, false);
  f.seeks[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.loopPreview.playing, false);
  assert.equal(f.state.loopPreview.cache, cache);
  assert.equal(f.el.scrubVideo.classList.contains('active'), false);
});

test('retrying a failed preparation clears its error when the preview becomes ready', async () => {
  const f = fixture();
  const pending = f.api.startLoopPreview(true);
  f.jobs[0].reject(new Error('decoder unavailable'));
  await pending;
  assert.equal(f.state.loopPreview.error, true);
  assert.match(f.statuses.at(-1), /decoder unavailable/);
  await ready(f);
  assert.equal(f.statuses.at(-1), '');
  assert.equal(f.state.loopPreview.playing, true);
});
