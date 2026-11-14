'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { enhanceSegmentedSelects, syncSegmentedSelect, animateSegmentedGroups, bindSheet, bindTabs } = require('../src/ui/controls');

function mount(html) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const { document } = dom.window;
  const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = html;
  return { dom, document, shadow, window: dom.window };
}

const SELECT = `
  <label for="fps">帧率</label>
  <select id="fps" class="edit-lockable export-input" data-segmented>
    <option value="8">8</option><option value="12" selected>12</option><option value="20">20</option>
  </select>`;

const options = (shadow) => [...shadow.querySelectorAll('.segmented-option')];
const checked = (shadow) => options(shadow).filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.value);

test('segmented select renders one radio per option, labelled by the field label', () => {
  const { shadow } = mount(SELECT);
  const [group] = enhanceSegmentedSelects(shadow);
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-labelledby'), shadow.querySelector('label').id);
  assert.deepEqual(options(shadow).map((b) => b.textContent), ['8', '12', '20']);
  assert.deepEqual(checked(shadow), ['12']);
  assert.ok(options(shadow).every((b) => b.classList.contains('edit-lockable')), 'export lock must cover the buttons');
  assert.equal(shadow.querySelector('select').getAttribute('aria-hidden'), 'true');
  assert.equal(enhanceSegmentedSelects(shadow).length, 0, 'enhancing twice is a no-op');
});

test('clicking an option writes the select and fires input + change like a native pick', () => {
  const { shadow, window } = mount(SELECT);
  enhanceSegmentedSelects(shadow);
  const select = shadow.querySelector('select');
  const events = [];
  select.addEventListener('input', () => events.push(`input:${select.value}`));
  select.addEventListener('change', () => events.push(`change:${select.value}`));
  options(shadow)[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(select.value, '20');
  assert.deepEqual(events, ['input:20', 'change:20']);
  assert.deepEqual(checked(shadow), ['20']);
  options(shadow)[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(events.length, 2, 're-clicking the current value does not re-fire');
});

test('programmatic value writes (pref restore, layer switch) refresh via syncSegmentedSelect without events', () => {
  const { shadow } = mount(SELECT);
  enhanceSegmentedSelects(shadow);
  const select = shadow.querySelector('select');
  let fired = 0;
  select.addEventListener('change', () => { fired += 1; });
  select.value = '8';
  syncSegmentedSelect(select);
  assert.deepEqual(checked(shadow), ['8']);
  select.selectedIndex = 2;
  syncSegmentedSelect(select);
  assert.deepEqual(checked(shadow), ['20']);
  assert.equal(fired, 0);
  syncSegmentedSelect(shadow.ownerDocument.createElement('select'));
});

test('every programmatic write to a segmented select in main.js is followed by a sync', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').split('\n');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.html'), 'utf8');
  const segmented = [...html.matchAll(/<select id="(\w+)"[^>]*data-segmented/g)].map((match) => match[1]);
  assert.ok(segmented.length >= 6);
  const writes = source
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => segmented.some((id) => new RegExp(`el\\.${id}\\.(value|selectedIndex)\\s*=[^=]`).test(line)));
  assert.ok(writes.length >= 4);
  for (const { line, index } of writes) {
    const window = source.slice(index, index + 6).join('\n');
    assert.match(window, /syncSegmentedSelect/, `missing syncSegmentedSelect after: ${line.trim()}`);
  }
});

test('options added later are rendered, and arrow keys move the selection', async () => {
  const { shadow, window } = mount(SELECT);
  enhanceSegmentedSelects(shadow);
  const select = shadow.querySelector('select');
  const extra = shadow.ownerDocument.createElement('option');
  extra.value = '24';
  extra.textContent = '24';
  select.appendChild(extra);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(options(shadow).map((b) => b.dataset.value), ['8', '12', '20', '24']);
  const group = shadow.querySelector('.segmented');
  group.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(select.value, '20');
  group.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(select.value, '8');
  options(shadow)[1].disabled = true;
  group.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(select.value, '8', 'disabled (export-locked) options cannot be chosen');
});

