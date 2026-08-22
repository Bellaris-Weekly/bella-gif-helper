const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LiveRewindTrack,
  calculateLiveFirstFrameTime,
  extractLiveRoomId,
  filterLiveInitToTrack,
  filterLiveMediaToTrack,
  formatGifFileName,
  installLiveMediaCollector,
  isLiveFrameMessage,
  mapLiveFrameVideoRect,
  parseLiveInit,
  parseLiveMedia,
  readIsoBoxes,
  toVideoOnlyMimeType,
} = require('../bella-gif-helper.user.js');

test('活动直播房间和轻量播放器路径使用同一房间识别规则', () => {
  assert.equal(extractLiveRoomId('/21919321'), '21919321');
  assert.equal(extractLiveRoomId('/blanc/21919321'), '21919321');
  assert.equal(extractLiveRoomId('/blanc/21919321/'), '21919321');
  assert.equal(extractLiveRoomId('/blackboard/era/example'), '');
});

test('跨 iframe 消息只接受同源、同通道和指定发送窗口', () => {
  const source = {};
  const base = {
    origin: 'https://live.bilibili.com',
    source,
    data: { channel: 'bella-gif-helper-live-frame-v1', version: 1, kind: 'ready' },
  };
  assert.equal(isLiveFrameMessage(base, 'https://live.bilibili.com', source), true);
  assert.equal(isLiveFrameMessage({ ...base, origin: 'https://evil.example' }, 'https://live.bilibili.com', source), false);
  assert.equal(isLiveFrameMessage({ ...base, source: {} }, 'https://live.bilibili.com', source), false);
  assert.equal(isLiveFrameMessage({ ...base, data: { ...base.data, version: 2 } }, 'https://live.bilibili.com', source), false);
});

test('活动播放器坐标按 iframe 视口比例映射到顶层页面', () => {
  assert.deepEqual(
    mapLiveFrameVideoRect(
      { left: 100, top: 50, width: 560, height: 315 },
      { viewportWidth: 1120, viewportHeight: 630, rect: { left: 0, top: 0, width: 1120, height: 630 } },
    ),
    { left: 100, top: 50, right: 660, bottom: 365, width: 560, height: 315 },
  );
  assert.equal(mapLiveFrameVideoRect(null, {}), null);
});

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function u64(value) {
  const bytes = new Uint8Array(8);
  const number = BigInt(value);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number((number >> 32n) & 0xffffffffn));
  view.setUint32(4, Number(number & 0xffffffffn));
  return bytes;
}

function ascii(value) {
  return Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
}

function box(type, ...payloads) {
  const payload = concat(payloads);
  return concat([u32(payload.byteLength + 8), ascii(type), payload]);
}

function fullBox(type, version, flags, ...payloads) {
  const header = Uint8Array.of(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff);
  return box(type, header, ...payloads);
}

function makeInit({ trackId = 1, timescale = 1000, defaultDuration = 500, marker = 0 } = {}) {
  const tkhd = fullBox('tkhd', 0, 0, u32(0), u32(0), u32(trackId));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr));
  const syncFlags = 0x02000000;
  const trex = fullBox('trex', 0, 0, u32(trackId), u32(1), u32(defaultDuration), u32(0), u32(syncFlags));
  const moov = box('moov', trak, box('mvex', trex), box('free', Uint8Array.of(marker)));
  return concat([box('ftyp', ascii('iso6'), u32(0), ascii('iso6')), moov]);
}

function makeMuxedInit() {
  const videoInit = makeInit();
  const videoTop = readIsoBoxes(videoInit);
  const videoMoov = videoTop.find((boxInfo) => boxInfo.type === 'moov');
  const videoChildren = readIsoBoxes(videoInit, videoMoov.dataStart, videoMoov.end);
  const audioTkhd = fullBox('tkhd', 0, 0, u32(0), u32(0), u32(2));
  const audioMdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(48_000));
  const audioHdlr = fullBox('hdlr', 0, 0, u32(0), ascii('soun'));
  const audioTrak = box('trak', audioTkhd, box('mdia', audioMdhd, audioHdlr));
  const audioTrex = fullBox('trex', 0, 0, u32(2), u32(1), u32(1024), u32(2), u32(0x02000000));
  const rebuiltChildren = [];
  for (const child of videoChildren) {
    rebuiltChildren.push(videoInit.subarray(child.start, child.end));
    if (child.type === 'trak') rebuiltChildren.push(audioTrak);
    if (child.type === 'mvex') {
      rebuiltChildren.pop();
      const mvexChildren = readIsoBoxes(videoInit, child.dataStart, child.end)
        .map((entry) => videoInit.subarray(entry.start, entry.end));
      rebuiltChildren.push(box('mvex', ...mvexChildren, audioTrex));
    }
  }
  const ftyp = videoTop.find((boxInfo) => boxInfo.type === 'ftyp');
  return concat([videoInit.subarray(ftyp.start, ftyp.end), box('moov', ...rebuiltChildren)]);
}

