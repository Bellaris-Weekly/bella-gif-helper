'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticReporter, pageIdentity } = require('../src/diagnostics');

function harness({ statuses = [], online = true } = {}) {
  const requests = [];
  const timers = [];
  let clock = 0;
  let ids = 0;
  const reporter = createDiagnosticReporter({
    endpoint: 'https://logs.example.com/v1/logs',
    version: '1.6.0',
    userAgent: 'Chrome/140',
    request(options) {
      requests.push({ ...options, body: JSON.parse(options.data) });
      const status = statuses.length ? statuses.shift() : 200;
      queueMicrotask(() => options.onload({ status }));
    },
    online: () => online,
    id: () => `op${++ids}`,
    wait: async () => {},
    now: () => clock,
    clock: () => `t${clock}`,
    every(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    cancelTimer(handle) { timers[handle - 1].cancelled = true; },
    visibility: () => 'visible',
  });
  const tick = (ms) => {
    clock += ms;
    for (const timer of timers) if (!timer.cancelled) timer.fn();
  };
  return { reporter, requests, timers, tick, advance: (ms) => { clock += ms; } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DETAILS = {
  pageUrl: 'https://live.bilibili.com/22625025?broadcast_type=0&spm_id_from=abc',
  mode: 'live_rewind',
  clip: { kind: 'media-source', duration: 60, width: 1920, height: 1080 },
  selection: { start: 10, end: 14 },
};

test('without an endpoint everything is a silent no-op and feedback is hidden', async () => {
  const requests = [];
  const reporter = createDiagnosticReporter({ endpoint: '', request: (o) => requests.push(o) });
  assert.equal(reporter.canFeedback, false);
  const op = reporter.begin('export', DETAILS);
  op.progress({ phase: 'encoding', fraction: 0.5 });
  op.fail(new Error('x'));
  assert.equal(await reporter.feedback('issue', 'hi'), 'failed');
  assert.equal(requests.length, 0);
});

test('feedback is sent immediately under the gif helper source without query strings', async () => {
  const { reporter, requests } = harness();
  assert.equal(await reporter.feedback('issue', '  导出后颜色发灰  ', DETAILS), 'sent');
  assert.equal(requests.length, 1);
  const { body } = requests[0];
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].anonymous, true);
  assert.deepEqual(Object.keys(body).sort(), ['context', 'event', 'id', 'level', 'message', 'source', 'version']);
  assert.equal(body.source, 'bella-gif-helper');
  assert.equal(body.event, 'feedback_issue');
  assert.equal(body.message, '导出后颜色发灰');
  assert.equal(body.context.page, 'https://live.bilibili.com/22625025');
  assert.equal(body.context.mode, 'live_rewind');
  assert.deepEqual(body.context.clip, { kind: 'media-source', duration: 60, width: 1920, height: 1080 });
  assert.equal(body.context.browser, 'Chrome/140');
});

test('feedback maps rate limits, rejects unknown kinds and empty text', async () => {
  const { reporter, requests } = harness({ statuses: [429, 500] });
  assert.equal(await reporter.feedback('issue', 'a'), 'rate_limited');
  assert.equal(await reporter.feedback('issue', 'a'), 'failed');
  assert.equal(await reporter.feedback('praise', 'a'), 'failed');
  assert.equal(await reporter.feedback('issue', '   '), 'failed');
  assert.equal(requests.length, 2);
});

test('an export reports start, 10 s heartbeats, stall and a terminal row under one operation id', async () => {
  const { reporter, requests, tick, advance } = harness();
  const op = reporter.begin('export', { ...DETAILS, settings: { fps: 12, quality: 'bei', frames: 48 } });
  op.stage('palette');
  advance(2000);
  op.progress({ phase: 'extracting', fraction: 0.3, frames: 12 });
  await flush();
  tick(10000);
  await flush();
  tick(31000);
  await flush();
  op.finish({ bytes: 1234567, frames: 48 });
  tick(10000);
  await flush();
  const events = requests.map((r) => r.body.event);
  assert.deepEqual(events, ['export_started', 'export_progress', 'export_stalled', 'export_completed']);
  const ids = new Set(requests.map((r) => r.body.context.operation.id));
  assert.deepEqual([...ids], ['op1']);
  assert.deepEqual(requests.map((r) => r.body.context.operation.sequence), [0, 1, 2, 3]);
  const done = requests.at(-1).body;
  assert.equal(done.level, 'info');
  assert.deepEqual(done.context.result, { bytes: 1234567, frames: 48 });
  assert.equal(done.context.settings.fps, 12);
  assert.ok(done.context.stageTimes.extracting > 0);
  assert.equal(requests[2].body.level, 'warn');
});

test('a queued heartbeat is superseded by the terminal row of the same export', async () => {
  const { reporter, requests, tick } = harness();
  const op = reporter.begin('export', DETAILS);
  reporter.begin('export', DETAILS);
  tick(10000);
  op.finish({ bytes: 1 });
  await flush();
  const first = requests.filter((r) => r.body.context.operation.id === 'op1').map((r) => r.body.event);
  assert.deepEqual(first, ['export_started', 'export_completed']);
});

test('cancel is reported as canceled, not as an error', async () => {
  const { reporter, requests } = harness();
  reporter.begin('export', DETAILS).fail(new Error('已取消导出。'), { canceled: true });
  await flush();
  assert.deepEqual(requests.map((r) => r.body.event), ['export_started', 'export_canceled']);
  assert.equal(requests[1].body.level, 'info');
});

test('non-export operations only report failures, with a redacted error', async () => {
  const { reporter, requests } = harness();
  reporter.begin('live_rewind', DETAILS);
  const failing = reporter.begin('recording', DETAILS);
  const error = new Error('fetch https://cn-gd.bilivideo.com/live/a.m4s?wsSecret=s3cret&token=abc failed');
  error.cause = new TypeError('network token=abc');
  failing.fail(error);
  await flush();
  assert.equal(requests.length, 1);
  const { body } = requests[0];
  assert.equal(body.event, 'recording_failed');
  assert.equal(body.level, 'error');
  assert.equal(body.message, 'fetch https://cn-gd.bilivideo.com/live/a.m4s failed');
  assert.ok(!JSON.stringify(body).includes('s3cret'));
  assert.ok(!JSON.stringify(body).includes('token=abc'));
  assert.equal(body.context.error.causes[0].name, 'TypeError');
});

test('server errors are retried once; offline logs are dropped and counted', async () => {
  const retry = harness({ statuses: [503, 200] });
  retry.reporter.begin('clip_load', DETAILS).fail(new Error('x'));
  await flush();
  await flush();
  assert.equal(retry.requests.length, 2);

  const offline = harness({ online: false });
  offline.reporter.begin('clip_load', DETAILS).fail(new Error('x'));
  await flush();
  assert.equal(offline.requests.length, 0);
});

test('page identity keeps only bilibili origin + path and the numeric part', () => {
  assert.equal(pageIdentity('https://www.bilibili.com/video/BV1xx?p=3&spm=x'), 'https://www.bilibili.com/video/BV1xx?p=3');
  assert.equal(pageIdentity('https://www.bilibili.com/video/BV1xx?p=evil'), 'https://www.bilibili.com/video/BV1xx');
  assert.equal(pageIdentity('https://studio.bk0717.com/clip?id=1'), undefined);
  assert.equal(pageIdentity('not a url'), undefined);
});
