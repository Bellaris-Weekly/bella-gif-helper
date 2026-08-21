// ==UserScript==
// @name         贝报 GIF 助手
// @namespace    https://www.bk0717.com/
// @version      1.4.1
// @description  B站直播回溯、视频框选录制与 GIF 编辑
// @author       贝极星周报
// @homepageURL  https://github.com/Bellaris-Weekly/bella-gif-helper
// @icon         https://i0.hdslb.com/bfs/garb/item/70de4619ce5e8a7b5bbe5c4124aa69353d8102e4.png
// @license      MIT
// @downloadURL  https://share.bellaris.fans/bella-gif-helper.user.js
// @updateURL    https://share.bellaris.fans/bella-gif-helper.user.js
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/cheese/play/*
// @match        https://live.bilibili.com/*
// @match        https://m.bilibili.com/video/*
// @match        https://live.bilibili.com/*
// @resource     MODERN_PALETTE_MODULE https://cdn.jsdelivr.net/npm/modern-palette@2.0.0/dist/index.mjs
// @resource     GIFENC_MODULE https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js
// @resource     GIFSICLE_MODULE https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

// GIF 调色使用 modern-palette 2.0.0，编码使用 gifenc 1.0.3（MIT License）。
// GIF 后压缩使用 Gifsicle WASM（Gifsicle GPL-2.0-or-later）。

(() => {
  'use strict';

  const LIVE_REWIND_BUFFER_SECONDS = 75;
  const LIVE_REWIND_TARGET_SECONDS = 60;
  const LIVE_CAPTURE_MODE_KEY = 'biliGifMakerLiveCaptureModeV1';
  const GIF_TRANSPARENT_INDEX = 255;
  const PREVIEW_CACHE_MEMORY_BUDGET = 32 * 1024 * 1024;
  const PREVIEW_CACHE_MAX_FRAMES = 121;
  const PREVIEW_CACHE_FPS = 2;
  const PREVIEW_CACHE_MAX_EDGE = 260;
  const PREVIEW_CACHE_MIN_EDGE = 256;
  const PANEL_MIN_WIDTH = 360;
  const PANEL_MAX_WIDTH = 720;
  const PANEL_MIN_HEIGHT = 560;
  const EXPORT_PHASE_RANGES = Object.freeze({
    palette: Object.freeze([0, 12]),
    extracting: Object.freeze([12, 68]),
    encoding: Object.freeze([68, 88]),
    compressing: Object.freeze([88, 99]),
  });
  const GIF_QUALITY_PRESETS = Object.freeze({
    nai: Object.freeze({ maxColors: 255, dither: 'floyd-steinberg', lossy: 0 }),
    bei: Object.freeze({ maxColors: 255, dither: null, lossy: 25 }),
    ran: Object.freeze({ maxColors: 192, dither: null, lossy: 50 }),
  });

  function buildGifsicleCommand(preset) {
    const lossy = preset.lossy > 0 ? ` --lossy=${preset.lossy}` : '';
    return `-O1 -Okeep-empty${lossy} input.gif -o /out/output.gif`;
  }

  function normalizeGifDelay(fps, speed) {
    return Math.max(20, Math.round(((1000 / fps) / speed) / 10) * 10);
  }

  function calculateEncoderWorkerCount(hardwareConcurrency) {
    return Math.min(4, Math.max(2, Math.floor((Number(hardwareConcurrency) || 4) / 2)));
  }

  function selectEncoderWorker(inFlightCounts, maxInFlight = 2) {
    if (!Array.isArray(inFlightCounts) || !inFlightCounts.length) return -1;
    let selected = 0;
    for (let index = 1; index < inFlightCounts.length; index += 1) {
      if (inFlightCounts[index] < inFlightCounts[selected]) selected = index;
    }
    return inFlightCounts[selected] < maxInFlight ? selected : -1;
  }

  function calculateExtractionPlaybackRate(fps) {
    return Math.min(6, Math.max(2, 48 / Math.max(1, Number(fps) || 1)));
  }

  function requiresPreciseFrameSeek(currentTime, targetTime, endTime, tolerance) {
    return Number(currentTime) >= Number(endTime)
      || Number(currentTime) > Number(targetTime) + Math.max(0, Number(tolerance) || 0);
  }

  function calculateExportFrameCount(duration, fps) {
    return Math.max(1, Math.ceil(Math.max(0, Number(duration) || 0) * Math.max(1, Number(fps) || 1)));
  }

  function calculateExportFrameTime(start, end, index, fps) {
    return Math.min(Number(end) - 0.001, Number(start) + Number(index) / Math.max(1, Number(fps) || 1));
  }

  function createExportFrameTimes(start, end, fps) {
    const frameCount = calculateExportFrameCount(Number(end) - Number(start), fps);
    return Object.freeze(Array.from(
      { length: frameCount },
      (_, index) => calculateExportFrameTime(start, end, index, fps),
    ));
  }

  function createExportPlan(settings) {
    const frameTimes = createExportFrameTimes(settings.start, settings.end, settings.fps);
    return Object.freeze({
      ...settings,
      crop: Object.freeze({ ...settings.crop }),
      textLayers: Object.freeze((settings.textLayers || []).map((layer) => Object.freeze({ ...layer }))),
      qualityPreset: Object.freeze({ ...settings.qualityPreset }),
      frameTimes,
      baseFrames: frameTimes.length,
      finalFrames: frameTimes.length,
    });
  }

  function createEstimateSampleWindows(frameTimes, windowSize = 8) {
    const times = Array.from(frameTimes || []);
    if (!times.length) return Object.freeze([]);
    if (times.length <= windowSize * 3) return Object.freeze([Object.freeze(times)]);
    const size = Math.min(windowSize, times.length);
    const windows = [0.1, 0.5, 0.9].map((ratio) => {
      const anchor = Math.round((times.length - 1) * ratio);
      const start = Math.min(times.length - size, Math.max(0, anchor - Math.floor(size / 2)));
      return Object.freeze(times.slice(start, start + size));
    });
    return Object.freeze(windows);
  }

  function inspectGifFrameBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF') return null;
    let offset = 13;
    if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 7) + 1));
    const frameBytes = [];
    let pendingGraphicControl = -1;
    const skipSubBlocks = () => {
      while (offset < bytes.length) {
        const size = bytes[offset++];
        if (!size) break;
        offset += size;
      }
    };
    while (offset < bytes.length) {
      const blockStart = offset;
      const marker = bytes[offset++];
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        const label = bytes[offset++];
        if (label === 0xf9) pendingGraphicControl = blockStart;
        skipSubBlocks();
        continue;
      }
      if (marker !== 0x2c || offset + 9 > bytes.length) return null;
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      offset += 1;
      skipSubBlocks();
      const frameStart = pendingGraphicControl >= 0 ? pendingGraphicControl : blockStart;
      frameBytes.push(offset - frameStart);
      pendingGraphicControl = -1;
    }
    if (!frameBytes.length) return null;
    const frameTotal = frameBytes.reduce((sum, size) => sum + size, 0);
    return Object.freeze({
      totalBytes: bytes.length,
      containerBytes: Math.max(0, bytes.length - frameTotal),
      frameBytes: Object.freeze(frameBytes),
    });
  }

  function calculateEstimatedSizeRange(reports, totalFrames, complete = false) {
    const valid = (reports || []).filter((report) => report?.frameBytes?.length);
    if (!valid.length || totalFrames < 1) return null;
    if (complete && valid.length === 1 && valid[0].frameBytes.length === totalFrames) {
      return Object.freeze({ min: valid[0].totalBytes, max: valid[0].totalBytes });
    }
    const containers = valid.map((report) => report.containerBytes).sort((a, b) => a - b);
    const firstFrames = valid.map((report) => report.frameBytes[0]).sort((a, b) => a - b);
    const following = valid.flatMap((report) => report.frameBytes.slice(1));
    if (!following.length) following.push(...firstFrames);
    const container = containers[Math.floor(containers.length / 2)];
    const first = firstFrames[Math.floor(firstFrames.length / 2)];
    const low = container + first + Math.min(...following) * Math.max(0, totalFrames - 1);
    const high = container + first + Math.max(...following) * Math.max(0, totalFrames - 1);
    return Object.freeze({
      min: Math.max(1024, Math.floor(low * 0.9)),
      max: Math.max(1024, Math.ceil(high * 1.1)),
    });
  }

  function calculateExportProgress(phase, completed = 0, total = 1) {
    const range = EXPORT_PHASE_RANGES[phase] || [0, 100];
    const ratio = Math.min(1, Math.max(0, Number(completed) / Math.max(1, Number(total) || 1)));
    return range[0] + (range[1] - range[0]) * ratio;
  }

  function calculatePreviewCacheProfile(videoWidth, videoHeight, duration) {
    const sourceWidth = Math.max(1, Number(videoWidth) || 1);
    const sourceHeight = Math.max(1, Number(videoHeight) || 1);
    const seconds = Math.max(0.1, Number(duration) || 0.1);
    const frameCount = Math.min(PREVIEW_CACHE_MAX_FRAMES, Math.max(2, Math.ceil(seconds * PREVIEW_CACHE_FPS) + 1));
    const aspect = sourceWidth / sourceHeight;
    const maxPixelsPerFrame = Math.floor(PREVIEW_CACHE_MEMORY_BUDGET / frameCount / 4);
    const budgetWidth = aspect >= 1
      ? Math.sqrt(maxPixelsPerFrame * aspect)
      : Math.sqrt(maxPixelsPerFrame / aspect);
    const longestEdge = Math.max(
      PREVIEW_CACHE_MIN_EDGE,
      Math.min(PREVIEW_CACHE_MAX_EDGE, Math.floor(budgetWidth)),
    );
    const scale = Math.min(1, longestEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    return {
      fps: PREVIEW_CACHE_FPS,
      width,
      height,
      frameCount,
      bytes: width * height * 4 * frameCount,
    };
  }

  function orderFrameChunks(chunks) {
    return [...chunks].sort((a, b) => a.index - b.index).map((item) => item.bytes);
  }

  function calculateCropViewport(viewportWidth, viewportHeight, videoWidth, videoHeight, crop, padding) {
    const availableWidth = viewportWidth - padding * 2;
    const availableHeight = viewportHeight - padding * 2;
    const scale = Math.min(
      availableWidth / (videoWidth * crop.w),
      availableHeight / (videoHeight * crop.h),
    );
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    return {
      width,
      height,
      left: viewportWidth / 2 - (crop.x + crop.w / 2) * width,
      top: viewportHeight / 2 - (crop.y + crop.h / 2) * height,
      scale,
    };
  }

  function calculateViewportTransitionTransform(first, last) {
    const scaleX = last.width / first.width;
    const scaleY = last.height / first.height;
    return {
      translateX: last.left - first.left * scaleX,
      translateY: last.top - first.top * scaleY,
      scaleX,
      scaleY,
    };
  }

  function constrainPanelGeometry(geometry, viewportWidth, viewportHeight, margin = 14) {
    const boundary = {
      left: margin,
      top: margin,
      right: Math.max(margin, viewportWidth - margin),
      bottom: Math.max(margin, viewportHeight - margin),
    };
    const availableWidth = Math.max(1, boundary.right - boundary.left);
    const availableHeight = Math.max(1, boundary.bottom - boundary.top);
    const minWidth = Math.min(PANEL_MIN_WIDTH, availableWidth);
    const maxWidth = Math.min(PANEL_MAX_WIDTH, availableWidth);
    const minHeight = Math.min(PANEL_MIN_HEIGHT, availableHeight);
    const width = Math.min(maxWidth, Math.max(minWidth, Number(geometry?.width) || minWidth));
    const height = Math.min(availableHeight, Math.max(minHeight, Number(geometry?.height) || minHeight));
    const left = Math.min(
      boundary.right - width,
      Math.max(boundary.left, Number(geometry?.left) || boundary.left),
    );
    const top = Math.min(
      boundary.bottom - height,
      Math.max(boundary.top, Number(geometry?.top) || boundary.top),
    );
    return { left, top, width, height };
  }

  function calculatePanelResize(startRect, handle, dx, dy, viewportWidth, viewportHeight, margin = 14) {
    const boundary = {
      left: margin,
      top: margin,
      right: Math.max(margin, viewportWidth - margin),
      bottom: Math.max(margin, viewportHeight - margin),
    };
    const maxWidth = Math.min(PANEL_MAX_WIDTH, boundary.right - boundary.left);
    const maxHeight = boundary.bottom - boundary.top;
    const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
    const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
    let left = startRect.left;
    let right = startRect.left + startRect.width;
    let top = startRect.top;
    let bottom = startRect.top + startRect.height;

    if (handle.includes('w')) {
      left = Math.min(right - minWidth, Math.max(right - maxWidth, startRect.left + dx, boundary.left));
    } else if (handle.includes('e')) {
      right = Math.max(left + minWidth, Math.min(left + maxWidth, startRect.left + startRect.width + dx, boundary.right));
    }
    if (handle.includes('n')) {
      top = Math.min(bottom - minHeight, Math.max(bottom - maxHeight, startRect.top + dy, boundary.top));
    } else if (handle.includes('s')) {
      bottom = Math.max(top + minHeight, Math.min(top + maxHeight, startRect.top + startRect.height + dy, boundary.bottom));
    }

    return { left, top, width: right - left, height: bottom - top };
  }

  function mergeEditorBackgroundIntent(current = null, next = null) {
    return {
      resumeCache: Boolean(current?.resumeCache || next?.resumeCache),
    };
  }

  function sanitizeFileNamePart(value, fallback = '') {
    const cleaned = String(value || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_\.]+|[_\.]+$/g, '');
    return cleaned || fallback;
  }

  function calculateLiveFirstFrameTime(liveWallClockStartMs, trimStart) {
    const start = Number(liveWallClockStartMs);
    if (!Number.isFinite(start)) return null;
    return start + Math.max(0, Number(trimStart) || 0) * 1000;
  }

  function formatGifFileName(dateValue, sourceLabel) {
    const timestamp = dateValue instanceof Date ? dateValue.getTime() : Number(dateValue);
    if (!Number.isFinite(timestamp) || dateValue === null) throw new Error('无法确定 GIF 首帧时间。');
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    const timeDate = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `贝报gif_${timeDate}_${sanitizeFileNamePart(sourceLabel, '视频')}.gif`;
  }

  function asBytes(value, copy = false) {
    let view;
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') view = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else return null;
    return copy ? new Uint8Array(view) : view;
  }

  function readUint64(view, offset) {
    return (BigInt(view.getUint32(offset)) << 32n) | BigInt(view.getUint32(offset + 4));
  }

  function writeUint64(view, offset, value) {
    const safe = value < 0n ? 0n : value;
    view.setUint32(offset, Number((safe >> 32n) & 0xffffffffn));
    view.setUint32(offset + 4, Number(safe & 0xffffffffn));
  }

  function readIsoBoxes(bytes, start = 0, end = bytes?.byteLength || 0) {
    if (!bytes || start < 0 || end > bytes.byteLength || start > end) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const largeSize = readUint64(view, offset + 8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(largeSize);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) break;
      boxes.push({ type, start: offset, end: offset + size, size, headerSize, dataStart: offset + headerSize });
      offset += size;
    }
    return boxes;
  }

  function childBox(bytes, parent, type) {
    return readIsoBoxes(bytes, parent.dataStart, parent.end).find((box) => box.type === type) || null;
  }

  function childBoxes(bytes, parent, type) {
    return readIsoBoxes(bytes, parent.dataStart, parent.end).filter((box) => !type || box.type === type);
  }

  function hashBytes(bytes) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function toVideoOnlyMimeType(mimeType) {
    const value = String(mimeType || '');
    const codecsMatch = value.match(/codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/i);
    if (!codecsMatch) return value;
    const codecs = (codecsMatch[1] || codecsMatch[2] || codecsMatch[3] || '')
      .split(',')
      .map((codec) => codec.trim())
      .filter(Boolean);
    const videoCodecs = codecs.filter((codec) => (
      /^(?:avc1|avc3|hev1|hvc1|av01|vp0[89]|vp9|dvhe|dvh1)(?:\.|$)/i.test(codec)
    ));
    if (!videoCodecs.length || videoCodecs.length === codecs.length) return value;
    return value.replace(codecsMatch[0], `codecs="${videoCodecs.join(',')}"`);
  }

  function parseLiveInit(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = readIsoBoxes(bytes).find((box) => box.type === 'moov');
    if (!moov) return null;
    const tracks = childBoxes(bytes, moov, 'trak');
    let selected = null;
    for (const trak of tracks) {
      const mdia = childBox(bytes, trak, 'mdia');
      const hdlr = mdia && childBox(bytes, mdia, 'hdlr');
      if (!mdia || !hdlr || hdlr.dataStart + 12 > hdlr.end) continue;
      const handler = String.fromCharCode(
        bytes[hdlr.dataStart + 8], bytes[hdlr.dataStart + 9],
        bytes[hdlr.dataStart + 10], bytes[hdlr.dataStart + 11],
      );
      if (handler !== 'vide') continue;
      const tkhd = childBox(bytes, trak, 'tkhd');
      const mdhd = childBox(bytes, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const tkhdVersion = bytes[tkhd.dataStart];
      const mdhdVersion = bytes[mdhd.dataStart];
      const trackIdOffset = tkhd.dataStart + (tkhdVersion === 1 ? 20 : 12);
      const timescaleOffset = mdhd.dataStart + (mdhdVersion === 1 ? 20 : 12);
      if (trackIdOffset + 4 > tkhd.end || timescaleOffset + 4 > mdhd.end) continue;
      selected = {
        trackId: view.getUint32(trackIdOffset),
        timescale: view.getUint32(timescaleOffset),
        defaultSampleDuration: 0,
        defaultSampleSize: 0,
        defaultSampleFlags: null,
      };
      break;
    }
    if (!selected?.trackId || !selected.timescale) return null;
    const mvex = childBox(bytes, moov, 'mvex');
    const trex = mvex && childBoxes(bytes, mvex, 'trex').find((box) => (
      box.dataStart + 24 <= box.end && view.getUint32(box.dataStart + 4) === selected.trackId
    ));
    if (trex) {
      selected.defaultSampleDuration = view.getUint32(trex.dataStart + 12);
      selected.defaultSampleSize = view.getUint32(trex.dataStart + 16);
      selected.defaultSampleFlags = view.getUint32(trex.dataStart + 20);
    }
    return selected;
  }

  function makeIsoBox(type, parts) {
    const payloadSize = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(payloadSize + 8);
    const view = new DataView(output.buffer);
    view.setUint32(0, output.byteLength);
    for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index);
    let offset = 8;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  function copyIsoBox(bytes, box) {
    return new Uint8Array(bytes.subarray(box.start, box.end));
  }

  function trackIdFromTrak(bytes, trak) {
    const tkhd = childBox(bytes, trak, 'tkhd');
    if (!tkhd) return null;
    const offset = tkhd.dataStart + (bytes[tkhd.dataStart] === 1 ? 20 : 12);
    if (offset + 4 > tkhd.end) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  }

  function filterLiveInitToTrack(bytes, trackId) {
    const topLevel = readIsoBoxes(bytes);
    const moov = topLevel.find((box) => box.type === 'moov');
    if (!moov) return new Uint8Array(bytes);
    const moovChildren = childBoxes(bytes, moov);
    const trackBoxes = moovChildren.filter((box) => box.type === 'trak');
    if (trackBoxes.length <= 1) return new Uint8Array(bytes);
    const filteredChildren = [];
    for (const child of moovChildren) {
      if (child.type === 'trak') {
        if (trackIdFromTrak(bytes, child) === trackId) filteredChildren.push(copyIsoBox(bytes, child));
        continue;
      }
      if (child.type === 'mvex') {
        const mvexChildren = childBoxes(bytes, child).filter((box) => {
          if (box.type !== 'trex') return true;
          if (box.dataStart + 8 > box.end) return false;
          return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(box.dataStart + 4) === trackId;
        });
        filteredChildren.push(makeIsoBox('mvex', mvexChildren.map((box) => copyIsoBox(bytes, box))));
        continue;
      }
      filteredChildren.push(copyIsoBox(bytes, child));
    }
    const filteredMoov = makeIsoBox('moov', filteredChildren);
    return concatByteParts(topLevel.map((box) => (
      box === moov ? filteredMoov : copyIsoBox(bytes, box)
    )));
  }

  function concatByteParts(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  function parseTrunDataLayout(bytes, moof, traf, tfhd) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const runs = [];
    let continuationOffset = null;
    for (const trun of childBoxes(bytes, traf, 'trun')) {
      if (trun.dataStart + 8 > trun.end) return null;
      const flags = (bytes[trun.dataStart + 1] << 16) | (bytes[trun.dataStart + 2] << 8) | bytes[trun.dataStart + 3];
      const sampleCount = view.getUint32(trun.dataStart + 4);
      let offset = trun.dataStart + 8;
      let dataOffsetPosition = null;
      let dataStart = continuationOffset;
      if (flags & 0x000001) {
        if (offset + 4 > trun.end) return null;
        dataOffsetPosition = offset;
        dataStart = moof.start + view.getInt32(offset);
        offset += 4;
      }
      if (flags & 0x000004) offset += 4;
      if (!Number.isFinite(dataStart)) return null;
      let dataSize = 0;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        if (flags & 0x000100) offset += 4;
        let sampleSize = tfhd.defaultSampleSize;
        if (flags & 0x000200) {
          if (offset + 4 > trun.end) return null;
          sampleSize = view.getUint32(offset);
          offset += 4;
        }
        if (flags & 0x000400) offset += 4;
        if (flags & 0x000800) offset += 4;
        if (offset > trun.end || !sampleSize) return null;
        dataSize += sampleSize;
      }
      runs.push({
        dataStart,
        dataEnd: dataStart + dataSize,
        dataOffsetPosition: dataOffsetPosition === null ? null : dataOffsetPosition - traf.start,
      });
      continuationOffset = dataStart + dataSize;
    }
    return runs;
  }

  function filterLiveMediaToTrack(bytes, trackId) {
    const topLevel = readIsoBoxes(bytes);
    const output = [];
    for (let index = 0; index < topLevel.length; index += 1) {
      const box = topLevel[index];
      if (box.type !== 'moof') {
        output.push(copyIsoBox(bytes, box));
        continue;
      }
      const children = childBoxes(bytes, box);
      const trafs = children.filter((child) => child.type === 'traf');
      if (trafs.length <= 1) {
        output.push(copyIsoBox(bytes, box));
        continue;
      }
      const selectedTraf = trafs.find((traf) => {
        const tfhdBox = childBox(bytes, traf, 'tfhd');
        return tfhdBox
          && tfhdBox.dataStart + 8 <= tfhdBox.end
          && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(tfhdBox.dataStart + 4) === trackId;
      });
      const followingMdat = topLevel[index + 1]?.type === 'mdat' ? topLevel[index + 1] : null;
      const tfhdBox = selectedTraf && childBox(bytes, selectedTraf, 'tfhd');
      if (!selectedTraf || !followingMdat || !tfhdBox) return new Uint8Array(bytes);
      const tfhd = parseTfhd(bytes, tfhdBox, {
        defaultSampleDuration: 0,
        defaultSampleSize: 0,
        defaultSampleFlags: null,
      });
      const runs = tfhd && parseTrunDataLayout(bytes, box, selectedTraf, tfhd);
      if (!runs?.length || runs.some((run) => run.dataStart < followingMdat.dataStart || run.dataEnd > followingMdat.end)) {
        return new Uint8Array(bytes);
      }

      const trafCopy = copyIsoBox(bytes, selectedTraf);
      const otherChildren = children
        .filter((child) => child.type !== 'traf')
        .map((child) => copyIsoBox(bytes, child));
      const newMoofSize = 8 + otherChildren.reduce((sum, child) => sum + child.byteLength, 0) + trafCopy.byteLength;
      const trafView = new DataView(trafCopy.buffer, trafCopy.byteOffset, trafCopy.byteLength);
      let payloadOffset = 0;
      const videoPayload = [];
      for (const run of runs) {
        if (run.dataOffsetPosition !== null) {
          trafView.setInt32(run.dataOffsetPosition, newMoofSize + 8 + payloadOffset);
        }
        const sampleBytes = new Uint8Array(bytes.subarray(run.dataStart, run.dataEnd));
        videoPayload.push(sampleBytes);
        payloadOffset += sampleBytes.byteLength;
      }
      output.push(makeIsoBox('moof', [...otherChildren, trafCopy]));
      output.push(makeIsoBox('mdat', videoPayload));
      index += 1;
    }
    return concatByteParts(output);
  }

  function parseTfhd(bytes, box, defaults) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = (bytes[box.dataStart + 1] << 16) | (bytes[box.dataStart + 2] << 8) | bytes[box.dataStart + 3];
    let offset = box.dataStart + 8;
    if (offset > box.end) return null;
    const result = {
      trackId: view.getUint32(box.dataStart + 4),
      defaultSampleDuration: defaults.defaultSampleDuration || 0,
      defaultSampleSize: defaults.defaultSampleSize || 0,
      defaultSampleFlags: defaults.defaultSampleFlags,
    };
    if (flags & 0x000001) offset += 8;
    if (flags & 0x000002) offset += 4;
    if (flags & 0x000008) {
      if (offset + 4 > box.end) return null;
      result.defaultSampleDuration = view.getUint32(offset);
      offset += 4;
    }
    if (flags & 0x000010) {
      if (offset + 4 > box.end) return null;
      result.defaultSampleSize = view.getUint32(offset);
      offset += 4;
    }
    if (flags & 0x000020) {
      if (offset + 4 > box.end) return null;
      result.defaultSampleFlags = view.getUint32(offset);
    }
    return result;
  }

  function isSyncSample(sampleFlags) {
    if (!Number.isFinite(sampleFlags)) return false;
    if (sampleFlags & 0x00010000) return false;
    const dependsOn = (sampleFlags >>> 24) & 0x03;
    return dependsOn !== 1;
  }

  function parseLiveMedia(bytes, init, timestampOffset = 0) {
    if (!init?.timescale) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moofs = readIsoBoxes(bytes).filter((box) => box.type === 'moof');
    let startTicks = null;
    let endTicks = null;
    const keyframeTicks = [];
    for (const moof of moofs) {
      for (const traf of childBoxes(bytes, moof, 'traf')) {
        const tfhdBox = childBox(bytes, traf, 'tfhd');
        const tfdtBox = childBox(bytes, traf, 'tfdt');
        if (!tfhdBox || !tfdtBox || tfdtBox.dataStart + 8 > tfdtBox.end) continue;
        const tfhd = parseTfhd(bytes, tfhdBox, init);
        if (!tfhd || tfhd.trackId !== init.trackId) continue;
        const version = bytes[tfdtBox.dataStart];
        let decodeTime = version === 1
          ? readUint64(view, tfdtBox.dataStart + 4)
          : BigInt(view.getUint32(tfdtBox.dataStart + 4));
        if (startTicks === null || decodeTime < startTicks) startTicks = decodeTime;
        for (const trun of childBoxes(bytes, traf, 'trun')) {
          if (trun.dataStart + 8 > trun.end) continue;
          const flags = (bytes[trun.dataStart + 1] << 16) | (bytes[trun.dataStart + 2] << 8) | bytes[trun.dataStart + 3];
          const sampleCount = view.getUint32(trun.dataStart + 4);
          let offset = trun.dataStart + 8;
          if (flags & 0x000001) offset += 4;
          let firstSampleFlags = null;
          if (flags & 0x000004) {
            if (offset + 4 > trun.end) break;
            firstSampleFlags = view.getUint32(offset);
            offset += 4;
          }
          for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
            let duration = tfhd.defaultSampleDuration;
            let sampleFlags = sampleIndex === 0 && firstSampleFlags !== null
              ? firstSampleFlags
              : tfhd.defaultSampleFlags;
            if (flags & 0x000100) {
              if (offset + 4 > trun.end) break;
              duration = view.getUint32(offset);
              offset += 4;
            }
            if (flags & 0x000200) offset += 4;
            if (flags & 0x000400) {
              if (offset + 4 > trun.end) break;
              sampleFlags = view.getUint32(offset);
              offset += 4;
            }
            if (flags & 0x000800) offset += 4;
            if (offset > trun.end || !duration) break;
            if (isSyncSample(sampleFlags)) keyframeTicks.push(decodeTime);
            decodeTime += BigInt(duration);
          }
        }
        if (endTicks === null || decodeTime > endTicks) endTicks = decodeTime;
      }
    }
    if (startTicks === null || endTicks === null || endTicks <= startTicks) return null;
    const timescale = init.timescale;
    return {
      start: Number(startTicks) / timescale + timestampOffset,
      end: Number(endTicks) / timescale + timestampOffset,
      startTicks,
      endTicks,
      keyframes: keyframeTicks.map((ticks) => Number(ticks) / timescale + timestampOffset),
    };
  }

  function rebaseLiveFragment(bytes, baseTicks) {
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    for (const moof of readIsoBoxes(copy).filter((box) => box.type === 'moof')) {
      for (const traf of childBoxes(copy, moof, 'traf')) {
        const tfdt = childBox(copy, traf, 'tfdt');
        if (!tfdt || tfdt.dataStart + 8 > tfdt.end) continue;
        const version = copy[tfdt.dataStart];
        if (version === 1) {
          writeUint64(view, tfdt.dataStart + 4, readUint64(view, tfdt.dataStart + 4) - baseTicks);
        } else {
          const current = BigInt(view.getUint32(tfdt.dataStart + 4));
          view.setUint32(tfdt.dataStart + 4, Number(current > baseTicks ? current - baseTicks : 0n));
        }
      }
    }
    return copy;
  }

  class LiveRewindTrack {
    constructor({
      maxBufferSeconds = LIVE_REWIND_BUFFER_SECONDS,
      targetSeconds = LIVE_REWIND_TARGET_SECONDS,
      now = () => Date.now(),
    } = {}) {
      this.maxBufferSeconds = maxBufferSeconds;
      this.targetSeconds = targetSeconds;
      this.now = now;
      this.enabled = true;
      this.mimeType = '';
      this.playbackMimeType = '';
      this.initBytes = null;
      this.init = null;
      this.initSignature = '';
      this.segments = [];
      this.pendingBytes = new Uint8Array(0);
      this.timestampOffset = null;
      this.generation = 0;
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (!this.enabled) this.clearMedia();
    }

    clearMedia() {
      this.segments = [];
      this.pendingBytes = new Uint8Array(0);
      this.timestampOffset = null;
      this.generation += 1;
    }

    clearAll() {
      this.clearMedia();
      this.initBytes = null;
      this.init = null;
      this.initSignature = '';
      this.playbackMimeType = '';
    }

    setMimeType(mimeType) {
      const next = String(mimeType || '');
      if (this.mimeType && next && this.mimeType !== next) this.clearAll();
      this.mimeType = next || this.mimeType;
    }

    setInit(bytes) {
      const parsed = parseLiveInit(bytes);
      if (!parsed) return false;
      const signature = `${this.mimeType}:${hashBytes(bytes)}`;
      if (this.initSignature && signature !== this.initSignature) this.clearMedia();
      this.initBytes = filterLiveInitToTrack(bytes, parsed.trackId);
      this.init = parsed;
      this.initSignature = signature;
      this.playbackMimeType = toVideoOnlyMimeType(this.mimeType);
      return true;
    }

    ingest(value, { mimeType = this.mimeType, timestampOffset = 0 } = {}) {
      const incoming = asBytes(value, false);
      if (!incoming?.byteLength) return false;
      this.setMimeType(mimeType);
      let pending = this.pendingBytes.byteLength
        ? concatByteParts([this.pendingBytes, incoming])
        : new Uint8Array(incoming);
      let accepted = false;
      const offset = Number(timestampOffset) || 0;

      while (pending.byteLength) {
        const boxes = readIsoBoxes(pending);
        if (!boxes.length) break;
        const moov = boxes.find((box) => box.type === 'moov');
        const moof = boxes.find((box) => box.type === 'moof');

        if (moov && (!moof || moov.start < moof.start)) {
          const initBytes = pending.subarray(0, moov.end);
          accepted = this.setInit(initBytes) || accepted;
          pending = new Uint8Array(pending.subarray(moov.end));
          continue;
        }

        if (moof) {
          const mdat = boxes.find((box) => box.type === 'mdat' && box.start > moof.start);
          if (!mdat) break;
          const unit = pending.subarray(0, mdat.end);
          if (this.enabled && this.init) {
            const mediaBytes = filterLiveMediaToTrack(unit, this.init.trackId);
            const parsed = parseLiveMedia(mediaBytes, this.init, offset);
            if (parsed) {
              this.appendSegment({ ...parsed, data: mediaBytes, timestampOffset: offset });
              accepted = true;
            }
          }
          pending = new Uint8Array(pending.subarray(mdat.end));
          continue;
        }

        const orphanMdat = boxes.find((box) => box.type === 'mdat');
        if (orphanMdat) {
          pending = new Uint8Array(pending.subarray(orphanMdat.end));
          continue;
        }
        break;
      }

      this.pendingBytes = pending;
      return accepted;
    }

    appendSegment(segment) {
      if (!this.enabled || !segment || !(segment.end > segment.start)) return;
      const offset = Number(segment.timestampOffset) || 0;
      if (this.timestampOffset !== null && Math.abs(offset - this.timestampOffset) > 0.0001) this.clearMedia();
      this.timestampOffset = offset;
      const previous = this.segments[this.segments.length - 1];
      if (previous) {
        const duration = Math.max(0.1, segment.end - segment.start);
        const tolerance = Math.max(3, duration * 4);
        if (segment.start < previous.end - 0.25 || segment.start > previous.end + tolerance) this.clearMedia();
      }
      this.segments.push({
        ...segment,
        receivedAtMs: Number.isFinite(segment.receivedAtMs) ? segment.receivedAtMs : this.now(),
        data: segment.data ? new Uint8Array(segment.data) : new Uint8Array([0]),
        keyframes: [...(segment.keyframes || [])].filter(Number.isFinite).sort((a, b) => a - b),
      });
      const latestEnd = this.segments[this.segments.length - 1].end;
      const cutoff = latestEnd - this.maxBufferSeconds;
      while (this.segments.length > 1 && this.segments[0].end <= cutoff) this.segments.shift();
    }

    snapshot() {
      if (!this.enabled || !this.initBytes || !this.init || !this.segments.length) return null;
      const latestEnd = this.segments[this.segments.length - 1].end;
      const earliestStart = this.segments[0].start;
      let desiredStart = Math.max(earliestStart, latestEnd - this.targetSeconds);
      let selectedIndex = -1;
      let firstUsableKeyframe = null;
      for (let index = 0; index < this.segments.length; index += 1) {
        for (const keyframe of this.segments[index].keyframes) {
          if (firstUsableKeyframe === null) firstUsableKeyframe = { index, time: keyframe };
          if (keyframe <= desiredStart + 0.0001) selectedIndex = index;
        }
      }
      if (selectedIndex < 0 && firstUsableKeyframe) {
        selectedIndex = firstUsableKeyframe.index;
        desiredStart = Math.max(desiredStart, firstUsableKeyframe.time);
      }
      if (selectedIndex < 0) return null;
      const selected = this.segments.slice(selectedIndex);
      const mediaStart = selected[0].start;
      const baseTicks = selected[0].startTicks ?? BigInt(Math.max(0, Math.round(
        (mediaStart - (selected[0].timestampOffset || 0)) * this.init.timescale,
      )));
      return {
        mimeType: this.playbackMimeType || toVideoOnlyMimeType(this.mimeType) || 'video/mp4',
        parts: [new Uint8Array(this.initBytes), ...selected.map((segment) => rebaseLiveFragment(segment.data, baseTicks))],
        duration: Math.max(0, latestEnd - mediaStart),
        trimStart: Math.max(0, desiredStart - mediaStart),
        trimEnd: Math.max(0, latestEnd - mediaStart),
        sourceStart: desiredStart,
        sourceEnd: latestEnd,
        bufferedStart: earliestStart,
        liveWallClockStartMs: this.segments[this.segments.length - 1].receivedAtMs
          - Math.max(0, latestEnd - mediaStart) * 1000,
        generation: this.generation,
      };
    }

    getStatus() {
      if (!this.enabled) return { state: 'disabled', duration: 0, bytes: 0 };
      const first = this.segments[0];
      const last = this.segments[this.segments.length - 1];
      return {
        state: this.init && first ? 'buffering' : 'warming',
        duration: first && last ? Math.max(0, last.end - first.start) : 0,
        bytes: this.segments.reduce((sum, segment) => sum + segment.data.byteLength, 0),
      };
    }
  }

  function installLiveMediaCollector(pageWindow, enabled) {
    const MediaSourceClass = pageWindow?.MediaSource;
    const URLClass = pageWindow?.URL;
    if (!MediaSourceClass?.prototype?.addSourceBuffer || !URLClass?.createObjectURL) return null;
    const sourceTracks = new WeakMap();
    const bufferTracks = new WeakMap();
    const bufferSources = new WeakMap();
    const urlSources = new Map();
    const originalAddSourceBuffer = MediaSourceClass.prototype.addSourceBuffer;
    const SourceBufferClass = pageWindow.SourceBuffer;
    const originalAppendBuffer = SourceBufferClass?.prototype?.appendBuffer;
    const originalChangeType = SourceBufferClass?.prototype?.changeType;
    const originalCreateObjectURL = URLClass.createObjectURL;
    const originalRevokeObjectURL = URLClass.revokeObjectURL;
    let captureEnabled = Boolean(enabled);
    let activeSource = null;
    let statusListener = null;
    let lastStatusNotice = 0;

    const notifyStatus = (track) => {
      const now = performance.now();
      if (!statusListener || now - lastStatusNotice < 500) return;
      lastStatusNotice = now;
      statusListener(track?.getStatus() || null);
    };

    MediaSourceClass.prototype.addSourceBuffer = function addSourceBuffer(mimeType) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      if (/^video\//i.test(String(mimeType || ''))) {
        const track = new LiveRewindTrack();
        track.setMimeType(mimeType);
        track.setEnabled(captureEnabled && (!activeSource || activeSource === this));
        sourceTracks.set(this, track);
        bufferTracks.set(sourceBuffer, track);
        bufferSources.set(sourceBuffer, this);
      }
      return sourceBuffer;
    };

    if (originalAppendBuffer) {
      SourceBufferClass.prototype.appendBuffer = function appendBuffer(data) {
        const track = bufferTracks.get(this);
        const isActive = !activeSource || bufferSources.get(this) === activeSource;
        if (track && (isActive || !track.init)) {
          try {
            const accepted = track.ingest(data, {
              mimeType: track.mimeType,
              timestampOffset: Number(this.timestampOffset) || 0,
            });
            if (accepted && isActive) notifyStatus(track);
          } catch (_) { }
        }
        return originalAppendBuffer.call(this, data);
      };
    }

    if (originalChangeType) {
      SourceBufferClass.prototype.changeType = function changeType(mimeType) {
        const track = bufferTracks.get(this);
        if (track) track.setMimeType(mimeType);
        return originalChangeType.call(this, mimeType);
      };
    }

    URLClass.createObjectURL = function createObjectURL(value) {
      const url = originalCreateObjectURL.call(this, value);
      if (value instanceof MediaSourceClass) urlSources.set(String(url), value);
      return url;
    };

    URLClass.revokeObjectURL = function revokeObjectURL(url) {
      const source = urlSources.get(String(url));
      sourceTracks.get(source)?.clearAll();
      urlSources.delete(String(url));
      return originalRevokeObjectURL.call(this, url);
    };

    return {
      setEnabled(nextEnabled) {
        captureEnabled = Boolean(nextEnabled);
        for (const source of urlSources.values()) {
          sourceTracks.get(source)?.setEnabled(captureEnabled && (!activeSource || source === activeSource));
        }
      },
      setActiveVideo(video) {
        const source = urlSources.get(String(video?.currentSrc || video?.src || '')) || null;
        if (!source || source === activeSource) return;
        activeSource = source;
        for (const candidate of urlSources.values()) {
          sourceTracks.get(candidate)?.setEnabled(captureEnabled && candidate === activeSource);
        }
      },
      getSnapshot(video) {
        const source = urlSources.get(String(video?.currentSrc || video?.src || ''));
        return source ? sourceTracks.get(source)?.snapshot() || null : null;
      },
      getStatus(video) {
        const source = urlSources.get(String(video?.currentSrc || video?.src || ''));
        return source ? sourceTracks.get(source)?.getStatus() || null : null;
      },
      setStatusListener(listener) {
        statusListener = typeof listener === 'function' ? listener : null;
      },
      dispose() {
        statusListener = null;
        for (const source of urlSources.values()) sourceTracks.get(source)?.clearAll();
        urlSources.clear();
      },
    };
  }

  const liveRewindTestApi = {
    LiveRewindTrack,
    parseLiveInit,
    parseLiveMedia,
    readIsoBoxes,
    rebaseLiveFragment,
    filterLiveInitToTrack,
    filterLiveMediaToTrack,
    toVideoOnlyMimeType,
    installLiveMediaCollector,
    GIF_QUALITY_PRESETS,
    buildGifsicleCommand,
    normalizeGifDelay,
    calculateEncoderWorkerCount,
    selectEncoderWorker,
    calculateExtractionPlaybackRate,
    requiresPreciseFrameSeek,
    calculateExportFrameCount,
    calculateExportFrameTime,
    createExportFrameTimes,
    createExportPlan,
    createEstimateSampleWindows,
    inspectGifFrameBytes,
    calculateEstimatedSizeRange,
    calculateExportProgress,
    calculatePreviewCacheProfile,
    orderFrameChunks,
    GIF_TRANSPARENT_INDEX,
    calculateCropViewport,
    calculateViewportTransitionTransform,
    constrainPanelGeometry,
    calculatePanelResize,
    calculateLiveFirstFrameTime,
    formatGifFileName,
    mergeEditorBackgroundIntent,
    sanitizeFileNamePart,
  };
  if (typeof module === 'object' && module.exports && typeof document === 'undefined') {
    module.exports = liveRewindTestApi;
    return;
  }

  const IS_LIVE_PAGE = location.hostname === 'live.bilibili.com';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  let initialLiveCaptureMode = 'rewind';
  if (IS_LIVE_PAGE) {
    try {
      initialLiveCaptureMode = localStorage.getItem(LIVE_CAPTURE_MODE_KEY) === 'forward' ? 'forward' : 'rewind';
    } catch (_) { }
  }
  const liveMediaCollector = IS_LIVE_PAGE
    ? installLiveMediaCollector(pageWindow, initialLiveCaptureMode === 'rewind')
    : null;

  function startApp() {

  const SCRIPT_NAME = '贝报 GIF 助手';
  const RECORD_FPS = 24;
  const RECORD_MAX_WIDTH = 720;
  const MAX_RECORD_SECONDS = 60;
  const MAX_EXPORT_FRAMES = 900;
  const ENCODE_TIMEOUT_MS = 600_000;
  const MIN_SELECT_PX = 24;
  const EDITOR_CROP_PADDING = 18;
  const EDITOR_VIEWPORT_MOTION_MS = 260;
  const EDITOR_VIEWPORT_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';
  const EDITOR_BACKGROUND_RESUME_DELAY_MS = 320;
  const LAUNCHER_POSITION_KEY = 'biliGifMakerLauncherPositionV1';
  const PANEL_GEOMETRY_KEY = 'biliGifMakerPanelGeometry';
  const EXPORT_PREFERENCES_KEY = 'biliGifMakerExportPreferencesV1';
  const UI_SAFE_MARGIN = 14;
    const state = {
    mode: 'capture',
    busy: false,
    pageKey: '',
    pageSelection: null,
    pageSelectionSession: null,
    pageAdjustSession: null,
    editorCropSession: null,
    editorViewportAnimation: null,
    editorBackgroundIntent: null,
    editorBackgroundResumeTimer: 0,
    editorBackgroundResumeIdle: 0,
    editorPreviewRaf: 0,
    timelineDrag: null,
    timelinePreviewRaf: 0,
    timelinePreviewTarget: null,
    timelinePreviewType: null,
    timelineSettleToken: 0,
    timelineResumePlayback: false,
    previewFrameCache: null,
    recording: null,
    clip: null,
    editorCrop: { x: 0, y: 0, w: 1, h: 1 },
    aspectSquare: true,
    trimStart: 0,
    trimEnd: 0,
    trimPreviewCleanup: null,
    exportEncodingSession: null,
    exportVideo: null,
    cancelExportPreparation: null,
    launcherDrag: null,
    panelDrag: null,
    panelResize: null,
    panelLayoutRaf: 0,
    preferredPanelGeometry: null,
    suppressLauncherClick: false,
    textLayers: [],
    activeTextId: null,
    textLayerDrag: null,
    nextTextLayerId: 1,
    toastTimer: 0,
    sizeEstimateTimer: 0,
    sizeEstimateToken: 0,
    sizeEstimateJob: null,
    sizeEstimateCache: null,
    clipRevision: 0,
    encodingResourceTexts: null,
    previewSnapshot: null,
      cancelRequested: false,
      liveCaptureMode: initialLiveCaptureMode,
      mainVideo: null,
      videoScanQueued: false,
      viewportSyncRaf: 0,
      viewportNeedsResize: false,
    };

  const host = document.createElement('div');
  host.id = 'bili-gif-maker-host';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        --color-bg: #151619;
        --color-surface: #1b1d21;
        --color-surface-raised: #22252a;
        --color-surface-hover: #2a2e34;
        --color-text: #f7f8fa;
        --color-text-secondary: #c6cbd3;
        --color-text-muted: #959ca8;
        --color-border: rgba(255, 255, 255, .10);
        --color-border-strong: rgba(255, 255, 255, .18);
        --color-brand: #db7d74;
        --color-brand-rgb: 219, 125, 116;
        --color-brand-hover: #e79890;
        --color-brand-soft: rgba(var(--color-brand-rgb), .16);
        --color-on-brand: #151619;
        --color-success: #70d9aa;
        --color-danger: #c9423d;
        --color-focus: #f2aaa4;
        --radius-panel: 14px;
        --radius-control: 8px;
        --radius-compact: 6px;
        --shadow-panel: 0 24px 72px rgba(0, 0, 0, .52), 0 2px 10px rgba(0, 0, 0, .28);
        --motion-fast: 120ms ease-out;
        --motion-standard: 180ms ease-out;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
        font-size: 14px;
        line-height: 1.5;
        letter-spacing: 0;
      }
      * { box-sizing: border-box; }
      button, input, select, textarea { font: inherit; }
      button {
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }
      button, select, textarea, input { color-scheme: dark; }
      button:focus-visible,
      select:focus-visible,
      textarea:focus-visible,
      input:focus-visible,
      [role="button"]:focus-visible {
        outline: 2px solid var(--color-focus);
        outline-offset: 2px;
      }
      .hidden { display: none !important; }

      #launcher {
        position: fixed;
        right: 18px;
        bottom: 120px;
        z-index: 2147483638;
        width: 54px;
        height: 54px;
        border: 0;
        border-radius: 14px;
        overflow: hidden;
        background-image: url('https://i0.hdslb.com/bfs/garb/item/70de4619ce5e8a7b5bbe5c4124aa69353d8102e4.png');
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        box-shadow: 0 10px 28px rgba(0, 0, 0, .34), 0 0 0 1px rgba(255, 255, 255, .12);
        cursor: grab;
        touch-action: none;
        user-select: none;
        transition: transform var(--motion-fast), filter var(--motion-fast), box-shadow var(--motion-fast);
      }
      #launcher:hover { transform: translateY(-2px); filter: brightness(1.06); }
      #launcher.dragging { cursor: grabbing; transition: none; transform: none !important; }
      #launcher.recording {
        outline: 3px solid #ff514a;
        outline-offset: 2px;
        animation: launcherPulse 1.25s ease-in-out infinite;
      }
      #launcher.recording::after {
        content: "";
        position: absolute;
        right: 4px;
        top: 4px;
        width: 10px;
        height: 10px;
        border: 2px solid #fff;
        border-radius: 50%;
        background: #ff514a;
        box-shadow: 0 1px 5px rgba(0,0,0,.45);
      }
      @keyframes launcherPulse {
        0%, 100% { box-shadow: 0 10px 28px rgba(233, 75, 69, .30); }
        50% { box-shadow: 0 10px 36px rgba(233, 75, 69, .68); }
      }

      #panel {
        position: fixed;
        right: 14px;
        top: 14px;
        z-index: 2147483639;
        display: flex;
        flex-direction: column;
        width: min(420px, calc(100vw - 20px));
        height: calc(100vh - 28px);
        max-height: calc(100vh - 28px);
        overflow: visible;
        border: 1px solid var(--color-border-strong);
        border-radius: var(--radius-panel);
        background: var(--color-bg);
        color: var(--color-text);
        box-shadow: var(--shadow-panel);
      }
      .panel-resize-handle {
        position: absolute;
        z-index: 20;
        display: block;
        outline: none;
        touch-action: none;
      }
      .panel-resize-handle::after {
        content: "";
        position: absolute;
        opacity: 0;
        background: var(--color-brand-hover);
        transition: opacity var(--motion-fast);
      }
      .panel-resize-handle:hover::after,
      .panel-resize-handle:focus-visible::after { opacity: .9; }
      .panel-resize-handle:focus-visible { outline: none; }
      [data-panel-resize="n"], [data-panel-resize="s"] {
        left: 28px;
        right: 28px;
        height: 24px;
        cursor: ns-resize;
      }
      [data-panel-resize="n"] { top: -12px; }
      [data-panel-resize="s"] { bottom: -12px; }
      [data-panel-resize="n"]::after, [data-panel-resize="s"]::after {
        left: 50%;
        width: 40px;
        height: 2px;
        transform: translateX(-50%);
      }
      [data-panel-resize="n"]::after { top: 2px; }
      [data-panel-resize="s"]::after { bottom: 2px; }
      [data-panel-resize="e"], [data-panel-resize="w"] {
        top: 28px;
        bottom: 28px;
        width: 24px;
        cursor: ew-resize;
      }
      [data-panel-resize="e"] { right: -12px; }
      [data-panel-resize="w"] { left: -12px; }
      [data-panel-resize="e"]::after, [data-panel-resize="w"]::after {
        top: 50%;
        width: 2px;
        height: 40px;
        transform: translateY(-50%);
      }
      [data-panel-resize="e"]::after { right: 2px; }
      [data-panel-resize="w"]::after { left: 2px; }
      [data-panel-resize="nw"], [data-panel-resize="ne"],
      [data-panel-resize="sw"], [data-panel-resize="se"] {
        width: 28px;
        height: 28px;
      }
      [data-panel-resize="nw"] { left: -12px; top: -12px; cursor: nwse-resize; }
      [data-panel-resize="ne"] { right: -12px; top: -12px; cursor: nesw-resize; }
      [data-panel-resize="sw"] { left: -12px; bottom: -12px; cursor: nesw-resize; }
      [data-panel-resize="se"] { right: -12px; bottom: -12px; cursor: nwse-resize; }
      [data-panel-resize="nw"]::after, [data-panel-resize="ne"]::after,
      [data-panel-resize="sw"]::after, [data-panel-resize="se"]::after {
        inset: 4px;
        border: 2px solid var(--color-brand-hover);
        background: transparent;
      }
      [data-panel-resize="nw"]::after { border-right: 0; border-bottom: 0; }
      [data-panel-resize="ne"]::after { border-left: 0; border-bottom: 0; }
      [data-panel-resize="sw"]::after { border-right: 0; border-top: 0; }
      [data-panel-resize="se"]::after { border-left: 0; border-top: 0; }
      .header {
        position: relative;
        z-index: 10;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 52px;
        padding: 8px 10px 8px 14px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface);
        border-radius: calc(var(--radius-panel) - 1px) calc(var(--radius-panel) - 1px) 0 0;
        user-select: none;
        touch-action: none;
      }
      .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; font-size: 15px; }
      #stageBadge {
        flex: 0 0 auto;
        padding: 3px 8px;
        border-radius: var(--radius-compact);
        background: var(--color-brand-soft);
        color: var(--color-brand-hover);
        font-size: 11px;
        font-weight: 750;
      }
      #stageBadge { display: none; }
      .icon-btn {
        flex: 0 0 auto;
        width: 36px;
        height: 36px;
        border: 1px solid transparent;
        border-radius: var(--radius-control);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 17px;
        line-height: 1;
        cursor: pointer;
        transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
      }
      .icon-btn:hover { border-color: var(--color-border); background: var(--color-surface-hover); color: var(--color-text); }
      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        border-radius: 0 0 calc(var(--radius-panel) - 1px) calc(var(--radius-panel) - 1px);
        padding: 0;
      }
      #captureStage { display: none !important; }
      .utility-hidden { display: none !important; }
      #editStage {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .workspace {
        flex: 0 0 auto;
        display: grid;
        gap: 8px;
        padding: 10px 10px 0;
      }
      #editorPreviewWrap {
        position: relative;
        display: grid;
        place-items: center;
        width: min(100%, var(--editor-preview-size, 360px));
        max-width: 520px;
        justify-self: center;
        aspect-ratio: 1 / 1;
        height: auto;
        overflow: hidden;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-control);
        background: #000;
        user-select: none;
        touch-action: none;
      }
      #editorMotionLayer {
        position: absolute;
        inset: 0;
        z-index: 0;
        contain: layout paint;
        transform-origin: 0 0;
        pointer-events: none;
      }
      #editorMotionLayer.output-previewing #clipVideo,
      #editorMotionLayer.output-previewing #scrubVideo {
        visibility: hidden;
      }
      #clipVideo, #scrubVideo {
        position: absolute;
        display: block;
        width: auto;
        height: auto;
        max-width: none;
        max-height: none;
        object-fit: contain;
        background: #000;
        pointer-events: none;
      }
      #previewCanvas {
        position: absolute;
        z-index: 2;
        display: block;
        visibility: hidden;
        pointer-events: none;
        image-rendering: auto;
        background-color: #202226;
        background-image:
          linear-gradient(45deg, rgba(255,255,255,.08) 25%, transparent 25%),
          linear-gradient(-45deg, rgba(255,255,255,.08) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, rgba(255,255,255,.08) 75%),
          linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.08) 75%);
        background-position: 0 0, 0 7px, 7px -7px, -7px 0;
        background-size: 14px 14px;
      }
      #clipVideo { z-index: 0; }
      #scrubVideo {
        z-index: 1;
        visibility: hidden;
      }
      #scrubVideo.active { visibility: visible; }
      #aspectSquareBtn {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 12;
        min-width: 46px;
        height: 32px;
        padding: 0 11px;
        border: 1px solid var(--color-border-strong);
        border-radius: var(--radius-control);
        background: rgba(21, 22, 25, .86);
        color: var(--color-text);
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
        backdrop-filter: blur(10px);
      }
      #aspectSquareBtn:hover { background: var(--color-surface-hover); }
      #aspectSquareBtn.active {
        border-color: var(--color-brand);
        background: var(--color-brand);
        color: var(--color-on-brand);
        box-shadow: 0 4px 16px rgba(var(--color-brand-rgb), .24);
      }
      #editorOverlay {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
      }
      #editorBoundary {
        position: absolute;
        border: 1px dashed rgba(255,255,255,.45);
        border-radius: 4px;
        pointer-events: none;
      }
      #editorCropBox {
        position: absolute;
        z-index: 2;
        border: 2px solid var(--color-brand);
        border-radius: var(--crop-frame-radius, 6px);
        box-shadow: 0 0 0 9999px rgba(0,0,0,.36), 0 0 0 1px rgba(0,0,0,.42) inset;
        pointer-events: auto;
        cursor: move;
        touch-action: none;
      }
      #editorCropBox::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 1;
        border-radius: inherit;
        background-image:
          linear-gradient(to right, transparent calc(33.333% - .5px), rgba(255,255,255,.38) 33.333%, transparent calc(33.333% + .5px), transparent calc(66.666% - .5px), rgba(255,255,255,.38) 66.666%, transparent calc(66.666% + .5px)),
          linear-gradient(to bottom, transparent calc(33.333% - .5px), rgba(255,255,255,.38) 33.333%, transparent calc(33.333% + .5px), transparent calc(66.666% - .5px), rgba(255,255,255,.38) 66.666%, transparent calc(66.666% + .5px));
        opacity: .24;
        pointer-events: none;
        transition: opacity var(--motion-fast);
      }
      #editorCropBox:hover::before { opacity: .52; }
      #cropSizeBadge {
        position: absolute;
        left: 7px;
        top: 7px;
        z-index: 8;
        padding: 2px 6px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 5px;
        background: rgba(16,17,19,.78);
        color: #fff;
        font-size: 10px;
        font-weight: 650;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
        backdrop-filter: blur(6px);
      }
      #editorPreviewWrap.viewport-transitioning .crop-handle,
      #editorPreviewWrap.viewport-transitioning #cropSizeBadge {
        visibility: hidden;
      }
      .crop-handle,
      .page-resize-handle {
        position: absolute;
        z-index: 7;
        display: block;
        border: 0;
        padding: 0;
        background: transparent;
        touch-action: none;
      }
      .crop-handle::after,
      .page-resize-handle::after {
        content: "";
        position: absolute;
        border: 2px solid #fff;
        background: var(--color-brand);
        box-shadow: 0 1px 5px rgba(0,0,0,.45);
      }
      [data-resize="n"], [data-resize="s"] { left: 14px; right: 14px; height: 14px; cursor: ns-resize; }
      [data-resize="n"] { top: -8px; }
      [data-resize="s"] { bottom: -8px; }
      [data-resize="n"]::after, [data-resize="s"]::after {
        left: 50%; top: 50%; width: 28px; height: 4px; border-radius: 99px; transform: translate(-50%, -50%);
      }
      [data-resize="e"], [data-resize="w"] { top: 14px; bottom: 14px; width: 14px; cursor: ew-resize; }
      [data-resize="e"] { right: -8px; }
      [data-resize="w"] { left: -8px; }
      [data-resize="e"]::after, [data-resize="w"]::after {
        left: 50%; top: 50%; width: 4px; height: 28px; border-radius: 99px; transform: translate(-50%, -50%);
      }
      [data-resize="nw"], [data-resize="ne"], [data-resize="sw"], [data-resize="se"] { width: 20px; height: 20px; }
      [data-resize="nw"] { left: -11px; top: -11px; cursor: nwse-resize; }
      [data-resize="ne"] { right: -11px; top: -11px; cursor: nesw-resize; }
      [data-resize="sw"] { left: -11px; bottom: -11px; cursor: nesw-resize; }
      [data-resize="se"] { right: -11px; bottom: -11px; cursor: nwse-resize; }
      [data-resize="nw"]::after, [data-resize="ne"]::after,
      [data-resize="sw"]::after, [data-resize="se"]::after {
        left: 50%; top: 50%; width: 9px; height: 9px; border-radius: 3px; transform: translate(-50%, -50%);
      }

      #captionLayer {
        position: absolute;
        z-index: 6;
        overflow: hidden;
        pointer-events: none;
      }
      #captionLayer.locked .caption-item { pointer-events: none; }
      .caption-item {
        position: absolute;
        max-width: 92%;
        transform: translate(-50%, -50%);
        color: #fff;
        font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
        font-weight: 850;
        line-height: 1.18;
        text-align: center;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        paint-order: stroke fill;
        pointer-events: auto;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .caption-item.active {
        outline: 1px dashed rgba(255,255,255,.88);
        outline-offset: 5px;
        border-radius: 3px;
      }
      .caption-item.dragging { cursor: grabbing; }
      #editorMotionLayer.output-previewing .caption-item {
        color: transparent !important;
        -webkit-text-stroke-color: transparent !important;
      }

      .trim-block {
        padding: 8px 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-control);
        background: var(--color-surface);
      }
      #timelineTrack {
        position: relative;
        height: 30px;
        margin: 0 7px;
        cursor: pointer;
        touch-action: none;
      }
      #timelineFilmstrip {
        position: absolute;
        inset: 3px 0;
        z-index: 0;
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        overflow: hidden;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        background: var(--color-surface-raised);
        pointer-events: none;
      }
      #timelineFilmstrip canvas {
        display: block;
        width: 100%;
        height: 100%;
        border-right: 1px solid rgba(255,255,255,.08);
      }
      #timelineFilmstrip canvas:last-child { border-right: 0; }
      #timelineRail {
        position: absolute;
        left: 0; right: 0; top: 3px;
        z-index: 1;
        height: 24px;
        border-radius: 6px;
        background: rgba(0,0,0,.24);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
      }
      #timelineSelected {
        position: absolute;
        top: 3px;
        z-index: 2;
        height: 24px;
        border-radius: 5px;
        background: rgba(var(--color-brand-rgb), .12);
        box-shadow: inset 0 0 0 2px var(--color-brand);
        pointer-events: none;
      }
      #timelinePlayhead {
        position: absolute;
        top: 0;
        z-index: 4;
        width: 2px;
        height: 30px;
        border-radius: 99px;
        background: #fff;
        box-shadow: 0 0 0 1px rgba(0,0,0,.3), 0 2px 7px rgba(0,0,0,.4);
        transform: translateX(-1px);
        pointer-events: none;
      }
      .timeline-handle {
        position: absolute;
        top: 2px;
        z-index: 3;
        width: 14px;
        height: 26px;
        margin-left: -7px;
        padding: 0;
        border: 2px solid #fff;
        border-radius: 6px;
        background: var(--color-brand);
        box-shadow: 0 3px 10px rgba(0,0,0,.42);
        cursor: ew-resize;
        touch-action: none;
      }
      .timeline-labels {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 8px;
        margin-top: 0;
        color: var(--color-text-muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      #trimStartValue { text-align: left; color: var(--color-brand-hover); }
      #trimSummary { text-align: center; color: var(--color-success); font-weight: 650; }
      #trimEndValue { text-align: right; color: var(--color-brand-hover); }
      .preview-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 5px;
      }
      .preview-controls .btn { min-height: 36px; padding: 0 12px; }
      .live-mode-switch {
        display: inline-flex;
        flex: 0 1 auto;
        min-width: 0;
        gap: 4px;
      }
      .live-mode-switch button {
        min-width: 0;
        height: 28px;
        padding: 0 5px;
        border: 0;
        background: transparent;
        color: var(--color-text-muted);
        font-size: 12px;
        white-space: nowrap;
        cursor: pointer;
      }
      .live-mode-switch button:hover { color: var(--color-text); }
      .live-mode-switch button.active {
        color: var(--color-brand-hover);
        font-weight: 700;
        box-shadow: inset 0 -2px 0 var(--color-brand);
      }
      .live-mode-switch button:disabled { cursor: default; opacity: .55; }

      #editorSettingsScroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        padding: 0 10px 10px;
      }
      #editorSettingsScroll::-webkit-scrollbar { width: 8px; }
      #editorSettingsScroll::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255,255,255,.20);
        background-clip: padding-box;
      }

      .compact-section {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--color-border);
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
        color: var(--color-text);
        font-size: 13px;
        font-weight: 700;
      }
      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .grid-2.text-options { margin-top: 8px; }
      .grid-2.export-options {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 10px;
      }
      .export-options .field > label { font-size: 11px; white-space: nowrap; }
      .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .field { min-width: 0; }
      .field > label {
        display: block;
        margin-bottom: 5px;
        color: var(--color-text-muted);
        font-size: 12px;
        line-height: 1.35;
      }
      .field-hint {
        color: var(--color-success);
        font-weight: 700;
      }
      select, textarea, input[type="text"] {
        width: 100%;
        border: 1px solid var(--color-border-strong);
        border-radius: var(--radius-control);
        outline: none;
        background: var(--color-surface-raised);
        color: var(--color-text);
        transition: border-color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast);
      }
      select:hover, textarea:hover, input[type="text"]:hover { background: var(--color-surface-hover); }
      select, input[type="text"] { height: 40px; padding: 0 10px; }
      textarea { min-height: 56px; padding: 9px 10px; resize: vertical; line-height: 1.45; }
      select:focus-visible, textarea:focus-visible, input[type="text"]:focus-visible {
        border-color: var(--color-brand-hover);
        box-shadow: 0 0 0 3px var(--color-brand-soft);
      }
      select option { background: var(--color-surface-raised); color: var(--color-text); }
      input[type="color"] {
        width: 100%;
        height: 40px;
        padding: 3px;
        border: 1px solid var(--color-border-strong);
        border-radius: var(--radius-control);
        background: var(--color-surface-raised);
      }
      .text-color-control {
        display: grid;
        grid-template-columns: minmax(40px, 1fr) repeat(3, 40px);
        gap: 4px;
        align-items: center;
      }
      .text-color-control input[type="color"] { min-width: 0; }
      .color-swatch {
        position: relative;
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        outline-offset: 0;
        background: transparent;
        cursor: pointer;
      }
      .color-swatch::before {
        content: '';
        position: absolute;
        inset: 8px;
        border: 1px solid rgba(255, 255, 255, .42);
        border-radius: 50%;
        background: var(--swatch-color);
        box-shadow: 0 1px 4px rgba(0, 0, 0, .34);
        transition: transform var(--motion-fast), box-shadow var(--motion-fast);
      }
      .color-swatch:hover::before { transform: scale(1.1); }
      .color-swatch[aria-pressed="true"]::before {
        box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-text), 0 1px 4px rgba(0, 0, 0, .34);
      }
      .color-swatch:disabled { cursor: default; opacity: .5; }
      input[type="checkbox"] { accent-color: var(--color-brand); }
      input[type="range"] {
        width: 100%;
        height: 36px;
        margin: 0;
        accent-color: var(--color-brand);
        cursor: pointer;
      }
      .size-estimate {
        flex: 0 0 auto;
        color: var(--color-success);
        font-size: 11px;
        font-weight: 760;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .btn {
        min-height: 42px;
        padding: 0 12px;
        border: 1px solid transparent;
        border-radius: var(--radius-control);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        transition: background var(--motion-fast), border-color var(--motion-fast), filter var(--motion-fast);
      }
      .btn.primary { background: var(--color-brand); color: var(--color-on-brand); }
      .btn.primary:hover { background: var(--color-brand-hover); }
      #generateBtn {
        display: grid;
        place-content: center;
        gap: 2px;
        line-height: 1.05;
      }
      #actionEstimate {
        color: rgba(21,22,25,.72);
        font-size: 10px;
        font-weight: 650;
        font-variant-numeric: tabular-nums;
      }
      .btn.secondary { border-color: var(--color-border); background: var(--color-surface-raised); color: var(--color-text-secondary); }
      .btn.secondary:hover { border-color: var(--color-border-strong); background: var(--color-surface-hover); color: var(--color-text); }
      .btn.danger { background: var(--color-danger); }
      .btn.danger:hover { background: #bf3935; }
      .btn:active, .small-btn:active, .icon-btn:active { filter: brightness(.92); }
      .btn:disabled, .small-btn:disabled, select:disabled, textarea:disabled, input:disabled {
        cursor: not-allowed;
        opacity: .48;
      }
      .small-btn {
        min-height: 34px;
        padding: 0 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-control);
        background: var(--color-surface-raised);
        color: var(--color-text-secondary);
        cursor: pointer;
        white-space: nowrap;
        transition: background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
      }
      .small-btn.danger-text { color: #ff9f99; }
      .small-btn:hover { border-color: var(--color-border-strong); background: var(--color-surface-hover); color: var(--color-text); }

      .text-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .text-tab {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 150px;
        height: 31px;
        padding: 0 5px 0 10px;
        overflow: hidden;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-compact);
        background: var(--color-surface-raised);
        color: var(--color-text-secondary);
        white-space: nowrap;
        cursor: pointer;
      }
      .text-tab-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .text-tab-delete {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        color: var(--color-text-muted);
        font-size: 15px;
        font-weight: 700;
        line-height: 1;
      }
      .text-tab-delete:hover {
        background: rgba(255,96,86,.16);
        color: #ff9f99;
      }
      .text-tab.active {
        border-color: var(--color-brand);
        background: var(--color-brand-soft);
        color: var(--color-brand-hover);
      }
      .text-tab:disabled { cursor: not-allowed; opacity: .48; }
      .text-empty { display: none !important; }
      details.advanced {
        margin-top: 9px;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 11px;
        background: rgba(255,255,255,.035);
      }
      details.advanced > summary {
        padding: 10px 11px;
        color: #bdc3cb;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      .advanced-body { padding: 0 10px 10px; }
      .check-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        margin-top: 9px;
        color: #c7ccd3;
        font-size: 12px;
      }
      .check-row label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }

      #status {
        min-height: 0;
        margin-top: 10px;
        padding: 9px 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-control);
        background: var(--color-surface);
        color: var(--color-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #status.success { color: var(--color-success); border-color: rgba(112, 217, 170, .26); }
      #status.error { color: #ff938e; border-color: rgba(255, 113, 107, .28); background: rgba(255, 113, 107, .07); }
      .progress-wrap {
        height: 7px;
        margin-top: 10px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--color-surface-raised);
      }
      #progress {
        width: 0;
        height: 100%;
        border-radius: inherit;
        background: var(--color-brand);
        transition: width .12s linear;
      }
      .action-dock {
        flex: 0 0 auto;
        z-index: 9;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin: 0;
        padding: 10px;
        border-top: 1px solid var(--color-border);
        background: var(--color-surface);
      }
      .action-dock.one { grid-template-columns: 1fr; }

      #pageSelectionMarker {
        position: fixed;
        z-index: 2147483640;
        border: 2px solid var(--color-brand);
        border-radius: 6px;
        background: rgba(var(--color-brand-rgb), .04);
        box-shadow: 0 0 0 1px rgba(0,0,0,.38) inset, 0 4px 18px rgba(0,0,0,.16);
        cursor: move;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
      }
      #pageSelectionMarker.recording {
        border-color: #ff514a;
        background: rgba(255,81,74,.035);
        cursor: default;
        pointer-events: none;
        animation: markerPulse 1s ease-in-out infinite;
      }
      #pageSelectionMarker.recording .page-resize-handle { display: none; }
      @keyframes markerPulse { 50% { box-shadow: 0 0 0 4px rgba(255,81,74,.24); } }
      #selectionToolbar {
        position: fixed;
        z-index: 2147483644;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 38px;
        padding: 5px 6px;
        border: 1px solid var(--color-border-strong);
        border-radius: 10px;
        background: var(--color-surface);
        color: var(--color-text);
        box-shadow: 0 10px 34px rgba(0,0,0,.42);
        white-space: nowrap;
      }
      #selectionRecordBtn {
        height: 34px;
        padding: 0 12px;
        border: 0;
        border-radius: var(--radius-control);
        background: var(--color-danger);
        color: #fff;
        font-weight: 850;
        cursor: pointer;
      }
      #selectionRecordBtn.recording { background: #bf3935; }
      #selectionTimer {
        min-width: 54px;
        color: #ffaaa5;
        font-size: 12px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        text-align: center;
      }
      #selectionReselectBtn, #selectionClearBtn {
        height: 34px;
        padding: 0 9px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-control);
        background: var(--color-surface-raised);
        color: var(--color-text-secondary);
        font-size: 12px;
        cursor: pointer;
      }
      #selectionToolbar button:disabled { opacity: .48; cursor: not-allowed; }

      #pageSelectOverlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        cursor: crosshair;
        background: rgba(0,0,0,.26);
        user-select: none;
        touch-action: none;
      }
      #pageSelectBoundary {
        position: absolute;
        border: 2px dashed rgba(255,255,255,.9);
        border-radius: 6px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,.12);
        pointer-events: none;
      }
      #pageSelectBox {
        position: absolute;
        display: none;
        border: 2px solid var(--color-brand);
        border-radius: 6px;
        background: var(--color-brand-soft);
        box-shadow: 0 0 0 9999px rgba(0,0,0,.36);
        pointer-events: none;
      }
      #pageSelectCancel {
        position: fixed;
        right: 18px;
        top: 16px;
        height: 40px;
        padding: 0 13px;
        border: 1px solid rgba(255,255,255,.2);
        border-radius: var(--radius-control);
        background: var(--color-surface);
        color: var(--color-text);
        cursor: pointer;
      }

      #toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        z-index: 2147483646;
        max-width: min(520px, calc(100vw - 28px));
        transform: translateX(-50%);
        padding: 10px 14px;
        border: 1px solid rgba(255,255,255,.15);
        border-radius: var(--radius-control);
        background: var(--color-surface-raised);
        color: var(--color-text);
        font-size: 12px;
        line-height: 1.45;
        box-shadow: 0 14px 40px rgba(0,0,0,.42);
        pointer-events: none;
      }
      #toast.error { color: #ffaaa5; border-color: rgba(255,105,96,.32); }
      #toast.success { color: var(--color-success); }

      @media (prefers-reduced-motion: reduce) {
        #launcher,
        #progress,
        button,
        select,
        textarea,
        input { transition-duration: 0.01ms !important; }
        #launcher.recording,
        #pageSelectionMarker.recording { animation: none !important; }
      }

      @media (max-width: 540px) {
        #panel {
          right: max(10px, env(safe-area-inset-right));
          top: max(10px, env(safe-area-inset-top));
          width: calc(100vw - 20px);
          height: calc(100dvh - 20px);
          max-height: calc(100dvh - 20px);
        }
        .panel-resize-handle { display: none; }
        .header { min-height: 54px; }
        .icon-btn { width: 40px; height: 40px; }
        .action-dock { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
        .action-dock .btn { min-height: 44px; }
        #pageSelectCancel { min-height: 44px; }
        #selectionRecordBtn, #selectionReselectBtn, #selectionClearBtn { min-height: 40px; }
        .grid-3 { grid-template-columns: 1fr 1fr; }
        .grid-3 .field:last-child { grid-column: 1 / -1; }
      }
    </style>

    <button id="launcher" title="框选视频制作 GIF" aria-label="贝报GIF助手"></button>

    <section id="panel" class="hidden" aria-label="${SCRIPT_NAME}">
      <div class="header">
        <div class="title-row">
          <div class="title">贝报GIF助手</div>
          <span id="stageBadge">编辑</span>
        </div>
        <button id="closeBtn" class="icon-btn" title="关闭">✕</button>
      </div>

      <div class="body">
        <div id="captureStage" class="hidden">
          <button id="selectAreaBtn"></button>
          <button id="clearAreaBtn"></button>
          <div id="selectionInfo"></div>
          <button id="recordBtn"></button>
        </div>
        <div class="utility-hidden">
        </div>

        <div id="editStage" class="hidden">
          <div class="workspace">
            <div id="editorPreviewWrap">
              <div id="editorMotionLayer">
                <video id="clipVideo" muted playsinline preload="auto"></video>
                <video id="scrubVideo" muted playsinline preload="auto" aria-hidden="true"></video>
                <canvas id="previewCanvas" aria-hidden="true"></canvas>
                <div id="editorOverlay">
                  <div id="editorBoundary"></div>
                  <div id="editorCropBox">
                    <span id="cropSizeBadge" aria-hidden="true">-- × --</span>
                    <i class="crop-handle" data-resize="n"></i>
                    <i class="crop-handle" data-resize="s"></i>
                    <i class="crop-handle" data-resize="e"></i>
                    <i class="crop-handle" data-resize="w"></i>
                    <i class="crop-handle" data-resize="nw"></i>
                    <i class="crop-handle" data-resize="ne"></i>
                    <i class="crop-handle" data-resize="sw"></i>
                    <i class="crop-handle" data-resize="se"></i>
                  </div>
                </div>
                <div id="captionLayer"></div>
              </div>
              <button id="aspectSquareBtn" class="edit-lockable" type="button" aria-pressed="false" title="锁定裁剪比例为 1:1">1:1</button>
            </div>

            <div class="trim-block">
              <div id="timelineTrack" class="edit-lockable" aria-label="片段剪辑时间轴">
                <div id="timelineFilmstrip" aria-hidden="true"></div>
                <div id="timelineRail"></div>
                <div id="timelineSelected"></div>
                <div id="timelinePlayhead"></div>
                <button id="timelineStartHandle" class="timeline-handle" data-timeline-handle="start" title="拖动设置起点"></button>
                <button id="timelineEndHandle" class="timeline-handle" data-timeline-handle="end" title="拖动设置终点"></button>
              </div>
              <div class="timeline-labels">
                <span id="trimStartValue">00:00.000</span>
                <span id="trimSummary">1.00 秒</span>
                <span id="trimEndValue">00:01.000</span>
              </div>
              <div class="preview-controls">
                <button id="previewTrimBtn" class="btn secondary edit-lockable">▶ 播放</button>
                <div id="liveModeSwitch" class="live-mode-switch hidden" role="group" aria-label="下次录制模式">
                  <button id="liveRewindModeBtn" type="button" class="edit-lockable" aria-pressed="true">回溯</button>
                  <button id="liveForwardModeBtn" type="button" class="edit-lockable" aria-pressed="false">录制</button>
                </div>
              </div>
            </div>
          </div>

          <div id="editorSettingsScroll">
          <section class="compact-section">
            <div class="section-head">
              <span>文字</span>
              <button id="addTextBtn" class="small-btn edit-lockable">＋ 添加</button>
            </div>
            <div id="textLayerTabs" class="text-tabs"></div>
            <div id="textEditorEmpty" class="text-empty">暂无文字</div>
            <div id="textEditor" class="hidden">
              <textarea id="captionText" class="edit-lockable export-input" maxlength="120" placeholder="输入文字"></textarea>
              <div class="grid-2 text-options">
                <div class="field">
                  <label for="fontScale">大小 <span id="fontScaleValue">9%</span></label>
                  <input id="fontScale" class="edit-lockable export-input" type="range" min="0.035" max="0.30" step="0.005" value="0.09">
                </div>
                <div class="field">
                  <label for="strokeScale">描边</label>
                  <select id="strokeScale" class="edit-lockable export-input">
                    <option value="0.08">细</option>
                    <option value="0.14" selected>标准</option>
                    <option value="0.20">粗</option>
                  </select>
                </div>
                <div class="field">
                  <label for="textColor">文字颜色</label>
                  <div class="text-color-control">
                    <input id="textColor" class="edit-lockable export-input" type="color" value="#ffffff" title="自定义文字颜色" aria-label="自定义文字颜色">
                    <button type="button" class="color-swatch edit-lockable" data-text-color="#db7d74" style="--swatch-color: #db7d74" aria-label="文字颜色 #db7d74" aria-pressed="false" title="#db7d74"></button>
                    <button type="button" class="color-swatch edit-lockable" data-text-color="#576690" style="--swatch-color: #576690" aria-label="文字颜色 #576690" aria-pressed="false" title="#576690"></button>
                    <button type="button" class="color-swatch edit-lockable" data-text-color="#e799b0" style="--swatch-color: #e799b0" aria-label="文字颜色 #e799b0" aria-pressed="false" title="#e799b0"></button>
                  </div>
                </div>
                <div class="field">
                  <label for="strokeColor">描边颜色</label>
                  <input id="strokeColor" class="edit-lockable export-input" type="color" value="#ffffff">
                </div>
              </div>
            </div>
          </section>

          <section class="compact-section">
            <div class="section-head"><span>导出</span><span id="estimatedSize" class="size-estimate">预计 --</span></div>
            <div class="grid-2">
              <div class="field">
                <label for="resolutionSelect">分辨率</label>
                <select id="resolutionSelect" class="edit-lockable export-input"></select>
              </div>
              <div class="field">
                <label for="fpsSelect">帧率</label>
                <select id="fpsSelect" class="edit-lockable export-input">
                  <option value="8">8 FPS</option>
                  <option value="10">10 FPS</option>
                  <option value="12" selected>12 FPS</option>
                  <option value="15">15 FPS</option>
                  <option value="20">20 FPS</option>
                </select>
              </div>
            </div>

            <div class="grid-2 export-options">
              <div class="field">
                <label for="speedSelect">播放速度</label>
                <select id="speedSelect" class="edit-lockable export-input">
                  <option value="0.75">0.75×</option>
                  <option value="1" selected>1.0×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                </select>
              </div>
              <div class="field">
                <label for="qualitySelect">画质</label>
                <select id="qualitySelect" class="edit-lockable export-input">
                  <option value="nai">乃</option>
                  <option value="bei" selected>贝</option>
                  <option value="ran">然</option>
                </select>
              </div>
              <div class="field">
                <label for="cornerRadiusSelect">圆角 <span id="cornerRadiusState" class="field-hint">无圆角</span></label>
                <select id="cornerRadiusSelect" class="edit-lockable export-input">
                  <option value="0" selected>无圆角</option>
                  <option value="0.04">4%</option>
                  <option value="0.08">8%</option>
                  <option value="0.12">12%</option>
                  <option value="0.16">16%</option>
                  <option value="0.24">24%</option>
                </select>
              </div>
            </div>
          </section>

          <div id="status" class="hidden" role="status" aria-live="polite"></div>
          <div id="progressWrap" class="progress-wrap hidden" role="progressbar" aria-label="GIF 导出进度" aria-valuemin="0" aria-valuemax="100"><div id="progress"></div></div>
          </div>

          <div id="mainActions" class="action-dock">
            <button id="newRecordingBtn" class="btn secondary edit-lockable">重新录制</button>
            <button id="generateBtn" class="btn primary edit-lockable"><span>导出 GIF</span><small id="actionEstimate">预计 --</small></button>
          </div>
          <div id="cancelExportWrap" class="action-dock one hidden">
            <button id="cancelExportBtn" class="btn danger">取消导出</button>
          </div>
        </div>
      </div>
      <span class="panel-resize-handle" data-panel-resize="n" role="button" aria-label="调整窗口上边缘" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="s" role="button" aria-label="调整窗口下边缘" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="e" role="button" aria-label="调整窗口右边缘" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="w" role="button" aria-label="调整窗口左边缘" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="nw" role="button" aria-label="调整窗口左上角" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="ne" role="button" aria-label="调整窗口右上角" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="sw" role="button" aria-label="调整窗口左下角" tabindex="0"></span>
      <span class="panel-resize-handle" data-panel-resize="se" role="button" aria-label="调整窗口右下角" tabindex="0"></span>
    </section>

    <div id="pageSelectionMarker" class="hidden">
      <i class="page-resize-handle" data-resize="n"></i>
      <i class="page-resize-handle" data-resize="s"></i>
      <i class="page-resize-handle" data-resize="e"></i>
      <i class="page-resize-handle" data-resize="w"></i>
      <i class="page-resize-handle" data-resize="nw"></i>
      <i class="page-resize-handle" data-resize="ne"></i>
      <i class="page-resize-handle" data-resize="sw"></i>
      <i class="page-resize-handle" data-resize="se"></i>
    </div>

    <div id="selectionToolbar" class="hidden">
      <button id="selectionRecordBtn">● 录制</button>
      <span id="selectionTimer" class="hidden">00:00.0</span>
      <button id="selectionReselectBtn">重选</button>
      <button id="selectionClearBtn" title="清除选区">✕</button>
    </div>

    <div id="recordHud" class="hidden"><span id="recordTimer">00:00.0</span><button id="hudStopBtn">停止</button></div>

    <div id="pageSelectOverlay" class="hidden">
      <div id="pageSelectBoundary"></div>
      <div id="pageSelectBox"></div>
      <button id="pageSelectCancel">取消</button>
    </div>

    <div id="toast" class="hidden"></div>
  `;

  const $ = (selector) => shadow.querySelector(selector);
  const $$ = (selector) => [...shadow.querySelectorAll(selector)];

  const el = {
    launcher: $('#launcher'),
    panel: $('#panel'),
    panelResizeHandles: $$('.panel-resize-handle'),
    header: $('.header'),
    closeBtn: $('#closeBtn'),
    stageBadge: $('#stageBadge'),
    captureStage: $('#captureStage'),
    editStage: $('#editStage'),
    editorSettingsScroll: $('#editorSettingsScroll'),
    selectAreaBtn: $('#selectAreaBtn'),
    clearAreaBtn: $('#clearAreaBtn'),
    selectionInfo: $('#selectionInfo'),
    recordBtn: $('#recordBtn'),
    pageSelectionMarker: $('#pageSelectionMarker'),
    selectionToolbar: $('#selectionToolbar'),
    selectionRecordBtn: $('#selectionRecordBtn'),
    selectionTimer: $('#selectionTimer'),
    selectionReselectBtn: $('#selectionReselectBtn'),
    selectionClearBtn: $('#selectionClearBtn'),
    pageSelectOverlay: $('#pageSelectOverlay'),
    pageSelectBoundary: $('#pageSelectBoundary'),
    pageSelectBox: $('#pageSelectBox'),
    pageSelectCancel: $('#pageSelectCancel'),
    recordHud: $('#recordHud'),
    recordTimer: $('#recordTimer'),
    hudStopBtn: $('#hudStopBtn'),
    editorPreviewWrap: $('#editorPreviewWrap'),
    editorMotionLayer: $('#editorMotionLayer'),
    clipVideo: $('#clipVideo'),
    scrubVideo: $('#scrubVideo'),
    previewCanvas: $('#previewCanvas'),
    aspectSquareBtn: $('#aspectSquareBtn'),
    editorOverlay: $('#editorOverlay'),
    editorBoundary: $('#editorBoundary'),
    editorCropBox: $('#editorCropBox'),
    cropSizeBadge: $('#cropSizeBadge'),
    captionLayer: $('#captionLayer'),
    timelineTrack: $('#timelineTrack'),
    timelineFilmstrip: $('#timelineFilmstrip'),
    timelineSelected: $('#timelineSelected'),
    timelinePlayhead: $('#timelinePlayhead'),
    timelineStartHandle: $('#timelineStartHandle'),
    timelineEndHandle: $('#timelineEndHandle'),
    trimStartValue: $('#trimStartValue'),
    trimEndValue: $('#trimEndValue'),
    trimSummary: $('#trimSummary'),
    previewTrimBtn: $('#previewTrimBtn'),
    liveModeSwitch: $('#liveModeSwitch'),
    liveRewindModeBtn: $('#liveRewindModeBtn'),
    liveForwardModeBtn: $('#liveForwardModeBtn'),
    textLayerTabs: $('#textLayerTabs'),
    textEditor: $('#textEditor'),
    textEditorEmpty: $('#textEditorEmpty'),
    addTextBtn: $('#addTextBtn'),
    resolutionSelect: $('#resolutionSelect'),
    fpsSelect: $('#fpsSelect'),
    estimatedSize: $('#estimatedSize'),
    actionEstimate: $('#actionEstimate'),
    speedSelect: $('#speedSelect'),
    qualitySelect: $('#qualitySelect'),
    cornerRadiusSelect: $('#cornerRadiusSelect'),
    cornerRadiusState: $('#cornerRadiusState'),
    captionText: $('#captionText'),
    fontScale: $('#fontScale'),
    fontScaleValue: $('#fontScaleValue'),
    textColor: $('#textColor'),
    textColorSwatches: $$('.color-swatch'),
    strokeColor: $('#strokeColor'),
    strokeScale: $('#strokeScale'),
    newRecordingBtn: $('#newRecordingBtn'),
    generateBtn: $('#generateBtn'),
    mainActions: $('#mainActions'),
    cancelExportWrap: $('#cancelExportWrap'),
    cancelExportBtn: $('#cancelExportBtn'),
    progressWrap: $('#progressWrap'),
    progress: $('#progress'),
    status: $('#status'),
    toast: $('#toast'),
  };

  class CancelledError extends Error {
    constructor(message = '用户取消了导出。') {
      super(message);
      this.name = 'CancelledError';
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '--:--.---';
    const safe = Math.max(0, seconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    const secText = secs.toFixed(3).padStart(6, '0');
    return hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText}`
      : `${String(minutes).padStart(2, '0')}:${secText}`;
  }

  function formatRecordTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
  }

  function showToast(message, type = '') {
    if (!message) return;
    clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.className = type || '';
    el.toast.classList.remove('hidden');
    state.toastTimer = window.setTimeout(() => el.toast.classList.add('hidden'), type === 'error' ? 4200 : 2600);
  }

  function setStatus(message, type = '') {
    el.status.textContent = message || '';
    el.status.className = type || '';
    el.status.classList.toggle('hidden', !message);
    if (type === 'error' && (el.panel.classList.contains('hidden') || state.mode === 'capture' || state.mode === 'recording')) {
      showToast(message, 'error');
    }
  }

  function setProgress(percent) {
    const value = clamp(Number(percent) || 0, 0, 100);
    el.progress.style.width = `${value}%`;
    el.progressWrap.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  function hasSelectValue(select, value) {
    return Array.from(select?.options || []).some((option) => option.value === value);
  }

  function restoreExportPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(EXPORT_PREFERENCES_KEY) || '{}');
      if (hasSelectValue(el.fpsSelect, String(saved.fps))) el.fpsSelect.value = String(saved.fps);
      if (hasSelectValue(el.qualitySelect, String(saved.quality))) el.qualitySelect.value = String(saved.quality);
      if (hasSelectValue(el.cornerRadiusSelect, String(saved.cornerRadius))) {
        el.cornerRadiusSelect.value = String(saved.cornerRadius);
      }
    } catch (_) { }
  }

  function saveExportPreference(input) {
    if (!input || !['fpsSelect', 'qualitySelect', 'cornerRadiusSelect'].includes(input.id)) return;
    try {
      const saved = JSON.parse(localStorage.getItem(EXPORT_PREFERENCES_KEY) || '{}');
      if (input === el.fpsSelect) saved.fps = input.value;
      if (input === el.qualitySelect) saved.quality = input.value;
      if (input === el.cornerRadiusSelect) saved.cornerRadius = input.value;
      localStorage.setItem(EXPORT_PREFERENCES_KEY, JSON.stringify(saved));
    } catch (_) { }
  }

  function pointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function normalizeScreenRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function parseObjectPositionToken(token, axis) {
    const value = String(token || '').toLowerCase();
    if (value.endsWith('%')) {
      const percent = Number.parseFloat(value);
      return Number.isFinite(percent) ? clamp(percent / 100, 0, 1) : 0.5;
    }
    if (value === 'left' || value === 'top') return 0;
    if (value === 'right' || value === 'bottom') return 1;
    if (value === 'center') return 0.5;
    if (value.endsWith('px')) return axis === 'x' ? 0 : 0;
    return 0.5;
  }

  function getMediaMapping(video) {
    if (!video || !video.isConnected || !video.videoWidth || !video.videoHeight) return null;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return null;

    const style = getComputedStyle(video);
    const fit = style.objectFit || 'fill';
    const posTokens = String(style.objectPosition || '50% 50%').trim().split(/\s+/);
    const posX = parseObjectPositionToken(posTokens[0], 'x');
    const posY = parseObjectPositionToken(posTokens[1] || posTokens[0], 'y');
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let scaleX = rect.width / vw;
    let scaleY = rect.height / vh;

    if (fit === 'contain' || fit === 'cover' || fit === 'scale-down' || fit === 'none') {
      let scale;
      if (fit === 'cover') {
        scale = Math.max(rect.width / vw, rect.height / vh);
      } else if (fit === 'none') {
        scale = 1;
      } else if (fit === 'scale-down') {
        scale = Math.min(1, Math.min(rect.width / vw, rect.height / vh));
      } else {
        scale = Math.min(rect.width / vw, rect.height / vh);
      }
      renderedWidth = vw * scale;
      renderedHeight = vh * scale;
      scaleX = scale;
      scaleY = scale;
    }

    const offsetX = (rect.width - renderedWidth) * posX;
    const offsetY = (rect.height - renderedHeight) * posY;
    const renderedRect = {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + renderedWidth,
      bottom: rect.top + offsetY + renderedHeight,
      width: renderedWidth,
      height: renderedHeight,
    };
    const elementRect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
    const visibleRect = intersectRects(renderedRect, elementRect);
    if (!visibleRect) return null;

    return {
      rect: elementRect,
      renderedRect,
      visibleRect,
      videoWidth: vw,
      videoHeight: vh,
      screenToSource(clientX, clientY) {
        return {
          x: clamp((clientX - renderedRect.left) / scaleX, 0, vw),
          y: clamp((clientY - renderedRect.top) / scaleY, 0, vh),
        };
      },
      sourceToScreen(sourceX, sourceY) {
        return {
          x: renderedRect.left + sourceX * scaleX,
          y: renderedRect.top + sourceY * scaleY,
        };
      },
    };
  }

  function scanMainVideo() {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return null;

    const candidates = videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        const visible = rect.width > 120
          && rect.height > 80
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0;
        return { video, area: visible ? rect.width * rect.height : 0 };
      })
      .filter((item) => item.area > 0 && item.video.videoWidth > 0 && item.video.videoHeight > 0)
      .sort((a, b) => b.area - a.area);

    if (candidates[0]) return candidates[0].video;
    return videos.find((video) => video.readyState >= 1 && video.videoWidth > 0) || null;
  }

  function getMainVideo() {
    const current = state.mainVideo;
    if (current?.isConnected && current.videoWidth > 0 && current.videoHeight > 0) return current;
    state.mainVideo = scanMainVideo();
    return state.mainVideo;
  }

  function invalidateMainVideo() {
    state.mainVideo = null;
    if (state.videoScanQueued) return;
    state.videoScanQueued = true;
    queueMicrotask(() => {
      state.videoScanQueued = false;
      const video = getMainVideo();
      liveMediaCollector?.setActiveVideo(video);
      updateLiveRewindTitle();
    });
  }

  function currentPageKey() {
    const p = new URLSearchParams(location.search).get('p') || '';
    return `${location.pathname}?p=${p}`;
  }

  function getLiveRoomIdentity() {
    const roomId = location.pathname.match(/^\/(\d+)/)?.[1] || '直播间';
    const ownerElement = document.querySelector('.room-owner-username');
    const titleParts = document.title.split(' - ').map((part) => part.trim()).filter(Boolean);
    const titleOwner = titleParts.length >= 3 ? titleParts[titleParts.length - 2] : '';
    return {
      streamerName: String(ownerElement?.textContent || titleOwner || '主播').trim(),
      roomId,
    };
  }

  function updateModeUi() {
    const editVisible = state.mode === 'edit' || state.mode === 'exporting';
    el.captureStage.classList.add('hidden');
    el.editStage.classList.toggle('hidden', !editVisible);

    if (state.mode === 'recording') el.stageBadge.textContent = '录制中';
    else if (state.mode === 'exporting') el.stageBadge.textContent = '导出中';
    else el.stageBadge.textContent = '编辑';

    const recording = state.mode === 'recording';
    const pageSelectionVisible = state.mode === 'capture' || recording;
    el.launcher.classList.toggle('recording', recording);
    el.launcher.textContent = '';
    el.recordHud.classList.add('hidden');
    el.pageSelectionMarker.classList.toggle('recording', recording);
    if (!pageSelectionVisible) {
      el.pageSelectionMarker.classList.add('hidden');
      el.selectionToolbar.classList.add('hidden');
    }

    const recordDisabled = !state.pageSelection || state.busy || Boolean(state.recording?.stopping);
    el.recordBtn.disabled = recordDisabled;
    el.selectionRecordBtn.disabled = recordDisabled;
    el.selectionRecordBtn.textContent = recording
      ? (state.recording?.stopping ? '正在停止…' : '■ 停止')
      : '● 录制';
    el.selectionRecordBtn.classList.toggle('recording', recording);
    el.selectionTimer.classList.toggle('hidden', !recording);
    el.selectionReselectBtn.classList.toggle('hidden', recording);
    el.selectionClearBtn.classList.toggle('hidden', recording);
    el.selectionReselectBtn.disabled = recording || state.mode === 'exporting';
    el.selectionClearBtn.disabled = recording || state.mode === 'exporting';

    const showSelectionTools = Boolean(state.pageSelection)
      && !state.pageSelectionSession
      && (state.mode === 'capture' || state.mode === 'recording');
    el.selectionToolbar.classList.toggle('hidden', !showSelectionTools);

    const lockEditor = state.mode === 'exporting';
    el.panel.setAttribute('aria-busy', String(lockEditor));
    $$('.edit-lockable').forEach((node) => {
      node.disabled = lockEditor;
      node.classList.toggle('disabled', lockEditor);
    });
    el.editorCropBox.style.pointerEvents = lockEditor ? 'none' : 'auto';
    el.captionLayer.classList.toggle('locked', lockEditor);
    el.addTextBtn.disabled = lockEditor || state.textLayers.length >= 8;
    el.mainActions.classList.toggle('hidden', lockEditor);
    el.cancelExportWrap.classList.toggle('hidden', !lockEditor);
    el.progressWrap.classList.toggle('hidden', !lockEditor);
    if (el.liveModeSwitch) {
      el.liveModeSwitch.classList.toggle('hidden', !IS_LIVE_PAGE);
      const rewindActive = state.liveCaptureMode === 'rewind';
      el.liveRewindModeBtn.classList.toggle('active', rewindActive);
      el.liveForwardModeBtn.classList.toggle('active', !rewindActive);
      el.liveRewindModeBtn.setAttribute('aria-pressed', String(rewindActive));
      el.liveForwardModeBtn.setAttribute('aria-pressed', String(!rewindActive));
    }
  }

  function clampLauncherPosition(left, top) {
    const rect = el.launcher.getBoundingClientRect();
    const width = rect.width || 54;
    const height = rect.height || 54;
    return {
      left: clamp(left, UI_SAFE_MARGIN, Math.max(UI_SAFE_MARGIN, window.innerWidth - width - UI_SAFE_MARGIN)),
      top: clamp(top, UI_SAFE_MARGIN, Math.max(UI_SAFE_MARGIN, window.innerHeight - height - UI_SAFE_MARGIN)),
    };
  }

  function applyLauncherPosition(left, top, { save = false } = {}) {
    const pos = clampLauncherPosition(left, top);
    el.launcher.style.left = `${Math.round(pos.left)}px`;
    el.launcher.style.top = `${Math.round(pos.top)}px`;
    el.launcher.style.right = 'auto';
    el.launcher.style.bottom = 'auto';
    if (save) {
      try {
        localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify(pos));
      } catch (_) { }
    }
  }

  function restoreLauncherPosition() {
    let restored = false;
    try {
      const raw = localStorage.getItem(LAUNCHER_POSITION_KEY);
      if (raw) {
        const pos = JSON.parse(raw);
        if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
          applyLauncherPosition(pos.left, pos.top);
          restored = true;
        }
      }
    } catch (_) { }
    if (!restored) {
      const rect = el.launcher.getBoundingClientRect();
      applyLauncherPosition(rect.left, rect.top);
    }
  }

  function handleLauncherPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const rect = el.launcher.getBoundingClientRect();
    state.launcherDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    el.launcher.classList.add('dragging');
    el.launcher.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function handleLauncherPointerMove(event) {
    const drag = state.launcherDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) >= 5) drag.moved = true;
    if (!drag.moved) return;
    applyLauncherPosition(drag.left + dx, drag.top + dy);
    event.preventDefault();
  }

  function finishLauncherPointer(event, cancelled = false) {
    const drag = state.launcherDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.launcherDrag = null;
    el.launcher.classList.remove('dragging');
    try { el.launcher.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    if (drag.moved) {
      const rect = el.launcher.getBoundingClientRect();
      applyLauncherPosition(rect.left, rect.top, { save: true });
      return;
    }
    if (!cancelled) handleLauncherAction();
  }

  function getEditorViewportRect() {
    const rect = el.editorPreviewWrap.getBoundingClientRect();
    return {
      left: rect.left + el.editorPreviewWrap.clientLeft,
      top: rect.top + el.editorPreviewWrap.clientTop,
      width: el.editorPreviewWrap.clientWidth,
      height: el.editorPreviewWrap.clientHeight,
    };
  }

  function applyEditorVideoLayout(layout) {
    [el.clipVideo, el.scrubVideo].filter(Boolean).forEach((video) => Object.assign(video.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
      transform: 'none',
    }));
  }

  function readEditorVideoLayout() {
    if (!el.clipVideo) return null;
    const layout = {
      left: Number.parseFloat(el.clipVideo.style.left),
      top: Number.parseFloat(el.clipVideo.style.top),
      width: Number.parseFloat(el.clipVideo.style.width),
      height: Number.parseFloat(el.clipVideo.style.height),
    };
    return Object.values(layout).every(Number.isFinite) && layout.width > 1 && layout.height > 1
      ? layout
      : null;
  }

  function calculateEditorCropGeometry(layout) {
    const crop = state.editorCrop;
    return {
      left: layout.left + crop.x * layout.width,
      top: layout.top + crop.y * layout.height,
      width: crop.w * layout.width,
      height: crop.h * layout.height,
    };
  }

  function setOutputPreviewVisible(visible) {
    if (!el.editorMotionLayer || !el.previewCanvas) return;
    el.editorMotionLayer.classList.toggle('output-previewing', visible);
    el.previewCanvas.style.visibility = visible ? 'visible' : 'hidden';
  }

  function applyEditorCropGeometry(layout) {
    if (!layout) return null;
    const crop = calculateEditorCropGeometry(layout);
    Object.assign(el.editorCropBox.style, {
      left: `${crop.left}px`,
      top: `${crop.top}px`,
      width: `${crop.width}px`,
      height: `${crop.height}px`,
      visibility: 'visible',
    });
    Object.assign(el.editorBoundary.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
    });
    Object.assign(el.captionLayer.style, {
      left: `${crop.left}px`,
      top: `${crop.top}px`,
      width: `${crop.width}px`,
      height: `${crop.height}px`,
    });
    Object.assign(el.previewCanvas.style, {
      left: `${crop.left}px`,
      top: `${crop.top}px`,
      width: `${Math.max(1, crop.width)}px`,
      height: `${Math.max(1, crop.height)}px`,
      borderRadius: '0px',
    });
    if (state.editorCropSession || state.editorViewportAnimation || state.editorBackgroundIntent) {
      setOutputPreviewVisible(false);
    }
    if (el.cropSizeBadge) {
      const sourceWidth = Math.max(1, Number(state.clip?.width) || 1);
      const sourceHeight = Math.max(1, Number(state.clip?.height) || 1);
      el.cropSizeBadge.textContent = `${Math.round(state.editorCrop.w * sourceWidth)} × ${Math.round(state.editorCrop.h * sourceHeight)}`;
    }
    updateRoundedCropGuide(crop.width, crop.height);
    updateTextLayerMetrics(crop.width);
    return crop;
  }

  function calculateFittedEditorViewport(viewport = null, crop = state.editorCrop) {
    if (!state.clip || !el.editorPreviewWrap || !el.clipVideo) return;
    const targetViewport = viewport || getEditorViewportRect();
    if (targetViewport.width <= 1 || targetViewport.height <= 1) return;

    const videoWidth = Math.max(1, state.clip.width || el.clipVideo.videoWidth || 1);
    const videoHeight = Math.max(1, state.clip.height || el.clipVideo.videoHeight || 1);
    return calculateCropViewport(
      targetViewport.width,
      targetViewport.height,
      videoWidth,
      videoHeight,
      crop,
      EDITOR_CROP_PADDING,
    );
  }

  function prepareEditorViewportAnimation() {
    el.editorMotionLayer.style.willChange = 'transform';
  }

  function clearEditorViewportAnimation(session = state.editorViewportAnimation) {
    if (session) {
      session.animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      if (state.editorViewportAnimation === session) state.editorViewportAnimation = null;
    }
    el.editorMotionLayer.style.willChange = '';
    el.editorPreviewWrap.classList.remove('viewport-transitioning');
  }

  function fitCropIntoPreview() {
    clearEditorViewportAnimation();
    const fitted = calculateFittedEditorViewport();
    if (fitted) applyEditorVideoLayout(fitted);
  }

  function readMotionRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function isVisibleViewportTransition(transform) {
    return Math.abs(transform.translateX) >= 0.5
      || Math.abs(transform.translateY) >= 0.5
      || Math.abs(transform.scaleX - 1) >= 0.002
      || Math.abs(transform.scaleY - 1) >= 0.002;
  }

  function cancelEditorBackgroundResume() {
    clearTimeout(state.editorBackgroundResumeTimer);
    state.editorBackgroundResumeTimer = 0;
    if (state.editorBackgroundResumeIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(state.editorBackgroundResumeIdle);
    }
    state.editorBackgroundResumeIdle = 0;
  }

  function suspendEditorBackgroundWork() {
    cancelEditorBackgroundResume();
    const cache = state.previewFrameCache;
    state.editorBackgroundIntent = mergeEditorBackgroundIntent(state.editorBackgroundIntent, {
      resumeCache: Boolean(cache && !cache.cancelled && cache.status !== 'ready'),
    });
    pausePreviewFrameCache();
    cancelEditorPreviewRender();
    setOutputPreviewVisible(false);
  }

  function resumeEditorBackgroundWork() {
    cancelEditorBackgroundResume();
    const intent = state.editorBackgroundIntent;
    state.editorBackgroundIntent = null;
    if (!intent || !state.clip || state.mode !== 'edit') return;
    scheduleEditorPreviewRender();
    if (intent.resumeCache) void resumePreviewFrameCache();
  }

  function scheduleEditorBackgroundResume() {
    if (!state.editorBackgroundIntent) return;
    cancelEditorBackgroundResume();
    state.editorBackgroundResumeTimer = window.setTimeout(() => {
      state.editorBackgroundResumeTimer = 0;
      if (typeof window.requestIdleCallback === 'function') {
        state.editorBackgroundResumeIdle = window.requestIdleCallback(() => {
          state.editorBackgroundResumeIdle = 0;
          resumeEditorBackgroundWork();
        }, { timeout: 600 });
        return;
      }
      resumeEditorBackgroundWork();
    }, EDITOR_BACKGROUND_RESUME_DELAY_MS);
  }

  function discardEditorBackgroundIntent() {
    cancelEditorBackgroundResume();
    state.editorBackgroundIntent = null;
  }

  function finishEditorViewportAnimation(session) {
    if (state.editorViewportAnimation !== session) return;
    applyEditorVideoLayout(session.targetLayout);
    applyEditorCropGeometry(session.targetLayout);
    clearEditorViewportAnimation(session);
    updateResolutionOptions();
    updateEstimatedFileSize();
    scheduleEditorPreviewRender();
    scheduleEditorBackgroundResume();
  }

  function settleEditorViewportAnimation() {
    const session = state.editorViewportAnimation;
    if (!session) return;
    const viewport = getEditorViewportRect();
    const currentRect = readMotionRect(el.clipVideo);
    clearEditorViewportAnimation(session);
    const currentLayout = {
      left: currentRect.left - viewport.left,
      top: currentRect.top - viewport.top,
      width: currentRect.width,
      height: currentRect.height,
    };
    applyEditorVideoLayout(currentLayout);
    applyEditorCropGeometry(currentLayout);
  }

  function animateCropIntoPreview(precomputedTarget = null) {
    if (!state.clip || el.editStage.classList.contains('hidden')) return;
    settleEditorViewportAnimation();
    suspendEditorBackgroundWork();
    const firstLayout = readEditorVideoLayout();
    const fitted = precomputedTarget || calculateFittedEditorViewport();
    if (!firstLayout || !fitted) {
      scheduleEditorBackgroundResume();
      return;
    }

    const transform = calculateViewportTransitionTransform(firstLayout, fitted);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = typeof el.editorMotionLayer?.animate === 'function';

    if (reducedMotion || !canAnimate || !isVisibleViewportTransition(transform)) {
      applyEditorVideoLayout(fitted);
      applyEditorCropGeometry(fitted);
      clearEditorViewportAnimation();
      updateResolutionOptions();
      updateEstimatedFileSize();
      scheduleEditorPreviewRender();
      scheduleEditorBackgroundResume();
      return;
    }

    prepareEditorViewportAnimation();
    el.editorPreviewWrap.classList.add('viewport-transitioning');
    const motionAnimation = el.editorMotionLayer.animate([
      { transformOrigin: '0 0', transform: 'translate(0px, 0px) scale(1, 1)' },
      {
        transformOrigin: '0 0',
        transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scaleX}, ${transform.scaleY})`,
      },
    ], {
      duration: EDITOR_VIEWPORT_MOTION_MS,
      easing: EDITOR_VIEWPORT_EASING,
      fill: 'both',
    });
    const session = { animations: [motionAnimation], targetLayout: fitted };
    state.editorViewportAnimation = session;

    motionAnimation.onfinish = () => finishEditorViewportAnimation(session);
  }

  function isNarrowPanelViewport() {
    return window.innerWidth <= 540;
  }

  function readSavedPanelGeometry() {
    try {
      const saved = GM_getValue(PANEL_GEOMETRY_KEY, null);
      if (saved && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(saved[key]))) {
        return saved;
      }
    } catch (_) { }
    return null;
  }

  function savePanelGeometry(geometry) {
    const saved = {
      left: Math.round(geometry.left),
      top: Math.round(geometry.top),
      width: Math.round(geometry.width),
      height: Math.round(geometry.height),
    };
    state.preferredPanelGeometry = saved;
    try { GM_setValue(PANEL_GEOMETRY_KEY, saved); } catch (_) { }
  }

  function panelGeometryFromRect(rect = el.panel.getBoundingClientRect()) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function getDefaultPanelGeometry() {
    const availableWidth = Math.max(1, window.innerWidth - UI_SAFE_MARGIN * 2);
    const availableHeight = Math.max(1, window.innerHeight - UI_SAFE_MARGIN * 2);
    const maxWidth = Math.min(420, availableWidth);
    const idealWidth = Math.round(window.innerHeight * 0.39 + 28);
    const width = clamp(idealWidth, Math.min(PANEL_MIN_WIDTH, maxWidth), maxWidth);
    const height = Math.min(availableHeight, 820);
    return {
      left: Math.max(UI_SAFE_MARGIN, window.innerWidth - width - UI_SAFE_MARGIN),
      top: UI_SAFE_MARGIN,
      width,
      height,
    };
  }

  function applyPanelGeometry(geometry) {
    el.panel.style.right = 'auto';
    el.panel.style.left = `${geometry.left}px`;
    el.panel.style.top = `${geometry.top}px`;
    el.panel.style.width = `${geometry.width}px`;
    el.panel.style.height = `${geometry.height}px`;
    el.panel.style.maxHeight = `${Math.max(1, window.innerHeight - UI_SAFE_MARGIN * 2)}px`;
  }

  function clearDesktopPanelGeometry() {
    ['right', 'left', 'top', 'width', 'height', 'max-height'].forEach((property) => {
      el.panel.style.removeProperty(property);
    });
  }

  function updatePanelContentLayout() {
    if (el.panel.classList.contains('hidden')) return;
    const rect = el.panel.getBoundingClientRect();
    const previewSize = Math.min(520, Math.max(1, rect.width - 20), Math.max(100, rect.height - 300));
    el.panel.style.setProperty('--editor-preview-size', `${previewSize}px`);
    fitCropIntoPreview();
    updateEditorCropBox();
    updateTimelinePlayhead();
  }

  function schedulePanelContentLayout() {
    if (state.panelLayoutRaf) return;
    state.panelLayoutRaf = requestAnimationFrame(() => {
      state.panelLayoutRaf = 0;
      updatePanelContentLayout();
    });
  }

  function fitEditorLayout() {
    if (isNarrowPanelViewport()) {
      clearDesktopPanelGeometry();
      schedulePanelContentLayout();
      return;
    }
    const preferred = state.preferredPanelGeometry || getDefaultPanelGeometry();
    const visible = constrainPanelGeometry(
      preferred,
      window.innerWidth,
      window.innerHeight,
      UI_SAFE_MARGIN,
    );
    applyPanelGeometry(visible);
    schedulePanelContentLayout();
  }

  function handlePanelHeaderPointerDown(event) {
    if (event.button !== 0 || state.busy || isNarrowPanelViewport()) return;
    if (event.target.closest?.('button, input, select, textarea, a')) return;
    const rect = el.panel.getBoundingClientRect();
    state.panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
    el.header.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function handlePanelHeaderPointerMove(event) {
    const drag = state.panelDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = el.panel.getBoundingClientRect();
    const geometry = constrainPanelGeometry(
      {
        left: drag.startLeft + event.clientX - drag.startX,
        top: drag.startTop + event.clientY - drag.startY,
        width: rect.width,
        height: rect.height,
      },
      window.innerWidth,
      window.innerHeight,
      UI_SAFE_MARGIN,
    );
    applyPanelGeometry(geometry);
    event.preventDefault();
  }

  function finishPanelHeaderDrag(event) {
    const drag = state.panelDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    state.panelDrag = null;
    try { el.header.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    const geometry = constrainPanelGeometry(
      panelGeometryFromRect(),
      window.innerWidth,
      window.innerHeight,
      UI_SAFE_MARGIN,
    );
    applyPanelGeometry(geometry);
    savePanelGeometry(geometry);
  }

  function handlePanelResizePointerDown(event) {
    if (event.button !== 0 || state.busy || isNarrowPanelViewport()) return;
    const handle = event.currentTarget.dataset.panelResize;
    const rect = panelGeometryFromRect();
    state.panelResize = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePanelResizePointerMove(event) {
    const resize = state.panelResize;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const geometry = calculatePanelResize(
      resize.startRect,
      resize.handle,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      window.innerWidth,
      window.innerHeight,
      UI_SAFE_MARGIN,
    );
    applyPanelGeometry(geometry);
    schedulePanelContentLayout();
    event.preventDefault();
  }

  function finishPanelResize(event, cancelled = false) {
    const resize = state.panelResize;
    if (!resize || resize.pointerId !== event.pointerId) return;
    state.panelResize = null;
    try { event.currentTarget.releasePointerCapture?.(resize.pointerId); } catch (_) { }
    const geometry = cancelled ? resize.startRect : panelGeometryFromRect();
    applyPanelGeometry(geometry);
    schedulePanelContentLayout();
    if (!cancelled) savePanelGeometry(geometry);
  }

  function handlePanelResizeKeyDown(event) {
    if (state.busy || isNarrowPanelViewport()) return;
    const handle = event.currentTarget.dataset.panelResize;
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if ((!dx && !dy) || (dx && !/[ew]/.test(handle)) || (dy && !/[ns]/.test(handle))) return;
    const geometry = calculatePanelResize(
      panelGeometryFromRect(),
      handle,
      dx,
      dy,
      window.innerWidth,
      window.innerHeight,
      UI_SAFE_MARGIN,
    );
    applyPanelGeometry(geometry);
    savePanelGeometry(geometry);
    schedulePanelContentLayout();
    event.preventDefault();
  }

  function keepFloatingUiInViewport() {
    const rect = el.launcher.getBoundingClientRect();
    applyLauncherPosition(rect.left, rect.top, { save: true });
    if (!el.panel.classList.contains('hidden')) fitEditorLayout();
  }

  function releasePreviewFrameCache() {
    const cache = state.previewFrameCache;
    if (el.timelineFilmstrip) el.timelineFilmstrip.replaceChildren();
    if (!cache) return;
    cache.cancelled = true;
    cache.runToken += 1;
    cache.stopRun?.();
    cache.stopRun = null;
    try { cache.video?.pause(); } catch (_) { }
    cache.frames?.forEach((frame) => {
      try { frame.close(); } catch (_) { }
    });
    state.previewFrameCache = null;
  }

  function renderTimelineFilmstrip(cache = state.previewFrameCache) {
    if (!el.timelineFilmstrip) return;
    el.timelineFilmstrip.replaceChildren();
    const availableFrames = cache?.frames?.filter(Boolean) || [];
    if (!cache || !availableFrames.length) return;

    const cellCount = Math.min(8, availableFrames.length);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < cellCount; index += 1) {
      const frameIndex = cellCount === 1
        ? 0
        : Math.round((index / (cellCount - 1)) * (availableFrames.length - 1));
      const frame = availableFrames[frameIndex];
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 44;
      const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
      if (ctx) {
        const scale = Math.max(canvas.width / cache.width, canvas.height / cache.height);
        const width = cache.width * scale;
        const height = cache.height * scale;
        ctx.drawImage(frame, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      }
      fragment.appendChild(canvas);
    }
    el.timelineFilmstrip.appendChild(fragment);
  }

  function cleanupClipAttachment(clip, video) {
    const attachment = clip?.attachments?.get(video);
    if (attachment) {
      clip.attachments.delete(video);
      try {
        if (attachment.sourceBuffer?.updating) attachment.sourceBuffer.abort();
      } catch (_) { }
    }
    try { video.pause(); } catch (_) { }
    video.removeAttribute('src');
    try { video.load(); } catch (_) { }
    if (attachment) URL.revokeObjectURL(attachment.url);
  }

  function appendMediaSourcePart(sourceBuffer, part) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        sourceBuffer.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onUpdateEnd = () => finish();
      const onError = () => finish(new Error('直播片段追加失败。'));
      sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true });
      sourceBuffer.addEventListener('error', onError, { once: true });
      try { sourceBuffer.appendBuffer(part); } catch (error) { finish(error); }
    });
  }

  async function attachClipToVideo(clip, video) {
    if (!clip || !video) throw new Error('片段播放源无效。');
    cleanupClipAttachment(clip, video);
    if (clip.kind !== 'media-source') {
      video.src = clip.url;
      video.load();
      if (video.readyState < 1) await waitForEvent(video, 'loadedmetadata', 10_000);
      return;
    }

    const MediaSourceClass = pageWindow.MediaSource || window.MediaSource;
    if (!MediaSourceClass?.isTypeSupported?.(clip.mimeType)) {
      throw new Error(`浏览器不支持当前直播编码：${clip.mimeType}`);
    }
    const mediaSource = new MediaSourceClass();
    const url = URL.createObjectURL(mediaSource);
    const attachment = { mediaSource, sourceBuffer: null, url };
    clip.attachments.set(video, attachment);
    video.src = url;
    video.load();
    try {
      await waitForEvent(mediaSource, 'sourceopen', 10_000);
      if (clip.attachments.get(video) !== attachment) throw new Error('片段播放源已释放。');
      const sourceBuffer = mediaSource.addSourceBuffer(clip.mimeType);
      attachment.sourceBuffer = sourceBuffer;
      for (let index = 0; index < clip.parts.length; index += 1) {
        const part = clip.parts[index];
        try {
          await appendMediaSourcePart(sourceBuffer, part);
        } catch (_) {
          const boxes = readIsoBoxes(asBytes(part, false)).map((box) => box.type).join('+') || 'unknown';
          const label = index === 0 ? '初始化段' : `媒体段 ${index}`;
          throw new Error(`直播${label}追加失败（${boxes}，${clip.mimeType}）。`);
        }
      }
      if (mediaSource.readyState === 'open') {
        const bufferedEnd = sourceBuffer.buffered.length
          ? sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
          : clip.duration;
        mediaSource.duration = Math.max(clip.duration, bufferedEnd);
        mediaSource.endOfStream();
      }
      if (video.readyState < 1) await waitForEvent(video, 'loadedmetadata', 10_000);
    } catch (error) {
      cleanupClipAttachment(clip, video);
      throw error;
    }
  }

  async function createDetachedClipVideo(clip) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    await attachClipToVideo(clip, video);
    return video;
  }

  function releaseDetachedClipVideo(clip, video) {
    if (!video) return;
    cleanupClipAttachment(clip, video);
  }

  function flattenSampleTimes(windows) {
    const seen = new Set();
    const times = [];
    for (const windowTimes of windows || []) {
      for (const time of windowTimes) {
        const key = Number(time).toFixed(6);
        if (seen.has(key)) continue;
        seen.add(key);
        times.push(Number(time));
      }
    }
    return times;
  }

  async function captureImageBitmapsAtTimes(video, times, clip, isCancelled = () => false) {
    const frames = new Map();
    try {
      for (const time of times) {
        if (isCancelled()) throw new CancelledError();
        await seekVideo(video, time, clip.duration);
        if (isCancelled()) throw new CancelledError();
        frames.set(Number(time).toFixed(6), await createImageBitmap(video));
      }
      return frames;
    } catch (error) {
      for (const frame of frames.values()) {
        try { frame.close(); } catch (_) { }
      }
      throw error;
    }
  }

  function closeImageBitmapMap(frames) {
    for (const frame of frames?.values?.() || []) {
      try { frame.close(); } catch (_) { }
    }
  }

  function choosePreviewCacheProfile(clip) {
    return calculatePreviewCacheProfile(clip.width, clip.height, clip.duration);
  }

  function hasPreviewCacheFrames() {
    return Boolean(state.previewFrameCache?.frames?.some(Boolean));
  }

  function pausePreviewFrameCache() {
    const cache = state.previewFrameCache;
    if (!cache || cache.status === 'ready' || cache.cancelled) return;
    cache.runToken += 1;
    cache.running = false;
    cache.stopRun?.();
    cache.stopRun = null;
    try { cache.video.pause(); } catch (_) { }
  }

  async function resumePreviewFrameCache(cache = state.previewFrameCache) {
    if (!cache || cache.cancelled || cache.status === 'ready' || cache.running
      || state.mode === 'exporting') return;
    const video = cache.video;
    const token = ++cache.runToken;
    cache.running = true;
    const canvas = document.createElement('canvas');
    canvas.width = cache.width;
    canvas.height = cache.height;
    const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (!ctx) {
      cache.running = false;
      return;
    }

    try {
      await seekVideo(video, cache.resumeTime, cache.clip.duration);
      if (cache.cancelled || state.previewFrameCache !== cache || token !== cache.runToken) return;
      video.playbackRate = 12;
      await new Promise((resolve, reject) => {
        let settled = false;
        let callbackId = 0;
        let timerId = 0;
        const stop = () => finish();
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timerId);
          if (callbackId && typeof video.cancelVideoFrameCallback === 'function') {
            try { video.cancelVideoFrameCallback(callbackId); } catch (_) { }
          }
          video.removeEventListener('ended', onEnded);
          if (cache.stopRun === stop) cache.stopRun = null;
          error ? reject(error) : resolve();
        };
        const capture = async (now, metadata = {}) => {
          if (settled || cache.cancelled || token !== cache.runToken) {
            return finish();
          }
          const currentTime = Number(metadata.mediaTime) || Number(video.currentTime) || 0;
          const bucket = clamp(
            Math.round((currentTime / Math.max(0.001, cache.clip.duration)) * (cache.frameCount - 1)),
            0,
            cache.frameCount - 1,
          );
          if (!cache.frames[bucket]) {
            ctx.drawImage(video, 0, 0, cache.width, cache.height);
            const frame = await createImageBitmap(canvas);
            if (cache.cancelled || state.previewFrameCache !== cache || token !== cache.runToken) {
              try { frame.close(); } catch (_) { }
              return finish();
            }
            cache.frames[bucket] = frame;
            cache.captured += 1;
            if (cache.captured === 1 || cache.captured % 12 === 0) renderTimelineFilmstrip(cache);
          }
          cache.resumeTime = Math.max(cache.resumeTime, currentTime);
          cache.progress = clamp(currentTime / Math.max(0.001, cache.clip.duration), 0, 1);
          if (currentTime >= cache.clip.duration - 0.01 || video.ended) return finish();
          callbackId = video.requestVideoFrameCallback(capture);
        };
        const onEnded = () => finish();
        cache.stopRun = stop;
        video.addEventListener('ended', onEnded, { once: true });
        if (typeof video.requestVideoFrameCallback === 'function') {
          callbackId = video.requestVideoFrameCallback(capture);
        } else {
          const tick = () => {
            if (settled) return;
            capture(performance.now()).catch(finish);
            if (!settled) timerId = window.setTimeout(tick, 16);
          };
          tick();
        }
        video.play().catch(finish);
      });
      if (!cache.cancelled && state.previewFrameCache === cache && token === cache.runToken
        && cache.resumeTime >= cache.clip.duration - 0.05) {
        cache.status = 'ready';
        renderTimelineFilmstrip(cache);
      }
    } catch (_) {
      // Timeline interaction may preempt the background scan; the next idle window resumes it.
    } finally {
      if (token === cache.runToken) {
        cache.running = false;
        try { video.pause(); } catch (_) { }
      }
    }
  }

  function buildPreviewFrameCache(clip) {
    if (!clip || !el.scrubVideo) return;
    releasePreviewFrameCache();
    const profile = choosePreviewCacheProfile(clip);
    const cache = {
      status: 'building',
      cancelled: false,
      running: false,
      runToken: 0,
      resumeTime: 0,
      progress: 0,
      captured: 0,
      stopRun: null,
      clip,
      ...profile,
      frames: new Array(profile.frameCount),
      video: el.scrubVideo,
    };
    state.previewFrameCache = cache;
    void resumePreviewFrameCache(cache);
  }

  function getCachedPreviewFrame(time) {
    const cache = state.previewFrameCache;
    if (!cache || !cache.frames.length) return null;
    const target = clamp(
      Math.round(((Number(time) || 0) / Math.max(0.001, cache.clip.duration)) * (cache.frameCount - 1)),
      0,
      cache.frameCount - 1,
    );
    if (cache.frames[target]) return cache.frames[target];
    for (let distance = 1; distance < cache.frameCount; distance += 1) {
      if (cache.frames[target - distance]) return cache.frames[target - distance];
      if (cache.frames[target + distance]) return cache.frames[target + distance];
    }
    return null;
  }

  function renderCachedPreviewFrame(settings, time) {
    const cache = state.previewFrameCache;
    const frame = getCachedPreviewFrame(time);
    if (!cache || !frame || !el.previewCanvas) return false;
    updatePreviewCanvasLayout(settings);
    const ctx = el.previewCanvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawExportCanvasFrame(ctx, settings, frame);
    setOutputPreviewVisible(true);
    return true;
  }

  function openPanel() {
    if (!state.clip) {
      beginPageSelection();
      return;
    }
    el.panel.classList.remove('hidden');
    el.panel.scrollTop = 0;
    if (el.editorSettingsScroll) el.editorSettingsScroll.scrollTop = 0;
    fitEditorLayout();
    updateModeUi();
  }

  function closePanel() {
    clearEditorViewportAnimation();
    cancelEditorPreviewRender();
    el.panel.classList.add('hidden');
    stopTrimPreview();
  }

  function setLiveCaptureMode(mode) {
    if (!IS_LIVE_PAGE || (mode !== 'rewind' && mode !== 'forward')) return;
    state.liveCaptureMode = mode;
    try { localStorage.setItem(LIVE_CAPTURE_MODE_KEY, mode); } catch (_) { }
    liveMediaCollector?.setEnabled(mode === 'rewind');
    updateModeUi();
    updateLiveRewindTitle();
  }

  function liveWarmupMessage(video) {
    const status = liveMediaCollector?.getStatus(video);
    const seconds = Math.max(0, Number(status?.duration) || 0);
    if (seconds >= 0.1) return `回溯正在预热，已缓存 ${seconds.toFixed(1)} 秒，等待可解码关键帧。`;
    return '回溯正在预热，请稍后再试。';
  }

  async function captureLiveRewind() {
    if (!IS_LIVE_PAGE || !liveMediaCollector || state.busy || state.mode === 'recording' || state.mode === 'exporting') return;
    const sourceVideo = getMainVideo();
    if (!sourceVideo) {
      showToast('未找到正在播放的直播画面。', 'error');
      return;
    }
    liveMediaCollector.setActiveVideo(sourceVideo);
    const snapshot = liveMediaCollector.getSnapshot(sourceVideo);
    if (!snapshot) {
      showToast(liveWarmupMessage(sourceVideo));
      return;
    }

    state.busy = true;
    stopTrimPreview();
    updateModeUi();
    try {
      const snapshotBytes = snapshot.parts.reduce((sum, part) => sum + part.byteLength, 0);
      if (snapshotBytes < 1024) throw new Error('回溯片段尚未准备好。');
      await loadLiveRewindClip(snapshot, {
        measuredDuration: snapshot.duration,
        sourceStart: snapshot.sourceStart,
        sourceEnd: snapshot.sourceEnd,
        captureWidth: sourceVideo.videoWidth,
        captureHeight: sourceVideo.videoHeight,
        initialTrimStart: snapshot.trimStart,
        initialTrimEnd: snapshot.trimEnd,
        clipKind: 'live-rewind',
        liveWallClockStartMs: snapshot.liveWallClockStartMs,
        liveIdentity: getLiveRoomIdentity(),
      });
      state.mode = 'edit';
      el.panel.classList.remove('hidden');
      el.panel.scrollTop = 0;
      if (el.editorSettingsScroll) el.editorSettingsScroll.scrollTop = 0;
      fitEditorLayout();
      setStatus('');
      requestAnimationFrame(() => { void ensureTrimPreviewPlaying(); });
    } catch (error) {
      disposeClip();
      state.mode = 'capture';
      showToast(friendlyError(error), 'error');
    } finally {
      state.busy = false;
      updateModeUi();
      if (state.mode === 'edit') updateEstimatedFileSize();
    }
  }

  function handleLauncherAction() {
    if (state.mode === 'capture') {
      if (IS_LIVE_PAGE && state.liveCaptureMode === 'rewind') void captureLiveRewind();
      else beginPageSelection();
      return;
    }
    if (state.mode === 'recording') {
      stopRecording('manual');
      return;
    }
    if (el.panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }

  function disposeClip() {
    cancelSizeEstimate({ clearCache: true });
    if (state.exportVideo) {
      releaseDetachedClipVideo(state.clip, state.exportVideo);
      state.exportVideo = null;
    }
    discardEditorBackgroundIntent();
    clearEditorViewportAnimation();
    cancelEditorPreviewRender();
    stopTrimPreview();
    releasePreviewFrameCache();
    const clip = state.clip;
    if (clip?.attachments) {
      for (const video of [...clip.attachments.keys()]) cleanupClipAttachment(clip, video);
    }
    if (clip?.url) URL.revokeObjectURL(clip.url);
    state.clip = null;
    if (el.previewCanvas) {
      setOutputPreviewVisible(false);
      el.previewCanvas.width = 1;
      el.previewCanvas.height = 1;
    }
    try {
      el.clipVideo.pause();
      el.clipVideo.removeAttribute('src');
      el.clipVideo.load();
      el.scrubVideo.pause();
      el.scrubVideo.classList.remove('active');
      el.scrubVideo.removeAttribute('src');
      el.scrubVideo.load();
    } catch (_) { }
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    state.aspectSquare = true;
    state.trimStart = 0;
    state.trimEnd = 0;
    state.textLayers = [];
    state.activeTextId = null;
    state.textLayerDrag = null;
    renderTextLayerTabs();
    renderTextLayers();
  }

  function clearPageSelection({ keepStatus = false } = {}) {
    state.pageSelection = null;
    state.pageAdjustSession = null;
    el.pageSelectionMarker.classList.add('hidden');
    el.selectionToolbar.classList.add('hidden');
    el.selectionInfo.textContent = '';
    el.selectionInfo.classList.remove('ready');
    updateModeUi();
    if (!keepStatus) setStatus('');
  }

  function normalizedSelectionToSource(selection, video) {
    return {
      sx: clamp(selection.x, 0, 1) * video.videoWidth,
      sy: clamp(selection.y, 0, 1) * video.videoHeight,
      sw: clamp(selection.w, 0, 1) * video.videoWidth,
      sh: clamp(selection.h, 0, 1) * video.videoHeight,
    };
  }

  function selectionToScreenRect(selection, mapping) {
    const source = {
      sx: clamp(selection.x, 0, 1) * mapping.videoWidth,
      sy: clamp(selection.y, 0, 1) * mapping.videoHeight,
      sw: clamp(selection.w, 0, 1) * mapping.videoWidth,
      sh: clamp(selection.h, 0, 1) * mapping.videoHeight,
    };
    const topLeft = mapping.sourceToScreen(source.sx, source.sy);
    const bottomRight = mapping.sourceToScreen(source.sx + source.sw, source.sy + source.sh);
    return normalizeScreenRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  }

  function screenRectToNormalizedSelection(rect, mapping) {
    const bounded = intersectRects(rect, mapping.visibleRect);
    if (!bounded) return null;
    const p1 = mapping.screenToSource(bounded.left, bounded.top);
    const p2 = mapping.screenToSource(bounded.right, bounded.bottom);
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const right = Math.max(p1.x, p2.x);
    const bottom = Math.max(p1.y, p2.y);
    return {
      x: clamp(left / mapping.videoWidth, 0, 1),
      y: clamp(top / mapping.videoHeight, 0, 1),
      w: clamp((right - left) / mapping.videoWidth, 0, 1),
      h: clamp((bottom - top) / mapping.videoHeight, 0, 1),
    };
  }

  function positionSelectionToolbar(rect) {
    if (el.selectionToolbar.classList.contains('hidden')) return;
    const toolbarWidth = el.selectionToolbar.offsetWidth || 210;
    const toolbarHeight = el.selectionToolbar.offsetHeight || 40;
    let left = rect.left + rect.width / 2 - toolbarWidth / 2;
    left = clamp(left, 8, Math.max(8, window.innerWidth - toolbarWidth - 8));
    let top = rect.bottom + 9;
    if (top + toolbarHeight > window.innerHeight - 8) top = rect.top - toolbarHeight - 9;
    top = clamp(top, 8, Math.max(8, window.innerHeight - toolbarHeight - 8));
    Object.assign(el.selectionToolbar.style, {
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  function updatePageSelectionUi() {
    if (!state.pageSelection) {
      el.pageSelectionMarker.classList.add('hidden');
      el.selectionToolbar.classList.add('hidden');
      updateModeUi();
      return;
    }

    const video = getMainVideo();
    const mapping = getMediaMapping(video);
    if (!video || !mapping) {
      el.pageSelectionMarker.classList.add('hidden');
      el.selectionToolbar.classList.add('hidden');
      return;
    }

    const rawRect = selectionToScreenRect(state.pageSelection, mapping);
    const visible = intersectRects(rawRect, mapping.visibleRect);
    const shouldShowMarker = state.mode === 'capture' || state.mode === 'recording';
    if (!shouldShowMarker || !visible || visible.width < 2 || visible.height < 2 || state.pageSelectionSession) {
      el.pageSelectionMarker.classList.add('hidden');
      el.selectionToolbar.classList.add('hidden');
    } else {
      Object.assign(el.pageSelectionMarker.style, {
        left: `${visible.left}px`,
        top: `${visible.top}px`,
        width: `${visible.width}px`,
        height: `${visible.height}px`,
      });
      el.pageSelectionMarker.classList.remove('hidden');
      updateModeUi();
      positionSelectionToolbar(visible);
    }
    updateModeUi();
  }

  function setPageSelectionBox(rect) {
    Object.assign(el.pageSelectBox.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function updatePageSelectionBoundary() {
    const session = state.pageSelectionSession;
    if (!session) return null;
    const mapping = getMediaMapping(session.video);
    if (!mapping) return null;
    session.mapping = mapping;
    Object.assign(el.pageSelectBoundary.style, {
      left: `${mapping.visibleRect.left}px`,
      top: `${mapping.visibleRect.top}px`,
      width: `${mapping.visibleRect.width}px`,
      height: `${mapping.visibleRect.height}px`,
    });
    return mapping;
  }

  function beginPageSelection() {
    if (state.mode === 'recording' || state.mode === 'exporting') return;
    const video = getMainVideo();
    const mapping = getMediaMapping(video);
    if (!video || !mapping) {
      setStatus('未找到视频画面，请等待加载完成。', 'error');
      return;
    }
    if (document.fullscreenElement && document.fullscreenElement.tagName === 'VIDEO') {
      setStatus('请退出浏览器全屏后再框选。', 'error');
      return;
    }

    state.pageSelectionSession = {
      video,
      mapping,
      drag: null,
      originalSelection: state.pageSelection ? { ...state.pageSelection } : null,
      panelWasOpen: !el.panel.classList.contains('hidden'),
    };
    el.pageSelectBox.style.display = 'none';
    el.panel.classList.add('hidden');
    el.launcher.classList.add('hidden');
    el.pageSelectionMarker.classList.add('hidden');
    el.selectionToolbar.classList.add('hidden');
    el.pageSelectOverlay.classList.remove('hidden');
    updatePageSelectionBoundary();
  }

  function finishPageSelection(cancelled = false) {
    const session = state.pageSelectionSession;
    if (!session) return;
    state.pageSelectionSession = null;
    el.pageSelectOverlay.classList.add('hidden');
    el.pageSelectBox.style.display = 'none';
    el.launcher.classList.remove('hidden');
    if (session.panelWasOpen) el.panel.classList.remove('hidden');
    updatePageSelectionUi();
  }

  function handlePageSelectPointerDown(event) {
    if (event.button !== 0 || event.target === el.pageSelectCancel) return;
    const session = state.pageSelectionSession;
    if (!session) return;
    const mapping = updatePageSelectionBoundary();
    if (!mapping || !pointInRect(event.clientX, event.clientY, mapping.visibleRect)) return;

    event.preventDefault();
    const startX = clamp(event.clientX, mapping.visibleRect.left, mapping.visibleRect.right);
    const startY = clamp(event.clientY, mapping.visibleRect.top, mapping.visibleRect.bottom);
    session.drag = { startX, startY, currentX: startX, currentY: startY };
    el.pageSelectOverlay.setPointerCapture?.(event.pointerId);
    setPageSelectionBox(normalizeScreenRect(startX, startY, startX, startY));
  }

  function handlePageSelectPointerMove(event) {
    const session = state.pageSelectionSession;
    if (!session?.drag) return;
    const mapping = session.mapping || updatePageSelectionBoundary();
    if (!mapping) return;
    session.drag.currentX = clamp(event.clientX, mapping.visibleRect.left, mapping.visibleRect.right);
    session.drag.currentY = clamp(event.clientY, mapping.visibleRect.top, mapping.visibleRect.bottom);
    setPageSelectionBox(normalizeScreenRect(
      session.drag.startX,
      session.drag.startY,
      session.drag.currentX,
      session.drag.currentY,
    ));
  }

  function handlePageSelectPointerUp(event) {
    const session = state.pageSelectionSession;
    if (!session?.drag) return;
    handlePageSelectPointerMove(event);
    const mapping = session.mapping || updatePageSelectionBoundary();
    const rect = normalizeScreenRect(
      session.drag.startX,
      session.drag.startY,
      session.drag.currentX,
      session.drag.currentY,
    );
    session.drag = null;

    if (!mapping || rect.width < MIN_SELECT_PX || rect.height < MIN_SELECT_PX) {
      el.pageSelectBox.style.display = 'none';
      return;
    }

    const p1 = mapping.screenToSource(rect.left, rect.top);
    const p2 = mapping.screenToSource(rect.right, rect.bottom);
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const right = Math.max(p1.x, p2.x);
    const bottom = Math.max(p1.y, p2.y);

    state.pageSelection = {
      x: clamp(left / mapping.videoWidth, 0, 1),
      y: clamp(top / mapping.videoHeight, 0, 1),
      w: clamp((right - left) / mapping.videoWidth, 0, 1),
      h: clamp((bottom - top) / mapping.videoHeight, 0, 1),
    };
    finishPageSelection(false);
    setStatus('');
  }

  function resizeScreenRect(startRect, handle, dx, dy, boundary, minSize = MIN_SELECT_PX) {
    let left = startRect.left;
    let right = startRect.right;
    let top = startRect.top;
    let bottom = startRect.bottom;

    if (handle.includes('w')) left = clamp(startRect.left + dx, boundary.left, right - minSize);
    if (handle.includes('e')) right = clamp(startRect.right + dx, left + minSize, boundary.right);
    if (handle.includes('n')) top = clamp(startRect.top + dy, boundary.top, bottom - minSize);
    if (handle.includes('s')) bottom = clamp(startRect.bottom + dy, top + minSize, boundary.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function moveScreenRect(startRect, dx, dy, boundary) {
    const width = startRect.width;
    const height = startRect.height;
    const left = clamp(startRect.left + dx, boundary.left, boundary.right - width);
    const top = clamp(startRect.top + dy, boundary.top, boundary.bottom - height);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function handlePageMarkerPointerDown(event) {
    if (event.button !== 0 || state.mode !== 'capture' || !state.pageSelection) return;
    const mapping = getMediaMapping(getMainVideo());
    if (!mapping) return;
    const startRect = selectionToScreenRect(state.pageSelection, mapping);
    const handle = event.target?.dataset?.resize || '';
    state.pageAdjustSession = {
      pointerId: event.pointerId,
      mapping,
      startRect,
      startX: event.clientX,
      startY: event.clientY,
      type: handle ? 'resize' : 'move',
      handle,
    };
    stopTrimPreview();
    event.preventDefault();
    event.stopPropagation();
    el.pageSelectionMarker.setPointerCapture?.(event.pointerId);
  }

  function handlePageMarkerPointerMove(event) {
    const session = state.pageAdjustSession;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const rect = session.type === 'move'
      ? moveScreenRect(session.startRect, dx, dy, session.mapping.visibleRect)
      : resizeScreenRect(session.startRect, session.handle, dx, dy, session.mapping.visibleRect);
    const selection = screenRectToNormalizedSelection(rect, session.mapping);
    if (!selection) return;
    state.pageSelection = selection;
    updatePageSelectionUi();
    event.preventDefault();
  }

  function finishPageMarkerAdjustment(event) {
    const session = state.pageAdjustSession;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    state.pageAdjustSession = null;
    try { el.pageSelectionMarker.releasePointerCapture?.(session.pointerId); } catch (_) { }
    updatePageSelectionUi();
  }

  function chooseRecorderMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
  }

  function drawSelectedVideoFrame(video, selection, ctx, width, height) {
    const source = normalizedSelectionToSource(selection, video);
    if (source.sw < 2 || source.sh < 2) throw new Error('选区太小，请重新框选。');
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    try {
      ctx.drawImage(
        video,
        source.sx, source.sy, source.sw, source.sh,
        0, 0, width, height,
      );
    } catch (error) {
      if (error?.name === 'SecurityError') {
        throw new Error(`SecurityError: 浏览器拒绝读取当前视频画面。${error.message || ''}`);
      }
      throw error;
    }
  }

  function cleanupRecordingResources(recording) {
    if (!recording) return;
    if (recording.rafId) cancelAnimationFrame(recording.rafId);
    if (recording.timerId) clearInterval(recording.timerId);
    if (recording.maxTimerId) clearTimeout(recording.maxTimerId);
    try { recording.stream?.getTracks().forEach((track) => track.stop()); } catch (_) { }
  }

  async function startRecording() {
    if (state.mode === 'recording') {
      stopRecording('manual');
      return;
    }
    if (state.mode !== 'capture' || state.busy) return;
    if (!state.pageSelection) {
      setStatus('请先框选录制区域。', 'error');
      return;
    }

    const video = getMainVideo();
    if (!video || !video.videoWidth || !video.videoHeight) {
      setStatus('未找到可录制的视频。', 'error');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setStatus('当前浏览器不支持录制。', 'error');
      return;
    }

    const captureStream = HTMLCanvasElement.prototype.captureStream
      || HTMLCanvasElement.prototype.mozCaptureStream;
    if (typeof captureStream !== 'function') {
      setStatus('当前浏览器不支持画布录制。', 'error');
      return;
    }

    const recordingSelection = { ...state.pageSelection };
    const source = normalizedSelectionToSource(recordingSelection, video);
    const captureWidth = Math.max(2, Math.round(Math.min(RECORD_MAX_WIDTH, source.sw) / 2) * 2);
    const captureHeight = Math.max(2, Math.round((captureWidth / (source.sw / source.sh)) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = captureWidth;
    canvas.height = captureHeight;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) {
      setStatus('无法创建录制画布。', 'error');
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const snapshot = {
      playbackRate: video.playbackRate,
      paused: video.paused,
      sourceStart: video.currentTime,
    };

    try {
      video.pause();
      video.playbackRate = 1;
      drawSelectedVideoFrame(video, recordingSelection, ctx, captureWidth, captureHeight);
      const liveWallClockStartMs = IS_LIVE_PAGE ? Date.now() : null;

      const stream = captureStream.call(canvas, RECORD_FPS);
      const mimeType = chooseRecorderMimeType();
      const recorderOptions = {
        videoBitsPerSecond: captureWidth >= 640 ? 6_000_000 : 4_000_000,
      };
      if (mimeType) recorderOptions.mimeType = mimeType;
      const recorder = new MediaRecorder(stream, recorderOptions);
      const chunks = [];
      const recording = {
        video,
        recorder,
        stream,
        canvas,
        ctx,
        chunks,
        snapshot,
        selection: recordingSelection,
        captureWidth,
        captureHeight,
        mimeType: recorder.mimeType || mimeType || 'video/webm',
        liveWallClockStartMs,
        liveIdentity: IS_LIVE_PAGE ? getLiveRoomIdentity() : null,
        startedAt: performance.now(),
        lastDrawAt: 0,
        rafId: 0,
        timerId: 0,
        maxTimerId: 0,
        stopping: false,
        stopReason: '',
        error: null,
      };
      state.recording = recording;
      state.mode = 'recording';
      el.panel.classList.add('hidden');
      updateModeUi();
      setStatus('');

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener('error', (event) => {
        recording.error = event.error || new Error('录制失败。');
        stopRecording('error');
      });
      recorder.addEventListener('stop', () => finalizeRecording(recording), { once: true });

      const drawLoop = (now) => {
        if (state.recording !== recording || recording.stopping) return;
        if (now - recording.lastDrawAt >= (1000 / RECORD_FPS) - 1) {
          try {
            drawSelectedVideoFrame(video, recording.selection, ctx, captureWidth, captureHeight);
            recording.lastDrawAt = now;
          } catch (error) {
            recording.error = error;
            stopRecording('error');
            return;
          }
        }
        recording.rafId = requestAnimationFrame(drawLoop);
      };

      recorder.start(250);
      recording.rafId = requestAnimationFrame(drawLoop);
      recording.timerId = setInterval(() => {
        const seconds = (performance.now() - recording.startedAt) / 1000;
        const timeText = formatRecordTime(seconds);
        el.recordTimer.textContent = timeText;
        el.selectionTimer.textContent = timeText;
        const liveMapping = getMediaMapping(recording.video);
        if (liveMapping) positionSelectionToolbar(selectionToScreenRect(recording.selection, liveMapping));
      }, 80);
      recording.maxTimerId = setTimeout(() => stopRecording('limit'), MAX_RECORD_SECONDS * 1000);

      try {
        await video.play();
      } catch (error) {
        recording.error = new Error(`视频无法自动播放：${error.message || error}`);
        stopRecording('error');
      }
    } catch (error) {
      cleanupRecordingResources(state.recording);
      try { video.playbackRate = snapshot.playbackRate; } catch (_) { }
      state.recording = null;
      state.mode = 'capture';
      updateModeUi();
      setStatus(friendlyError(error), 'error');
    }
  }

  function stopRecording(reason = 'manual') {
    const recording = state.recording;
    if (!recording || recording.stopping) return;
    recording.stopping = true;
    recording.stopReason = reason;
    try { recording.video.pause(); } catch (_) { }
    if (recording.rafId) cancelAnimationFrame(recording.rafId);
    if (recording.timerId) clearInterval(recording.timerId);
    if (recording.maxTimerId) clearTimeout(recording.maxTimerId);
    updateModeUi();
    try {
      if (recording.recorder.state !== 'inactive') {
        try { recording.recorder.requestData(); } catch (_) { }
        recording.recorder.stop();
      } else {
        finalizeRecording(recording);
      }
    } catch (error) {
      recording.error = error;
      finalizeRecording(recording);
    }
  }

  function waitForEvent(target, eventName, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeEventListener(eventName, done);
        target.removeEventListener('error', fail);
        resolve(event);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeEventListener(eventName, done);
        target.removeEventListener('error', fail);
        reject(new Error('片段加载失败。'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        target.removeEventListener(eventName, done);
        target.removeEventListener('error', fail);
        reject(new Error('片段加载超时。'));
      }, timeoutMs);
      target.addEventListener(eventName, done, { once: true });
      target.addEventListener('error', fail, { once: true });
    });
  }

  async function resolveRecordedDuration(video, measuredDuration) {
    if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    try {
      const changed = waitForEvent(video, 'durationchange', 2_500).catch(() => null);
      video.currentTime = 1e101;
      await changed;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = 0;
        return video.duration;
      }
    } catch (_) { }
    try { video.currentTime = 0; } catch (_) { }
    return measuredDuration;
  }

  async function finishLoadingClip(metadata) {
    await Promise.all([
      seekVideo(el.clipVideo, 0, state.clip.duration),
      seekVideo(el.scrubVideo, 0, state.clip.duration),
    ]);
    state.clip.width = el.clipVideo.videoWidth || metadata.captureWidth;
    state.clip.height = el.clipVideo.videoHeight || metadata.captureHeight;
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    state.aspectSquare = true;
    makeCurrentCropSquare();
    state.trimStart = clamp(Number(metadata.initialTrimStart) || 0, 0, Math.max(0, state.clip.duration - 0.05));
    state.trimEnd = clamp(
      Number.isFinite(metadata.initialTrimEnd) ? metadata.initialTrimEnd : state.clip.duration,
      Math.min(state.clip.duration, state.trimStart + 0.05),
      state.clip.duration,
    );
    setupEditorForClip();
  }

  async function loadRecordedClip(blob, metadata) {
    disposeClip();
    state.clipRevision += 1;
    const url = URL.createObjectURL(blob);
    state.clip = { ...metadata, kind: 'blob', blob, url, duration: metadata.measuredDuration };
    await Promise.all([
      attachClipToVideo(state.clip, el.clipVideo),
      attachClipToVideo(state.clip, el.scrubVideo),
    ]);
    const duration = await resolveRecordedDuration(el.clipVideo, metadata.measuredDuration);
    state.clip.duration = Math.max(0.1, Math.min(
      Number.isFinite(duration) && duration > 0 ? duration : metadata.measuredDuration,
      metadata.measuredDuration + 0.5,
    ));
    await finishLoadingClip(metadata);
  }

  async function loadLiveRewindClip(snapshot, metadata) {
    disposeClip();
    state.clipRevision += 1;
    state.clip = {
      ...metadata,
      kind: 'media-source',
      mimeType: snapshot.mimeType,
      parts: snapshot.parts.map((part) => new Uint8Array(part)),
      attachments: new Map(),
      duration: snapshot.duration,
    };
    await Promise.all([
      attachClipToVideo(state.clip, el.clipVideo),
      attachClipToVideo(state.clip, el.scrubVideo),
    ]);
    await finishLoadingClip(metadata);
  }

  async function finalizeRecording(recording) {
    if (state.recording !== recording) return;
    cleanupRecordingResources(recording);
    try { recording.video.playbackRate = recording.snapshot.playbackRate; } catch (_) { }
    try { recording.video.pause(); } catch (_) { }

    const measuredDuration = Math.max(0, (performance.now() - recording.startedAt) / 1000);
    const sourceEnd = Number(recording.video.currentTime) || recording.snapshot.sourceStart + measuredDuration;
    state.recording = null;
    el.recordTimer.textContent = '00:00.0';
    el.selectionTimer.textContent = '00:00.0';

    if (recording.error) {
      state.mode = 'capture';
      updateModeUi();
      setStatus(friendlyError(recording.error), 'error');
      return;
    }
    if (measuredDuration < 0.2 || recording.chunks.length === 0) {
      state.mode = 'capture';
      updateModeUi();
      setStatus('片段太短，至少需要 0.2 秒。', 'error');
      return;
    }

    try {
      const blob = new Blob(recording.chunks, { type: recording.mimeType || 'video/webm' });
      if (blob.size < 1024) throw new Error('录制失败，请重试。');
      await loadRecordedClip(blob, {
        measuredDuration,
        sourceStart: recording.snapshot.sourceStart,
        sourceEnd,
        captureWidth: recording.captureWidth,
        captureHeight: recording.captureHeight,
        stopReason: recording.stopReason,
        liveWallClockStartMs: recording.liveWallClockStartMs,
        liveIdentity: recording.liveIdentity,
      });
      state.mode = 'edit';
      el.panel.classList.remove('hidden');
      el.panel.scrollTop = 0;
      if (el.editorSettingsScroll) el.editorSettingsScroll.scrollTop = 0;
      fitEditorLayout();
      updateModeUi();
      updateEstimatedFileSize();
      setStatus('');
      requestAnimationFrame(() => { void ensureTrimPreviewPlaying(); });
      if (recording.stopReason === 'limit') {
        showToast(`已达到 ${MAX_RECORD_SECONDS} 秒上限。`, 'success');
      }
    } catch (error) {
      disposeClip();
      state.mode = 'capture';
      updateModeUi();
      setStatus(friendlyError(error), 'error');
    }
  }

  function setupEditorForClip() {
    try { el.clipVideo.currentTime = 0; } catch (_) { }
    state.textLayers = [];
    state.activeTextId = null;
    renderTextLayerTabs();
    renderTextLayers();
    updateAspectSquareButton();
    updateTrimUi();
    fitEditorLayout();
    updateResolutionOptions();
    updateEstimatedFileSize();
    buildPreviewFrameCache(state.clip);
  }

  function getEditorMapping() {
    return getMediaMapping(el.clipVideo);
  }

  function cropToScreenRect(crop, mapping) {
    const topLeft = mapping.sourceToScreen(crop.x * mapping.videoWidth, crop.y * mapping.videoHeight);
    const bottomRight = mapping.sourceToScreen(
      (crop.x + crop.w) * mapping.videoWidth,
      (crop.y + crop.h) * mapping.videoHeight,
    );
    return normalizeScreenRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  }

  function screenRectToEditorCrop(rect, mapping) {
    const bounded = intersectRects(rect, mapping.renderedRect);
    if (!bounded) return null;
    const p1 = mapping.screenToSource(bounded.left, bounded.top);
    const p2 = mapping.screenToSource(bounded.right, bounded.bottom);
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const right = Math.max(p1.x, p2.x);
    const bottom = Math.max(p1.y, p2.y);
    return {
      x: clamp(left / mapping.videoWidth, 0, 1),
      y: clamp(top / mapping.videoHeight, 0, 1),
      w: clamp((right - left) / mapping.videoWidth, 0, 1),
      h: clamp((bottom - top) / mapping.videoHeight, 0, 1),
    };
  }

  function updateEditorCropBox({ force = false, render = true } = {}) {
    if (!state.clip || el.editStage.classList.contains('hidden')) return;
    if (state.editorViewportAnimation && !force) return;
    const layout = readEditorVideoLayout();
    if (!layout) return;
    applyEditorCropGeometry(layout);
    if (render) renderExportPreviewFrame();
  }

  function updateAspectSquareButton() {
    if (!el.aspectSquareBtn) return;
    el.aspectSquareBtn.classList.toggle('active', state.aspectSquare);
    el.aspectSquareBtn.setAttribute('aria-pressed', state.aspectSquare ? 'true' : 'false');
    el.aspectSquareBtn.title = state.aspectSquare ? '已锁定 1:1，点击取消' : '锁定裁剪比例为 1:1';
  }

  function makeCurrentCropSquare() {
    if (!state.clip) return;
    const vw = Math.max(1, state.clip.width || el.clipVideo.videoWidth || 1);
    const vh = Math.max(1, state.clip.height || el.clipVideo.videoHeight || 1);
    const crop = state.editorCrop;
    const pixelW = crop.w * vw;
    const pixelH = crop.h * vh;
    const side = Math.max(1, Math.min(pixelW, pixelH));
    const centerX = (crop.x + crop.w / 2) * vw;
    const centerY = (crop.y + crop.h / 2) * vh;
    const maxX = Math.max(0, vw - side);
    const maxY = Math.max(0, vh - side);
    const x = clamp(centerX - side / 2, 0, maxX);
    const y = clamp(centerY - side / 2, 0, maxY);
    state.editorCrop = { x: x / vw, y: y / vh, w: side / vw, h: side / vh };
  }

  function toggleAspectSquare() {
    if (state.mode !== 'edit' || !state.clip) return;
    state.aspectSquare = !state.aspectSquare;
    if (state.aspectSquare) makeCurrentCropSquare();
    updateAspectSquareButton();
    animateCropIntoPreview();
  }

  function resizeSquareScreenRect(startRect, handle, dx, dy, boundary, minSize = MIN_SELECT_PX) {
    const centerX = (startRect.left + startRect.right) / 2;
    const centerY = (startRect.top + startRect.bottom) / 2;

    if (handle.length === 2) {
      const west = handle.includes('w');
      const north = handle.includes('n');
      const anchorX = west ? startRect.right : startRect.left;
      const anchorY = north ? startRect.bottom : startRect.top;
      const dragStartX = west ? startRect.left : startRect.right;
      const dragStartY = north ? startRect.top : startRect.bottom;
      const dragX = dragStartX + dx;
      const dragY = dragStartY + dy;
      const rawSide = Math.max(Math.abs(dragX - anchorX), Math.abs(dragY - anchorY));
      const maxHorizontal = west ? anchorX - boundary.left : boundary.right - anchorX;
      const maxVertical = north ? anchorY - boundary.top : boundary.bottom - anchorY;
      const maxSide = Math.max(1, Math.min(maxHorizontal, maxVertical));
      const side = clamp(rawSide, Math.min(minSize, maxSide), maxSide);
      const left = west ? anchorX - side : anchorX;
      const top = north ? anchorY - side : anchorY;
      return { left, top, right: left + side, bottom: top + side, width: side, height: side };
    }

    if (handle === 'e' || handle === 'w') {
      const west = handle === 'w';
      const anchorX = west ? startRect.right : startRect.left;
      const rawSide = west ? startRect.width - dx : startRect.width + dx;
      const maxHorizontal = west ? anchorX - boundary.left : boundary.right - anchorX;
      const maxVertical = 2 * Math.min(centerY - boundary.top, boundary.bottom - centerY);
      const maxSide = Math.max(1, Math.min(maxHorizontal, maxVertical));
      const side = clamp(rawSide, Math.min(minSize, maxSide), maxSide);
      const left = west ? anchorX - side : anchorX;
      const top = centerY - side / 2;
      return { left, top, right: left + side, bottom: top + side, width: side, height: side };
    }

    if (handle === 'n' || handle === 's') {
      const north = handle === 'n';
      const anchorY = north ? startRect.bottom : startRect.top;
      const rawSide = north ? startRect.height - dy : startRect.height + dy;
      const maxVertical = north ? anchorY - boundary.top : boundary.bottom - anchorY;
      const maxHorizontal = 2 * Math.min(centerX - boundary.left, boundary.right - centerX);
      const maxSide = Math.max(1, Math.min(maxHorizontal, maxVertical));
      const side = clamp(rawSide, Math.min(minSize, maxSide), maxSide);
      const left = centerX - side / 2;
      const top = north ? anchorY - side : anchorY;
      return { left, top, right: left + side, bottom: top + side, width: side, height: side };
    }

    return startRect;
  }

  function handleEditorCropPointerDown(event) {
    if (event.button !== 0 || state.mode !== 'edit' || !state.clip) return;
    settleEditorViewportAnimation();
    const mapping = getEditorMapping();
    if (!mapping) return;
    const viewport = getEditorViewportRect();
    const startRect = cropToScreenRect(state.editorCrop, mapping);
    const handle = event.target?.dataset?.resize || '';
    state.editorCropSession = {
      pointerId: event.pointerId,
      mapping,
      startRect,
      startX: event.clientX,
      startY: event.clientY,
      type: handle ? 'resize' : 'move',
      handle,
      viewport: { width: viewport.width, height: viewport.height },
      fittedLayout: calculateFittedEditorViewport(viewport),
    };
    suspendEditorBackgroundWork();
    prepareEditorViewportAnimation();
    event.preventDefault();
    event.stopPropagation();
    el.editorCropBox.setPointerCapture?.(event.pointerId);
  }

  function handleEditorCropPointerMove(event) {
    const session = state.editorCropSession;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const rect = session.type === 'move'
      ? moveScreenRect(session.startRect, dx, dy, session.mapping.visibleRect)
      : (state.aspectSquare
        ? resizeSquareScreenRect(session.startRect, session.handle, dx, dy, session.mapping.renderedRect)
        : resizeScreenRect(session.startRect, session.handle, dx, dy, session.mapping.renderedRect));
    const crop = screenRectToEditorCrop(rect, session.mapping);
    if (!crop) return;
    state.editorCrop = crop;
    session.fittedLayout = calculateFittedEditorViewport(session.viewport, crop);
    updateEditorCropBox({ render: false });
    event.preventDefault();
  }

  function finishEditorCropAdjustment(event) {
    const session = state.editorCropSession;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    state.editorCropSession = null;
    try { el.editorCropBox.releasePointerCapture?.(session.pointerId); } catch (_) { }
    animateCropIntoPreview(session.fittedLayout);
  }

  function resetEditorCrop() {
    if (!state.clip || state.mode !== 'edit') return;
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    animateCropIntoPreview();
  }

  function updateTimelinePlayhead() {
    if (!state.clip) return;
    const duration = Math.max(0.001, state.clip.duration);
    const current = clamp(Number(el.clipVideo.currentTime) || 0, 0, duration);
    const pct = (current / duration) * 100;
    el.timelinePlayhead.style.left = `${pct}%`;
  }

  function updateTrimUi(seekTarget = null) {
    if (!state.clip) return;
    const duration = state.clip.duration;
    const minGap = Math.min(0.1, duration / 2);
    state.trimStart = clamp(Number(state.trimStart) || 0, 0, Math.max(0, duration - minGap));
    state.trimEnd = clamp(Number(state.trimEnd) || duration, state.trimStart + minGap, duration);

    const startPct = (state.trimStart / duration) * 100;
    const endPct = (state.trimEnd / duration) * 100;
    el.timelineStartHandle.style.left = `${startPct}%`;
    el.timelineEndHandle.style.left = `${endPct}%`;
    el.timelineSelected.style.left = `${startPct}%`;
    el.timelineSelected.style.width = `${Math.max(0, endPct - startPct)}%`;
    el.trimStartValue.textContent = formatTime(state.trimStart);
    el.trimEndValue.textContent = formatTime(state.trimEnd);
    el.trimSummary.textContent = `${(state.trimEnd - state.trimStart).toFixed(2)} 秒`;

    if (seekTarget !== null && Number.isFinite(seekTarget)) {
      try { el.clipVideo.currentTime = clamp(seekTarget, 0, duration); } catch (_) { }
    }
    updateTimelinePlayhead();
  }

  function timelineTimeFromClientX(clientX) {
    if (!state.clip) return 0;
    const rect = el.timelineTrack.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return ratio * state.clip.duration;
  }

  function showTimelineHandlePreview(time) {
    if (!state.clip || !el.scrubVideo) return;
    const target = clamp(Number(time) || 0, 0, Math.max(0, state.clip.duration - 0.001));
    try { el.scrubVideo.pause(); } catch (_) { }
    el.scrubVideo.classList.add('active');
    queueTimelinePreview(target, 'handle');
  }

  function cancelTimelinePreview() {
    if (state.timelinePreviewRaf) cancelAnimationFrame(state.timelinePreviewRaf);
    state.timelinePreviewRaf = 0;
    state.timelinePreviewTarget = null;
    state.timelinePreviewType = null;
  }

  function queueTimelinePreview(time, type) {
    if (!state.clip) return;
    state.timelinePreviewTarget = clamp(Number(time) || 0, 0, Math.max(0, state.clip.duration - 0.001));
    state.timelinePreviewType = type;
    if (state.timelinePreviewRaf) return;
    state.timelinePreviewRaf = requestAnimationFrame(() => {
      state.timelinePreviewRaf = 0;
      if (!state.timelineDrag || state.timelinePreviewTarget === null) return;
      const target = state.timelinePreviewTarget;
      let settings;
      try { settings = readExportSettings(); } catch (_) { return; }
      el.scrubVideo.classList.add('active');
      if (hasPreviewCacheFrames()) {
        renderCachedPreviewFrame(settings, target);
      }
      if (Math.abs((Number(el.scrubVideo.currentTime) || 0) - target) < 0.008
        && el.scrubVideo.readyState >= 2) {
        renderExportPreviewFrame();
        return;
      }
      try { el.scrubVideo.currentTime = target; } catch (_) { }
    });
  }

  function renderTimelinePreviewIfCurrent(video) {
    if (!state.timelineDrag || !video || state.timelinePreviewTarget === null) return;
    const target = state.timelinePreviewTarget;
    if (Math.abs((Number(video.currentTime) || 0) - target) > 0.035) return;
    renderExportPreviewFrame();
  }

  function hideTimelineHandlePreview() {
    if (!el.scrubVideo) return;
    cancelTimelinePreview();
    el.scrubVideo.classList.remove('active');
    renderExportPreviewFrame();
  }

  function settleTimelinePreview(type, target, resumePlayback = false) {
    if (!state.clip || !Number.isFinite(target)) return;
    const token = ++state.timelineSettleToken;
    const video = type === 'handle' ? el.scrubVideo : el.clipVideo;
    if (!video) return;
    if (type === 'handle') el.scrubVideo.classList.add('active');
    seekVideo(video, target, state.clip.duration).then(() => {
      if (token !== state.timelineSettleToken || state.timelineDrag) return;
      if (type === 'playhead') el.scrubVideo.classList.remove('active');
      renderExportPreviewFrame();
      if (type === 'handle') el.scrubVideo.classList.remove('active');
      if (resumePlayback) void ensureTrimPreviewPlaying();
      void resumePreviewFrameCache();
    }).catch(() => { });
  }

  function applyTimelineDrag(event) {
    const drag = state.timelineDrag;
    if (!drag || !state.clip) return;
    const target = timelineTimeFromClientX(event.clientX);
    const minGap = Math.min(0.1, state.clip.duration / 2);
    if (drag.type === 'start') {
      state.trimStart = Math.min(target, state.trimEnd - minGap);
      updateTrimUi();
      queueTimelinePreview(state.trimStart, 'handle');
    } else if (drag.type === 'end') {
      state.trimEnd = Math.max(target, state.trimStart + minGap);
      updateTrimUi();
      queueTimelinePreview(state.trimEnd, 'handle');
    } else {
      queueTimelinePreview(target, 'playhead');
      el.timelinePlayhead.style.left = `${(target / Math.max(0.001, state.clip.duration)) * 100}%`;
    }
  }

  function handleTimelinePointerDown(event) {
    if (event.button !== 0 || state.mode !== 'edit' || !state.clip) return;
    state.timelineResumePlayback = Boolean(state.trimPreviewCleanup && !el.clipVideo.paused);
    stopTrimPreview();
    pausePreviewFrameCache();
    state.timelineSettleToken += 1;
    const handleType = event.target?.dataset?.timelineHandle;
    state.timelineDrag = {
      pointerId: event.pointerId,
      type: handleType === 'start' || handleType === 'end' ? handleType : 'playhead',
    };
    if (state.timelineDrag.type === 'start') showTimelineHandlePreview(state.trimStart);
    if (state.timelineDrag.type === 'end') showTimelineHandlePreview(state.trimEnd);
    event.preventDefault();
    el.timelineTrack.setPointerCapture?.(event.pointerId);
    applyTimelineDrag(event);
  }

  function handleTimelinePointerMove(event) {
    if (!state.timelineDrag || state.timelineDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    applyTimelineDrag(event);
  }

  function finishTimelineDrag(event) {
    const drag = state.timelineDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    const target = state.timelinePreviewTarget;
    const shouldResumePlayback = state.timelineResumePlayback;
    state.timelineResumePlayback = false;
    state.timelineDrag = null;
    try { el.timelineTrack.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    if (Number.isFinite(target)) {
      cancelTimelinePreview();
      settleTimelinePreview(
        drag.type === 'start' || drag.type === 'end' ? 'handle' : 'playhead',
        target,
        shouldResumePlayback,
      );
    } else {
      hideTimelineHandlePreview();
      void resumePreviewFrameCache();
    }
    updateTrimUi();
    updateEstimatedFileSize();
  }

  function stopTrimPreview({ keepPosition = true } = {}) {
    if (typeof state.trimPreviewCleanup === 'function') state.trimPreviewCleanup();
    state.trimPreviewCleanup = null;
    if (state.previewSnapshot) {
      try { el.clipVideo.playbackRate = state.previewSnapshot.playbackRate; } catch (_) { }
      state.previewSnapshot = null;
    }
    el.previewTrimBtn.textContent = '▶ 播放';
    if (!keepPosition && state.clip) {
      try { el.clipVideo.currentTime = state.trimStart; } catch (_) { }
      updateTimelinePlayhead();
    }
    renderExportPreviewFrame();
  }

  async function ensureTrimPreviewPlaying() {
    if (state.mode !== 'edit' || !state.clip || state.trimPreviewCleanup) return;
    await previewTrimmedClip();
  }

  async function previewTrimmedClip() {
    if (state.mode !== 'edit' || !state.clip) return;
    if (state.trimPreviewCleanup) {
      stopTrimPreview();
      return;
    }

    let stopped = false;
    let jumping = false;
    let lastDrawAt = 0;
    let animationFrame = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      el.clipVideo.removeEventListener('timeupdate', check);
      state.trimPreviewCleanup = null;
      el.previewTrimBtn.textContent = '▶ 播放';
    };
    const check = async () => {
      if (stopped || jumping) return;
      updateTimelinePlayhead();
      if (el.clipVideo.currentTime < state.trimEnd - 0.025 && !el.clipVideo.ended) return;
      jumping = true;
      try {
        await seekVideo(el.clipVideo, state.trimStart, state.clip.duration);
        if (!stopped && el.clipVideo.paused) await el.clipVideo.play();
      } catch (error) {
        stop();
        setStatus(friendlyError(error), 'error');
      } finally {
        jumping = false;
      }
    };

    try {
      const current = Number(el.clipVideo.currentTime);
      const resumeAt = Number.isFinite(current)
        && current >= state.trimStart
        && current < state.trimEnd - 0.025
        ? current
        : state.trimStart;
      el.clipVideo.pause();
      await seekVideo(el.clipVideo, resumeAt, state.clip.duration);
      state.previewSnapshot = { playbackRate: el.clipVideo.playbackRate };
      el.clipVideo.addEventListener('timeupdate', check);
      state.trimPreviewCleanup = () => {
        try { el.clipVideo.pause(); } catch (_) { }
        stop();
      };
      el.previewTrimBtn.textContent = '⏸ 暂停';
      el.clipVideo.playbackRate = Math.max(0.1, Number(el.speedSelect.value) || 1);
      const tick = (now) => {
        if (stopped) return;
        const fps = Math.max(1, Number(el.fpsSelect.value) || 12);
        if (!lastDrawAt || now - lastDrawAt >= 1000 / fps) {
          renderExportPreviewFrame();
          lastDrawAt = now;
        }
        updateTimelinePlayhead();
        if (!stopped) animationFrame = requestAnimationFrame(tick);
      };
      renderExportPreviewFrame();
      animationFrame = requestAnimationFrame(tick);
      await el.clipVideo.play();
      setStatus('');
    } catch (error) {
      stopTrimPreview();
      setStatus(friendlyError(error), 'error');
    }
  }

  function getActiveTextLayer() {
    return state.textLayers.find((layer) => layer.id === state.activeTextId) || null;
  }

  function textLayerLabel(layer, index) {
    const compact = String(layer.text || '').replace(/\s+/g, ' ').trim();
    return compact ? compact.slice(0, 12) : `文字 ${index + 1}`;
  }

  function renderTextLayerTabs(syncControls = true) {
    if (!el.textLayerTabs) return;
    el.textLayerTabs.textContent = '';
    state.textLayers.forEach((layer, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `text-tab${layer.id === state.activeTextId ? ' active' : ''}`;
      button.dataset.textId = layer.id;
      button.title = String(layer.text || `文字 ${index + 1}`);
      button.disabled = state.mode === 'exporting';

      const label = document.createElement('span');
      label.className = 'text-tab-label';
      label.textContent = textLayerLabel(layer, index);
      button.appendChild(label);

      const remove = document.createElement('span');
      remove.className = 'text-tab-delete';
      remove.dataset.deleteTextId = layer.id;
      remove.setAttribute('role', 'button');
      remove.setAttribute('aria-label', `删除${textLayerLabel(layer, index)}`);
      remove.title = '删除这段文字';
      remove.textContent = '×';
      button.appendChild(remove);

      el.textLayerTabs.appendChild(button);
    });
    el.addTextBtn.disabled = state.mode === 'exporting' || state.textLayers.length >= 8;
    const active = getActiveTextLayer();
    el.textEditor.classList.toggle('hidden', !active);
    el.textEditorEmpty.classList.toggle('hidden', Boolean(active));
    if (active && syncControls) {
      el.captionText.value = active.text;
      el.fontScale.value = String(active.fontScale);
      if (el.fontScaleValue) el.fontScaleValue.textContent = `${Math.round(active.fontScale * 100)}%`;
      el.textColor.value = active.textColor;
      el.strokeColor.value = active.strokeColor;
      el.strokeScale.value = String(active.strokeScale);
      syncTextColorSwatches();
    }
  }

  function syncTextColorSwatches() {
    const selectedColor = String(el.textColor.value || '').toLowerCase();
    el.textColorSwatches.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.textColor === selectedColor));
    });
  }

  function applyTextLayerMetrics(item, layer, previewWidth) {
    const fontSize = Math.max(12, Math.round(previewWidth * layer.fontScale));
    const strokeWidth = Math.max(0, fontSize * layer.strokeScale);
    Object.assign(item.style, {
      fontSize: `${fontSize}px`,
      webkitTextStroke: `${strokeWidth}px ${layer.strokeColor}`,
    });
  }

  function updateTextLayerMetrics(previewWidth) {
    if (!el.captionLayer || !state.textLayers.length) return;
    const layers = new Map(state.textLayers.map((layer) => [layer.id, layer]));
    el.captionLayer.querySelectorAll('.caption-item').forEach((item) => {
      const layer = layers.get(item.dataset.textId);
      if (layer) applyTextLayerMetrics(item, layer, previewWidth);
    });
  }

  function renderTextLayers() {
    if (!el.captionLayer) return;
    el.captionLayer.textContent = '';
    if (!state.clip) return;
    const previewWidth = Math.max(1, Number.parseFloat(el.captionLayer.style.width) || 1);
    state.textLayers.forEach((layer) => {
      if (!String(layer.text || '').trim()) return;
      const item = document.createElement('div');
      item.className = `caption-item${layer.id === state.activeTextId ? ' active' : ''}`;
      item.dataset.textId = layer.id;
      item.textContent = layer.text;
      Object.assign(item.style, {
        left: `${clamp(layer.x, 0, 1) * 100}%`,
        top: `${clamp(layer.y, 0, 1) * 100}%`,
        color: layer.textColor,
      });
      applyTextLayerMetrics(item, layer, previewWidth);
      el.captionLayer.appendChild(item);
    });
  }

  function selectTextLayer(id, { focus = false } = {}) {
    if (!state.textLayers.some((layer) => layer.id === id)) return;
    state.activeTextId = id;
    renderTextLayerTabs();
    renderTextLayers();
    if (focus) {
      requestAnimationFrame(() => {
        el.captionText.focus();
        el.captionText.select();
      });
    }
  }

  function addTextLayer() {
    if (state.mode !== 'edit' || !state.clip || state.busy) return;
    if (state.textLayers.length >= 8) {
      showToast('最多可添加 8 段文字。', 'error');
      return;
    }
    const id = `text-${state.nextTextLayerId++}`;
    const offset = Math.min(0.12, state.textLayers.length * 0.035);
    state.textLayers.push({
      id,
      text: '文字',
      x: 0.5,
      y: clamp(0.82 - offset, 0.12, 0.88),
      fontScale: 0.09,
      textColor: '#ffffff',
      strokeColor: '#ffffff',
      strokeScale: 0.14,
    });
    selectTextLayer(id, { focus: true });
    scheduleEditorPreviewRender();
    updateEstimatedFileSize();
  }

  function deleteTextLayerById(id) {
    const index = state.textLayers.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    const wasActive = state.activeTextId === id;
    state.textLayers.splice(index, 1);
    if (wasActive) {
      state.activeTextId = state.textLayers[index]?.id || state.textLayers[index - 1]?.id || null;
    }
    renderTextLayerTabs();
    renderTextLayers();
    scheduleEditorPreviewRender();
    updateEstimatedFileSize();
  }

  function deleteActiveTextLayer() {
    if (state.activeTextId) deleteTextLayerById(state.activeTextId);
  }

  function updateActiveTextLayerFromControls() {
    const layer = getActiveTextLayer();
    if (!layer) return;
    layer.text = el.captionText.value;
    layer.fontScale = Number(el.fontScale.value) || 0.09;
    if (el.fontScaleValue) el.fontScaleValue.textContent = `${Math.round(layer.fontScale * 100)}%`;
    layer.textColor = el.textColor.value || '#ffffff';
    layer.strokeColor = el.strokeColor.value || '#ffffff';
    layer.strokeScale = Number(el.strokeScale.value) || 0;
    syncTextColorSwatches();
    renderTextLayerTabs(false);
    renderTextLayers();
    scheduleEditorPreviewRender();
    updateEstimatedFileSize();
  }

  function handleTextLayerPointerDown(event) {
    if (event.button !== 0 || state.mode !== 'edit' || state.busy) return;
    const item = event.target.closest?.('.caption-item');
    const id = item?.dataset?.textId;
    if (!id) return;
    const layer = state.textLayers.find((candidate) => candidate.id === id);
    if (!layer) return;
    state.activeTextId = id;
    $$('.caption-item').forEach((node) => node.classList.toggle('active', node === item));
    renderTextLayerTabs();
    const rect = el.captionLayer.getBoundingClientRect();
    state.textLayerDrag = {
      pointerId: event.pointerId,
      id,
      item,
      rect,
      startX: event.clientX,
      startY: event.clientY,
      startLayerX: layer.x,
      startLayerY: layer.y,
    };
    item.classList.add('dragging');
    item.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleTextLayerPointerMove(event) {
    const drag = state.textLayerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const layer = state.textLayers.find((candidate) => candidate.id === drag.id);
    if (!layer) return;
    layer.x = clamp(
      drag.startLayerX + (event.clientX - drag.startX) / Math.max(1, drag.rect.width),
      0.02,
      0.98,
    );
    layer.y = clamp(
      drag.startLayerY + (event.clientY - drag.startY) / Math.max(1, drag.rect.height),
      0.04,
      0.96,
    );
    drag.item.style.left = `${layer.x * 100}%`;
    drag.item.style.top = `${layer.y * 100}%`;
    scheduleEditorPreviewRender();
    event.preventDefault();
  }

  function finishTextLayerDrag(event) {
    const drag = state.textLayerDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    state.textLayerDrag = null;
    drag.item.classList.remove('dragging');
    try { drag.item.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    scheduleEditorPreviewRender();
  }

  function waitForFreshFrame(video) {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(done, 350);
      if (typeof video.requestVideoFrameCallback === 'function') {
        try { video.requestVideoFrameCallback(done); } catch (_) { }
      }
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
  }

  function seekVideo(video, targetTime, knownDuration = null) {
    return new Promise((resolve, reject) => {
      const duration = Number.isFinite(knownDuration)
        ? knownDuration
        : (Number.isFinite(video.duration) ? video.duration : targetTime);
      const target = clamp(targetTime, 0, Math.max(0, duration - 0.001));

      if (Math.abs(video.currentTime - target) < 0.008 && video.readyState >= 2) {
        waitForFreshFrame(video).then(resolve);
        return;
      }

      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        await waitForFreshFrame(video);
        resolve();
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(new Error(message));
      };
      const onSeeked = () => finish();
      const onError = () => fail('视频跳转失败。');
      const timeout = setTimeout(() => {
        if (Math.abs(video.currentTime - target) < 0.14 && video.readyState >= 2) finish();
        else fail('跳转超时。');
      }, 10_000);

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError, { once: true });
      try {
        video.currentTime = target;
      } catch (error) {
        fail(`无法跳转时间轴：${error.message || error}`);
      }
    });
  }

  function wrapCaption(ctx, text, maxWidth, maxLines = 5) {
    const result = [];
    const paragraphs = text.replace(/\r/g, '').split('\n');
    for (const paragraph of paragraphs) {
      if (result.length >= maxLines) break;
      if (!paragraph) {
        result.push('');
        continue;
      }
      let line = '';
      for (const char of paragraph) {
        const candidate = line + char;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          result.push(line);
          line = char;
          if (result.length >= maxLines) break;
        } else {
          line = candidate;
        }
      }
      if (result.length < maxLines && line) result.push(line);
    }
    if (result.length === maxLines) {
      const lastIndex = result.length - 1;
      let last = result[lastIndex];
      while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
      result[lastIndex] = `${last}…`;
    }
    return result;
  }

  function drawTextLayers(ctx, width, height, layers) {
    if (!Array.isArray(layers) || !layers.length) return;
    layers.forEach((layer) => {
      const textValue = String(layer.text || '').trim();
      if (!textValue) return;
      const fontSize = Math.max(16, Math.round(width * layer.fontScale));
      const lineHeight = Math.round(fontSize * 1.18);
      ctx.save();
      ctx.font = `850 ${fontSize}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.fillStyle = layer.textColor;
      ctx.strokeStyle = layer.strokeColor;
      ctx.lineWidth = Math.max(1, fontSize * layer.strokeScale * 2);
      const lines = wrapCaption(ctx, textValue, width * 0.9, 6);
      const span = Math.max(0, lines.length - 1) * lineHeight;
      const centerX = clamp(layer.x, 0, 1) * width;
      const centerY = clamp(layer.y, 0, 1) * height;
      lines.forEach((line, index) => {
        const y = centerY - span / 2 + index * lineHeight;
        if (layer.strokeScale > 0) ctx.strokeText(line, centerX, y);
        ctx.fillText(line, centerX, y);
      });
      ctx.restore();
    });
  }

  function getCornerRadiusRatio() {
    const value = Number(el.cornerRadiusSelect?.value);
    return clamp(Number.isFinite(value) ? value : 0, 0, 0.5);
  }

  function getCornerRadiusPixels(width, height, ratio = getCornerRadiusRatio()) {
    return Math.min(width, height) * clamp(Number(ratio) || 0, 0, 0.5);
  }

  function updateRoundedCropGuide(width, height, settings = null) {
    if (!el.editorCropBox) return;
    const ratio = settings ? Number(settings.cornerRadiusRatio) || 0 : getCornerRadiusRatio();
    const radius = getCornerRadiusPixels(width, height, ratio);
    // Apply the guide to the crop frame itself so its corners match the real output boundary.
    el.editorCropBox.style.setProperty('--crop-frame-radius', `${radius}px`);
    if (el.cornerRadiusState) {
      el.cornerRadiusState.textContent = ratio > 0 ? '透明背景' : '无圆角';
    }
  }

  function hasTransparentCorners(settings) {
    return settings.transparentCorners === true
      || getCornerRadiusPixels(
        settings.outputWidth,
        settings.outputHeight,
        settings.cornerRadiusRatio,
      ) > 0;
  }

  function addRoundedRectPath(ctx, width, height, radius) {
    const r = clamp(Number(radius) || 0, 0, Math.min(width, height) / 2);
    if (r <= 0) {
      ctx.rect(0, 0, width, height);
      return;
    }
    ctx.moveTo(r, 0);
    ctx.lineTo(width - r, 0);
    ctx.arcTo(width, 0, width, r, r);
    ctx.lineTo(width, height - r);
    ctx.arcTo(width, height, width - r, height, r);
    ctx.lineTo(r, height);
    ctx.arcTo(0, height, 0, height - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
  }

  function normalizeTransparentCorner(ctx, x, y, size) {
    const image = ctx.getImageData(x, y, size, size);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      // GIF transparency is binary; keep no partially covered edge pixel visible.
      if (alpha < 255) {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0;
      } else {
        pixels[i + 3] = 255;
      }
    }
    ctx.putImageData(image, x, y);
  }

  function normalizeTransparentCorners(ctx, width, height, radius) {
    const size = Math.min(
      Math.max(1, Math.ceil(radius) + 1),
      width,
      height,
    );
    normalizeTransparentCorner(ctx, 0, 0, size);
    normalizeTransparentCorner(ctx, width - size, 0, size);
    normalizeTransparentCorner(ctx, 0, height - size, size);
    normalizeTransparentCorner(ctx, width - size, height - size, size);
  }

  function drawExportCanvasFrame(ctx, settings, source) {
    const width = settings.outputWidth;
    const height = settings.outputHeight;
    const radius = Number(settings.outputRadius)
      || getCornerRadiusPixels(width, height, settings.cornerRadiusRatio);
    const transparentCorners = hasTransparentCorners(settings);
    const sourceWidth = Number(source.videoWidth || source.displayWidth || source.width || state.clip.width);
    const sourceHeight = Number(source.videoHeight || source.displayHeight || source.height || state.clip.height);
    const sx = settings.crop.x * sourceWidth;
    const sy = settings.crop.y * sourceHeight;
    const sw = settings.crop.w * sourceWidth;
    const sh = settings.crop.h * sourceHeight;

    ctx.clearRect(0, 0, width, height);
    if (!transparentCorners || radius <= 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    drawTextLayers(ctx, width, height, settings.textLayers);
    if (transparentCorners && radius > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      addRoundedRectPath(ctx, width, height, radius);
      ctx.fill();
      ctx.restore();
      normalizeTransparentCorners(ctx, width, height, radius);
    }
  }

  function updatePreviewCanvasLayout(settings = null) {
    if (!state.clip || !el.previewCanvas || !el.editorPreviewWrap) return null;
    const nextSettings = settings || (() => {
      try { return readExportSettings(); } catch (_) { return null; }
    })();
    if (!nextSettings) return null;
    if (state.editorCropSession || state.editorViewportAnimation || state.editorBackgroundIntent) return null;

    const layout = readEditorVideoLayout();
    if (!layout) return null;
    const crop = calculateEditorCropGeometry(layout);
    const canvas = el.previewCanvas;
    if (canvas.width !== nextSettings.outputWidth) canvas.width = nextSettings.outputWidth;
    if (canvas.height !== nextSettings.outputHeight) canvas.height = nextSettings.outputHeight;
    const displayWidth = Math.max(1, crop.width);
    const displayHeight = Math.max(1, crop.height);
    Object.assign(canvas.style, {
      left: `${crop.left}px`,
      top: `${crop.top}px`,
      width: `${displayWidth}px`,
      height: `${displayHeight}px`,
      borderRadius: '0px',
    });
    updateRoundedCropGuide(displayWidth, displayHeight, nextSettings);
    return nextSettings;
  }

  function scheduleEditorPreviewRender() {
    if (state.editorPreviewRaf) return;
    state.editorPreviewRaf = requestAnimationFrame(() => {
      state.editorPreviewRaf = 0;
      renderExportPreviewFrame();
    });
  }

  function cancelEditorPreviewRender() {
    if (!state.editorPreviewRaf) return;
    cancelAnimationFrame(state.editorPreviewRaf);
    state.editorPreviewRaf = 0;
  }

  function renderExportPreviewFrame(settings = null) {
    if (!state.clip || state.mode !== 'edit' || !el.previewCanvas) return;
    if (state.editorCropSession || state.editorViewportAnimation || state.editorBackgroundIntent) return;
    const nextSettings = updatePreviewCanvasLayout(settings);
    const sourceVideo = el.scrubVideo?.classList.contains('active') ? el.scrubVideo : el.clipVideo;
    if (!nextSettings || !sourceVideo || sourceVideo.readyState < 2) return;
    const ctx = el.previewCanvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawExportCanvasFrame(ctx, nextSettings, sourceVideo);
    setOutputPreviewVisible(true);
  }

  async function readUserscriptResource(name) {
    if (typeof GM_getResourceText === 'function') return GM_getResourceText(name);
    if (globalThis.GM && typeof globalThis.GM.getResourceText === 'function') {
      return globalThis.GM.getResourceText(name);
    }
    return '';
  }

  async function loadEncodingResourceTexts() {
    if (state.encodingResourceTexts) return state.encodingResourceTexts;
    const [modernPalette, gifenc, gifsicle] = await Promise.all([
      readUserscriptResource('MODERN_PALETTE_MODULE'),
      readUserscriptResource('GIFENC_MODULE'),
      readUserscriptResource('GIFSICLE_MODULE'),
    ]);
    if (!modernPalette || !gifenc || !gifsicle) throw new Error('编码组件加载失败，请刷新页面重试。');
    state.encodingResourceTexts = { modernPalette, gifenc, gifsicle };
    return state.encodingResourceTexts;
  }

  function makeEncodingWorkerSource(modernPaletteUrl, gifencUrl, gifsicleUrl) {
    return `
      const modernPaletteUrl = ${JSON.stringify(modernPaletteUrl)};
      const gifencUrl = ${JSON.stringify(gifencUrl)};
      const gifsicleUrl = ${JSON.stringify(gifsicleUrl)};
      const TRANSPARENT_INDEX = ${GIF_TRANSPARENT_INDEX};
      let encoderApi = null;
      let settings = null;
      let mappingPalette = null;
      let globalPalette = null;
      let canvas = null;
      let ctx = null;

      function reportError(error) {
        const message = String(error && (error.message || error) || '编码失败');
        self.postMessage({ type: 'error', message });
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function addRoundedRectPath(context, width, height, radius) {
        const safeRadius = clamp(radius, 0, Math.min(width, height) / 2);
        context.moveTo(safeRadius, 0);
        context.lineTo(width - safeRadius, 0);
        context.quadraticCurveTo(width, 0, width, safeRadius);
        context.lineTo(width, height - safeRadius);
        context.quadraticCurveTo(width, height, width - safeRadius, height);
        context.lineTo(safeRadius, height);
        context.quadraticCurveTo(0, height, 0, height - safeRadius);
        context.lineTo(0, safeRadius);
        context.quadraticCurveTo(0, 0, safeRadius, 0);
      }

      function wrapCaption(context, text, maxWidth, maxLines) {
        const result = [];
        const paragraphs = String(text || '').replace(/\\r/g, '').split('\\n');
        for (const paragraph of paragraphs) {
          if (result.length >= maxLines) break;
          if (!paragraph) {
            result.push('');
            continue;
          }
          let line = '';
          for (const char of paragraph) {
            const candidate = line + char;
            if (line && context.measureText(candidate).width > maxWidth) {
              result.push(line);
              line = char;
              if (result.length >= maxLines) break;
            } else {
              line = candidate;
            }
          }
          if (result.length < maxLines && line) result.push(line);
        }
        if (result.length === maxLines) {
          let last = result[result.length - 1];
          while (last && context.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
          result[result.length - 1] = last + '…';
        }
        return result;
      }

      function drawTextLayers(context, width, height, layers) {
        for (const layer of layers || []) {
          const value = String(layer.text || '').trim();
          if (!value) continue;
          const fontSize = Math.max(16, Math.round(width * layer.fontScale));
          const lineHeight = Math.round(fontSize * 1.18);
          context.save();
          context.font = '850 ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.lineJoin = 'round';
          context.miterLimit = 2;
          context.fillStyle = layer.textColor;
          context.strokeStyle = layer.strokeColor;
          context.lineWidth = Math.max(1, fontSize * layer.strokeScale * 2);
          const lines = wrapCaption(context, value, width * 0.9, 6);
          const span = Math.max(0, lines.length - 1) * lineHeight;
          const centerX = clamp(layer.x, 0, 1) * width;
          const centerY = clamp(layer.y, 0, 1) * height;
          lines.forEach((line, index) => {
            const y = centerY - span / 2 + index * lineHeight;
            if (layer.strokeScale > 0) context.strokeText(line, centerX, y);
            context.fillText(line, centerX, y);
          });
          context.restore();
        }
      }

      function composeFrame(source, frameSettings) {
        const width = frameSettings.outputWidth;
        const height = frameSettings.outputHeight;
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          canvas = new OffscreenCanvas(width, height);
          ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
        }
        const crop = frameSettings.crop;
        const sourceWidth = Number(source.displayWidth || source.width);
        const sourceHeight = Number(source.displayHeight || source.height);
        const sx = crop.x * sourceWidth;
        const sy = crop.y * sourceHeight;
        const sw = crop.w * sourceWidth;
        const sh = crop.h * sourceHeight;
        ctx.clearRect(0, 0, width, height);
        if (!frameSettings.transparentCorners) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
        drawTextLayers(ctx, width, height, frameSettings.textLayers);
        if (frameSettings.transparentCorners && frameSettings.outputRadius > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          addRoundedRectPath(ctx, width, height, frameSettings.outputRadius);
          ctx.fill();
          ctx.restore();
        }
        return ctx.getImageData(0, 0, width, height);
      }

      function parseHexColor(value) {
        const match = String(value || '').match(/^#([0-9a-f]{6})$/i);
        if (!match) return null;
        const number = Number.parseInt(match[1], 16);
        return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
      }

      function forcePaletteColors(palette, colors, maxColors) {
        const result = palette.slice(0, maxColors).map((color) => color.slice(0, 3));
        for (const color of colors) {
          if (!color || result.some((item) => item[0] === color[0] && item[1] === color[1] && item[2] === color[2])) continue;
          if (result.length >= maxColors) result.pop();
          result.push(color);
        }
        while (result.length < maxColors) result.push(result[result.length - 1] || [0, 0, 0]);
        return result;
      }

      async function buildPalette(message) {
        const { Palette } = await import(modernPaletteUrl);
        const palette = new Palette({
          maxColors: message.preset.maxColors,
          premultipliedAlpha: true,
          tint: [255, 255, 255],
        });
        try {
          for (const frame of message.frames) {
            const imageData = composeFrame(frame, message.settings);
            palette.addSample(imageData.data);
            frame.close();
          }
          const colors = (await palette.generate()).map((color) => [color.rgb.r, color.rgb.g, color.rgb.b]);
          const forced = [];
          for (const layer of message.settings.textLayers || []) {
            forced.push(parseHexColor(layer.textColor), parseHexColor(layer.strokeColor));
          }
          const mapped = forcePaletteColors(colors, forced, message.preset.maxColors);
          const global = mapped.slice();
          while (global.length < TRANSPARENT_INDEX) global.push(global[global.length - 1] || [0, 0, 0]);
          global.length = TRANSPARENT_INDEX;
          global.push([0, 0, 0]);
          self.postMessage({ type: 'palette', mappingPalette: mapped, globalPalette: global });
        } finally {
          for (const frame of message.frames) {
            try { frame.close(); } catch (_) { }
          }
        }
      }

      function applyFloydSteinberg(data, width, height, palette, nearestColorIndex) {
        const indexed = new Uint8Array(width * height);
        let currentR = new Float32Array(width + 2);
        let currentG = new Float32Array(width + 2);
        let currentB = new Float32Array(width + 2);
        let nextR = new Float32Array(width + 2);
        let nextG = new Float32Array(width + 2);
        let nextB = new Float32Array(width + 2);
        for (let y = 0; y < height; y += 1) {
          nextR.fill(0); nextG.fill(0); nextB.fill(0);
          for (let x = 0; x < width; x += 1) {
            const pixel = y * width + x;
            const offset = pixel * 4;
            if (data[offset + 3] < 128) {
              indexed[pixel] = TRANSPARENT_INDEX;
              continue;
            }
            const r = clamp(Math.round(data[offset] + currentR[x + 1]), 0, 255);
            const g = clamp(Math.round(data[offset + 1] + currentG[x + 1]), 0, 255);
            const b = clamp(Math.round(data[offset + 2] + currentB[x + 1]), 0, 255);
            const paletteIndex = nearestColorIndex(palette, [r, g, b]);
            indexed[pixel] = paletteIndex;
            const color = palette[paletteIndex];
            const errorR = r - color[0];
            const errorG = g - color[1];
            const errorB = b - color[2];
            currentR[x + 2] += errorR * 7 / 16;
            currentG[x + 2] += errorG * 7 / 16;
            currentB[x + 2] += errorB * 7 / 16;
            nextR[x] += errorR * 3 / 16;
            nextG[x] += errorG * 3 / 16;
            nextB[x] += errorB * 3 / 16;
            nextR[x + 1] += errorR * 5 / 16;
            nextG[x + 1] += errorG * 5 / 16;
            nextB[x + 1] += errorB * 5 / 16;
            nextR[x + 2] += errorR / 16;
            nextG[x + 2] += errorG / 16;
            nextB[x + 2] += errorB / 16;
          }
          [currentR, nextR] = [nextR, currentR];
          [currentG, nextG] = [nextG, currentG];
          [currentB, nextB] = [nextB, currentB];
        }
        return indexed;
      }

      async function initializeEncoder(message) {
        encoderApi = await import(gifencUrl);
        settings = message.settings;
        mappingPalette = message.mappingPalette;
        globalPalette = message.globalPalette;
        let compressorSource = '';
        if (message.loadCompressor) {
          const module = await import(gifsicleUrl);
          compressorSource = module.default?.tool?.workerLocalUrl || '';
        }
        self.postMessage({ type: 'ready', compressorSource });
      }

      async function encodeFrame(message) {
        const frame = message.frame;
        try {
          const imageData = composeFrame(frame, settings);
          let indexed;
          if (settings.qualityPreset.dither === 'floyd-steinberg') {
            indexed = applyFloydSteinberg(
              imageData.data,
              imageData.width,
              imageData.height,
              mappingPalette,
              encoderApi.nearestColorIndex,
            );
          } else {
            indexed = encoderApi.applyPalette(imageData.data, mappingPalette, 'rgb565');
            for (let pixel = 0; pixel < indexed.length; pixel += 1) {
              if (imageData.data[pixel * 4 + 3] < 128) indexed[pixel] = TRANSPARENT_INDEX;
            }
          }
          const gif = encoderApi.GIFEncoder({ auto: false });
          gif.writeFrame(indexed, settings.outputWidth, settings.outputHeight, {
            first: message.index === 0,
            palette: message.index === 0 ? globalPalette : null,
            transparent: settings.transparentCorners,
            transparentIndex: TRANSPARENT_INDEX,
            delay: message.delay,
            repeat: 0,
            dispose: 1,
          });
          const bytes = gif.bytes();
          self.postMessage({ type: 'frame', id: message.id, index: message.index, bytes }, [bytes.buffer]);
        } finally {
          frame.close();
        }
      }

      self.onmessage = (event) => {
        const message = event.data || {};
        let task = null;
        if (message.type === 'palette') task = buildPalette(message);
        else if (message.type === 'init') task = initializeEncoder(message);
        else if (message.type === 'frame') task = encodeFrame(message);
        if (task) Promise.resolve(task).catch(reportError);
      };
    `;
  }

  function makeResourceModuleUrl(source, urls) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    urls.push(url);
    return url;
  }

  function assembleEncodedGif(chunks) {
    const ordered = orderFrameChunks(chunks);
    const header = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const total = header.byteLength + ordered.reduce((sum, bytes) => sum + bytes.byteLength, 0) + 1;
    const output = new Uint8Array(total);
    output.set(header, 0);
    let offset = header.byteLength;
    for (const bytes of ordered) {
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
    output[offset] = 0x3b;
    return output.buffer;
  }

  function makeWorkerFrameSettings(settings, overrides = {}) {
    return {
      outputWidth: settings.outputWidth,
      outputHeight: settings.outputHeight,
      outputRadius: settings.outputRadius,
      transparentCorners: settings.transparentCorners,
      crop: { ...settings.crop },
      textLayers: settings.textLayers.map((layer) => ({ ...layer })),
      qualityPreset: { ...settings.qualityPreset },
      ...overrides,
    };
  }

  function createEncodingModuleUrls(resources, urls) {
    const modernPaletteUrl = makeResourceModuleUrl(resources.modernPalette, urls);
    const gifencUrl = makeResourceModuleUrl(resources.gifenc, urls);
    const gifsicleUrl = makeResourceModuleUrl(resources.gifsicle, urls);
    const workerUrl = makeResourceModuleUrl(
      makeEncodingWorkerSource(modernPaletteUrl, gifencUrl, gifsicleUrl),
      urls,
    );
    return { modernPaletteUrl, gifencUrl, gifsicleUrl, workerUrl };
  }

  async function createGlobalPalette(settings, frames, moduleUrls) {
    const selected = Array.from(frames || []);
    if (!selected.length) throw new Error('没有可用于调色板的选区画面。');
    const longest = Math.max(settings.outputWidth, settings.outputHeight);
    const sampleScale = Math.min(1, PREVIEW_CACHE_MAX_EDGE / longest);
    const paletteSettings = makeWorkerFrameSettings(settings, {
      outputWidth: Math.max(2, Math.round(settings.outputWidth * sampleScale)),
      outputHeight: Math.max(2, Math.round(settings.outputHeight * sampleScale)),
      outputRadius: Math.max(0, Math.round(settings.outputRadius * sampleScale)),
    });
    const { workerUrl } = moduleUrls;
    const worker = new Worker(workerUrl, { type: 'module', name: 'bella-gif-palette' });
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        worker.terminate();
        if (state.cancelExportPreparation === cancel) state.cancelExportPreparation = null;
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new CancelledError());
      state.cancelExportPreparation = cancel;
      worker.addEventListener('message', (event) => {
        const message = event.data || {};
        if (message.type === 'palette') finish(null, message);
        else if (message.type === 'error') finish(new Error(message.message || '调色板生成失败。'));
      });
      worker.addEventListener('error', (event) => finish(new Error(event.message || '调色板 Worker 运行失败。')));
      worker.postMessage({
        type: 'palette',
        frames: selected,
        settings: paletteSettings,
        preset: settings.qualityPreset,
      }, selected);
    });
  }

  async function createGifEncodingSession(settings, {
    sampleFrames = [],
    preparedPalette = null,
    timeoutMs = ENCODE_TIMEOUT_MS,
  } = {}) {
    const resources = await loadEncodingResourceTexts();
    const urls = [];
    const moduleUrls = createEncodingModuleUrls(resources, urls);
    settings.onPhase?.('palette');
    let paletteResult;
    try {
      paletteResult = preparedPalette || await createGlobalPalette(settings, sampleFrames, moduleUrls);
    } catch (error) {
      urls.forEach((url) => URL.revokeObjectURL(url));
      throw error;
    }
    const { gifencUrl, gifsicleUrl, workerUrl } = moduleUrls;
    const workerCount = calculateEncoderWorkerCount(navigator.hardwareConcurrency);
    const workers = [];
    const activeTasks = new Map();
    const activePromises = new Set();
    const chunks = [];
    let nextTaskId = 1;
    let encodedFrames = 0;
    let finishing = false;
    let compressionWorker = null;
    let compressionWorkerUrl = null;
    let compressorSource = '';
    let settled = false;
    let backpressured = false;
    let resultResolve;
    let resultReject;
    const result = new Promise((resolve, reject) => {
      resultResolve = resolve;
      resultReject = reject;
    });
    result.catch(() => { });
    const stopCompressionWorker = () => {
      compressionWorker?.terminate();
      compressionWorker = null;
      if (compressionWorkerUrl) URL.revokeObjectURL(compressionWorkerUrl);
      compressionWorkerUrl = null;
    };

    const settleError = (error) => {
      if (settled) return;
      settled = true;
      if (backpressured) settings.onBackpressure?.(false);
      backpressured = false;
      const normalized = error instanceof Error ? error : new Error(String(error));
      resultReject(normalized);
      activeTasks.forEach((task) => task.reject(normalized));
      activeTasks.clear();
      stopCompressionWorker();
    };
    const compressGif = async (encoded) => {
      try {
        settings.onPhase?.('compressing');
        if (settled) return;
        if (!compressorSource) throw new Error('GIF 压缩组件接口不完整。');
        compressionWorkerUrl = URL.createObjectURL(new Blob([compressorSource], { type: 'text/javascript' }));
        compressionWorker = new Worker(compressionWorkerUrl, { name: 'bella-gif-compressor' });
        compressionWorker.addEventListener('message', async (event) => {
          if (settled) return;
          const output = event.data;
          if (!output || typeof output === 'string' || !Array.isArray(output) || !output[0]?.file) {
            settleError(new Error(typeof output === 'string' ? output : 'GIF 压缩组件未返回结果。'));
            return;
          }
          const buffer = await new Blob([output[0].file], { type: 'image/gif' }).arrayBuffer();
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resultResolve(new Blob([buffer], { type: 'image/gif' }));
          stopCompressionWorker();
        });
        compressionWorker.addEventListener('error', (event) => {
          settleError(new Error(event.message || 'GIF 压缩 Worker 运行失败。'));
        });
        compressionWorker.postMessage({
          data: [{ file: encoded, name: 'input.gif' }],
          command: [buildGifsicleCommand(settings.qualityPreset)],
          folder: [],
          isStrict: true,
        }, [encoded]);
      } catch (error) {
        settleError(error);
      }
    };
    const timeout = window.setTimeout(() => {
      settleError(new Error('导出超时，请缩短片段或稍后重试。'));
      workers.forEach((item) => item.worker.terminate());
      stopCompressionWorker();
    }, timeoutMs);

    try {
      await Promise.all(Array.from({ length: workerCount }, (_, index) => new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, { type: 'module', name: `bella-gif-encoder-${index + 1}` });
        const item = { worker, inFlight: 0 };
        workers.push(item);
        worker.addEventListener('message', (event) => {
          const message = event.data || {};
          if (message.type === 'ready') {
            if (message.compressorSource) compressorSource = message.compressorSource;
            resolve();
            return;
          }
          if (message.type === 'error') {
            const error = new Error(message.message || '编码失败。');
            reject(error);
            settleError(error);
            return;
          }
          if (message.type !== 'frame') return;
          const task = activeTasks.get(message.id);
          if (!task) return;
          activeTasks.delete(message.id);
          item.inFlight = Math.max(0, item.inFlight - 1);
          chunks.push({ index: message.index, bytes: new Uint8Array(message.bytes) });
          encodedFrames += 1;
          if (finishing) settings.onProgress?.('encoding', encodedFrames, settings.finalFrames);
          task.resolve();
        });
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || '编码 Worker 运行失败。');
          reject(error);
          settleError(error);
        });
        worker.postMessage({
          type: 'init',
          settings: makeWorkerFrameSettings(settings),
          mappingPalette: paletteResult.mappingPalette,
          globalPalette: paletteResult.globalPalette,
          loadCompressor: index === 0,
        });
      })));
      if (!compressorSource) throw new Error('GIF 压缩组件接口不完整。');
    } catch (error) {
      clearTimeout(timeout);
      workers.forEach((item) => item.worker.terminate());
      stopCompressionWorker();
      urls.forEach((url) => URL.revokeObjectURL(url));
      throw error;
    }

    return {
      async addFrame(frame, index, delay) {
        let posted = false;
        try {
          while (!settled) {
            const workerIndex = selectEncoderWorker(workers.map((item) => item.inFlight));
            if (workerIndex >= 0) {
              if (backpressured) settings.onBackpressure?.(false);
              backpressured = false;
              const available = workers[workerIndex];
              const id = nextTaskId++;
              let resolveTask;
              let rejectTask;
              const taskPromise = new Promise((resolve, reject) => {
                resolveTask = resolve;
                rejectTask = reject;
              });
              taskPromise.catch(() => { });
              activePromises.add(taskPromise);
              taskPromise.finally(() => activePromises.delete(taskPromise)).catch(() => { });
              activeTasks.set(id, { resolve: resolveTask, reject: rejectTask });
              available.inFlight += 1;
              available.worker.postMessage({ type: 'frame', id, index, delay, frame }, [frame]);
              posted = true;
              return;
            }
            if (!backpressured) settings.onBackpressure?.(true);
            backpressured = true;
            await Promise.race(activePromises);
          }
          throw new CancelledError();
        } finally {
          if (!posted) {
            try { frame.close(); } catch (_) { }
          }
        }
      },
      async finish() {
        finishing = true;
        settings.onProgress?.('encoding', encodedFrames, settings.finalFrames);
        await Promise.all([...activePromises]);
        if (settled) return result;
        const encoded = assembleEncodedGif(chunks);
        void compressGif(encoded);
        return result;
      },
      cancel(error = new CancelledError()) {
        settleError(error);
        clearTimeout(timeout);
        workers.forEach((item) => item.worker.terminate());
        stopCompressionWorker();
      },
      destroy() {
        clearTimeout(timeout);
        workers.forEach((item) => item.worker.terminate());
        stopCompressionWorker();
        urls.forEach((url) => URL.revokeObjectURL(url));
      },
      palette: Object.freeze({
        mappingPalette: paletteResult.mappingPalette.map((color) => [...color]),
        globalPalette: paletteResult.globalPalette.map((color) => [...color]),
      }),
    };
  }

  function getCurrentCropSourceSize() {
    if (!state.clip) return { width: 0, height: 0, longest: 0 };
    const crop = state.editorCrop || { x: 0, y: 0, w: 1, h: 1 };
    const width = Math.max(2, Math.round((crop.w || 1) * state.clip.width));
    const height = Math.max(2, Math.round((crop.h || 1) * state.clip.height));
    return { width, height, longest: Math.max(width, height) };
  }

  function buildResolutionSteps(longest) {
    const base = Math.max(2, Math.round(longest));
    const ratios = [1, 0.75, 0.5, 1 / 3, 0.25];
    const seen = new Set();
    const steps = [];
    for (const ratio of ratios) {
      let value = Math.max(2, Math.round(base * ratio));
      if (value % 2) value -= 1;
      value = Math.max(2, value);
      if (steps.length > 0) {
        const prev = steps[steps.length - 1];
        if (Math.abs(prev - value) < 24) continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      steps.push(value);
      if (value <= 160) break;
    }
    if (!steps.length) steps.push(base);
    return steps;
  }

  function updateResolutionOptions() {
    if (!el.resolutionSelect) return;
    const previous = Number(el.resolutionSelect.value) || 0;
    const { longest } = getCurrentCropSourceSize();
    el.resolutionSelect.innerHTML = '';
    if (!longest) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = '--';
      el.resolutionSelect.appendChild(opt);
      return;
    }
    const steps = buildResolutionSteps(longest);
    let nextValue = steps[0];
    if (previous > 0) {
      nextValue = steps.reduce((best, cur) => Math.abs(cur - previous) < Math.abs(best - previous) ? cur : best, steps[0]);
    }
    for (const value of steps) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = `${value} px`;
      if (value === nextValue) opt.selected = true;
      el.resolutionSelect.appendChild(opt);
    }
  }

  function readExportSettings() {
    if (!state.clip) throw new Error('没有可导出的片段。');
    const start = state.trimStart;
    const end = state.trimEnd;
    if (end <= start) throw new Error('结束时间必须晚于开始时间。');
    if (end - start < 0.15) throw new Error('片段太短，至少需要 0.15 秒。');

    const fps = Number(el.fpsSelect.value);
    const speed = Number(el.speedSelect.value);
    const quality = Object.hasOwn(GIF_QUALITY_PRESETS, el.qualitySelect.value)
      ? el.qualitySelect.value
      : 'bei';
    const qualityPreset = GIF_QUALITY_PRESETS[quality];
    const cornerRadiusRatio = getCornerRadiusRatio();
    const baseFrames = calculateExportFrameCount(end - start, fps);
    const finalFrames = baseFrames;
    if (finalFrames > MAX_EXPORT_FRAMES) {
      throw new Error('帧数超过上限，请缩短片段或降低帧率。');
    }

    const crop = state.editorCrop;
    const sourceWidth = Math.max(2, crop.w * state.clip.width);
    const sourceHeight = Math.max(2, crop.h * state.clip.height);
    const longestSide = Number(el.resolutionSelect.value) || Math.max(sourceWidth, sourceHeight);
    let outputWidth;
    let outputHeight;
    if (sourceWidth >= sourceHeight) {
      outputWidth = Math.max(2, Math.round(longestSide / 2) * 2);
      outputHeight = Math.max(2, Math.round((outputWidth * sourceHeight / sourceWidth) / 2) * 2);
    } else {
      outputHeight = Math.max(2, Math.round(longestSide / 2) * 2);
      outputWidth = Math.max(2, Math.round((outputHeight * sourceWidth / sourceHeight) / 2) * 2);
    }

    const outputRadius = getCornerRadiusPixels(outputWidth, outputHeight, cornerRadiusRatio);

    return createExportPlan({
      start,
      end,
      fps,
      speed,
      quality,
      qualityPreset,
      cornerRadiusRatio,
      outputRadius,
      transparentCorners: outputRadius > 0,
      delay: normalizeGifDelay(fps, speed),
      baseFrames,
      finalFrames,
      outputWidth,
      outputHeight,
      crop,
      outputLongestEdge: longestSide,
      textLayers: state.textLayers
        .filter((layer) => String(layer.text || '').trim())
        .map((layer) => ({ ...layer })),
    });
  }

  function makeEstimateSignature(plan) {
    return JSON.stringify([
      state.clipRevision,
      plan.start.toFixed(6), plan.end.toFixed(6), plan.fps,
      plan.outputWidth, plan.outputHeight, plan.quality,
      plan.outputRadius, plan.transparentCorners,
      plan.crop.x.toFixed(6), plan.crop.y.toFixed(6),
      plan.crop.w.toFixed(6), plan.crop.h.toFixed(6),
      plan.textLayers.map((layer) => [
        layer.text, layer.x, layer.y, layer.fontScale,
        layer.textColor, layer.strokeColor, layer.strokeScale,
      ]),
    ]);
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '--';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function formatEstimatedSizeRange(range) {
    if (!range) return '--';
    const minText = formatFileSize(range.min);
    const maxText = formatFileSize(range.max);
    return minText === maxText ? minText : `${minText}～${maxText}`;
  }

  function setEstimatedSizeText(text, title = '', busy = false) {
    if (el.estimatedSize) {
      el.estimatedSize.textContent = text;
      el.estimatedSize.title = title;
      el.estimatedSize.setAttribute('aria-busy', String(busy));
    }
    if (el.actionEstimate) {
      el.actionEstimate.textContent = text;
      el.actionEstimate.setAttribute('aria-busy', String(busy));
    }
  }

  function cancelSizeEstimate({ clearCache = false } = {}) {
    clearTimeout(state.sizeEstimateTimer);
    state.sizeEstimateTimer = 0;
    state.sizeEstimateToken += 1;
    const job = state.sizeEstimateJob;
    if (job) {
      job.cancelled = true;
      job.session?.cancel(new CancelledError());
      if (state.cancelExportPreparation) state.cancelExportPreparation();
    }
    state.sizeEstimateJob = null;
    if (clearCache) state.sizeEstimateCache = null;
  }

  async function estimateExportSize(plan, signature, token) {
    const clip = state.clip;
    if (!clip) throw new CancelledError();
    const windows = createEstimateSampleWindows(plan.frameTimes);
    const sampleTimes = flattenSampleTimes(windows);
    const job = { cancelled: false, session: null, video: null };
    state.sizeEstimateJob = job;
    let frames = null;
    let paletteFrames = [];
    try {
      job.video = await createDetachedClipVideo(clip);
      frames = await captureImageBitmapsAtTimes(
        job.video,
        sampleTimes,
        clip,
        () => job.cancelled || token !== state.sizeEstimateToken,
      );
      paletteFrames = await Promise.all([...frames.values()].map((frame) => createImageBitmap(frame)));
      const reports = [];
      let preparedPalette = null;
      for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
        if (job.cancelled || token !== state.sizeEstimateToken) throw new CancelledError();
        const windowTimes = windows[windowIndex];
        const samplePlan = {
          ...plan,
          frameTimes: windowTimes,
          baseFrames: windowTimes.length,
          finalFrames: windowTimes.length,
        };
        job.session = await createGifEncodingSession(samplePlan, {
          sampleFrames: windowIndex === 0 ? paletteFrames : [],
          preparedPalette,
          timeoutMs: 120_000,
        });
        paletteFrames = [];
        if (job.cancelled || token !== state.sizeEstimateToken) {
          job.session.cancel(new CancelledError());
          throw new CancelledError();
        }
        if (!preparedPalette) preparedPalette = job.session.palette;
        for (let index = 0; index < windowTimes.length; index += 1) {
          const time = windowTimes[index];
          const source = frames.get(Number(time).toFixed(6));
          const frame = new VideoFrame(source, { timestamp: Math.round(time * 1_000_000) });
          await job.session.addFrame(frame, index, plan.delay);
        }
        const blob = await job.session.finish();
        reports.push(inspectGifFrameBytes(await blob.arrayBuffer()));
        job.session.destroy();
        job.session = null;
      }
      const complete = windows.length === 1 && windows[0].length === plan.finalFrames;
      const range = calculateEstimatedSizeRange(reports, plan.finalFrames, complete);
      if (!range || job.cancelled || token !== state.sizeEstimateToken) throw new CancelledError();
      state.sizeEstimateCache = { signature, range, palette: preparedPalette };
      setEstimatedSizeText(
        `预计 ${formatEstimatedSizeRange(range)}`,
        complete ? '根据全部导出帧计算。' : '根据选区内连续画面采样计算。',
      );
    } finally {
      job.session?.destroy();
      for (const frame of paletteFrames) {
        try { frame.close(); } catch (_) { }
      }
      closeImageBitmapMap(frames);
      releaseDetachedClipVideo(clip, job.video);
      if (state.sizeEstimateJob === job) state.sizeEstimateJob = null;
    }
  }

  function updateEstimatedFileSize({ actualBytes = 0 } = {}) {
    if (!el.estimatedSize) return;
    if (actualBytes > 0) {
      setEstimatedSizeText(`实际 ${formatFileSize(actualBytes)}`);
      return;
    }
    if (!state.clip || state.mode !== 'edit' || state.busy) {
      cancelSizeEstimate();
      setEstimatedSizeText('预计 --');
      return;
    }
    let plan;
    try {
      plan = readExportSettings();
    } catch (_) {
      setEstimatedSizeText('预计 --');
      return;
    }
    const signature = makeEstimateSignature(plan);
    if (state.sizeEstimateCache?.signature === signature) {
      setEstimatedSizeText(
        `预计 ${formatEstimatedSizeRange(state.sizeEstimateCache.range)}`,
        '根据选区内连续画面采样计算。',
      );
      return;
    }
    cancelSizeEstimate();
    const token = state.sizeEstimateToken;
    setEstimatedSizeText('预计计算中…', '正在分析选区画面。', true);
    state.sizeEstimateTimer = window.setTimeout(() => {
      state.sizeEstimateTimer = 0;
      estimateExportSize(plan, signature, token).catch((error) => {
        if (token !== state.sizeEstimateToken || error instanceof CancelledError) return;
        setEstimatedSizeText('预计 --', friendlyError(error));
      });
    }, 300);
  }

  function makeFileName(settings) {
    if (IS_LIVE_PAGE) {
      const identity = state.clip.liveIdentity;
      const sourceLabel = `${identity.streamerName}_${identity.roomId}`;
      const firstFrameTime = calculateLiveFirstFrameTime(state.clip.liveWallClockStartMs, settings.start);
      return formatGifFileName(firstFrameTime, sourceLabel);
    }
    const bvid = location.pathname.match(/\/(BV[\w]+)/i)?.[1] || '视频';
    return formatGifFileName(Date.now(), bvid);
  }


  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || '贝报gif.gif';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function generateGif() {
    if (state.mode !== 'edit' || state.busy) return;
    let settings;
    let fileName;
    let encodingSession = null;
    let exportVideo = null;
    let exportClip = null;
    let pendingPaletteFrames = [];
    try {
      settings = readExportSettings();
      fileName = makeFileName(settings);

      cancelSizeEstimate();
      stopTrimPreview();
      pausePreviewFrameCache();
      state.busy = true;
      state.mode = 'exporting';
      state.cancelRequested = false;
      updateModeUi();
      setProgress(0);
      setStatus('正在准备选区色彩……');

      const clip = state.clip;
      exportClip = clip;
      exportVideo = await createDetachedClipVideo(clip);
      state.exportVideo = exportVideo;
      const estimateSignature = makeEstimateSignature(settings);
      let preparedPalette = state.sizeEstimateCache?.signature === estimateSignature
        ? state.sizeEstimateCache.palette
        : null;
      let paletteFrames = [];
      if (!preparedPalette) {
        const paletteTimes = flattenSampleTimes(createEstimateSampleWindows(settings.frameTimes));
        const paletteBitmaps = await captureImageBitmapsAtTimes(
          exportVideo,
          paletteTimes,
          clip,
          () => state.cancelRequested,
        );
        try {
          paletteFrames = await Promise.all([...paletteBitmaps.values()].map((frame) => createImageBitmap(frame)));
        } finally {
          closeImageBitmapMap(paletteBitmaps);
        }
        pendingPaletteFrames = paletteFrames;
      }

      encodingSession = await createGifEncodingSession({
        ...settings,
        onPhase: (phase) => {
          if (phase === 'compressing') {
            setProgress(88);
            setStatus('正在压缩体积……');
          }
        },
        onProgress: (phase, completed, total) => {
          if (phase !== 'encoding') return;
          setProgress(calculateExportProgress('encoding', completed, total));
          setStatus(`正在并行编码：${completed}/${total}`);
        },
        onBackpressure: (full) => {
          if (full) exportVideo.pause();
        },
      }, {
        sampleFrames: paletteFrames,
        preparedPalette,
      });
      paletteFrames = [];
      pendingPaletteFrames = [];
      state.exportEncodingSession = encodingSession;
      if (state.cancelRequested) throw new CancelledError();

      const delay = settings.delay;
      const frameTimes = settings.frameTimes;

      const queueExportFrame = async (index) => {
        if (state.cancelRequested) throw new CancelledError();
        const frame = new VideoFrame(exportVideo, {
          timestamp: Math.round(frameTimes[index] * 1_000_000),
        });
        await encodingSession.addFrame(frame, index, delay);
      };

      const updateExtractionProgress = (count) => {
        setProgress(calculateExportProgress('extracting', count, settings.baseFrames));
        setStatus(`正在提取画面：${count}/${settings.baseFrames}`);
      };

      const extractRemainingPrecisely = async (startIndex) => {
        exportVideo.pause();
        for (let index = startIndex; index < frameTimes.length; index += 1) {
          if (state.cancelRequested) throw new CancelledError();
          await seekVideo(exportVideo, frameTimes[index], clip.duration);
          await queueExportFrame(index);
          updateExtractionProgress(index + 1);
        }
      };

      if (typeof exportVideo.requestVideoFrameCallback === 'function') {
        const extractionPlaybackRate = calculateExtractionPlaybackRate(settings.fps);
        const frameTolerance = 0.5 / settings.fps;
        await seekVideo(exportVideo, frameTimes[0], clip.duration);
        if (state.cancelRequested) throw new CancelledError();

        let extractedFrames = 0;
        await queueExportFrame(extractedFrames);
        extractedFrames = 1;
        updateExtractionProgress(extractedFrames);

        if (extractedFrames < settings.baseFrames) {
          exportVideo.playbackRate = extractionPlaybackRate;
          await new Promise((resolve, reject) => {
            let settled = false;
            let callbackId = 0;
            let timeoutId = 0;

            const cleanup = () => {
              clearTimeout(timeoutId);
              if (callbackId && typeof exportVideo.cancelVideoFrameCallback === 'function') {
                try { exportVideo.cancelVideoFrameCallback(callbackId); } catch (_) { }
              }
              exportVideo.removeEventListener('error', onError);
              exportVideo.removeEventListener('ended', onEnded);
              try { exportVideo.pause(); } catch (_) { }
            };

            const finish = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };

            const fail = (error) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            };

            const onError = () => fail(new Error('视频解码失败。'));
            const onEnded = async () => {
              if (state.cancelRequested) {
                fail(new CancelledError());
                return;
              }
              try {
                clearTimeout(timeoutId);
                timeoutId = 0;
                await extractRemainingPrecisely(extractedFrames);
                finish();
              } catch (error) {
                fail(error);
              }
            };

            const onFrame = async (_now, metadata) => {
              if (settled) return;
              if (state.cancelRequested) {
                fail(new CancelledError());
                return;
              }

              const mediaTime = Number(metadata?.mediaTime);
              const currentTime = Number.isFinite(mediaTime) ? mediaTime : Number(exportVideo.currentTime) || 0;

              try {
                if (extractedFrames >= frameTimes.length) {
                  finish();
                  return;
                }
                const target = frameTimes[extractedFrames];
                if (requiresPreciseFrameSeek(currentTime, target, settings.end, frameTolerance)) {
                  clearTimeout(timeoutId);
                  timeoutId = 0;
                  await extractRemainingPrecisely(extractedFrames);
                  finish();
                  return;
                }
                if (currentTime + frameTolerance < target) {
                  callbackId = exportVideo.requestVideoFrameCallback(onFrame);
                  return;
                }
                await queueExportFrame(extractedFrames);
                extractedFrames += 1;
                updateExtractionProgress(extractedFrames);
                if (extractedFrames >= frameTimes.length) {
                  finish();
                  return;
                }
                if (exportVideo.paused) await exportVideo.play();

                callbackId = exportVideo.requestVideoFrameCallback(onFrame);
              } catch (error) {
                fail(error);
              }
            };

            const expectedMs = ((settings.end - settings.start) / extractionPlaybackRate) * 1000;
            timeoutId = window.setTimeout(
              () => fail(new Error('取帧超时，请重试。')),
              Math.max(15_000, expectedMs + 12_000),
            );

            exportVideo.addEventListener('error', onError, { once: true });
            exportVideo.addEventListener('ended', onEnded, { once: true });
            callbackId = exportVideo.requestVideoFrameCallback(onFrame);
            exportVideo.play().catch((error) => fail(new Error(`无法启动取帧：${error.message || error}`)));
          });
        }
      } else {
        await extractRemainingPrecisely(0);
      }

      if (state.cancelRequested) throw new CancelledError();
      setProgress(calculateExportProgress('encoding', 0, settings.baseFrames));
      setStatus('正在并行编码……');
      const blob = await encodingSession.finish();
      if (state.cancelRequested) throw new CancelledError();

      updateEstimatedFileSize({ actualBytes: blob.size });
      setProgress(100);
      downloadBlob(blob, fileName);
      setStatus(`已导出并下载 · ${formatFileSize(blob.size)}`, 'success');
      showToast(`下载完成 · ${formatFileSize(blob.size)}`, 'success');
    } catch (error) {
      setStatus(friendlyError(error), error instanceof CancelledError ? '' : 'error');
    } finally {
      encodingSession?.destroy();
      for (const frame of pendingPaletteFrames) {
        try { frame.close(); } catch (_) { }
      }
      if (state.exportEncodingSession === encodingSession) state.exportEncodingSession = null;
      if (exportVideo) {
        releaseDetachedClipVideo(exportClip, exportVideo);
        if (state.exportVideo === exportVideo) state.exportVideo = null;
      }
      state.busy = false;
      state.cancelRequested = false;
      state.mode = state.clip ? 'edit' : 'capture';
      updateModeUi();
      if (state.mode === 'edit') updateEditorCropBox();

      if (state.mode === 'edit') void resumePreviewFrameCache();
    }
  }

  function cancelExport() {
    if (state.mode !== 'exporting' || !state.busy) return;
    state.cancelRequested = true;
    setStatus('正在取消导出…');
    pausePreviewFrameCache();
    try { state.exportVideo?.pause(); } catch (_) { }
    state.cancelExportPreparation?.();
    state.exportEncodingSession?.cancel(new CancelledError());
  }

  function friendlyError(error) {
    if (error instanceof CancelledError) return '已取消导出。';
    const message = String(error && (error.message || error));
    if (/taint|cross-origin|cross origin|SecurityError/i.test(message)) {
      return '无法读取视频画面，请刷新页面重试。';
    }
    if (/GIF is not defined|编码库/i.test(message)) {
      return 'GIF 编码组件加载失败，请刷新页面重试。';
    }
    if (/Worker|Content Security Policy|CSP|blob:/i.test(message)) {
      return '编码组件启动失败，请刷新页面重试。';
    }
    return message || '操作失败，请重试。';
  }

  function returnToCaptureStage() {
    if (state.mode !== 'edit' || state.busy) return;
    disposeClip();
    state.mode = 'capture';
    el.panel.classList.add('hidden');
    updateModeUi();
    updatePageSelectionUi();
    setStatus('');
  }

  function handleNewRecording() {
    if (state.mode !== 'edit' || state.busy) return;
    if (IS_LIVE_PAGE && state.liveCaptureMode === 'rewind') {
      void captureLiveRewind();
      return;
    }
    returnToCaptureStage();
  }

  function handlePageRouteChange() {
    const key = currentPageKey();
    if (!state.pageKey) state.pageKey = key;
    else if (state.pageKey !== key && state.mode !== 'recording' && state.mode !== 'exporting') {
      state.pageKey = key;
      disposeClip();
      clearPageSelection({ keepStatus: true });
      state.mode = 'capture';
      el.panel.classList.add('hidden');
      updateModeUi();
    }
    invalidateMainVideo();
  }

  function updateLiveRewindTitle(status = null) {
    if (!IS_LIVE_PAGE || !el.liveRewindModeBtn) return;
    const video = getMainVideo();
    liveMediaCollector?.setActiveVideo(video);
    const currentStatus = status || liveMediaCollector?.getStatus(video);
    const seconds = Math.max(0, Number(currentStatus?.duration) || 0);
    el.liveRewindModeBtn.title = state.liveCaptureMode === 'rewind'
      ? `已缓存 ${seconds.toFixed(1)} 秒`
      : '切换后开始缓存直播画面';
  }

  function scheduleViewportSync(resized = false) {
    state.viewportNeedsResize ||= resized;
    if (state.viewportSyncRaf) return;
    state.viewportSyncRaf = requestAnimationFrame(() => {
      state.viewportSyncRaf = 0;
      const shouldFit = state.viewportNeedsResize;
      state.viewportNeedsResize = false;
      if (shouldFit) keepFloatingUiInViewport();
      updatePageSelectionBoundary();
      updatePageSelectionUi();
      if (!shouldFit) updateEditorCropBox();
    });
  }

  function handleExportInputChange(event) {
    saveExportPreference(event?.currentTarget);
    if (state.mode === 'edit' && state.clip) {
      if (state.trimPreviewCleanup && el.speedSelect) {
        el.clipVideo.playbackRate = Math.max(0.1, Number(el.speedSelect.value) || 1);
      }
      renderExportPreviewFrame();
    }
    updateEstimatedFileSize();
  }

  const videoObserver = new MutationObserver((records) => {
    const changed = records.some((record) => {
      if (record.type === 'attributes') {
        return record.target instanceof HTMLVideoElement || record.target instanceof HTMLSourceElement;
      }
      return [...record.addedNodes, ...record.removedNodes].some((node) => (
        node instanceof HTMLVideoElement || node.querySelector?.('video')
      ));
    });
    if (changed) invalidateMainVideo();
  });

  const handleVideoIdentityChange = (event) => {
    if (event.target instanceof HTMLVideoElement) invalidateMainVideo();
  };

  el.launcher.addEventListener('pointerdown', handleLauncherPointerDown);
  el.launcher.addEventListener('pointermove', handleLauncherPointerMove);
  el.launcher.addEventListener('pointerup', (event) => finishLauncherPointer(event, false));
  el.launcher.addEventListener('pointercancel', (event) => finishLauncherPointer(event, true));
  el.launcher.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleLauncherAction();
    }
  });

  el.header.addEventListener('pointerdown', handlePanelHeaderPointerDown);
  el.header.addEventListener('pointermove', handlePanelHeaderPointerMove);
  el.header.addEventListener('pointerup', finishPanelHeaderDrag);
  el.header.addEventListener('pointercancel', finishPanelHeaderDrag);
  el.panelResizeHandles.forEach((handle) => {
    handle.addEventListener('pointerdown', handlePanelResizePointerDown);
    handle.addEventListener('pointermove', handlePanelResizePointerMove);
    handle.addEventListener('pointerup', (event) => finishPanelResize(event, false));
    handle.addEventListener('pointercancel', (event) => finishPanelResize(event, true));
    handle.addEventListener('keydown', handlePanelResizeKeyDown);
  });

  el.closeBtn.addEventListener('click', closePanel);
  el.selectAreaBtn.addEventListener('click', beginPageSelection);
  el.clearAreaBtn.addEventListener('click', () => {
    if (state.mode === 'recording' || state.mode === 'exporting') return;
    clearPageSelection();
  });
  el.recordBtn.addEventListener('click', startRecording);
  el.selectionRecordBtn.addEventListener('click', startRecording);
  el.selectionReselectBtn.addEventListener('click', beginPageSelection);
  el.selectionClearBtn.addEventListener('click', () => clearPageSelection());
  el.hudStopBtn.addEventListener('click', () => stopRecording('manual'));

  el.pageSelectCancel.addEventListener('click', (event) => {
    event.stopPropagation();
    finishPageSelection(true);
  });
  el.pageSelectOverlay.addEventListener('pointerdown', handlePageSelectPointerDown);
  el.pageSelectOverlay.addEventListener('pointermove', handlePageSelectPointerMove);
  el.pageSelectOverlay.addEventListener('pointerup', handlePageSelectPointerUp);
  el.pageSelectOverlay.addEventListener('pointercancel', () => {
    const session = state.pageSelectionSession;
    if (session) session.drag = null;
    el.pageSelectBox.style.display = 'none';
  });

  el.pageSelectionMarker.addEventListener('pointerdown', handlePageMarkerPointerDown);
  el.pageSelectionMarker.addEventListener('pointermove', handlePageMarkerPointerMove);
  el.pageSelectionMarker.addEventListener('pointerup', finishPageMarkerAdjustment);
  el.pageSelectionMarker.addEventListener('pointercancel', finishPageMarkerAdjustment);

  el.editorCropBox.addEventListener('pointerdown', handleEditorCropPointerDown);
  el.editorCropBox.addEventListener('pointermove', handleEditorCropPointerMove);
  el.editorCropBox.addEventListener('pointerup', finishEditorCropAdjustment);
  el.editorCropBox.addEventListener('pointercancel', finishEditorCropAdjustment);

  el.timelineTrack.addEventListener('pointerdown', handleTimelinePointerDown);
  el.timelineTrack.addEventListener('pointermove', handleTimelinePointerMove);
  el.timelineTrack.addEventListener('pointerup', finishTimelineDrag);
  el.timelineTrack.addEventListener('pointercancel', finishTimelineDrag);

  el.previewTrimBtn.addEventListener('click', previewTrimmedClip);
  el.liveRewindModeBtn.addEventListener('click', () => setLiveCaptureMode('rewind'));
  el.liveForwardModeBtn.addEventListener('click', () => setLiveCaptureMode('forward'));
  el.aspectSquareBtn.addEventListener('click', toggleAspectSquare);
  el.addTextBtn.addEventListener('click', addTextLayer);
  el.textLayerTabs.addEventListener('click', (event) => {
    const remove = event.target.closest?.('[data-delete-text-id]');
    if (remove?.dataset?.deleteTextId) {
      event.preventDefault();
      event.stopPropagation();
      deleteTextLayerById(remove.dataset.deleteTextId);
      return;
    }
    const button = event.target.closest?.('[data-text-id]');
    if (button?.dataset?.textId) selectTextLayer(button.dataset.textId);
  });
  [el.captionText, el.fontScale, el.textColor, el.strokeColor, el.strokeScale].forEach((input) => {
    input.addEventListener('input', updateActiveTextLayerFromControls);
    input.addEventListener('change', updateActiveTextLayerFromControls);
  });
  el.textColorSwatches.forEach((button) => {
    button.addEventListener('click', () => {
      el.textColor.value = button.dataset.textColor;
      updateActiveTextLayerFromControls();
    });
  });
  el.captionLayer.addEventListener('pointerdown', handleTextLayerPointerDown);
  el.captionLayer.addEventListener('pointermove', handleTextLayerPointerMove);
  el.captionLayer.addEventListener('pointerup', finishTextLayerDrag);
  el.captionLayer.addEventListener('pointercancel', finishTextLayerDrag);
  el.clipVideo.addEventListener('timeupdate', updateTimelinePlayhead);
  el.clipVideo.addEventListener('timeupdate', () => {
    if (state.timelineDrag) {
      if (state.timelineDrag.type === 'playhead') renderTimelinePreviewIfCurrent(el.clipVideo);
      return;
    }
    renderExportPreviewFrame();
  });
  el.clipVideo.addEventListener('loadeddata', () => {
    fitCropIntoPreview();
    updateEditorCropBox();
    updateTimelinePlayhead();
    renderExportPreviewFrame();
    updateEstimatedFileSize();
  });
  el.clipVideo.addEventListener('resize', () => {
    fitCropIntoPreview();
    updateEditorCropBox();
  });
  el.scrubVideo.addEventListener('loadeddata', () => renderExportPreviewFrame());
  el.scrubVideo.addEventListener('seeked', () => {
    if (state.timelineDrag) renderTimelinePreviewIfCurrent(el.scrubVideo);
  });

  el.newRecordingBtn.addEventListener('click', handleNewRecording);
  el.generateBtn.addEventListener('click', generateGif);
  el.cancelExportBtn.addEventListener('click', cancelExport);
  $$('.export-input').forEach((input) => input.addEventListener('input', handleExportInputChange));
  $$('.export-input').forEach((input) => input.addEventListener('change', handleExportInputChange));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.pageSelectionSession) {
        event.preventDefault();
        finishPageSelection(true);
        return;
      }
      if (state.pageAdjustSession) {
        event.preventDefault();
        state.pageAdjustSession = null;
        updatePageSelectionUi();
        return;
      }
    }
  }, true);

  window.addEventListener('resize', () => scheduleViewportSync(true));
  window.addEventListener('scroll', () => scheduleViewportSync(false), true);

  window.addEventListener('beforeunload', () => {
    discardEditorBackgroundIntent();
    clearEditorViewportAnimation();
    if (state.viewportSyncRaf) cancelAnimationFrame(state.viewportSyncRaf);
    if (state.panelLayoutRaf) cancelAnimationFrame(state.panelLayoutRaf);
    cancelEditorPreviewRender();
    stopTrimPreview();
    releasePreviewFrameCache();
    cancelSizeEstimate({ clearCache: true });
    cleanupRecordingResources(state.recording);
    state.exportEncodingSession?.destroy();
    if (state.exportVideo) releaseDetachedClipVideo(state.clip, state.exportVideo);
    state.cancelExportPreparation?.();
    if (state.clip?.attachments) {
      for (const video of [...state.clip.attachments.keys()]) cleanupClipAttachment(state.clip, video);
    }
    if (state.clip?.url) URL.revokeObjectURL(state.clip.url);
    liveMediaCollector?.dispose();
    videoObserver.disconnect();
    document.removeEventListener('loadedmetadata', handleVideoIdentityChange, true);
    document.removeEventListener('emptied', handleVideoIdentityChange, true);
    pageWindow.navigation?.removeEventListener('currententrychange', handlePageRouteChange);
  });

  restoreExportPreferences();
  state.preferredPanelGeometry = readSavedPanelGeometry();
  liveMediaCollector?.setEnabled(state.liveCaptureMode === 'rewind');
  liveMediaCollector?.setStatusListener((status) => updateLiveRewindTitle(status));
  restoreLauncherPosition();
  renderTextLayerTabs();
  renderTextLayers();
  videoObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  document.addEventListener('loadedmetadata', handleVideoIdentityChange, true);
  document.addEventListener('emptied', handleVideoIdentityChange, true);
  pageWindow.navigation?.addEventListener('currententrychange', handlePageRouteChange);
  updateModeUi();
  handlePageRouteChange();
  }

  if (document.documentElement && document.body) startApp();
  else document.addEventListener('DOMContentLoaded', startApp, { once: true });
})();