function makeMuxedMedia() {
  const makeTraf = (trackId, dataOffset, sampleSize) => {
    const tfhd = fullBox('tfhd', 0, 0x000008 | 0x000010 | 0x000020,
      u32(trackId), u32(500), u32(sampleSize), u32(trackId === 1 ? 0x02000000 : 0));
    const tfdt = fullBox('tfdt', 1, 0, u64(0));
    const trun = fullBox('trun', 0, 0x000001 | 0x000100 | 0x000400,
      u32(2), u32(dataOffset),
      u32(500), u32(trackId === 1 ? 0x02000000 : 0),
      u32(500), u32(trackId === 1 ? 0x01010000 : 0));
    return box('traf', tfhd, tfdt, trun);
  };
  const placeholder = box('moof', fullBox('mfhd', 0, 0, u32(1)), makeTraf(1, 0, 4), makeTraf(2, 0, 2));
  const videoOffset = placeholder.byteLength + 8;
  const audioOffset = videoOffset + 8;
  const moof = box('moof', fullBox('mfhd', 0, 0, u32(1)), makeTraf(1, videoOffset, 4), makeTraf(2, audioOffset, 2));
  return concat([moof, box('mdat', new Uint8Array(12))]);
}

function makeMedia({
  trackId = 1,
  base = 0,
  durations = [500, 500],
  keyframes = [0],
  payloadBytes = 16,
} = {}) {
  const defaultFlags = 0x01010000;
  const tfhd = fullBox('tfhd', 0, 0x000008 | 0x000020, u32(trackId), u32(durations[0]), u32(defaultFlags));
  const tfdt = fullBox('tfdt', 1, 0, u64(base));
  const samples = durations.flatMap((duration, index) => [
    u32(duration),
    u32(keyframes.includes(index) ? 0x02000000 : 0x01010000),
  ]);
  const trun = fullBox('trun', 0, 0x000100 | 0x000400, u32(durations.length), ...samples);
  return concat([
    box('styp', ascii('msdh'), u32(0), ascii('msdh')),
    box('moof', box('traf', tfhd, tfdt, trun)),
    box('mdat', new Uint8Array(payloadBytes)),
  ]);
}

function readyTrack(options) {
  const track = new LiveRewindTrack(options);
  track.setMimeType('video/mp4; codecs="avc1.640028"');
  assert.equal(track.setInit(makeInit()), true);
  return track;
}

function appendParsedSecond(track, second, { keyframe = true, bytes = 1 } = {}) {
  track.appendSegment({
    start: second,
    end: second + 1,
    startTicks: BigInt(second * 1000),
    endTicks: BigInt((second + 1) * 1000),
    keyframes: keyframe ? [second] : [],
    timestampOffset: 0,
    data: new Uint8Array(bytes),
  });
}

test('fMP4 解析能识别视频轨道、时间和关键帧', () => {
  const init = makeInit({ timescale: 1000, defaultDuration: 400 });
  const metadata = parseLiveInit(init);
  assert.deepEqual(metadata, {
    trackId: 1,
    timescale: 1000,
    defaultSampleDuration: 400,
    defaultSampleSize: 0,
    defaultSampleFlags: 0x02000000,
  });
  const media = makeMedia({ base: 12_000, durations: [400, 600], keyframes: [0] });
  const parsed = parseLiveMedia(media, metadata, 2.5);
  assert.equal(parsed.start, 14.5);
  assert.equal(parsed.end, 15.5);
  assert.deepEqual(parsed.keyframes, [14.5]);
});

test('音视频复用分片在缓存前只保留视频轨道和视频样本', () => {
  const init = makeMuxedInit();
  const filteredInit = filterLiveInitToTrack(init, 1);
  const moov = readIsoBoxes(filteredInit).find((boxInfo) => boxInfo.type === 'moov');
  assert.equal(readIsoBoxes(filteredInit, moov.dataStart, moov.end).filter((boxInfo) => boxInfo.type === 'trak').length, 1);

  const media = makeMuxedMedia();
  const filteredMedia = filterLiveMediaToTrack(media, 1);
  const topLevel = readIsoBoxes(filteredMedia);
  const moof = topLevel.find((boxInfo) => boxInfo.type === 'moof');
  const mdat = topLevel.find((boxInfo) => boxInfo.type === 'mdat');
  assert.equal(readIsoBoxes(filteredMedia, moof.dataStart, moof.end).filter((boxInfo) => boxInfo.type === 'traf').length, 1);
  assert.equal(mdat.size, 16);
  assert.equal(parseLiveMedia(filteredMedia, parseLiveInit(filteredInit)).end, 1);
});

