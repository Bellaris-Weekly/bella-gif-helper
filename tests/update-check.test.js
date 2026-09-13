'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, readRemoteVersion, bindVersionButton } = require('../src/update-check');
const header = version => `// ==UserScript==\n// @version ${version}\n// ==/UserScript==\n`;
function setup() {
  const attrs = {};
  const classes = new Set();
  let click;
  const button = {
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attrs[name] = value; },
    addEventListener(name, handler) { assert.equal(name, 'click'); click = handler; },
  };
  const requests = [];
  const tabs = [];
  bindVersionButton({ button, version: '1.5.12', updateUrl: 'https://example.com/app.user.js', downloadUrl: 'https://example.com/app.user.js', request: r => requests.push(r), openTab: (...args) => tabs.push(args) });
  return { button, attrs, classes, requests, tabs, click: () => click() };
}
test('version ordering handles numeric components, releases and multiple prerelease labels', () => {
  for (const [a,b,result] of [
    ['1.5.12','1.5.9',1], ['1.10.0','1.9.99',1], ['2.0','1.99.0',1],
    ['1.5.12','1.5.12',0], ['1.5.12','1.6.0',-1], ['1.5','1.5.0',0],
    ['1.6.0','1.6.0-beta.2',1], ['1.6.0-beta.10','1.6.0-beta.2',1],
    ['1.6.0-alpha','1.6.0-beta',-1], ['1.6.0+build.2','1.6.0+build.3',0],
    ['1.6.0-beta','1.6.0-beta.1',-1],
  ]) assert.equal(compareVersions(a,b), result, `${a} / ${b}`);
});
test('only valid userscript metadata provides a remote version', () => {
  assert.equal(readRemoteVersion(header('1.6.0')), '1.6.0');
  assert.equal(readRemoteVersion(header('2.0.0-rc.1').replaceAll('\n','\r\n')), '2.0.0-rc.1');
  for (const source of ['<html>error</html>', '// @version 9.0.0', header('nope'), header('')]) assert.throws(() => readRemoteVersion(source));
});
test('startup checks silently, deduplicates clicks, and available update opens only on click', () => {
  const s = setup();
  assert.equal(s.button.textContent, 'v1.5.12');
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].anonymous, true);
  assert.equal(s.requests[0].timeout, 15000);
  s.click(); s.click();
  assert.equal(s.requests.length, 1);
  s.requests[0].onload({status:200,responseText:header('1.5.13')});
  assert.equal(s.tabs.length, 0);
  assert.ok(s.classes.has('update-available'));
  assert.match(s.attrs['aria-label'], /1.5.13/);
  s.click();
  assert.deepEqual(s.tabs, [['https://example.com/app.user.js', {active:true,insert:true}]]);
});
test('same and older versions remain neutral and clicks recheck', () => {
  for (const remote of ['1.5.12', '1.5.11', '1.5.12-beta.1']) {
    const s = setup();
    s.requests[0].onload({status:200,responseText:header(remote)});
    assert.equal(s.classes.has('update-available'), false);
    assert.equal(s.attrs['aria-busy'], 'false');
    s.click();
    assert.equal(s.requests.length, 2);
    assert.equal(s.tabs.length, 0);
  }
});
test('HTTP, invalid metadata, timeout and network failures all permit retry without update badges', () => {
  for (const fail of [r=>r.onload({status:503,responseText:header('9.0.0')}),r=>r.onload({status:200,responseText:'<html>error</html>'}),r=>r.onerror(),r=>r.ontimeout(),r=>r.onabort()]) {
    const s = setup(); fail(s.requests[0]);
    assert.match(s.button.title, /失败/);
    assert.equal(s.classes.size, 0);
    assert.equal(s.attrs['aria-busy'], 'false');
    s.click(); assert.equal(s.requests.length, 2);
    s.requests[1].onload({status:200,responseText:header('2.0.0')});
    assert.ok(s.classes.has('update-available'));
  }
});
