'use strict';

// 循环效果（往返 / 淡入淡出）预览：按导出帧计划播放一份解码缓存。
//
// 缓存只覆盖当前裁剪区，尺寸按预览框实际显示像素决定（maxEdge），不按整幅原片缩小。
// 两档存储：
// - raw：位图总量不超过 rawBudgetBytes 时直接保留 ImageBitmap；
// - compressed：否则每帧压成 JPEG 存 Blob，播放时只把即将用到的少量帧解成位图（window）。
// 解码是渐进的：每就绪一帧回调 onFrame，播放时钟遇到未就绪的帧会停在上一帧等待，
// 所以第一帧到手就能开始播放，不必等整段解完。

const RAW_BUDGET_BYTES = 64 * 1024 * 1024;
const COMPRESSED_BUDGET_BYTES = 96 * 1024 * 1024;
const COMPRESSED_BYTES_PER_PIXEL = 0.35; // JPEG q≈0.85 对视频画面的保守估计
const PREVIEW_MAX_EDGE = 960;
const PREVIEW_MIN_EDGE = 240;
const DECODED_WINDOW = 12;
const MAX_PENDING_DECODES = 3;

// The export plan supplies both order and delay; the preview only owns its clock.
// isReady(index) 返回 false 时，时钟停在该帧之前，返回 waiting: true。
const HOLD_MS = 0.001;

function createLoopPreviewClock(plan, { isReady = null } = {}) {
  const ends = [];
  let duration = 0;
  for (const frame of plan) ends.push(duration += frame.delay);
  let elapsed = 0;
  let previous = null;
  let running = false;
  let waiting = false;
  const indexAt = (time) => {
    let index = 0;
    while (index < ends.length - 1 && time >= ends[index]) index += 1;
    return index;
  };
  const advance = (delta) => {
    if (!isReady) {
      elapsed = (elapsed + delta) % duration;
      waiting = false;
      return;
    }
    let index = indexAt(elapsed);
    if (!isReady(index)) {
      waiting = true;
      return;
    }
    let next = elapsed + delta;
    const followingOf = (value) => (value + 1 < plan.length ? value + 1 : 0);
    // 逐帧走过这一步会跨入的帧；遇到没就绪的帧就停在它前面。
    for (let guard = 0; guard <= plan.length && next >= ends[index]; guard += 1) {
      const following = followingOf(index);
      if (!isReady(following)) {
        next = Math.max(elapsed, ends[index] - HOLD_MS);
        break;
      }
      if (following === 0) {
        next -= duration;
        elapsed -= duration;
      }
      index = following;
    }
    elapsed = Math.max(0, next) % duration;
    // 停在等待边界上（包括零时间增量的重复采样）都算等待中。
    waiting = elapsed >= ends[index] - HOLD_MS * 1.5 && !isReady(followingOf(index));
  };
  const sample = (now) => {
    if (running && previous !== null) advance(Math.max(0, now - previous));
    else if (isReady) waiting = !isReady(indexAt(elapsed));
    previous = now;
    const index = indexAt(elapsed);
    return {
      frame: plan[index], index, elapsed, duration, waiting,
      reverse: index > 0 && plan[index].sourceIndex < plan[index - 1].sourceIndex,
    };
  };
  return {
    sample,
    setRunning(value, now) {
      sample(now);
      running = value;
    },
  };
}

function fullRegion() {
  return { x: 0, y: 0, w: 1, h: 1 };
}

function normalizeRegion(region) {
  const r = region || fullRegion();
  const x = Math.min(1, Math.max(0, Number(r.x) || 0));
  const y = Math.min(1, Math.max(0, Number(r.y) || 0));
  const w = Math.min(1 - x, Math.max(1e-4, Number(r.w) || 1));
  const h = Math.min(1 - y, Math.max(1e-4, Number(r.h) || 1));
  return { x, y, w, h };
}

// 根据裁剪区原始像素、显示尺寸和帧数，决定缓存尺寸与存储档位。
function planPreviewStorage({ sourceWidth, sourceHeight, region, frameCount, maxEdge = PREVIEW_MAX_EDGE,
  rawBudgetBytes = RAW_BUDGET_BYTES, compressedBudgetBytes = COMPRESSED_BUDGET_BYTES }) {
  const rect = {
    sx: Math.floor(region.x * sourceWidth),
    sy: Math.floor(region.y * sourceHeight),
    sw: Math.max(1, Math.round(region.w * sourceWidth)),
    sh: Math.max(1, Math.round(region.h * sourceHeight)),
  };
  rect.sw = Math.min(rect.sw, sourceWidth - rect.sx);
  rect.sh = Math.min(rect.sh, sourceHeight - rect.sy);
  const edge = Math.max(PREVIEW_MIN_EDGE, Math.min(PREVIEW_MAX_EDGE, Math.round(maxEdge) || PREVIEW_MAX_EDGE));
  let scale = Math.min(1, edge / Math.max(rect.sw, rect.sh));
  const pixels = () => Math.max(1, Math.floor(rect.sw * scale)) * Math.max(1, Math.floor(rect.sh * scale));
  const count = Math.max(1, frameCount);
  let mode = 'raw';
  if (pixels() * 4 * count > rawBudgetBytes) {
    mode = 'compressed';
    const estimate = pixels() * COMPRESSED_BYTES_PER_PIXEL * count;
    if (estimate > compressedBudgetBytes) scale *= Math.sqrt(compressedBudgetBytes / estimate);
  }
  return {
    mode,
    rect,
    size: {
      resizeWidth: Math.max(1, Math.floor(rect.sw * scale)),
      resizeHeight: Math.max(1, Math.floor(rect.sh * scale)),
      resizeQuality: 'medium',
    },
  };
}

