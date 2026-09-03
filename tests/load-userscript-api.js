'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
// 产物由 esbuild 生成后不再保留源码的精确引号与 const 形态，这里用宽松匹配
// 定位「库区 / 应用区」的分界声明。T8.1 会把纯函数拆成可 require 的模块，
// 届时本 vm hack 会被删除。
const marker = /\b(?:const|var) IS_LIVE_PAGE = location\.hostname === ["']live\.bilibili\.com["'];/;
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

if (!marker.test(source)) throw new Error('无法定位用户脚本测试入口。');
const injected = source.replace(
  marker,
  (match) => `\n  globalThis.__bellaGifTestApi = { ${exportNames.join(', ')} };\n  return;${match}`,
);
vm.runInThisContext(injected, { filename: userscriptPath });
module.exports = globalThis.__bellaGifTestApi;
delete globalThis.__bellaGifTestApi;