test('过滤音轨后回放声明只保留对应视频编码', () => {
  const samples = [
    ['video/mp4; codecs="avc1.4d401f,mp4a.40.2"', 'video/mp4; codecs="avc1.4d401f"'],
    ['video/mp4; codecs="hvc1.2.4.L153.B0,opus"', 'video/mp4; codecs="hvc1.2.4.L153.B0"'],
  ];
  for (const [sourceMimeType, expectedMimeType] of samples) {
    assert.equal(toVideoOnlyMimeType(sourceMimeType), expectedMimeType);
    const track = new LiveRewindTrack();
    track.setMimeType(sourceMimeType);
    assert.equal(track.setInit(makeInit()), true);
    appendParsedSecond(track, 0);
    assert.equal(track.snapshot().mimeType, expectedMimeType);
  }
});

test('分次追加的 fMP4 盒会先组装为完整媒体单元', () => {
  const muxedTrack = new LiveRewindTrack();
  muxedTrack.setMimeType('video/mp4; codecs="avc1.4d401f,mp4a.40.2"');
  assert.equal(muxedTrack.ingest(makeMuxedInit()), true);
  const muxedMedia = makeMuxedMedia();
  const moof = readIsoBoxes(muxedMedia).find((boxInfo) => boxInfo.type === 'moof');
  assert.equal(muxedTrack.ingest(muxedMedia.subarray(0, moof.end)), false);
  assert.equal(muxedTrack.getStatus().duration, 0);
  assert.equal(muxedTrack.ingest(muxedMedia.subarray(moof.end)), true);
  assert.deepEqual(readIsoBoxes(muxedTrack.snapshot().parts[1]).map((boxInfo) => boxInfo.type), ['moof', 'mdat']);

  const byteSplitTrack = new LiveRewindTrack();
  byteSplitTrack.setMimeType('video/mp4; codecs="hev1.1.6.L93"');
  const init = makeInit();
  assert.equal(byteSplitTrack.ingest(init.subarray(0, 13)), false);
  assert.equal(byteSplitTrack.ingest(init.subarray(13)), true);
  const media = makeMedia();
  assert.equal(byteSplitTrack.ingest(media.subarray(0, 29)), false);
  assert.equal(byteSplitTrack.ingest(media.subarray(29)), true);
  assert.equal(byteSplitTrack.snapshot().duration, 1);
});

test('75 秒环形缓存只快照最后 60 秒', () => {
  const track = readyTrack();
  for (let second = 0; second < 100; second += 1) appendParsedSecond(track, second);
  assert.equal(track.segments.length, 75);
  assert.equal(track.segments[0].start, 25);
  const snapshot = track.snapshot();
  assert.equal(snapshot.sourceStart, 40);
  assert.equal(snapshot.sourceEnd, 100);
  assert.equal(snapshot.trimStart, 0);
  assert.equal(snapshot.trimEnd, 60);
});

test('预热不足 60 秒时返回当前全部可解码内容', () => {
  const track = readyTrack();
  for (let second = 0; second < 9; second += 1) appendParsedSecond(track, second);
  const snapshot = track.snapshot();
  assert.equal(snapshot.duration, 9);
  assert.equal(snapshot.trimStart, 0);
  assert.equal(snapshot.trimEnd, 9);
});

test('关键帧预留不改变默认的最近 60 秒范围', () => {
  const receivedAtMs = new Date(2026, 7, 20, 14, 5, 9).getTime();
  const track = readyTrack({ now: () => receivedAtMs });
  for (let second = 0; second < 72; second += 1) {
    appendParsedSecond(track, second, { keyframe: second % 10 === 0 });
  }
  const snapshot = track.snapshot();
  assert.equal(snapshot.duration, 62);
  assert.equal(snapshot.trimStart, 2);
  assert.equal(snapshot.trimEnd, 62);
  assert.equal(snapshot.trimEnd - snapshot.trimStart, 60);
  assert.equal(
    calculateLiveFirstFrameTime(snapshot.liveWallClockStartMs, snapshot.trimStart),
    receivedAtMs - 60_000,
  );
});

