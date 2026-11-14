'use strict';

// 反馈表单：类型切换、字数统计、提交与失败提示。发送由调用方注入（diagnostics.feedback）。

const KINDS = Object.freeze({
  issue: Object.freeze({
    label: '问题反馈',
    field: '遇到了什么问题',
    placeholder: '在哪个页面、做了什么操作、出现了什么情况。需要回复的话，可以留下联系方式。',
  }),
  suggestion: Object.freeze({
    label: '功能建议',
    field: '想要什么功能或改进',
    placeholder: '想用它做什么、现在哪里不方便。需要回复的话，可以留下联系方式。',
  }),
});

const FAILURES = Object.freeze({
  rate_limited: '提交太频繁了，请过一分钟再试。',
  failed: '没有发送成功，请检查网络后重试。',
});

function bindFeedbackForm({ form, send, onSent, limit = 2000 }) {
  const $ = (selector) => form.querySelector(selector);
  const textarea = $('#feedbackText');
  const counter = $('#feedbackCounter');
  const fieldLabel = $('#feedbackFieldLabel');
  const error = $('#feedbackError');
  const submit = $('#feedbackSubmitBtn');
  const kindButtons = Array.from(form.querySelectorAll('[data-feedback-kind]'));
  let kind = 'issue';
  let sending = false;

  function setError(message) {
    error.textContent = message || '';
    error.classList.toggle('hidden', !message);
  }

  function render() {
    const current = KINDS[kind];
    for (const button of kindButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.feedbackKind === kind));
      button.disabled = sending;
    }
    fieldLabel.textContent = current.field;
    textarea.placeholder = current.placeholder;
    textarea.disabled = sending;
    counter.textContent = `${textarea.value.length}/${limit}`;
    submit.disabled = sending || !textarea.value.trim();
    submit.textContent = sending ? '正在发送…' : `发送${current.label}`;
  }

  for (const button of kindButtons) {
    button.addEventListener('click', () => {
      if (sending || !KINDS[button.dataset.feedbackKind]) return;
      kind = button.dataset.feedbackKind;
      setError('');
      render();
    });
  }
  textarea.addEventListener('input', () => {
    setError('');
    render();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = textarea.value.trim();
    if (!message || sending) return;
    sending = true;
    setError('');
    render();
    let result = 'failed';
    try {
      result = await send(kind, message);
    } catch (_) {
      result = 'failed';
    }
    sending = false;
    if (result !== 'sent') {
      setError(FAILURES[result] || FAILURES.failed);
      render();
      return;
    }
    const label = KINDS[kind].label;
    textarea.value = '';
    render();
    onSent?.(label);
  });

  render();
  return {
    focus: () => textarea.focus({ preventScroll: true }),
    reset() {
      if (sending) return;
      setError('');
      render();
    },
  };
}

module.exports = { bindFeedbackForm, FEEDBACK_KINDS: KINDS };
