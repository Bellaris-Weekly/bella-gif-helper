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

test('filled actions and muted text retain readable contrast', () => {
  assert.ok(contrast(readHexToken('color-on-brand'), readHexToken('color-brand')) >= 4.5);
  assert.ok(contrast(readHexToken('color-text-muted'), readHexToken('color-surface-raised')) >= 4.5);
  assert.ok(contrast('#ffffff', readHexToken('color-danger')) >= 4.5);
});
