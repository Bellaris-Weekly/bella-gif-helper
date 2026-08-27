'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CancelledError,
  createExportFrameSourceFromMediaApi,
  normalizeFrameTargetTimes,
} = require('./load-userscript-api');

function createFakeMediaApi(presentationSamples, { decodable = true, defaultDuration = 1 / 25 } = {}) {
  const metrics = {
    activeReads: 0,
    blobs: [],
    decodedSamples: 0,
    disposals: 0,
    framesClosed: 0,
    maxActiveReads: 0,
    randomReads: 0,
    sampleOptions: [],
    samplesClosed: 0,
    sequentialReads: 0,
  };
  const sortedSamples = presentationSamples
    .map((sample) => typeof sample === 'number'
      ? { timestamp: sample, duration: defaultDuration }
      : { duration: defaultDuration, ...sample })
    .sort((a, b) => a.timestamp - b.timestamp);
  const MP4 = Object.freeze({ name: 'mp4' });
  const WEBM = Object.freeze({ name: 'webm' });

  class BlobSource {
    constructor(blob) {
      this.blob = blob;
      metrics.blobs.push(blob);
    }
  }

  class Input {
    constructor(options) {
      this.options = options;
      this.disposed = false;
    }

    async getPrimaryVideoTrack() {
      return {
        canDecode: async () => decodable,
        getFirstTimestamp: async () => {
          throw new Error('frame source must not shift the clip presentation timeline');
        },
      };
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      metrics.disposals += 1;
    }
  }

  class VideoSampleSink {
    async *samples(startTimestamp, endTimestamp, options) {
      metrics.sequentialReads += 1;
      metrics.sampleOptions.push({ startTimestamp, endTimestamp, options });
      metrics.activeReads += 1;
      metrics.maxActiveReads = Math.max(metrics.maxActiveReads, metrics.activeReads);
      try {
        for (const sourceSample of sortedSamples) {
          metrics.decodedSamples += 1;
          let sampleClosed = false;
          yield {
            duration: sourceSample.duration,
            timestamp: sourceSample.timestamp,
            close() {
              if (sampleClosed) return;
              sampleClosed = true;
              metrics.samplesClosed += 1;
            },
            toVideoFrame() {
              let frameClosed = false;
              return {
                timestamp: Math.round(sourceSample.timestamp * 1_000_000),
                close() {
                  if (frameClosed) return;
                  frameClosed = true;
                  metrics.framesClosed += 1;
                },
              };
            },
          };
        }
      } finally {
        metrics.activeReads -= 1;
      }
    }

    samplesAtTimestamps() {
      metrics.randomReads += 1;
      throw new Error('random timestamp lookup must not be used');
    }
  }

  return {
    api: { BlobSource, Input, MP4, VideoSampleSink, WEBM },
    metrics,
  };
}

async function readFrames(source, times, options) {
  const frames = [];
  for await (const item of source.framesAt(times, options)) frames.push(item);
  return frames;
}

test('recorded WebM and rewind fMP4 use the same frame source adapter', async () => {
  const fake = createFakeMediaApi([0, 0.04, 0.08]);
  const webm = new Blob([Uint8Array.of(1, 2, 3)], { type: 'video/webm' });
  const recordedSource = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: webm },
    fake.api,
  );
  const rewindSource = await createExportFrameSourceFromMediaApi({
    kind: 'media-source',
    mimeType: 'video/mp4; codecs="avc1.640028"',
    parts: [Uint8Array.of(4, 5), Uint8Array.of(6, 7)],
  }, fake.api);

  assert.equal(fake.metrics.blobs[0], webm);
  assert.equal(fake.metrics.blobs[1].type, 'video/mp4; codecs="avc1.640028"');
  assert.equal(fake.metrics.blobs[1].size, 4);
  recordedSource.dispose();
  rewindSource.dispose();
  assert.equal(fake.metrics.disposals, 2);
});

