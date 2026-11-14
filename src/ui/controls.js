'use strict';

// 面板里的轻量交互控件。
//
// 分段按钮只是原生 <select> 的「皮肤」：select 仍留在 DOM 里作为唯一数据源，
// main.js 继续读写 select.value、监听它的 input/change 事件。
// 按钮带 edit-lockable 类，导出时会被 updateModeUi() 一并锁定。

const SEGMENTED_SELECTOR = 'select[data-segmented]';

// main.js 直接给 select.value 赋值时（恢复偏好、切换文字图层）不会触发事件，
// 赋值后需调用 syncSegmentedSelect(select) 刷新高亮；tests/ui-controls.test.js 会检查这一点。
const syncers = new WeakMap();

function syncSegmentedSelect(select) {
  syncers.get(select)?.();
}

function enhanceSegmentedSelect(select) {
  if (!select || select.dataset.segmentedReady === 'true') return null;
  const doc = select.ownerDocument;
  const group = doc.createElement('div');
  group.className = 'segmented';
  group.setAttribute('role', 'radiogroup');
  const labelledBy = select.id
    ? select.getRootNode().querySelector?.(`label[for="${select.id}"]`)
    : null;
  if (labelledBy) {
    if (!labelledBy.id) labelledBy.id = `${select.id}Label`;
    group.setAttribute('aria-labelledby', labelledBy.id);
  } else if (select.getAttribute('aria-label')) {
    group.setAttribute('aria-label', select.getAttribute('aria-label'));
  }
  select.dataset.segmentedReady = 'true';
  select.classList.add('segmented-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.insertAdjacentElement('afterend', group);

  const buttons = () => Array.from(group.querySelectorAll('.segmented-option'));

  function sync() {
    const current = select.value;
    for (const button of buttons()) {
      const checked = button.dataset.value === current;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }

  function render() {
    // 只替换选项按钮，保留滑块（.segmented-thumb）。
    for (const button of buttons()) button.remove();
    for (const option of Array.from(select.options)) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'segmented-option edit-lockable';
      button.setAttribute('role', 'radio');
      button.dataset.value = option.value;
      button.textContent = option.textContent;
      if (option.title) button.title = option.title;
      button.disabled = select.disabled;
      group.appendChild(button);
    }
    sync();
  }

  function choose(value, focus) {
    const target = buttons().find((button) => button.dataset.value === value);
    if (!target || target.disabled) return;
    if (focus) target.focus();
    if (select.value === value) return;
    select.value = value;
    const EventCtor = doc.defaultView?.Event || Event;
    select.dispatchEvent(new EventCtor('input', { bubbles: true }));
    select.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  group.addEventListener('click', (event) => {
    const button = event.target.closest?.('.segmented-option');
    if (button && group.contains(button)) choose(button.dataset.value, false);
  });

  group.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    const all = buttons();
    let index = all.findIndex((button) => button.dataset.value === select.value);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = all.length - 1;
    else if (step) index = Math.min(all.length - 1, Math.max(0, index + step));
    else return;
    event.preventDefault();
    if (all[index]) choose(all[index].dataset.value, true);
  });

  syncers.set(select, sync);
  select.addEventListener('change', sync);
  select.addEventListener('input', sync);
  const View = doc.defaultView;
  if (View?.MutationObserver) {
    new View.MutationObserver(render).observe(select, { childList: true, subtree: true });
  }
  render();
  return group;
}

function enhanceSegmentedSelects(root) {
  return Array.from(root.querySelectorAll(SEGMENTED_SELECTOR))
    .map(enhanceSegmentedSelect)
    .filter(Boolean);
}

