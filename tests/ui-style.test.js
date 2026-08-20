'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const userscriptPath = path.join(__dirname, '..', 'bella-gif-helper.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
const css = source.match(/shadow\.innerHTML = `\s*<style>([\s\S]*?)<\/style>/)?.[1] || '';

function readHexToken(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  return channels
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('UI uses shared visual tokens and accessible state rules', () => {
  assert.match(css, /--color-bg:/);
  assert.match(css, /--color-brand:/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 540px\)/);
  assert.match(css, /100dvh/);
});

test('compact editor keeps visual feedback inside the existing workspace', () => {
  assert.match(source, /id="cropSizeBadge"/);
  assert.match(source, /id="timelineFilmstrip"/);
  assert.match(source, /id="actionEstimate"/);
  assert.match(css, /\.grid-2\.export-options\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
});

test('floating editor exposes desktop resize handles and keeps narrow screens fixed', () => {
  assert.equal((source.match(/class="panel-resize-handle"/g) || []).length, 8);
  assert.match(css, /\.panel-resize-handle\s*\{[\s\S]*?touch-action:\s*none/);
  assert.match(css, /\[data-panel-resize="n"\][\s\S]*?height:\s*24px/);
  assert.match(css, /\[data-panel-resize="e"\][\s\S]*?width:\s*24px/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*?\.panel-resize-handle\s*\{\s*display:\s*none/);
  assert.match(css, /--editor-preview-size/);
  assert.match(css, /max-width:\s*520px/);
});

test('panel geometry uses stable userscript storage shared across matched origins', () => {
  assert.match(source, /@grant\s+GM_getValue/);
  assert.match(source, /@grant\s+GM_setValue/);
  assert.match(source, /PANEL_GEOMETRY_KEY\s*=\s*'biliGifMakerPanelGeometry'/);
  assert.match(source, /GM_getValue\(PANEL_GEOMETRY_KEY/);
  assert.match(source, /GM_setValue\(PANEL_GEOMETRY_KEY/);
  assert.doesNotMatch(source, /biliGifMakerPanelGeometryV\d/);
});

test('crop viewport adaptation uses interruptible transform-only motion', () => {
  assert.match(source, /id="editorMotionLayer"/);
  assert.match(source, /EDITOR_VIEWPORT_MOTION_MS\s*=\s*260/);
  assert.match(source, /EDITOR_VIEWPORT_EASING\s*=\s*'cubic-bezier\(0\.33, 1, 0\.68, 1\)'/);
  assert.match(source, /el\.editorMotionLayer\.animate\(\[\s*\{[\s\S]*?transform:[\s\S]*?\}\s*,\s*\{[\s\S]*?transform:/);
  assert.match(source, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(source, /if \(reducedMotion \|\| !canAnimate \|\| !isVisibleViewportTransition/);
  assert.match(source, /settleEditorViewportAnimation\(\);[\s\S]*?const mapping = getEditorMapping\(\)/);
  assert.match(source, /applyEditorVideoLayout\(session\.targetLayout\);\s*applyEditorCropGeometry\(session\.targetLayout\);\s*clearEditorViewportAnimation\(session\);/);
  assert.doesNotMatch(source, /makeCounterScaleKeyframes/);
  assert.match(css, /#editorMotionLayer\s*\{[\s\S]*?contain:\s*layout paint/);
  assert.match(css, /#editorPreviewWrap\.viewport-transitioning[\s\S]*?visibility:\s*hidden/);
});

test('crop release precomputes its target and defers expensive canvas rendering', () => {
  assert.match(source, /fittedLayout:\s*calculateFittedEditorViewport\(viewport\)/);
  assert.match(source, /session\.fittedLayout\s*=\s*calculateFittedEditorViewport\(session\.viewport, crop\)/);
  assert.match(source, /suspendEditorBackgroundWork\(\);\s*prepareEditorViewportAnimation\(\);/);
  assert.match(source, /animateCropIntoPreview\(session\.fittedLayout\);/);
  assert.match(source, /if \(state\.editorCropSession \|\| state\.editorViewportAnimation \|\| state\.editorBackgroundIntent\) return;/);
  assert.doesNotMatch(source, /updateEditorCropBox\(\{ render: false \}\);\s*scheduleEditorPreviewRender\(\);/);
});

test('crop interaction pauses cache work without stopping playback', () => {
  assert.match(source, /EDITOR_BACKGROUND_RESUME_DELAY_MS\s*=\s*320/);
  const suspendBlock = source.match(/function suspendEditorBackgroundWork\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(suspendBlock, /pausePreviewFrameCache\(\);/);
  assert.doesNotMatch(suspendBlock, /stopTrimPreview\(\)/);
  assert.match(source, /function scheduleEditorBackgroundResume\(\)[\s\S]*?requestIdleCallback[\s\S]*?resumeEditorBackgroundWork\(\)/);
  assert.match(source, /if \(intent\.resumeCache\) void resumePreviewFrameCache\(\);/);
});

test('filled actions and muted text retain readable contrast', () => {
  assert.ok(contrast(readHexToken('color-on-brand'), readHexToken('color-brand')) >= 4.5);
  assert.ok(contrast(readHexToken('color-text-muted'), readHexToken('color-surface-raised')) >= 4.5);
  assert.ok(contrast('#ffffff', readHexToken('color-danger')) >= 4.5);
});

test('text colors offer accessible presets while keeping custom selection', () => {
  const presets = [...source.matchAll(/data-text-color="(#[0-9a-f]{6})"/gi)].map((match) => match[1].toLowerCase());
  assert.deepEqual(presets, ['#db7d74', '#576690', '#e799b0']);
  assert.match(source, /class="color-swatch edit-lockable"[^>]+aria-label="[^"]+"[^>]+aria-pressed="false"/);
  assert.match(source, /button\.setAttribute\('aria-pressed', String\(button\.dataset\.textColor === selectedColor\)\)/);
  assert.match(source, /el\.textColor\.value = button\.dataset\.textColor;\s*updateActiveTextLayerFromControls\(\);/);
  assert.match(css, /\.color-swatch\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px/);
});

test('new text layers use a white stroke by default', () => {
  assert.match(source, /id="strokeColor"[^>]+value="#ffffff"/);
  const addTextLayerBlock = source.match(/function addTextLayer\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(addTextLayerBlock, /strokeColor:\s*'#ffffff'/);
  assert.match(source, /layer\.strokeColor = el\.strokeColor\.value \|\| '#ffffff'/);
});