test('target FPS preserves count and selects the frame displayed at each target time', async () => {
  for (const sourceFps of [12, 25, 30, 60]) {
    const sourceTimes = Array.from({ length: sourceFps + 1 }, (_, index) => index / sourceFps);
    const fake = createFakeMediaApi([...sourceTimes].reverse(), { defaultDuration: 1 / sourceFps });
    const source = await createExportFrameSourceFromMediaApi(
      { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
      fake.api,
    );
    const targets = Array.from({ length: 20 }, (_, index) => index / 20);
    const frames = await readFrames(source, targets);

    assert.equal(frames.length, targets.length);
    assert.deepEqual(frames.map((item) => item.index), Array.from(targets.keys()));
    assert.deepEqual(frames.map((item) => item.targetTime), targets);
    frames.forEach((item, index) => {
      const expected = sourceTimes.filter((time) => time <= targets[index]).sort((a, b) => a - b).at(-1);
      assert.equal(item.frame.timestamp, Math.round(expected * 1_000_000));
      item.frame.close();
    });
    const firstAfterLastTarget = sourceTimes.findIndex((time) => time - targets.at(-1) > 1e-10);
    const expectedDecoded = firstAfterLastTarget === -1 ? sourceTimes.length : firstAfterLastTarget + 1;
    assert.equal(fake.metrics.decodedSamples, expectedDecoded);
    assert.equal(fake.metrics.samplesClosed, expectedDecoded);
    assert.equal(fake.metrics.framesClosed, targets.length);
    assert.equal(fake.metrics.randomReads, 0);
    assert.equal(fake.metrics.sequentialReads, 1);
    source.dispose();
  }
});

test('target times remain on the clip presentation timeline', async () => {
  const fake = createFakeMediaApi([0.08, 0.12, 0.16]);
  const source = await createExportFrameSourceFromMediaApi(
    { kind: 'media-source', mimeType: 'video/mp4', parts: [Uint8Array.of(1)] },
    fake.api,
  );
  await assert.rejects(readFrames(source, [0]), /无法解码/);
  const frames = await readFrames(source, [0.08, 0.12, 0.16]);

  assert.deepEqual(frames.map((item) => item.frame.timestamp), [80000, 120000, 160000]);
  frames.forEach((item) => item.frame.close());
  source.dispose();
});

test('palette and full-frame reads remain sequential on one decoder source', async () => {
  const fake = createFakeMediaApi([0, 0.25, 0.5, 0.75, 1]);
  const source = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
    fake.api,
  );
  const palette = await readFrames(source, [0, 0.5, 1]);
  palette.forEach((item) => item.frame.close());
  const full = await readFrames(source, [0, 0.25, 0.5, 0.75, 1]);
  full.forEach((item) => item.frame.close());

  assert.equal(fake.metrics.maxActiveReads, 1);
  source.dispose();
});

test('sequential decoding crosses fragment boundaries without timestamp lookups', async () => {
  const fake = createFakeMediaApi([
    { timestamp: 0, duration: 1 / 30 },
    { timestamp: 0.267, duration: 1 / 30 },
    { timestamp: 0.3, duration: 1 / 30 },
    { timestamp: 0.333, duration: 1 / 30 },
    { timestamp: 0.367, duration: 1 / 30 },
  ]);
  const source = await createExportFrameSourceFromMediaApi(
    { kind: 'media-source', mimeType: 'video/mp4', parts: [Uint8Array.of(1), Uint8Array.of(2)] },
    fake.api,
  );
  const frames = await readFrames(source, [0, 0.25, 0.333, 0.35]);

  assert.deepEqual(frames.map((item) => item.frame.timestamp), [0, 0, 333000, 333000]);
  assert.equal(fake.metrics.sequentialReads, 1);
  assert.equal(fake.metrics.randomReads, 0);
  assert.deepEqual(fake.metrics.sampleOptions[0].options, { skipLiveWait: true });
  frames.forEach((item) => item.frame.close());
  source.dispose();
});

test('missing frames, unordered targets and cancellation fail explicitly', async () => {
  assert.throws(() => normalizeFrameTargetTimes([0.2, 0.1]), /顺序排列/);

  const missingFake = createFakeMediaApi([]);
  const missingSource = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
    missingFake.api,
  );
  await assert.rejects(readFrames(missingSource, [0]), /无法解码/);
  missingSource.dispose();

  const incompleteFake = createFakeMediaApi([{ timestamp: 0, duration: 0.04 }]);
  const incompleteSource = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
    incompleteFake.api,
  );
  await assert.rejects(readFrames(incompleteSource, [0.05]), /无法解码/);
  assert.equal(incompleteFake.metrics.samplesClosed, 1);
  incompleteSource.dispose();

  const unsupportedFake = createFakeMediaApi([0], { decodable: false });
  await assert.rejects(
    createExportFrameSourceFromMediaApi(
      { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
      unsupportedFake.api,
    ),
    /无法通过 WebCodecs 解码/,
  );
  assert.equal(unsupportedFake.metrics.disposals, 1);

  const cancelFake = createFakeMediaApi([0, 0.1]);
  const cancelSource = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
    cancelFake.api,
  );
  const controller = new AbortController();
  const iterator = cancelSource.framesAt([0, 0.1], { signal: controller.signal });
  const first = await iterator.next();
  first.value.frame.close();
  controller.abort();
  await assert.rejects(iterator.next(), (error) => error instanceof CancelledError);
  assert.equal(cancelFake.metrics.disposals, 1);
  assert.equal(cancelFake.metrics.samplesClosed, 2);
  assert.equal(cancelFake.metrics.activeReads, 0);
});
