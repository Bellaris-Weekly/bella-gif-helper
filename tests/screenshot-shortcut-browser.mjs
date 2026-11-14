// Run after both repos build: node tests/screenshot-shortcut-browser.mjs <clip-repo> <chromium>
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

const clipRoot = resolve(process.argv[2]);
const {chromium} = createRequire(join(clipRoot, 'package.json'))('playwright-core');
const gifRoot = resolve(new URL('..', import.meta.url).pathname);
const artifacts = process.env.BELLA_TEST_ARTIFACTS || '/tmp/bella-shortcut-browser';
mkdirSync(artifacts, {recursive: true});
assert.equal(readFileSync(join(gifRoot, 'src/screenshot-shortcut.js'), 'utf8').replace("'use strict';\n\n", '').replace('module.exports = {', 'export {'),
  readFileSync(join(clipRoot, 'src/ui/screenshot-shortcut.js'), 'utf8'), 'both plugins must ship the same protocol');
const sources = {
  gif: readFileSync(join(gifRoot, 'bella-gif-helper.user.js'), 'utf8'),
  clip: readFileSync(join(clipRoot, 'bella-live-clip.user.js'), 'utf8'),
  oldGif: execFileSync('git', ['show', 'HEAD:bella-gif-helper.user.js'], {cwd: gifRoot, encoding: 'utf8', maxBuffer: 20e6}),
  // Clip doesn't track its bundle; exercise its exact legacy screenshot module.
  oldClip: `(() => {${execFileSync('git', ['show', 'HEAD:src/ui/live-screenshot.js'], {cwd: clipRoot, encoding: 'utf8'}).replace(/export \{[^}]+\};/, '')}
    installLiveScreenshot({rootDocument: document, selectVideo: root => root.querySelector('video'),
      getIdentity: () => ({roomId: '123'}), download: (blob, name) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      }});
  })();`,
};
const media = readFileSync(join(gifRoot, 'tests/fixtures/avc-bframes-fragmented.mp4'));
const fixture = `<!doctype html><meta charset="utf-8"><title>fixture</title>
<style>body{margin:0}.player{position:relative;width:640px;background:black}.player video{width:100%;display:block}
.web-player-icon-feedback{position:absolute;right:0;top:0}.player:fullscreen{width:100vw}.webfull{position:fixed;inset:0;width:100vw!important;z-index:9999}
iframe{width:680px;height:430px;border:0}</style>
<div class="player" id="player"><video id="source" autoplay muted loop playsinline src="/fixture.mp4"></video><div class="web-player-icon-feedback"></div></div>
<input id="typing"><div contenteditable id="editable"></div>`;

