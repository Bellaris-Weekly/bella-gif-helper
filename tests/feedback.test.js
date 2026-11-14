'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bindFeedbackForm } = require('../src/ui/feedback');

function mount(send) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel.html'), 'utf8');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const shadow = dom.window.document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = html;
  const form = shadow.getElementById('feedbackSheet');
  const sent = [];
  const controller = bindFeedbackForm({ form, send, onSent: (label) => sent.push(label) });
  const $ = (id) => shadow.getElementById(id);
  const type = (value) => {
    $('feedbackText').value = value;
    $('feedbackText').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { $, type, submit, sent, controller, window: dom.window };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('submit stays disabled until there is text, and the counter tracks length', () => {
  const { $, type } = mount(async () => 'sent');
  assert.equal($('feedbackSubmitBtn').disabled, true);
  type('   ');
  assert.equal($('feedbackSubmitBtn').disabled, true);
  type('导出卡住了');
  assert.equal($('feedbackSubmitBtn').disabled, false);
  assert.equal($('feedbackCounter').textContent, '5/2000');
});

test('kind switch updates labels and is what gets sent', async () => {
  const calls = [];
  const { $, type, submit, sent } = mount(async (kind, message) => {
    calls.push([kind, message]);
    return 'sent';
  });
  $('feedbackSheet').querySelector('[data-feedback-kind="suggestion"]').click();
  assert.equal($('feedbackFieldLabel').textContent, '想要什么功能或改进');
  assert.equal($('feedbackSubmitBtn').textContent, '发送功能建议');
  type('  想要 WebP 导出  ');
  submit();
  assert.equal($('feedbackSubmitBtn').textContent, '正在发送…');
  assert.equal($('feedbackText').disabled, true);
  await flush();
  assert.deepEqual(calls, [['suggestion', '想要 WebP 导出']]);
  assert.deepEqual(sent, ['功能建议']);
  assert.equal($('feedbackText').value, '', 'sent text is cleared');
});

test('rate limits and failures keep the text and explain what to do', async () => {
  const results = ['rate_limited', 'failed'];
  const { $, type, submit, sent } = mount(async () => results.shift());
  type('录制没有声音');
  submit();
  await flush();
  assert.equal($('feedbackError').textContent, '提交太频繁了，请过一分钟再试。');
  assert.equal($('feedbackError').classList.contains('hidden'), false);
  assert.equal($('feedbackText').value, '录制没有声音');
  submit();
  await flush();
  assert.equal($('feedbackError').textContent, '没有发送成功，请检查网络后重试。');
  type('录制没有声音！');
  assert.equal($('feedbackError').classList.contains('hidden'), true, 'editing clears the error');
  assert.deepEqual(sent, []);
});

test('a throwing sender is reported as a failure, not an exception', async () => {
  const { $, type, submit } = mount(async () => { throw new Error('boom'); });
  type('x');
  submit();
  await flush();
  assert.equal($('feedbackError').textContent, '没有发送成功，请检查网络后重试。');
  assert.equal($('feedbackSubmitBtn').disabled, false);
});
