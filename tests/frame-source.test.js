'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CancelledError,
  createExportFrameSourceFromMediaApi,
  normalizeFrameTargetTimes,
} = require('./load-userscript-api');

function createFakeMediaApi(presentationTimes, { decodable = true } = {}) {
  const metrics = {
    activeReads: 0,
    blobs: [],
    disposals: 0,
    framesClosed: 0,
    maxActiveReads: 0,
    samplesClosed: 0,
  };
  const sortedTimes = [...presentationTimes].sort((a, b) => a - b);
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
        getFirstTimestamp: async () => sortedTimes[0] ?? 0,
      };
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      metrics.disposals += 1;
    }
  }

  class VideoSampleSink {
    async *samplesAtTimestamps(targetTimes) {
      metrics.activeReads += 1;
      metrics.maxActiveReads = Math.max(metrics.maxActiveReads, metrics.activeReads);
      try {
        for (const target of targetTimes) {
          const timestamp = sortedTimes.filter((time) => time <= target).at(-1);
          if (timestamp === undefined) {
            yield null;
            continue;
          }
          let sampleClosed = false;
          yield {
            close() {
              if (sampleClosed) return;
              sampleClosed = true;
              metrics.samplesClosed += 1;
            },
            toVideoFrame() {
              let frameClosed = false;
              return {
                timestamp: Math.round(timestamp * 1_000_000),
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
    const fake = createFakeMediaApi(sourceTimes.reverse());
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
    assert.equal(fake.metrics.samplesClosed, targets.length);
    assert.equal(fake.metrics.framesClosed, targets.length);
    source.dispose();
  }
});

test('local export times are mapped from a non-zero first presentation timestamp', async () => {
  const fake = createFakeMediaApi([0.08, 0.12, 0.16]);
  const source = await createExportFrameSourceFromMediaApi(
    { kind: 'media-source', mimeType: 'video/mp4', parts: [Uint8Array.of(1)] },
    fake.api,
  );
  const frames = await readFrames(source, [0, 0.04, 0.08]);

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

test('missing frames, unordered targets and cancellation fail explicitly', async () => {
  assert.throws(() => normalizeFrameTargetTimes([0.2, 0.1]), /顺序排列/);

  const missingFake = createFakeMediaApi([]);
  const missingSource = await createExportFrameSourceFromMediaApi(
    { kind: 'blob', blob: new Blob([Uint8Array.of(1)], { type: 'video/webm' }) },
    missingFake.api,
  );
  await assert.rejects(readFrames(missingSource, [0]), /无法解码/);
  missingSource.dispose();

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
});