const browser = await chromium.launch({executablePath: process.argv[3], headless: true, args: ['--no-sandbox']});
const results = [];
async function makePage({legacy = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture.mp4') return route.fulfill({contentType: 'video/mp4', body: media});
    if (['/123', '/frame', '/activity'].includes(url.pathname)) return route.fulfill({contentType: 'text/html', body: fixture});
    return route.fulfill({status: 404, contentType: 'application/json', body: '{}'});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.goto('https://live.bilibili.com/123');
  await page.evaluate(legacy => {
    window.__stores = {gif: {}, clip: {}};
    if (legacy) {
      localStorage.setItem('biliGifMakerAspectSquareV1', '1');
      localStorage.setItem('biliGifMakerExportPreferencesV1', JSON.stringify({fps: '12', quality: 'bei', cornerRadius: '0'}));
      window.__stores.gif.biliGifMakerShortcutV1 = {code: 'KeyJ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false};
      window.__stores.gif.biliGifMakerPanelGeometry = {width: 410, height: 660};
    }
  }, legacy);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  return {context, page, downloads, errors};
}
async function install(frame, name) {
  const id = name.toLowerCase().includes('gif') ? 'gif' : 'clip';
  await frame.evaluate(({source, id}) => {
    window.__stores ||= {gif: {}, clip: {}};
    const store = window.__stores[id];
    new Function('GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'GM_getResourceText', 'GM_openInTab',
      'GM_registerMenuCommand', 'GM_addValueChangeListener', 'GM_listValues', 'unsafeWindow', source)(
      (key, fallback) => structuredClone(store[key] ?? fallback),
      (key, value) => { store[key] = structuredClone(value); },
      options => { setTimeout(() => options.onload?.({status: 404, responseText: ''}), 0); return {abort() {}}; },
      () => '', () => {}, () => {}, () => 0, () => Object.keys(store), window,
    );
  }, {source: sources[name], id});
}
async function shot(f, key = 'p', frame = f.page) {
  const before = f.downloads.length;
  await frame.locator('body').click({position: {x: 3, y: 3}});
  const downloaded = f.page.waitForEvent('download', {timeout: 5000});
  await f.page.keyboard.press(key);
  await downloaded;
  await f.page.waitForTimeout(100);
  assert.equal(f.downloads.length, before + 1, 'one keypress must download exactly once');
  const download = f.downloads.at(-1);
  assert.match(download.suggestedFilename(), /\.png$/);
  const file = join(artifacts, `shot-${results.length}-${before}.png`);
  await download.saveAs(file);
  const png = readFileSync(file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const size = await frame.locator('#source').evaluate(v => [v.videoWidth, v.videoHeight]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], size);
}

try {
  for (const order of process.argv.includes('--frames-only') ? [] : [['gif'], ['clip'], ['gif', 'clip'], ['clip', 'gif'], ['oldGif', 'clip'], ['oldClip', 'gif'], ['gif', 'oldClip'], ['clip', 'oldGif']]) {
    const f = await makePage();
    for (const name of order) await install(f.page, name);
    await shot(f);
    await f.page.evaluate(() => {
      document.querySelector('.web-player-icon-feedback').style.display = 'none';
      document.querySelector('#player').classList.add('webfull');
    });
    await shot(f);
    await f.page.evaluate(() => document.querySelector('#player').classList.remove('webfull'));
    await f.page.locator('#player').evaluate(el => el.requestFullscreen());
    assert.equal(await f.page.evaluate(() => document.fullscreenElement?.id), 'player');
    await shot(f);
    await f.page.evaluate(() => document.exitFullscreen());
    const cdp = await f.context.newCDPSession(f.page);
    const {windowId} = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}});
    await shot(f);
    await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'normal'}});
    await cdp.detach();
    const before = f.downloads.length;
    await f.page.locator('#typing').fill('p');
    await f.page.locator('#typing').press('p');
    await f.page.locator('#editable').press('p');
    await f.page.waitForTimeout(100);
    assert.equal(f.downloads.length, before);
    assert.deepEqual(f.errors, []);
    results.push({order, normal: true, webFullscreen: true, nativeFullscreen: true, browserFullscreen: true, typing: true});
    await f.context.close();
    console.log('PASS', order.join(' → '));
  }

  if (!process.argv.includes('--frames-only')) {
  const f = await makePage({legacy: true});
  await install(f.page, 'gif'); await install(f.page, 'clip');
  const migration = await f.page.evaluate(() => window.__stores.gif.biliGifMakerPrefsV1);
  assert.equal(migration.aspectSquare, true);
  assert.equal(migration.shortcut.code, 'KeyJ');
  assert.equal(migration.shortcut.ctrlKey, true);
  assert.deepEqual(migration.panelGeometry, {width: 410, height: 660});
  assert.equal(migration.exportPreferences.fps, '12');
  // Open settings without starting recording; exercise real input handlers with trusted keys.
  await f.page.evaluate(() => {
    const root = document.querySelector('#bili-gif-maker-host').shadowRoot;
    root.querySelector('#panel').classList.remove('hidden');
    root.querySelector('#settingsBtn').click();
  });
  const gifField = f.page.locator('#bili-gif-maker-host #screenshotShortcutInput');
  await gifField.focus(); await gifField.press('k');
  assert.equal(await gifField.inputValue(), 'K');
  assert.equal(await f.page.locator('#bella-live-clip-host #screenshotShortcut').inputValue(), 'K');
  await f.page.locator('#bili-gif-maker-host #shortcutInput').focus();
  await f.page.locator('#bili-gif-maker-host #shortcutInput').press('g');
  assert.equal(await f.page.locator('#bili-gif-maker-host #shortcutInput').inputValue(), 'G');
  await f.page.screenshot({path: join(artifacts, 'gif-settings.png')});
  await f.page.evaluate(() => document.querySelector('#bili-gif-maker-host').shadowRoot.querySelector('#closeBtn').click());
  await f.page.locator('#bella-live-clip-host #openPanel').click();
  await f.page.locator('#bella-live-clip-host button[aria-label="设置"]').click();
  const clipField = f.page.locator('#bella-live-clip-host #screenshotShortcut');
  await clipField.focus(); await clipField.press('l');
  assert.equal(await gifField.inputValue(), 'L');
  const clipLauncher = f.page.locator('#bella-live-clip-host #shortcut');
  await clipLauncher.focus(); await clipLauncher.press('c');
  assert.equal(await clipLauncher.inputValue(), 'C');
  await clipField.focus(); await clipField.press('c');
  assert.equal(await gifField.inputValue(), 'L');
  await clipField.press('Escape');
  await f.page.screenshot({path: join(artifacts, 'settings.png')});
  assert.deepEqual(await f.page.evaluate(() => window.__stores.gif.bellaScreenshotShortcutV1),
    await f.page.evaluate(() => window.__stores.clip.bellaScreenshotShortcutV1));
  assert.deepEqual(f.errors, []);
  results.push({settingsSync: true, launcherSingleKeys: true, conflicts: true, legacy14Migration: true});
  await f.context.close();
  console.log('PASS settings, single keys, conflict, 1.4.x profile migration');
  }

  for (const origin of ['https://live.bilibili.com', 'https://www.bilibili.com']) {
    const f = await makePage();
    await f.page.goto(origin + '/activity');
    await install(f.page, 'gif'); await install(f.page, 'clip');
    await f.page.evaluate(() => {
      document.querySelector('#player').remove();
      const frame = document.createElement('iframe');
      frame.id = 'liveFrame'; frame.allowFullscreen = true;
      frame.referrerPolicy = 'no-referrer';
      frame.src = 'https://live.bilibili.com/frame'; document.body.append(frame);
    });
    const child = await f.page.waitForEvent('framenavigated', {predicate: frame => frame.url().endsWith('/frame')});
    await child.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await install(child, 'clip'); await install(child, 'gif');
    await f.page.waitForTimeout(100);
    await shot(f, 'p', child);
    await child.locator('#player').evaluate(el => el.requestFullscreen());
    await shot(f, 'p', child);
    await f.page.evaluate(() => document.exitFullscreen());
    // Key in the parent routes only to its selected player frame.
    await f.page.locator('#typing').focus(); await f.page.locator('#typing').evaluate(el => el.blur());
    const before = f.downloads.length;
    const downloaded = f.page.waitForEvent('download', {timeout: 5000});
    await f.page.keyboard.press('p');
    await downloaded;
    await f.page.waitForTimeout(100);
    assert.equal(f.downloads.length, before + 1);
    await f.page.evaluate(() => {
      const root = document.querySelector('#bili-gif-maker-host').shadowRoot;
      root.querySelector('#panel').classList.remove('hidden');
      root.querySelector('#settingsBtn').click();
    });
    const field = f.page.locator('#bili-gif-maker-host #screenshotShortcutInput');
    await field.focus(); await field.press('j');
    await child.waitForFunction(() => JSON.parse(document.documentElement.getAttribute('data-bella-screenshot-shortcut-v1')).shortcut.code === 'KeyJ');
    await f.page.evaluate(() => document.querySelector('#bili-gif-maker-host').shadowRoot.querySelector('#closeBtn').click());
    await shot(f, 'j', child);
    assert.deepEqual(f.errors, []);
    results.push({iframeOrigin: origin, focus: true, fullscreen: true, parentRouting: true, settingsSync: true});
    await f.context.close();
    console.log('PASS iframe', origin);
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
