'use strict';

function parseVersion(version) {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error('无效版本号');
  return { core: match[1].split('.').map(BigInt), pre: match[2]?.split('.') || [] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const x = a.core[i] ?? 0n;
    const y = b.core[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length) - Math.sign(a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function readRemoteVersion(source) {
  const header = /^\s*\/\/ ==UserScript==\s*\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m.exec(source);
  const version = header?.[1].match(/^\/\/\s*@version\s+(\S+)\s*$/m)?.[1];
  if (!version) throw new Error('更新响应缺少版本号');
  parseVersion(version);
  return version;
}

function bindVersionButton({ button, version, updateUrl, downloadUrl, request, openTab }) {
  let latest = null;
  let checking = false;
  function render(message = '') {
    button.textContent = `v${version}`;
    button.classList.toggle('update-available', latest !== null);
    button.setAttribute('aria-busy', String(checking));
    button.title = latest
      ? `发现新版本 v${latest}，点击更新（在安装页确认后刷新本页）`
      : message || `当前版本 v${version}，点击检查更新`;
    button.setAttribute('aria-label', button.title);
  }
  function check() {
    if (checking) return;
    checking = true;
    render('正在检查更新…');
    function fail() {
      checking = false;
      render('检查失败，点击重试');
    }
    try {
      request({
        method: 'GET',
        url: `${updateUrl}${updateUrl.includes('?') ? '&' : '?'}_check=${Date.now()}`,
        anonymous: true,
        timeout: 15000,
        onload(response) {
          try {
            if (response.status !== 200) throw new Error('更新请求失败');
            const remote = readRemoteVersion(response.responseText);
            latest = compareVersions(remote, version) > 0 ? remote : null;
            checking = false;
            render('已是最新版本，点击重新检查');
          } catch (_) { fail(); }
        },
        onerror: fail,
        ontimeout: fail,
        onabort: fail,
      });
    } catch (_) { fail(); }
  }
  button.addEventListener('click', () => {
    if (latest) {
      try { openTab(downloadUrl, { active: true, insert: true }); }
      catch (_) { button.title = '无法打开更新页，请重试'; }
    } else check();
  });
  render();
  check();
}

module.exports = { compareVersions, readRemoteVersion, bindVersionButton };