// 面板内的覆盖页（设置、反馈）。openers 切换开关，closers 关闭，Esc 关闭并把焦点还给打开它的按钮。
function bindSheet(sheet, { openers = [], closers = [], onOpen, onClose } = {}) {
  let returnFocus = null;
  const isOpen = () => !sheet.classList.contains('hidden');
  function setOpen(open, opener = null) {
    if (open === isOpen()) return;
    sheet.classList.toggle('hidden', !open);
    for (const button of openers) button.setAttribute('aria-expanded', String(open));
    if (open) {
      returnFocus = opener;
      onOpen?.();
    } else {
      onClose?.();
      const target = returnFocus;
      returnFocus = null;
      target?.focus?.();
    }
  }
  for (const button of openers) {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => setOpen(!isOpen(), button));
  }
  for (const button of closers) button.addEventListener('click', () => setOpen(false));
  sheet.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });
  return { open: (opener) => setOpen(true, opener), close: () => setOpen(false), isOpen };
}

// role="tab" 按钮切换 aria-controls 指向的面板；方向键在页签间移动。
function bindTabs(tablist, { onChange } = {}) {
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const root = tablist.getRootNode();
  const panelOf = (tab) => root.getElementById?.(tab.getAttribute('aria-controls'));
  function select(tab, focus = false) {
    if (!tab) return;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      panelOf(item)?.classList.toggle('hidden', !selected);
    }
    if (focus) tab.focus();
    onChange?.(tab);
  }
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tab && tabs.includes(tab)) select(tab);
  });
  tablist.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    select(tabs[(current + step + tabs.length) % tabs.length], true);
  });
  select(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
  return { select: (id) => select(tabs.find((tab) => tab.id === id)) };
}

// 分段按钮的选中滑块：一个独立的 .segmented-thumb 跟随选中项平移、伸缩（CSS transition）。
// 选中状态仍以按钮的 aria-checked / aria-pressed / aria-selected 为准，这里只观察它们。
// 首次定位、从隐藏变为可见、尺寸变化时直接就位，不播放动画；只有切换选中项才滑动。
const SELECTED = '.segmented-option[aria-checked="true"], .segmented-option[aria-pressed="true"], .segmented-option[aria-selected="true"]';

function animateSegmentedGroup(group) {
  if (!group || group.querySelector(':scope > .segmented-thumb')) return null;
  const doc = group.ownerDocument;
  const View = doc.defaultView;
  const thumb = doc.createElement('span');
  thumb.className = 'segmented-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  group.prepend(thumb);
  group.classList.add('has-thumb');
  let placed = null;
  let frame = 0;

  function place(animate) {
    const selected = group.querySelector(SELECTED);
    const width = selected?.offsetWidth || 0;
    if (!selected || !width) {
      thumb.style.opacity = '0';
      placed = null;
      return;
    }
    const left = selected.offsetLeft;
    const height = selected.offsetHeight;
    const top = selected.offsetTop;
    if (placed && placed.left === left && placed.width === width && placed.top === top && placed.height === height) return;
    const slide = animate && placed !== null;
    thumb.classList.toggle('no-transition', !slide);
    thumb.style.width = `${width}px`;
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translate(${left}px, ${top}px)`;
    thumb.style.opacity = '1';
    placed = { left, width, top, height };
    if (!slide) {
      // 强制一次布局，让下次变化恢复过渡。
      void thumb.offsetWidth;
      thumb.classList.remove('no-transition');
    }
  }

  function schedule(animate) {
    if (frame) View?.cancelAnimationFrame?.(frame);
    const run = () => { frame = 0; place(animate); };
    frame = View?.requestAnimationFrame ? View.requestAnimationFrame(run) : (run(), 0);
  }

  if (View?.MutationObserver) {
    new View.MutationObserver(() => schedule(true)).observe(group, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-checked', 'aria-pressed', 'aria-selected', 'disabled'],
    });
  }
  if (View?.ResizeObserver) new View.ResizeObserver(() => schedule(false)).observe(group);
  place(false);
  return { place };
}

function animateSegmentedGroups(root) {
  return Array.from(root.querySelectorAll('.segmented')).map(animateSegmentedGroup).filter(Boolean);
}

module.exports = {
  enhanceSegmentedSelects,
  enhanceSegmentedSelect,
  syncSegmentedSelect,
  animateSegmentedGroups,
  bindSheet,
  bindTabs,
};