async function defaultEncodeBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

function defaultCreateBitmap(frame, options) {
  return createImageBitmap(frame, options.sx, options.sy, options.sw, options.sh, {
    resizeWidth: options.resizeWidth,
    resizeHeight: options.resizeHeight,
    resizeQuality: options.resizeQuality,
  });
}

// 按帧序号存取的缓存。raw 档永不淘汰；compressed 档按 request() 的需求解码并淘汰窗口外的位图。
function createPreviewFrameStore({ count, region, decodeBlob, onDecoded, window = DECODED_WINDOW }) {
  const bitmaps = new Array(count).fill(null);
  const blobs = new Array(count).fill(null);
  const pending = new Map();
  let mode = 'raw';
  let filled = 0;
  let disposed = false;
  let wanted = new Set();
  let order = [];

  const closeBitmap = (index) => {
    const bitmap = bitmaps[index];
    bitmaps[index] = null;
    try { bitmap?.close(); } catch (_) { /* already closed */ }
  };

  function evict() {
    if (mode !== 'compressed') return;
    order = order.filter((index) => bitmaps[index]);
    while (order.length > window) {
      const victim = order.find((index) => !wanted.has(index));
      if (victim === undefined) break;
      order.splice(order.indexOf(victim), 1);
      closeBitmap(victim);
    }
  }

  function decode(index) {
    const job = Promise.resolve()
      .then(() => decodeBlob(blobs[index]))
      .then((bitmap) => {
        pending.delete(index);
        if (disposed || bitmaps[index] || !blobs[index]) {
          bitmap.close();
          return;
        }
        bitmaps[index] = bitmap;
        order.push(index);
        evict();
        onDecoded?.(index);
      }, () => { pending.delete(index); });
    pending.set(index, job);
  }

  return {
    count,
    region,
    get mode() { return mode; },
    get filled() { return filled; },
    get complete() { return filled === count; },
    setMode(next) { mode = next; },
    has: (index) => Boolean(bitmaps[index]),
    get: (index) => bitmaps[index] || null,
    stored: (index) => Boolean(bitmaps[index] || blobs[index]),
    putBitmap(index, bitmap) {
      if (disposed) { bitmap.close(); return; }
      bitmaps[index] = bitmap;
      filled += 1;
    },
    putBlob(index, blob) {
      if (disposed) return;
      blobs[index] = blob;
      filled += 1;
    },
    // 声明接下来要用的帧：compressed 档会解码缺的帧，并把窗口外的位图释放掉。
    request(indices) {
      if (disposed || mode !== 'compressed') return;
      wanted = new Set(indices);
      for (const index of indices) {
        if (pending.size >= MAX_PENDING_DECODES) break;
        if (index < 0 || index >= count || bitmaps[index] || !blobs[index] || pending.has(index)) continue;
        decode(index);
      }
      evict();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let index = 0; index < count; index += 1) closeBitmap(index);
      blobs.fill(null);
    },
  };
}

async function prepareLoopPreviewFrames({
  clip, frameTimes, createSource, signal,
  createBitmap = defaultCreateBitmap,
  encodeBitmap = defaultEncodeBitmap,
  decodeBlob = (blob) => createImageBitmap(blob),
  region = null,
  maxEdge = PREVIEW_MAX_EDGE,
  rawBudgetBytes = RAW_BUDGET_BYTES,
  compressedBudgetBytes = COMPRESSED_BUDGET_BYTES,
  onFrame = null,
  onDecoded = null,
}) {
  const store = createPreviewFrameStore({
    count: frameTimes.length,
    region: normalizeRegion(region),
    decodeBlob,
    onDecoded,
  });
  let source = null;
  const disposeSource = () => {
    const owned = source;
    source = null;
    owned?.dispose();
  };
  const checkCancelled = () => {
    if (signal.aborted) throw new DOMException('预览已取消', 'AbortError');
  };
  signal.addEventListener('abort', disposeSource, { once: true });
  try {
    checkCancelled();
    source = await createSource(clip);
    checkCancelled();
    let storage;
    for await (const decoded of source.framesAt(frameTimes, { signal })) {
      let bitmap;
      try {
        checkCancelled();
        if (!storage) {
          storage = planPreviewStorage({
            sourceWidth: decoded.frame.displayWidth || clip.width,
            sourceHeight: decoded.frame.displayHeight || clip.height,
            region: store.region,
            frameCount: frameTimes.length,
            maxEdge,
            rawBudgetBytes,
            compressedBudgetBytes,
          });
          store.setMode(storage.mode);
        }
        bitmap = await createBitmap(decoded.frame, { ...storage.rect, ...storage.size });
        checkCancelled();
        const index = decoded.index ?? store.filled;
        if (storage.mode === 'raw') {
          store.putBitmap(index, bitmap);
          bitmap = null;
        } else {
          const blob = await encodeBitmap(bitmap);
          checkCancelled();
          store.putBlob(index, blob);
        }
      } finally {
        bitmap?.close();
        decoded.frame.close();
      }
      onFrame?.(store);
    }
    checkCancelled();
    if (!store.complete) throw new Error('循环预览画面不完整。');
    return store;
  } catch (error) {
    store.dispose();
    throw error;
  } finally {
    signal.removeEventListener('abort', disposeSource);
    disposeSource();
  }
}

module.exports = {
  createLoopPreviewClock,
  createPreviewFrameStore,
  planPreviewStorage,
  prepareLoopPreviewFrames,
};
