'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
const marker = "\n  const IS_LIVE_PAGE = location.hostname === 'live.bilibili.com';";
const exportNames = [
  'DEFAULT_SHORTCUT',
  'GIF_QUALITY_PRESETS',
  'LiveRewindTrack',
  'CancelledError',
  'buildGifsicleCommand',
  'calculateCropViewport',
  'calculateEncoderWorkerCount',
  'calculateInnerOverlayPosition',
  'calculateLiveFirstFrameTime',
  'calculatePanelResize',
  'calculateTimelineDraggedViewport',
  'calculateTimelineDragTime',
  'calculateTimelinePlaybackTarget',
  'calculateTimelinePosition',
  'calculateTimelineSelectionViewport',
  'calculateTimelineTime',
  'calculateTimelineViewport',
  'calculateViewportTransitionTransform',
  'constrainPanelGeometry',
  'createExportFrameSourceFromMediaApi',
  'createExportTiming',
  'createTimelineSeekGate',
  'extractLiveRoomId',
  'filterLiveInitToTrack',
  'filterLiveMediaToTrack',
  'formatGifFileName',
  'formatLiveGifFileName',
  'formatShortcut',
  'installLiveMediaCollector',
  'isEditableShortcutEvent',
  'isLiveFrameMessage',
  'mapLiveFrameVideoRect',
  'matchesShortcut',
  'normalizeShortcut',
  'normalizeFrameTargetTimes',
  'orderFrameChunks',
  'parseLiveInit',
  'parseLiveMedia',
  'readIsoBoxes',
  'selectEncoderWorker',
  'shortcutFromKeyboardEvent',
  'toVideoOnlyMimeType',
];

if (!source.includes(marker)) throw new Error('无法定位用户脚本测试入口。');
const injected = source.replace(
  marker,
  `\n  globalThis.__bellaGifTestApi = { ${exportNames.join(', ')} };\n  return;${marker}`,
);
vm.runInThisContext(injected, { filename: userscriptPath });
module.exports = globalThis.__bellaGifTestApi;
delete globalThis.__bellaGifTestApi;