test('直播录制按最终裁剪首帧计算文件时间并清理来源名称', () => {
  const recordingStart = new Date(2026, 7, 20, 14, 5, 9).getTime();
  const firstFrameTime = calculateLiveFirstFrameTime(recordingStart, 4.25);

  assert.equal(firstFrameTime, recordingStart + 4250);
  assert.equal(
    formatGifFileName(firstFrameTime, '主播 名/测试_1700657229'),
    '贝报gif_140513_0820_主播_名_测试_1700657229.gif',
  );
  assert.throws(() => formatGifFileName(null, '主播_1700657229'), /无法确定 GIF 首帧时间/);
});

test('2 Mbps 与 8 Mbps 都按时间而不是字节数清理', () => {
  for (const bytesPerSecond of [250_000, 1_000_000]) {
    const track = readyTrack();
    for (let second = 0; second < 76; second += 1) {
      appendParsedSecond(track, second, { bytes: bytesPerSecond });
    }
    assert.equal(track.segments.length, 75);
    assert.equal(track.segments[0].start, 1);
    assert.equal(track.segments.at(-1).end, 76);
    track.clearAll();
  }
});

test('时间偏移、断层、倒退和编码变化都会开启新代次', () => {
  const samples = [
    (track) => track.appendSegment({ start: 1, end: 2, startTicks: 0n, keyframes: [1], timestampOffset: 1, data: new Uint8Array(1) }),
    (track) => appendParsedSecond(track, 20),
    (track) => appendParsedSecond(track, -2),
    (track) => track.setMimeType('video/mp4; codecs="hev1.1.6.L120"'),
  ];
  for (const mutate of samples) {
    const track = readyTrack();
    appendParsedSecond(track, 0);
    const generation = track.generation;
    mutate(track);
    assert.ok(track.generation > generation);
    assert.ok(track.segments.length <= 1);
  }
});

test('相同编码的新初始化段会隔离旧清晰度代次', () => {
  const track = readyTrack();
  appendParsedSecond(track, 0);
  const generation = track.generation;
  assert.equal(track.setInit(makeInit({ marker: 1 })), true);
  assert.ok(track.generation > generation);
  assert.equal(track.segments.length, 0);
});

test('收集器隔离音频与第二播放器，并在框选模式释放媒体缓存', () => {
  let nextUrl = 1;
  class FakeSourceBuffer {
    constructor() { this.timestampOffset = 0; }
    appendBuffer() { return undefined; }
    changeType() { return undefined; }
  }
  class FakeMediaSource {
    addSourceBuffer() { return new FakeSourceBuffer(); }
  }
  const fakeWindow = {
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    URL: {
      createObjectURL() { return `blob:fake-${nextUrl++}`; },
      revokeObjectURL() {},
    },
  };
  const collector = installLiveMediaCollector(fakeWindow, true);
  const first = new FakeMediaSource();
  const second = new FakeMediaSource();
  const firstUrl = fakeWindow.URL.createObjectURL(first);
  const secondUrl = fakeWindow.URL.createObjectURL(second);
  const audio = first.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const firstVideo = first.addSourceBuffer('video/mp4; codecs="avc1.640028"');
  const secondVideo = second.addSourceBuffer('video/mp4; codecs="avc1.640028"');
  collector.setActiveVideo({ currentSrc: firstUrl });
  audio.appendBuffer(makeInit());
  firstVideo.appendBuffer(makeInit());
  firstVideo.appendBuffer(makeMedia({ base: 0 }));
  secondVideo.appendBuffer(makeInit());
  secondVideo.appendBuffer(makeMedia({ base: 10_000 }));

  const firstSnapshot = collector.getSnapshot({ currentSrc: firstUrl });
  const secondSnapshot = collector.getSnapshot({ currentSrc: secondUrl });
  assert.equal(firstSnapshot.sourceEnd, 1);
  assert.equal(secondSnapshot, null);

  collector.setActiveVideo({ currentSrc: secondUrl });
  secondVideo.appendBuffer(makeMedia({ base: 11_000 }));
  assert.equal(collector.getSnapshot({ currentSrc: secondUrl }).sourceStart, 11);
  assert.equal(collector.getSnapshot({ currentSrc: firstUrl }), null);

  collector.setEnabled(false);
  assert.equal(collector.getSnapshot({ currentSrc: secondUrl }), null);
  assert.equal(collector.getStatus({ currentSrc: secondUrl }).bytes, 0);
  collector.setActiveVideo({ currentSrc: firstUrl });
  collector.setEnabled(true);
  firstVideo.appendBuffer(makeMedia({ base: 1_000 }));
  assert.equal(collector.getSnapshot({ currentSrc: firstUrl }).sourceStart, 1);
  collector.dispose();
});