test('the selection thumb jumps into place first, then slides to newly selected options', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
  const shadow = dom.window.document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = SELECT;
  const lay = (button, index) => {
    for (const [key, value] of Object.entries({ offsetLeft: 2 + index * 40, offsetWidth: 38, offsetTop: 2, offsetHeight: 26 })) {
      Object.defineProperty(button, key, { configurable: true, get: () => value });
    }
  };
  enhanceSegmentedSelects(shadow);
  shadow.querySelectorAll('.segmented-option').forEach(lay);
  const [anim] = animateSegmentedGroups(shadow);
  const thumb = shadow.querySelector('.segmented > .segmented-thumb');
  assert.ok(anim && thumb);
  assert.equal(thumb.style.transform, 'translate(42px, 2px)');
  assert.equal(thumb.style.width, '38px');
  assert.equal(thumb.classList.contains('no-transition'), false);
  assert.equal(animateSegmentedGroups(shadow).length, 0, 'one thumb per group');
  shadow.querySelectorAll('.segmented-option')[2].click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(thumb.style.transform, 'translate(82px, 2px)');
  assert.equal(thumb.classList.contains('no-transition'), false, 'a user pick slides');
  const extra = dom.window.document.createElement('option');
  extra.value = '24';
  extra.textContent = '24';
  shadow.querySelector('select').appendChild(extra);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(shadow.querySelector('.segmented > .segmented-thumb'), 're-rendering options keeps the thumb');
});

test('sheet opens from its button, closes from back button and Esc, and returns focus', () => {
  const { shadow, window } = mount(`
    <button id="open">设置</button>
    <div id="sheet" class="hidden"><button id="back">返回</button><input id="field"></div>`);
  const opener = shadow.getElementById('open');
  const sheetEl = shadow.getElementById('sheet');
  const calls = [];
  const sheet = bindSheet(sheetEl, {
    openers: [opener],
    closers: [shadow.getElementById('back')],
    onOpen: () => calls.push('open'),
    onClose: () => calls.push('close'),
  });
  assert.equal(opener.getAttribute('aria-expanded'), 'false');
  opener.click();
  assert.ok(sheet.isOpen());
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  shadow.getElementById('back').click();
  assert.ok(!sheet.isOpen());
  assert.equal(shadow.activeElement, opener);
  opener.click();
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  shadow.getElementById('field').dispatchEvent(esc);
  assert.ok(!sheet.isOpen());
  assert.ok(esc.defaultPrevented);
  opener.click();
  opener.click();
  assert.ok(!sheet.isOpen(), 'the opener toggles');
  sheet.close();
  assert.deepEqual(calls, ['open', 'close', 'open', 'close', 'open', 'close']);
});

test('an Esc already handled inside the sheet (shortcut recording) does not close it', () => {
  const { shadow, window } = mount('<button id="open"></button><div id="sheet" class="hidden"><input id="field"></div>');
  const sheet = bindSheet(shadow.getElementById('sheet'), { openers: [shadow.getElementById('open')] });
  sheet.open();
  const field = shadow.getElementById('field');
  field.addEventListener('keydown', (event) => event.preventDefault());
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(sheet.isOpen());
});

test('tabs show only the selected panel and support arrow navigation', () => {
  const { shadow, window } = mount(`
    <div role="tablist">
      <button role="tab" id="a" aria-selected="true" aria-controls="pa"></button>
      <button role="tab" id="b" aria-selected="false" aria-controls="pb"></button>
    </div>
    <section id="pa"></section><section id="pb"></section>`);
  const tabs = bindTabs(shadow.querySelector('[role="tablist"]'));
  const hidden = (id) => shadow.getElementById(id).classList.contains('hidden');
  assert.deepEqual([hidden('pa'), hidden('pb')], [false, true]);
  shadow.getElementById('b').click();
  assert.deepEqual([hidden('pa'), hidden('pb')], [true, false]);
  assert.equal(shadow.getElementById('b').getAttribute('aria-selected'), 'true');
  shadow.querySelector('[role="tablist"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(hidden('pa'), false, 'arrow wraps around');
  tabs.select('b');
  assert.equal(hidden('pb'), false);
});

test('panel template keeps every element main.js looks up by id', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.html'), 'utf8');
  const ids = new Set([...source.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((match) => match[1]));
  assert.ok(ids.size > 60);
  const { shadow } = mount(html);
  const missing = [...ids].filter((id) => !shadow.getElementById(id));
  assert.deepEqual(missing, []);
  const seen = new Set();
  for (const node of shadow.querySelectorAll('[id]')) {
    assert.ok(!seen.has(node.id), `duplicate id ${node.id}`);
    seen.add(node.id);
  }
  for (const select of shadow.querySelectorAll('select[data-segmented]')) {
    assert.ok(select.classList.contains('export-input'), `${select.id} must keep driving handleExportInputChange`);
    // main.js 用 String(number) 回写数值型选项（如 strokeScale），值必须是数字的规范字符串。
    for (const option of select.options) {
      if (Number.isFinite(Number(option.value))) {
        assert.equal(String(Number(option.value)), option.value, `${select.id} option "${option.value}" cannot round-trip`);
      }
    }
  }
});
