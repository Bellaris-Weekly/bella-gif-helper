'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_SHORTCUT,
  formatShortcut,
  isEditableShortcutEvent,
  matchesShortcut,
  normalizeShortcut,
  shortcutFromKeyboardEvent,
} = require('../bella-gif-helper.user.js');

test('default shortcut is Ctrl+Z and can be formatted for display', () => {
  assert.deepEqual(DEFAULT_SHORTCUT, {
    code: 'KeyZ',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  });
  assert.equal(formatShortcut(DEFAULT_SHORTCUT), 'Ctrl+Z');
});

test('shortcut recording accepts another modified key combination', () => {
  const shortcut = shortcutFromKeyboardEvent({
    code: 'KeyK',
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
    isComposing: false,
  });
  assert.deepEqual(shortcut, {
    code: 'KeyK',
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
  });
  assert.equal(formatShortcut(shortcut), 'Ctrl+Shift+K');
});

test('shortcut matching requires the exact modifier set', () => {
  const event = {
    code: 'KeyZ',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
  };
  assert.equal(matchesShortcut(event, DEFAULT_SHORTCUT), true);
  assert.equal(matchesShortcut({ ...event, shiftKey: true }, DEFAULT_SHORTCUT), false);
  assert.equal(matchesShortcut({ ...event, ctrlKey: false }, DEFAULT_SHORTCUT), false);
  assert.equal(matchesShortcut({ ...event, repeat: true }, DEFAULT_SHORTCUT), false);
  assert.equal(matchesShortcut({ ...event, isComposing: true }, DEFAULT_SHORTCUT), false);
});

test('shortcut validation rejects bare, shift-only, and modifier-only keys', () => {
  assert.equal(normalizeShortcut({ code: 'KeyG' }), null);
  assert.equal(normalizeShortcut({ code: 'KeyG', shiftKey: true }), null);
  assert.equal(normalizeShortcut({ code: 'ControlLeft', ctrlKey: true }), null);
  assert.equal(shortcutFromKeyboardEvent({ code: 'KeyG', ctrlKey: true, isComposing: true }), null);
});

test('editable targets preserve their native keyboard behavior', () => {
  assert.equal(isEditableShortcutEvent({ target: { tagName: 'TEXTAREA' } }), true);
  assert.equal(isEditableShortcutEvent({ target: { tagName: 'INPUT' } }), true);
  assert.equal(isEditableShortcutEvent({
    target: { tagName: 'SPAN' },
    composedPath: () => [{ tagName: 'SPAN' }, { tagName: 'DIV', isContentEditable: true }],
  }), true);
  assert.equal(isEditableShortcutEvent({ target: { tagName: 'BUTTON' } }), false);
});
