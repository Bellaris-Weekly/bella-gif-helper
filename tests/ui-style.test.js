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

test('crop viewport adaptation uses interruptible transform-only motion', () => {
  assert.match(source, /EDITOR_VIEWPORT_MOTION_MS\s*=\s*220/);
  assert.match(source, /EDITOR_VIEWPORT_EASING\s*=\s*'cubic-bezier\(0\.22, 1, 0\.36, 1\)'/);
  assert.match(source, /element\.animate\(\[\s*\{[\s\S]*?transform:[\s\S]*?\}\s*,\s*\{[\s\S]*?transform:/);
  assert.match(source, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(source, /if \(reducedMotion \|\| !elements\.every/);
  assert.match(source, /settleEditorViewportAnimation\(\);[\s\S]*?const mapping = getEditorMapping\(\)/);
});

test('filled actions and muted text retain readable contrast', () => {
  assert.ok(contrast(readHexToken('color-on-brand'), readHexToken('color-brand')) >= 4.5);
  assert.ok(contrast(readHexToken('color-text-muted'), readHexToken('color-surface-raised')) >= 4.5);
  assert.ok(contrast('#ffffff', readHexToken('color-danger')) >= 4.5);
});
