// ==UserScript==
// @name         贝报 GIF 助手
// @namespace    https://www.bk0717.com/
// @version      0.6.8
// @description  B站视频框选录制与 GIF 编辑；
// @author       贝极星周报
// @icon         https://i0.hdslb.com/bfs/garb/item/70de4619ce5e8a7b5bbe5c4124aa69353d8102e4.png
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/cheese/play/*
// @match        https://m.bilibili.com/video/*
// @require      https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js
// @resource     GIF_WORKER https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js
// @grant        GM_getResourceText
// @run-at       document-idle
// @noframes
// ==/UserScript==

// GIF 编码使用 Johan Nordberg 的 gif.js 0.2.0（MIT License）。

(() => {
  'use strict';

  const SCRIPT_NAME = '贝报 GIF 助手';
  const RECORD_FPS = 24;
  const RECORD_MAX_WIDTH = 720;
  const MAX_RECORD_SECONDS = 60;
  const MAX_EXPORT_FRAMES = 900;
  const ENCODE_TIMEOUT_MS = 600_000;
  const MIN_SELECT_PX = 24;
  const TRANSPARENT_KEY_COLOR = '#ff00fe';
  const TRANSPARENT_KEY_RGB = 0xff00fe;
  const LAUNCHER_POSITION_KEY = 'biliGifMakerLauncherPositionV1';
  const PANEL_POSITION_KEY = 'biliGifMakerPanelPositionV1';
  const UI_SAFE_MARGIN = 14;
    const state = {
    mode: 'capture',
    busy: false,
    pageKey: '',
    pageSelection: null,
    pageSelectionSession: null,
    pageAdjustSession: null,
    editorCropSession: null,
    timelineDrag: null,
    recording: null,
    clip: null,
    editorCrop: { x: 0, y: 0, w: 1, h: 1 },
    aspectSquare: true,
    trimStart: 0,
    trimEnd: 0,
    trimPreviewCleanup: null,
    gif: null,
    workerUrl: null,
    launcherDrag: null,
    panelDrag: null,
    suppressLauncherClick: false,
    textLayers: [],
    activeTextId: null,
    textLayerDrag: null,
    nextTextLayerId: 1,
    toastTimer: 0,
    sizeEstimateCalibration: 1,
    sizeEstimateTimer: 0,
    sizeEstimateToken: 0,
    sizeEstimateGif: null,
    lastSampleEstimate: null,
    previewSnapshot: null,
    cancelRequested: false,
  };

  const host = document.createElement('div');
  host.id = 'bili-gif-maker-host';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      }
      * { box-sizing: border-box; }
      button, input, select, textarea { font: inherit; }
      button { -webkit-tap-highlight-color: transparent; }
      .hidden { display: none !important; }

      #launcher {
        position: fixed;
        right: 18px;
        bottom: 120px;
        z-index: 2147483638;
        width: 54px;
        height: 54px;
        border: 0;
        border-radius: 17px;
        overflow: hidden;
        background-image: url('https://i0.hdslb.com/bfs/garb/item/70de4619ce5e8a7b5bbe5c4124aa69353d8102e4.png');
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
        cursor: grab;
        touch-action: none;
        user-select: none;
        transition: transform .15s ease, filter .15s ease;
      }
      #launcher:hover { transform: translateY(-2px); filter: brightness(1.05); }
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
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 18px;
        background: rgba(24, 25, 29, .985);
        color: #f5f6f7;
        box-shadow: 0 24px 78px rgba(0,0,0,.48);
        backdrop-filter: blur(18px);
      }
      .header {
        position: relative;
        z-index: 10;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 50px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        background: rgba(24, 25, 29, .985);
        user-select: none;
        touch-action: none;
      }
      .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 850; font-size: 15px; }
      #stageBadge {
        flex: 0 0 auto;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(251,114,153,.16);
        color: #ff9db9;
        font-size: 11px;
        font-weight: 750;
      }
      #stageBadge { display: none; }
      .icon-btn {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 11px;
        background: rgba(255,255,255,.08);
        color: #fff;
        font-size: 18px;
        cursor: pointer;
      }
      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
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
        gap: 7px;
        padding: 8px 10px 0;
      }
      #editorPreviewWrap {
        position: relative;
        display: grid;
        place-items: center;
        width: min(100%, 360px);
        justify-self: center;
        aspect-ratio: 1 / 1;
        height: auto;
        overflow: hidden;
        border-radius: 14px;
        background: #000;
        user-select: none;
        touch-action: none;
      }
      #clipVideo, #scrubVideo {
        display: block;
        width: auto;
        height: auto;
        max-width: 100%;
        max-height: 100%;
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
        background: #000;
      }
      #clipVideo { position: relative; z-index: 0; }
      #scrubVideo {
        position: absolute;
        left: 50%;
        top: 50%;
        z-index: 1;
        transform: translate(-50%, -50%);
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
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 10px;
        background: rgba(24,25,29,.78);
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
        backdrop-filter: blur(10px);
      }
      #aspectSquareBtn:hover { background: rgba(45,46,51,.92); }
      #aspectSquareBtn.active {
        border-color: #fb7299;
        background: #fb7299;
        color: #fff;
        box-shadow: 0 4px 16px rgba(251,114,153,.3);
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
        border: 2px solid #fb7299;
        border-radius: 6px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,.36), 0 0 0 1px rgba(0,0,0,.42) inset;
        pointer-events: auto;
        cursor: move;
        touch-action: none;
      }
      #roundedCropGuide {
        position: absolute;
        inset: var(--rounded-guide-inset, 6px);
        z-index: 1;
        display: none;
        border: 1px solid rgba(255,255,255,.84);
        border-radius: var(--rounded-guide-radius, 0px);
        box-shadow: 0 0 0 1px rgba(0,0,0,.28);
        pointer-events: none;
      }
      #editorCropBox.rounded-guide-active #roundedCropGuide { display: block; }
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
        background: #fb7299;
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

      .trim-block {
        padding: 7px 8px 6px;
        border-radius: 12px;
        background: rgba(255,255,255,.05);
      }
      #timelineTrack {
        position: relative;
        height: 30px;
        margin: 0 7px;
        cursor: pointer;
        touch-action: none;
      }
      #timelineRail {
        position: absolute;
        left: 0; right: 0; top: 12px;
        height: 6px;
        border-radius: 999px;
        background: rgba(255,255,255,.13);
        box-shadow: inset 0 1px 2px rgba(0,0,0,.32);
      }
      #timelineSelected {
        position: absolute;
        top: 12px;
        height: 6px;
        border-radius: 999px;
        background: linear-gradient(90deg, #fb7299, #ffbad0);
        pointer-events: none;
      }
      #timelinePlayhead {
        position: absolute;
        top: 5px;
        width: 2px;
        height: 20px;
        border-radius: 99px;
        background: #fff;
        box-shadow: 0 0 0 1px rgba(0,0,0,.3), 0 2px 7px rgba(0,0,0,.4);
        transform: translateX(-1px);
        pointer-events: none;
      }
      .timeline-handle {
        position: absolute;
        top: 3px;
        z-index: 3;
        width: 16px;
        height: 24px;
        margin-left: -8px;
        padding: 0;
        border: 2px solid #fff;
        border-radius: 6px;
        background: #fb7299;
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
        color: #aeb4bf;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      #trimStartValue { text-align: left; color: #ff9db9; }
      #trimSummary { text-align: center; color: #6fd5a7; }
      #trimEndValue { text-align: right; color: #ff9db9; }
      .preview-controls { margin-top: 5px; }
      .preview-controls .btn { min-height: 34px; padding: 0 11px; }

      #editorSettingsScroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        padding: 0 10px 8px;
      }
      #editorSettingsScroll::-webkit-scrollbar { width: 8px; }
      #editorSettingsScroll::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255,255,255,.18);
        background-clip: padding-box;
      }

      .compact-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,.08);
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 7px;
        color: #eef0f3;
        font-size: 13px;
        font-weight: 820;
      }
      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .grid-2.text-options { margin-top: 8px; }
      .grid-2.export-options { margin-top: 10px; }
      .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .field { min-width: 0; }
      .field > label {
        display: block;
        margin-bottom: 5px;
        color: #aeb4bf;
        font-size: 11px;
      }
      .field-hint {
        color: #8ee1b9;
        font-weight: 700;
      }
      select, textarea, input[type="text"] {
        width: 100%;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        outline: none;
        background: rgba(255,255,255,.07);
        color: #fff;
      }
      select, input[type="text"] { height: 36px; padding: 0 9px; }
      textarea { min-height: 50px; padding: 9px; resize: vertical; line-height: 1.4; }
      select:focus, textarea:focus, input[type="text"]:focus {
        border-color: rgba(251,114,153,.85);
        box-shadow: 0 0 0 3px rgba(251,114,153,.14);
      }
      select option { background: #24262b; color: #fff; }
      input[type="color"] {
        width: 100%;
        height: 36px;
        padding: 2px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 9px;
        background: rgba(255,255,255,.07);
      }
      input[type="checkbox"] { accent-color: #fb7299; }
      input[type="range"] {
        width: 100%;
        height: 34px;
        margin: 0;
        accent-color: #fb7299;
        cursor: pointer;
      }
      .size-estimate {
        flex: 0 0 auto;
        color: #8ee1b9;
        font-size: 11px;
        font-weight: 760;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .btn {
        min-height: 40px;
        padding: 0 12px;
        border: 0;
        border-radius: 11px;
        color: #fff;
        font-weight: 800;
        cursor: pointer;
      }
      .btn.primary { background: linear-gradient(135deg, #fb7299, #ff8bb0); }
      .btn.secondary { background: rgba(255,255,255,.10); }
      .btn.danger { background: linear-gradient(135deg, #d84d47, #f36b63); }
      .btn:disabled, .small-btn:disabled, select:disabled, textarea:disabled, input:disabled {
        cursor: not-allowed;
        opacity: .48;
      }
      .small-btn {
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid rgba(255,255,255,.11);
        border-radius: 9px;
        background: rgba(255,255,255,.07);
        color: #edf0f3;
        cursor: pointer;
        white-space: nowrap;
      }
      .small-btn.danger-text { color: #ff9f99; }
      .small-btn:hover { background: rgba(255,255,255,.12); }

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
        border: 1px solid rgba(255,255,255,.10);
        border-radius: 999px;
        background: rgba(255,255,255,.055);
        color: #c9ced5;
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
        color: #aeb4bf;
        font-size: 15px;
        font-weight: 700;
        line-height: 1;
      }
      .text-tab-delete:hover {
        background: rgba(255,96,86,.16);
        color: #ff9f99;
      }
      .text-tab.active {
        border-color: rgba(251,114,153,.72);
        background: rgba(251,114,153,.17);
        color: #ffb0c7;
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
        border-radius: 10px;
        background: rgba(255,255,255,.045);
        color: #aeb4bf;
        font-size: 12px;
        line-height: 1.45;
      }
      #status.success { color: #69d3a4; }
      #status.error { color: #ff8f87; background: rgba(255,96,86,.08); }
      .progress-wrap {
        height: 7px;
        margin-top: 10px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255,255,255,.08);
      }
      #progress {
        width: 0;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #fb7299, #ffbad0);
        transition: width .12s linear;
      }
      .action-dock {
        flex: 0 0 auto;
        z-index: 9;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin: 0;
        padding: 8px 10px 10px;
        border-top: 1px solid rgba(255,255,255,.08);
        background: linear-gradient(180deg, rgba(24,25,29,.88), rgba(24,25,29,.995) 24%);
        backdrop-filter: blur(12px);
      }
      .action-dock.one { grid-template-columns: 1fr; }

      #pageSelectionMarker {
        position: fixed;
        z-index: 2147483640;
        border: 2px solid #fb7299;
        border-radius: 6px;
        background: rgba(251,114,153,.035);
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
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 12px;
        background: rgba(20,21,24,.97);
        color: #fff;
        box-shadow: 0 10px 34px rgba(0,0,0,.42);
        white-space: nowrap;
      }
      #selectionRecordBtn {
        height: 29px;
        padding: 0 12px;
        border: 0;
        border-radius: 9px;
        background: linear-gradient(135deg, #e85650, #ff756d);
        color: #fff;
        font-weight: 850;
        cursor: pointer;
      }
      #selectionRecordBtn.recording { background: linear-gradient(135deg, #c83f39, #ef5d55); }
      #selectionTimer {
        min-width: 54px;
        color: #ffaaa5;
        font-size: 12px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        text-align: center;
      }
      #selectionReselectBtn, #selectionClearBtn {
        height: 29px;
        padding: 0 9px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 9px;
        background: rgba(255,255,255,.08);
        color: #e9ecf0;
        font-size: 11px;
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
        border: 2px solid #fb7299;
        border-radius: 6px;
        background: rgba(251,114,153,.14);
        box-shadow: 0 0 0 9999px rgba(0,0,0,.36);
        pointer-events: none;
      }
      #pageSelectCancel {
        position: fixed;
        right: 18px;
        top: 16px;
        height: 36px;
        padding: 0 13px;
        border: 1px solid rgba(255,255,255,.2);
        border-radius: 10px;
        background: rgba(20,21,24,.94);
        color: #fff;
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
        border-radius: 11px;
        background: rgba(22,23,26,.96);
        color: #fff;
        font-size: 12px;
        line-height: 1.45;
        box-shadow: 0 14px 40px rgba(0,0,0,.42);
        pointer-events: none;
      }
      #toast.error { color: #ffaaa5; border-color: rgba(255,105,96,.32); }
      #toast.success { color: #7fe0b4; }

      @media (max-width: 540px) {
        #panel { right: 10px; top: 10px; width: calc(100vw - 20px); height: calc(100vh - 20px); max-height: calc(100vh - 20px); }
        .grid-3 { grid-template-columns: 1fr 1fr; }
        .grid-3 .field:last-child { grid-column: 1 / -1; }
      }
    </style>

    <button id="launcher" title="框选 B站视频制作 GIF" aria-label="贝报GIF助手"></button>

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
              <video id="clipVideo" muted playsinline preload="auto"></video>
              <video id="scrubVideo" muted playsinline preload="auto" aria-hidden="true"></video>
              <canvas id="previewCanvas" aria-hidden="true"></canvas>
              <button id="aspectSquareBtn" class="edit-lockable" type="button" aria-pressed="false" title="锁定裁剪比例为 1:1">1:1</button>
              <div id="editorOverlay">
                <div id="editorBoundary"></div>
                <div id="editorCropBox">
                  <div id="roundedCropGuide" aria-hidden="true"></div>
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

            <div class="trim-block">
              <div id="timelineTrack" class="edit-lockable" aria-label="片段剪辑时间轴">
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
                  <input id="textColor" class="edit-lockable export-input" type="color" value="#ffffff">
                </div>
                <div class="field">
                  <label for="strokeColor">描边颜色</label>
                  <input id="strokeColor" class="edit-lockable export-input" type="color" value="#000000">
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

          <div id="status" class="hidden"></div>
          <div id="progressWrap" class="progress-wrap hidden"><div id="progress"></div></div>
          </div>

          <div id="mainActions" class="action-dock">
            <button id="newRecordingBtn" class="btn secondary edit-lockable">重新录制</button>
            <button id="generateBtn" class="btn primary edit-lockable">生成 GIF</button>
          </div>
          <div id="cancelExportWrap" class="action-dock one hidden">
            <button id="cancelExportBtn" class="btn danger">取消生成</button>
          </div>
        </div>
      </div>
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
    clipVideo: $('#clipVideo'),
    scrubVideo: $('#scrubVideo'),
    previewCanvas: $('#previewCanvas'),
    aspectSquareBtn: $('#aspectSquareBtn'),
    editorOverlay: $('#editorOverlay'),
    editorBoundary: $('#editorBoundary'),
    editorCropBox: $('#editorCropBox'),
    captionLayer: $('#captionLayer'),
    timelineTrack: $('#timelineTrack'),
    timelineSelected: $('#timelineSelected'),
    timelinePlayhead: $('#timelinePlayhead'),
    timelineStartHandle: $('#timelineStartHandle'),
    timelineEndHandle: $('#timelineEndHandle'),
    trimStartValue: $('#trimStartValue'),
    trimEndValue: $('#trimEndValue'),
    trimSummary: $('#trimSummary'),
    previewTrimBtn: $('#previewTrimBtn'),
    textLayerTabs: $('#textLayerTabs'),
    textEditor: $('#textEditor'),
    textEditorEmpty: $('#textEditorEmpty'),
    addTextBtn: $('#addTextBtn'),
    resolutionSelect: $('#resolutionSelect'),
    fpsSelect: $('#fpsSelect'),
    estimatedSize: $('#estimatedSize'),
    speedSelect: $('#speedSelect'),
    cornerRadiusSelect: $('#cornerRadiusSelect'),
    cornerRadiusState: $('#cornerRadiusState'),
    captionText: $('#captionText'),
    fontScale: $('#fontScale'),
    fontScaleValue: $('#fontScaleValue'),
    textColor: $('#textColor'),
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
    constructor(message = '用户取消了生成。') {
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
    el.progress.style.width = `${clamp(Number(percent) || 0, 0, 100)}%`;
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

  function getMainVideo() {
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

  function currentPageKey() {
    const p = new URLSearchParams(location.search).get('p') || '';
    return `${location.pathname}?p=${p}`;
  }

  function updateModeUi() {
    const editVisible = state.mode === 'edit' || state.mode === 'exporting';
    el.captureStage.classList.add('hidden');
    el.editStage.classList.toggle('hidden', !editVisible);

    if (state.mode === 'recording') el.stageBadge.textContent = '录制中';
    else if (state.mode === 'exporting') el.stageBadge.textContent = '生成中';
    else el.stageBadge.textContent = '编辑';

    const recording = state.mode === 'recording';
    el.launcher.classList.toggle('recording', recording);
    el.launcher.textContent = '';
    el.recordHud.classList.add('hidden');
    el.pageSelectionMarker.classList.toggle('recording', recording);

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

  function fitClipVideoIntoPreview() {
    if (!state.clip || !el.editorPreviewWrap || !el.clipVideo) return;
    const wrapRect = el.editorPreviewWrap.getBoundingClientRect();
    if (wrapRect.width <= 1 || wrapRect.height <= 1) return;

    const videoWidth = Math.max(1, state.clip.width || el.clipVideo.videoWidth || 1);
    const videoHeight = Math.max(1, state.clip.height || el.clipVideo.videoHeight || 1);
    const scale = Math.min(wrapRect.width / videoWidth, wrapRect.height / videoHeight);
    const displayWidth = Math.max(1, videoWidth * scale);
    const displayHeight = Math.max(1, videoHeight * scale);

    el.clipVideo.style.width = `${displayWidth}px`;
    el.clipVideo.style.height = `${displayHeight}px`;
    if (el.scrubVideo) {
      el.scrubVideo.style.width = `${displayWidth}px`;
      el.scrubVideo.style.height = `${displayHeight}px`;
    }
  }

  function readSavedPanelPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) return saved;
    } catch (_) { }
    return null;
  }

  function savePanelPosition(left, top) {
    try { localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left, top })); } catch (_) { }
  }

  function clampPanelPosition(left, top) {
    const rect = el.panel.getBoundingClientRect();
    const width = Math.max(1, rect.width || parseFloat(el.panel.style.width) || 420);
    const height = Math.max(1, rect.height || parseFloat(el.panel.style.height) || 700);
    const minLeft = UI_SAFE_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - width - UI_SAFE_MARGIN);
    const minTop = UI_SAFE_MARGIN;
    const maxTop = Math.max(minTop, window.innerHeight - height - UI_SAFE_MARGIN);
    return {
      left: clamp(left, minLeft, maxLeft),
      top: clamp(top, minTop, maxTop),
    };
  }

  function applyPanelPosition({ preferSaved = true } = {}) {
    const rect = el.panel.getBoundingClientRect();
    const width = Math.max(1, rect.width || 420);
    const saved = preferSaved ? readSavedPanelPosition() : null;
    const desiredLeft = saved?.left ?? Math.max(UI_SAFE_MARGIN, window.innerWidth - width - UI_SAFE_MARGIN);
    const desiredTop = saved?.top ?? UI_SAFE_MARGIN;
    const pos = clampPanelPosition(desiredLeft, desiredTop);
    el.panel.style.right = 'auto';
    el.panel.style.left = `${pos.left}px`;
    el.panel.style.top = `${pos.top}px`;
  }

  function handlePanelHeaderPointerDown(event) {
    if (event.button !== 0 || state.busy) return;
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
    const pos = clampPanelPosition(
      drag.startLeft + event.clientX - drag.startX,
      drag.startTop + event.clientY - drag.startY,
    );
    el.panel.style.right = 'auto';
    el.panel.style.left = `${pos.left}px`;
    el.panel.style.top = `${pos.top}px`;
    event.preventDefault();
  }

  function finishPanelHeaderDrag(event) {
    const drag = state.panelDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    state.panelDrag = null;
    try { el.header.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    const rect = el.panel.getBoundingClientRect();
    const pos = clampPanelPosition(rect.left, rect.top);
    el.panel.style.left = `${pos.left}px`;
    el.panel.style.top = `${pos.top}px`;
    savePanelPosition(pos.left, pos.top);
  }

  function fitEditorLayout() {
    const availableWidth = Math.max(1, window.innerWidth - UI_SAFE_MARGIN * 2);
    const availableHeight = Math.max(260, window.innerHeight - UI_SAFE_MARGIN * 2);
    const maxWidth = Math.min(420, availableWidth);
    const preferredMin = window.innerHeight < 760 ? 330 : 360;
    const minWidth = Math.min(preferredMin, maxWidth);
    const idealWidth = Math.round(window.innerHeight * 0.39 + 28);
    const panelWidth = window.innerWidth <= 500 ? maxWidth : clamp(idealWidth, minWidth, maxWidth);
    const panelHeight = Math.min(availableHeight, 820);

    el.panel.style.width = `${panelWidth}px`;
    el.panel.style.height = `${panelHeight}px`;
    el.panel.style.maxHeight = `${availableHeight}px`;
    el.editorPreviewWrap.style.height = 'auto';
    applyPanelPosition({ preferSaved: !state.panelDrag });

    requestAnimationFrame(() => {
      fitClipVideoIntoPreview();
      updateEditorCropBox();
      updateTimelinePlayhead();
    });
  }

  function keepFloatingUiInViewport() {
    const rect = el.launcher.getBoundingClientRect();
    applyLauncherPosition(rect.left, rect.top, { save: true });
    if (!el.panel.classList.contains('hidden')) fitEditorLayout();
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
    el.panel.classList.add('hidden');
    stopTrimPreview();
  }

  function handleLauncherAction() {
    if (state.mode === 'capture') {
      beginPageSelection();
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
    stopTrimPreview();
    if (state.clip?.url) URL.revokeObjectURL(state.clip.url);
    state.clip = null;
    if (el.previewCanvas) {
      el.previewCanvas.style.visibility = 'hidden';
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
      setStatus('没有找到可框选的 B站视频画面，请等待视频加载后再试。', 'error');
      return;
    }
    if (document.fullscreenElement && document.fullscreenElement.tagName === 'VIDEO') {
      setStatus('浏览器原生视频全屏会遮住脚本界面，请先退出原生全屏再框选；B站网页全屏可以使用。', 'error');
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
    if (source.sw < 2 || source.sh < 2) throw new Error('录制选区过小，请重新框选。');
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
      setStatus('请先用鼠标框选录制区域。', 'error');
      return;
    }

    const video = getMainVideo();
    if (!video || !video.videoWidth || !video.videoHeight) {
      setStatus('没有找到可录制的 B站视频。', 'error');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setStatus('当前浏览器不支持 MediaRecorder。建议使用最新版 Chrome、Edge 或 Firefox。', 'error');
      return;
    }

    const captureStream = HTMLCanvasElement.prototype.captureStream
      || HTMLCanvasElement.prototype.mozCaptureStream;
    if (typeof captureStream !== 'function') {
      setStatus('当前浏览器不支持 Canvas 录制。建议使用最新版 Chrome 或 Edge。', 'error');
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
      setStatus('浏览器无法创建录制画布。', 'error');
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
        recording.error = event.error || new Error('MediaRecorder 录制失败。');
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
        recording.error = new Error(`无法自动播放 B站视频：${error.message || error}`);
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
        reject(new Error('录制片段载入失败。'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        target.removeEventListener(eventName, done);
        target.removeEventListener('error', fail);
        reject(new Error('录制片段载入超时。'));
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

  async function loadRecordedClip(blob, metadata) {
    disposeClip();
    const url = URL.createObjectURL(blob);
    state.clip = { ...metadata, blob, url, duration: metadata.measuredDuration };
    el.clipVideo.src = url;
    el.scrubVideo.src = url;
    el.clipVideo.load();
    el.scrubVideo.load();
    const scrubReady = waitForEvent(el.scrubVideo, 'loadedmetadata', 10_000).catch(() => null);
    await waitForEvent(el.clipVideo, 'loadedmetadata', 10_000);
    await scrubReady;
    const duration = await resolveRecordedDuration(el.clipVideo, metadata.measuredDuration);
    state.clip.duration = Math.max(0.1, Math.min(
      Number.isFinite(duration) && duration > 0 ? duration : metadata.measuredDuration,
      metadata.measuredDuration + 0.5,
    ));
    state.clip.width = el.clipVideo.videoWidth || metadata.captureWidth;
    state.clip.height = el.clipVideo.videoHeight || metadata.captureHeight;
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    state.aspectSquare = true;
    makeCurrentCropSquare();
    state.trimStart = 0;
    state.trimEnd = state.clip.duration;
    setupEditorForClip();
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
      setStatus('录制时间太短，请至少录制约 0.2 秒。', 'error');
      return;
    }

    try {
      const blob = new Blob(recording.chunks, { type: recording.mimeType || 'video/webm' });
      if (blob.size < 1024) throw new Error('录制文件为空，请重新录制。');
      await loadRecordedClip(blob, {
        measuredDuration,
        sourceStart: recording.snapshot.sourceStart,
        sourceEnd,
        captureWidth: recording.captureWidth,
        captureHeight: recording.captureHeight,
        stopReason: recording.stopReason,
      });
      state.mode = 'edit';
      el.panel.classList.remove('hidden');
      el.panel.scrollTop = 0;
      if (el.editorSettingsScroll) el.editorSettingsScroll.scrollTop = 0;
      fitEditorLayout();
      updateModeUi();
      setStatus('');
      requestAnimationFrame(() => { void ensureTrimPreviewPlaying(); });
      if (recording.stopReason === 'limit') {
        showToast(`已达到 ${MAX_RECORD_SECONDS} 秒上限并自动停止。`, 'success');
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

  function updateEditorCropBox() {
    if (!state.clip || el.editStage.classList.contains('hidden')) return;
    const mapping = getEditorMapping();
    if (!mapping) return;
    const wrapRect = el.editorPreviewWrap.getBoundingClientRect();
    const rawRect = cropToScreenRect(state.editorCrop, mapping);
    const visible = intersectRects(rawRect, mapping.visibleRect);
    if (!visible) return;

    Object.assign(el.editorCropBox.style, {
      left: `${visible.left - wrapRect.left}px`,
      top: `${visible.top - wrapRect.top}px`,
      width: `${visible.width}px`,
      height: `${visible.height}px`,
      visibility: 'visible',
    });
    Object.assign(el.editorBoundary.style, {
      left: `${mapping.visibleRect.left - wrapRect.left}px`,
      top: `${mapping.visibleRect.top - wrapRect.top}px`,
      width: `${mapping.visibleRect.width}px`,
      height: `${mapping.visibleRect.height}px`,
    });
    Object.assign(el.captionLayer.style, {
      left: `${visible.left - wrapRect.left}px`,
      top: `${visible.top - wrapRect.top}px`,
      width: `${visible.width}px`,
      height: `${visible.height}px`,
    });
    updateRoundedCropGuide(visible.width, visible.height);
    renderTextLayers();
    renderExportPreviewFrame();
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
    updateEditorCropBox();
    updateResolutionOptions();
    updateEstimatedFileSize();
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
    const mapping = getEditorMapping();
    if (!mapping) return;
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
    };
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
        ? resizeSquareScreenRect(session.startRect, session.handle, dx, dy, session.mapping.visibleRect)
        : resizeScreenRect(session.startRect, session.handle, dx, dy, session.mapping.visibleRect));
    const crop = screenRectToEditorCrop(rect, session.mapping);
    if (!crop) return;
    state.editorCrop = crop;
    updateEditorCropBox();
    updateResolutionOptions();
    updateEstimatedFileSize();
    event.preventDefault();
  }

  function finishEditorCropAdjustment(event) {
    const session = state.editorCropSession;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    state.editorCropSession = null;
    try { el.editorCropBox.releasePointerCapture?.(session.pointerId); } catch (_) { }
    updateEditorCropBox();
  }

  function resetEditorCrop() {
    if (!state.clip || state.mode !== 'edit') return;
    state.editorCrop = { x: 0, y: 0, w: 1, h: 1 };
    updateEditorCropBox();
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
    try { el.scrubVideo.currentTime = target; } catch (_) { }
  }

  function hideTimelineHandlePreview() {
    if (!el.scrubVideo) return;
    el.scrubVideo.classList.remove('active');
    renderExportPreviewFrame();
  }

  function applyTimelineDrag(event) {
    const drag = state.timelineDrag;
    if (!drag || !state.clip) return;
    const target = timelineTimeFromClientX(event.clientX);
    const minGap = Math.min(0.1, state.clip.duration / 2);
    if (drag.type === 'start') {
      state.trimStart = Math.min(target, state.trimEnd - minGap);
      updateTrimUi();
      showTimelineHandlePreview(state.trimStart);
    } else if (drag.type === 'end') {
      state.trimEnd = Math.max(target, state.trimStart + minGap);
      updateTrimUi();
      showTimelineHandlePreview(state.trimEnd);
    } else {
      try { el.clipVideo.currentTime = target; } catch (_) { }
      updateTimelinePlayhead();
    }
    renderExportPreviewFrame();
    updateEstimatedFileSize();
  }

  function handleTimelinePointerDown(event) {
    if (event.button !== 0 || state.mode !== 'edit' || !state.clip) return;
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
    state.timelineDrag = null;
    try { el.timelineTrack.releasePointerCapture?.(drag.pointerId); } catch (_) { }
    hideTimelineHandlePreview();
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
    }
  }

  function renderTextLayers() {
    if (!el.captionLayer) return;
    el.captionLayer.textContent = '';
    if (!state.clip) return;
    const bounds = el.captionLayer.getBoundingClientRect();
    const previewWidth = Math.max(1, bounds.width || Number.parseFloat(el.captionLayer.style.width) || 1);
    state.textLayers.forEach((layer) => {
      if (!String(layer.text || '').trim()) return;
      const item = document.createElement('div');
      item.className = `caption-item${layer.id === state.activeTextId ? ' active' : ''}`;
      item.dataset.textId = layer.id;
      item.textContent = layer.text;
      const fontSize = Math.max(12, Math.round(previewWidth * layer.fontScale));
      const strokeWidth = Math.max(0, fontSize * layer.strokeScale);
      Object.assign(item.style, {
        left: `${clamp(layer.x, 0, 1) * 100}%`,
        top: `${clamp(layer.y, 0, 1) * 100}%`,
        fontSize: `${fontSize}px`,
        color: layer.textColor,
        webkitTextStroke: `${strokeWidth}px ${layer.strokeColor}`,
      });
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
      strokeColor: '#000000',
      strokeScale: 0.14,
    });
    selectTextLayer(id, { focus: true });
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
    layer.strokeColor = el.strokeColor.value || '#000000';
    layer.strokeScale = Number(el.strokeScale.value) || 0;
    renderTextLayerTabs(false);
    renderTextLayers();
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
    event.preventDefault();
  }

  function finishTextLayerDrag(event) {
    const drag = state.textLayerDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    state.textLayerDrag = null;
    drag.item.classList.remove('dragging');
    try { drag.item.releasePointerCapture?.(drag.pointerId); } catch (_) { }
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
      const onError = () => fail('视频跳转时间轴时发生错误。');
      const timeout = setTimeout(() => {
        if (Math.abs(video.currentTime - target) < 0.14 && video.readyState >= 2) finish();
        else fail(`跳转到 ${formatTime(target)} 超时。`);
      }, 10_000);

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError, { once: true });
      try {
        video.currentTime = target;
      } catch (error) {
        fail(`无法跳转视频时间轴：${error.message || error}`);
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
    const inset = Math.min(6, Math.max(2, Math.min(width, height) / 5));
    el.editorCropBox.style.setProperty('--rounded-guide-inset', `${inset}px`);
    el.editorCropBox.style.setProperty('--rounded-guide-radius', `${Math.max(0, radius - inset)}px`);
    el.editorCropBox.classList.toggle('rounded-guide-active', ratio > 0);
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

  function drawExportCanvasFrame(ctx, settings, video, mode = 'export') {
    const width = settings.outputWidth;
    const height = settings.outputHeight;
    const radius = mode === 'preview'
      ? 0
      : Number(settings.outputRadius) || getCornerRadiusPixels(width, height, settings.cornerRadiusRatio);
    const transparentCorners = mode === 'export' || mode === 'estimate';
    const includeText = mode !== 'preview';
    const sx = settings.crop.x * state.clip.width;
    const sy = settings.crop.y * state.clip.height;
    const sw = settings.crop.w * state.clip.width;
    const sh = settings.crop.h * state.clip.height;

    ctx.clearRect(0, 0, width, height);
    if (transparentCorners && radius > 0) {
      ctx.fillStyle = TRANSPARENT_KEY_COLOR;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, width, height, radius);
    ctx.clip();
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
    if (includeText) drawTextLayers(ctx, width, height, settings.textLayers);
    ctx.restore();
  }

  function updatePreviewCanvasLayout(settings = null) {
    if (!state.clip || !el.previewCanvas || !el.editorPreviewWrap) return null;
    const mapping = getEditorMapping();
    if (!mapping) return null;
    const wrapRect = el.editorPreviewWrap.getBoundingClientRect();
    const rawRect = cropToScreenRect(state.editorCrop, mapping);
    const visible = intersectRects(rawRect, mapping.visibleRect);
    if (!visible) return null;
    const nextSettings = settings || (() => {
      try { return readExportSettings(); } catch (_) { return null; }
    })();
    if (!nextSettings) return null;
    const canvas = el.previewCanvas;
    if (canvas.width !== nextSettings.outputWidth) canvas.width = nextSettings.outputWidth;
    if (canvas.height !== nextSettings.outputHeight) canvas.height = nextSettings.outputHeight;
    const displayWidth = Math.max(1, visible.width);
    const displayHeight = Math.max(1, visible.height);
    Object.assign(canvas.style, {
      left: `${visible.left - wrapRect.left}px`,
      top: `${visible.top - wrapRect.top}px`,
      width: `${displayWidth}px`,
      height: `${displayHeight}px`,
      borderRadius: '0px',
      visibility: 'visible',
    });
    updateRoundedCropGuide(displayWidth, displayHeight, nextSettings);
    return nextSettings;
  }

  function renderExportPreviewFrame(settings = null) {
    if (!state.clip || state.mode !== 'edit' || !el.previewCanvas) return;
    const nextSettings = updatePreviewCanvasLayout(settings);
    const sourceVideo = el.scrubVideo?.classList.contains('active') ? el.scrubVideo : el.clipVideo;
    if (!nextSettings || !sourceVideo || sourceVideo.readyState < 2) return;
    const ctx = el.previewCanvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawExportCanvasFrame(ctx, nextSettings, sourceVideo, 'preview');
  }

  async function getWorkerBlobUrl() {
    let workerText = '';
    if (typeof GM_getResourceText === 'function') {
      workerText = await GM_getResourceText('GIF_WORKER');
    } else if (globalThis.GM && typeof globalThis.GM.getResourceText === 'function') {
      workerText = await globalThis.GM.getResourceText('GIF_WORKER');
    }
    if (!workerText) throw new Error('GIF Worker 资源未能加载，请重新保存脚本或检查脚本管理器。');
    return URL.createObjectURL(new Blob([workerText], { type: 'application/javascript' }));
  }

  function cleanupGifWorkers(gif) {
    if (!gif) return;
    const workers = [
      ...(Array.isArray(gif.activeWorkers) ? gif.activeWorkers : []),
      ...(Array.isArray(gif.freeWorkers) ? gif.freeWorkers : []),
    ];
    [...new Set(workers)].forEach((worker) => {
      try { worker.terminate(); } catch (_) { }
    });
    if (Array.isArray(gif.activeWorkers)) gif.activeWorkers.length = 0;
    if (Array.isArray(gif.freeWorkers)) gif.freeWorkers.length = 0;
  }

  function renderGif(gif) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };
      const timeout = setTimeout(() => {
        finish(reject, new Error('GIF 编码超时。请缩短片段、降低尺寸或帧率。'));
        try { gif.abort(); } catch (_) { }
      }, ENCODE_TIMEOUT_MS);

      gif.on('progress', (progress) => {
        setProgress(60 + progress * 40);
        setStatus(`正在编码 GIF：${Math.round(progress * 100)}%`);
      });
      gif.on('finished', (blob) => finish(resolve, blob));
      gif.on('abort', () => finish(reject, new CancelledError()));

      try {
        gif.render();
      } catch (error) {
        finish(reject, error);
      }
    });
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
    if (!state.clip) throw new Error('没有可编辑的录制片段。');
    const start = state.trimStart;
    const end = state.trimEnd;
    if (end <= start) throw new Error('剪辑终点必须晚于起点。');
    if (end - start < 0.15) throw new Error('导出片段太短，请至少保留 0.15 秒。');

    const fps = Number(el.fpsSelect.value);
    const speed = Number(el.speedSelect.value);
    const cornerRadiusRatio = getCornerRadiusRatio();
    const baseFrames = Math.max(1, Math.ceil((end - start) * fps));
    const finalFrames = baseFrames;
    if (finalFrames > MAX_EXPORT_FRAMES) {
      throw new Error(`当前设置会生成 ${finalFrames} 帧，超过上限 ${MAX_EXPORT_FRAMES} 帧。请缩短片段或降低帧率。`);
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

    return {
      video: el.clipVideo,
      start,
      end,
      fps,
      speed,
      cornerRadiusRatio,
      outputRadius,
      transparentCorners: outputRadius > 0,
      delay: Math.max(20, Math.round((1000 / fps) / speed)),
      baseFrames,
      finalFrames,
      outputWidth,
      outputHeight,
      crop,
      outputLongestEdge: longestSide,
      textLayers: state.textLayers
        .filter((layer) => String(layer.text || '').trim())
        .map((layer) => ({ ...layer })),
    };
  }

  function createGifOptions(settings, workerScript, workers) {
    return {
      workers,
      quality: 10,
      width: settings.outputWidth,
      height: settings.outputHeight,
      repeat: 0,
      background: '#000000',
      transparent: hasTransparentCorners(settings) ? TRANSPARENT_KEY_RGB : null,
      globalPalette: hasTransparentCorners(settings),
      dither: false,
      workerScript,
    };
  }

  function estimateGifBytes(settings) {
    const pixelsPerFrame = Math.max(1, settings.outputWidth * settings.outputHeight);
    const framePayload = pixelsPerFrame * settings.finalFrames;
    const textFactor = 1 + (settings.textLayers?.length || 0) * 0.04;
    const calibration = clamp(Number(state.sizeEstimateCalibration) || 1, 0.35, 3.2);
    const base = (framePayload * 0.30 * textFactor) + 2508;
    return Math.max(1024, base * calibration);
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '--';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function estimateSettingsSignature(settings) {
    const crop = settings.crop || {};
    const text = (settings.textLayers || []).map((layer) => [
      String(layer.text || ''),
      Number(layer.x || 0).toFixed(3), Number(layer.y || 0).toFixed(3),
      Number(layer.fontScale || 0).toFixed(3),
    ]);
    return JSON.stringify([
      settings.outputWidth, settings.outputHeight, settings.fps, settings.speed,
      Number(settings.cornerRadiusRatio || 0).toFixed(4),
      Number(settings.start).toFixed(3), Number(settings.end).toFixed(3),
      Number(crop.x || 0).toFixed(4), Number(crop.y || 0).toFixed(4),
      Number(crop.w || 0).toFixed(4), Number(crop.h || 0).toFixed(4), text,
    ]);
  }

  function renderGifQuiet(gif, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };
      const timeout = setTimeout(() => {
        try { gif.abort(); } catch (_) { }
        finish(reject, new Error('大小估算超时'));
      }, timeoutMs);
      gif.on('finished', (blob) => finish(resolve, blob));
      gif.on('abort', () => finish(reject, new Error('大小估算已取消')));
      try { gif.render(); } catch (error) { finish(reject, error); }
    });
  }

  async function estimateGifBytesBySampling(settings, token) {
    const GIFClass = typeof GIF === 'function' ? GIF : globalThis.GIF;
    if (typeof GIFClass !== 'function' || !state.clip?.url) return estimateGifBytes(settings);

    const sampleCount = Math.min(5, Math.max(2, settings.baseFrames));
    const sampleVideo = document.createElement('video');
    sampleVideo.muted = true;
    sampleVideo.playsInline = true;
    sampleVideo.preload = 'auto';
    sampleVideo.src = state.clip.url;
    sampleVideo.load();
    try {
      if (sampleVideo.readyState < 1) await waitForEvent(sampleVideo, 'loadedmetadata', 10_000);
      if (token !== state.sizeEstimateToken) throw new Error('stale');

      const workerScript = await getWorkerBlobUrl();
      let gif = null;
      try {
        gif = new GIFClass(createGifOptions(settings, workerScript, 1));
        state.sizeEstimateGif = gif;
        const canvas = document.createElement('canvas');
        canvas.width = settings.outputWidth;
        canvas.height = settings.outputHeight;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) throw new Error('无法创建估算画布');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const delay = settings.delay;

        for (let i = 0; i < sampleCount; i += 1) {
          if (token !== state.sizeEstimateToken) throw new Error('stale');
          const ratio = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
          const target = Math.min(settings.end - 0.001, settings.start + (settings.end - settings.start) * ratio);
          await seekVideo(sampleVideo, target, state.clip.duration);
          drawExportCanvasFrame(ctx, settings, sampleVideo, 'estimate');
          gif.addFrame(ctx, { copy: true, delay });
        }

        const blob = await renderGifQuiet(gif);
        if (token !== state.sizeEstimateToken) throw new Error('stale');
        const containerOverhead = Math.min(1400, blob.size * 0.18);
        const perFrame = Math.max(1, (blob.size - containerOverhead) / sampleCount);
        const calibration = clamp(Number(state.sizeEstimateCalibration) || 1, 0.35, 3.2);
        return Math.max(1024, (containerOverhead + perFrame * settings.finalFrames) * calibration);
      } finally {
        cleanupGifWorkers(gif);
        if (state.sizeEstimateGif === gif) state.sizeEstimateGif = null;
        URL.revokeObjectURL(workerScript);
      }
    } finally {
      try { sampleVideo.pause(); } catch (_) { }
      sampleVideo.removeAttribute('src');
      try { sampleVideo.load(); } catch (_) { }
    }
  }

  function scheduleSampledSizeEstimate(settings) {
    clearTimeout(state.sizeEstimateTimer);
    const token = ++state.sizeEstimateToken;
    const signature = estimateSettingsSignature(settings);
    state.sizeEstimateTimer = window.setTimeout(async () => {
      if (token !== state.sizeEstimateToken || state.mode !== 'edit' || state.busy) return;
      try {
        const bytes = await estimateGifBytesBySampling(settings, token);
        if (token !== state.sizeEstimateToken || state.mode !== 'edit') return;
        state.lastSampleEstimate = { signature, bytes };
        el.estimatedSize.textContent = `预计约 ${formatFileSize(bytes)}`;
        el.estimatedSize.title = '通过当前片段的代表帧做小样本 GIF 编码后推算；真实导出后还会用实际结果继续校准。';
      } catch (error) {
        if (String(error?.message || '') === 'stale') return;
      }
    }, 700);
  }

  function updateEstimatedFileSize({ actualBytes = 0 } = {}) {
    if (!el.estimatedSize) return;
    if (actualBytes > 0) {
      clearTimeout(state.sizeEstimateTimer);
      state.sizeEstimateToken += 1;
      el.estimatedSize.textContent = `实际 ${formatFileSize(actualBytes)}`;
      return;
    }
    if (!state.clip || state.mode === 'capture' || state.mode === 'recording') {
      clearTimeout(state.sizeEstimateTimer);
      state.sizeEstimateToken += 1;
      el.estimatedSize.textContent = '预计 --';
      return;
    }
    try {
      const settings = readExportSettings();
      const bytes = estimateGifBytes(settings);
      el.estimatedSize.textContent = `预计约 ${formatFileSize(bytes)}`;
      el.estimatedSize.title = '正在根据当前片段的实际画面内容进行采样估算。';
      scheduleSampledSizeEstimate(settings);
    } catch (_) {
      el.estimatedSize.textContent = '预计 --';
    }
  }

  function makeFileName(settings) {
    const bvid = location.pathname.match(/\/(BV[\w]+)/i)?.[1] || 'bilibili';
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const timeDate = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    return `贝报gif_${timeDate}_${bvid}.gif`;
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
    let snapshot;
    try {
      settings = readExportSettings();
      const GIFClass = typeof GIF === 'function' ? GIF : globalThis.GIF;
      if (typeof GIFClass !== 'function') throw new Error('GIF 编码库没有加载成功。');

      stopTrimPreview();
      clearTimeout(state.sizeEstimateTimer);
      state.sizeEstimateToken += 1;
      if (state.sizeEstimateGif && typeof state.sizeEstimateGif.abort === 'function') {
        try { state.sizeEstimateGif.abort(); } catch (_) { }
      }
      state.sizeEstimateGif = null;
      state.busy = true;
      state.mode = 'exporting';
      state.cancelRequested = false;
      updateModeUi();
      setProgress(0);

      const video = settings.video;
      snapshot = { currentTime: video.currentTime, paused: video.paused, playbackRate: video.playbackRate };
      video.pause();

      state.workerUrl = await getWorkerBlobUrl();
      const logicalCores = Math.max(1, navigator.hardwareConcurrency || 4);
      const workerCount = logicalCores >= 8 ? 4 : logicalCores >= 4 ? 2 : 1;
      const gif = new GIFClass(createGifOptions(settings, state.workerUrl, workerCount));
      state.gif = gif;

      const canvas = document.createElement('canvas');
      canvas.width = settings.outputWidth;
      canvas.height = settings.outputHeight;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('浏览器无法创建 GIF 画布。');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const delay = settings.delay;

      const drawExportFrame = () => {
        drawExportCanvasFrame(ctx, settings, video, 'export');
        gif.addFrame(ctx, { copy: true, delay });
      };

      const updateExtractionProgress = (count) => {
        setProgress((count / settings.baseFrames) * 60);
        setStatus(`正在高速提取编辑后的画面：${count}/${settings.baseFrames} 帧`);
      };

      if (typeof video.requestVideoFrameCallback === 'function') {
        const extractionPlaybackRate = 2;
        const frameTolerance = 0.5 / RECORD_FPS;
        await seekVideo(video, settings.start, state.clip.duration);
        if (state.cancelRequested) throw new CancelledError();

        let extractedFrames = 0;
        drawExportFrame();
        extractedFrames = 1;
        updateExtractionProgress(extractedFrames);

        if (extractedFrames < settings.baseFrames) {
          video.playbackRate = extractionPlaybackRate;
          await new Promise((resolve, reject) => {
            let settled = false;
            let callbackId = 0;
            let timeoutId = 0;

            const cleanup = () => {
              clearTimeout(timeoutId);
              if (callbackId && typeof video.cancelVideoFrameCallback === 'function') {
                try { video.cancelVideoFrameCallback(callbackId); } catch (_) { }
              }
              video.removeEventListener('error', onError);
              video.removeEventListener('ended', onEnded);
              try { video.pause(); } catch (_) { }
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

            const fillRemainingWithCurrentFrame = () => {
              while (extractedFrames < settings.baseFrames) {
                drawExportFrame();
                extractedFrames += 1;
                updateExtractionProgress(extractedFrames);
              }
            };

            const onError = () => fail(new Error('高速取帧时视频解码失败。'));
            const onEnded = () => {
              if (state.cancelRequested) {
                fail(new CancelledError());
                return;
              }
              fillRemainingWithCurrentFrame();
              finish();
            };

            const onFrame = (_now, metadata) => {
              if (settled) return;
              if (state.cancelRequested) {
                fail(new CancelledError());
                return;
              }

              const mediaTime = Number(metadata?.mediaTime);
              const currentTime = Number.isFinite(mediaTime) ? mediaTime : Number(video.currentTime) || 0;

              while (extractedFrames < settings.baseFrames) {
                const target = Math.min(
                  settings.end - 0.001,
                  settings.start + extractedFrames / settings.fps,
                );
                if (target > currentTime + frameTolerance) break;
                drawExportFrame();
                extractedFrames += 1;
                updateExtractionProgress(extractedFrames);
              }

              if (extractedFrames >= settings.baseFrames) {
                finish();
                return;
              }

              if (currentTime >= settings.end - 0.001) {
                fillRemainingWithCurrentFrame();
                finish();
                return;
              }

              callbackId = video.requestVideoFrameCallback(onFrame);
            };

            const expectedMs = ((settings.end - settings.start) / extractionPlaybackRate) * 1000;
            timeoutId = window.setTimeout(
              () => fail(new Error('高速取帧超时，请重试。')),
              Math.max(15_000, expectedMs + 12_000),
            );

            video.addEventListener('error', onError, { once: true });
            video.addEventListener('ended', onEnded, { once: true });
            callbackId = video.requestVideoFrameCallback(onFrame);
            video.play().catch((error) => fail(new Error(`无法启动高速取帧：${error.message || error}`)));
          });
        }
      } else {
        for (let index = 0; index < settings.baseFrames; index += 1) {
          if (state.cancelRequested) throw new CancelledError();
          const target = Math.min(settings.end - 0.001, settings.start + index / settings.fps);
          await seekVideo(video, target, state.clip.duration);
          drawExportFrame();
          updateExtractionProgress(index + 1);
        }
      }

      if (state.cancelRequested) throw new CancelledError();
      setStatus(`已提取 ${settings.baseFrames} 帧，开始编码 GIF……`);
      const blob = await renderGif(gif);
      if (state.cancelRequested) throw new CancelledError();

      const signature = estimateSettingsSignature(settings);
      const sampled = state.lastSampleEstimate?.signature === signature ? Number(state.lastSampleEstimate.bytes) : 0;
      const preCalibrationEstimate = Math.max(1, sampled || estimateGifBytes({ ...settings }));
      const previousCalibration = Number(state.sizeEstimateCalibration) || 1;
      const correction = clamp(blob.size / preCalibrationEstimate, 0.55, 1.8);
      state.sizeEstimateCalibration = clamp(previousCalibration * (0.7 + correction * 0.3), 0.5, 2.2);
      updateEstimatedFileSize({ actualBytes: blob.size });
      setProgress(100);
      const fileName = makeFileName(settings);
      downloadBlob(blob, fileName);
      setStatus(`GIF 已生成并开始下载 · ${formatFileSize(blob.size)}`, 'success');
      showToast(`GIF 已下载 · ${formatFileSize(blob.size)}`, 'success');
    } catch (error) {
      setStatus(friendlyError(error), error instanceof CancelledError ? '' : 'error');
    } finally {
      if (snapshot && state.clip) {
        try {
          el.clipVideo.playbackRate = Number.isFinite(snapshot.playbackRate) ? snapshot.playbackRate : 1;
          await seekVideo(el.clipVideo, snapshot.currentTime, state.clip.duration);
          if (snapshot.paused) el.clipVideo.pause();
          else await el.clipVideo.play();
        } catch (_) { }
      }
      cleanupGifWorkers(state.gif);
      state.gif = null;
      if (state.workerUrl) URL.revokeObjectURL(state.workerUrl);
      state.workerUrl = null;
      state.busy = false;
      state.cancelRequested = false;
      state.mode = state.clip ? 'edit' : 'capture';
      updateModeUi();
      if (state.mode === 'edit') updateEditorCropBox();
    }
  }

  function cancelExport() {
    if (state.mode !== 'exporting' || !state.busy) return;
    state.cancelRequested = true;
    setStatus('正在取消 GIF 生成……');
    if (state.gif && typeof state.gif.abort === 'function') {
      try { state.gif.abort(); } catch (_) { }
    }
  }

  function friendlyError(error) {
    if (error instanceof CancelledError) return '已取消生成。';
    const message = String(error && (error.message || error));
    if (/taint|cross-origin|cross origin|SecurityError/i.test(message)) {
      return '浏览器拒绝读取视频画面（Canvas 跨域限制）。请先关闭其他替换播放器或视频增强脚本并刷新页面；仍失败时把控制台红色报错发给我。';
    }
    if (/GIF is not defined|编码库/i.test(message)) {
      return 'GIF 编码库没有加载成功，请确认 jsDelivr 没有被网络或扩展拦截，然后重新保存脚本。';
    }
    if (/Worker|Content Security Policy|CSP|blob:/i.test(message)) {
      return 'GIF Worker 启动失败。请检查安全扩展是否禁止 Blob Worker，或尝试使用 Tampermonkey/Violentmonkey。';
    }
    return message || '操作失败，原因未知。';
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

  function updateVideoStatus() {
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

    if (state.pageSelection && !state.pageSelectionSession) updatePageSelectionUi();
    if (state.clip && Number.isFinite(el.clipVideo.currentTime)) updateTimelinePlayhead();
  }

  function handleExportInputChange() {
    if (state.mode === 'edit' && state.clip) {
      if (state.trimPreviewCleanup && el.speedSelect) {
        el.clipVideo.playbackRate = Math.max(0.1, Number(el.speedSelect.value) || 1);
      }
      renderExportPreviewFrame();
    }
    updateEstimatedFileSize();
  }

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
  el.captionLayer.addEventListener('pointerdown', handleTextLayerPointerDown);
  el.captionLayer.addEventListener('pointermove', handleTextLayerPointerMove);
  el.captionLayer.addEventListener('pointerup', finishTextLayerDrag);
  el.captionLayer.addEventListener('pointercancel', finishTextLayerDrag);
  el.clipVideo.addEventListener('timeupdate', updateTimelinePlayhead);
  el.clipVideo.addEventListener('timeupdate', () => renderExportPreviewFrame());
  el.clipVideo.addEventListener('loadeddata', () => {
    fitClipVideoIntoPreview();
    updateEditorCropBox();
    updateTimelinePlayhead();
    renderExportPreviewFrame();
    updateEstimatedFileSize();
  });
  el.clipVideo.addEventListener('resize', updateEditorCropBox);
  el.scrubVideo.addEventListener('loadeddata', () => renderExportPreviewFrame());
  el.scrubVideo.addEventListener('seeked', () => renderExportPreviewFrame());

  el.newRecordingBtn.addEventListener('click', returnToCaptureStage);
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

  window.addEventListener('resize', () => {
    keepFloatingUiInViewport();
    updatePageSelectionBoundary();
    updatePageSelectionUi();
    if (!el.panel.classList.contains('hidden')) fitEditorLayout();
  });
  window.addEventListener('scroll', () => {
    updatePageSelectionBoundary();
    updatePageSelectionUi();
    updateEditorCropBox();
  }, true);

  window.addEventListener('beforeunload', () => {
    stopTrimPreview();
    cleanupRecordingResources(state.recording);
    cleanupGifWorkers(state.gif);
    if (state.workerUrl) URL.revokeObjectURL(state.workerUrl);
    if (state.clip?.url) URL.revokeObjectURL(state.clip.url);
  });

  restoreLauncherPosition();
  renderTextLayerTabs();
  renderTextLayers();
  setInterval(updateVideoStatus, 300);
  updateModeUi();
  updateVideoStatus();
})();
