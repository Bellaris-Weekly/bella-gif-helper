'use strict';

const PREVIEW_CACHE_BYTES = 24 * 1024 * 1024;
const PREVIEW_MAX_EDGE = 320;

// The export plan supplies both order and delay; the preview only owns its clock.
function createLoopPreviewClock(plan) {
  const ends = [];
  let duration = 0;
  for (const frame of plan) ends.push(duration += frame.delay);
  let elapsed = 0;
  let previous = null;
  let running = false;
  const sample = (now) => {
    if (running && previous !== null) elapsed = (elapsed + Math.max(0, now - previous)) % duration;
    previous = now;
    let index = 0;
    while (index < ends.length - 1 && elapsed >= ends[index]) index += 1;
    return {
      frame: plan[index], index, elapsed, duration,
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

async function prepareLoopPreviewFrames({ clip, frameTimes, createSource, signal, createBitmap = createImageBitmap }) {
  const frames = [];
  let source = null;
  let disposed = false;
  const closeFrames = () => {
    for (const frame of frames) frame.close();
    frames.length = 0;
  };
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
    let size;
    for await (const decoded of source.framesAt(frameTimes, { signal })) {
      let bitmap;
      try {
        checkCancelled();
        if (!size) {
          const width = decoded.frame.displayWidth || clip.width;
          const height = decoded.frame.displayHeight || clip.height;
          const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height),
            Math.sqrt(PREVIEW_CACHE_BYTES / (frameTimes.length * width * height * 4)));
          size = { resizeWidth: Math.max(1, Math.floor(width * scale)),
            resizeHeight: Math.max(1, Math.floor(height * scale)), resizeQuality: 'low' };
        }
        bitmap = await createBitmap(decoded.frame, size);
        checkCancelled();
        frames.push(bitmap);
        bitmap = null;
      } finally {
        bitmap?.close();
        decoded.frame.close();
      }
    }
    checkCancelled();
    if (frames.length !== frameTimes.length) throw new Error('循环预览画面不完整。');
    return {
      frames,
      dispose() {
        if (disposed) return;
        disposed = true;
        closeFrames();
      },
    };
  } catch (error) {
    closeFrames();
    throw error;
  } finally {
    signal.removeEventListener('abort', disposeSource);
    disposeSource();
  }
}

module.exports = { createLoopPreviewClock, prepareLoopPreviewFrames };
