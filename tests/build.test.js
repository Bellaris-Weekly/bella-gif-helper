'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../scripts/build.mjs');
const header = fs.readFileSync(path.join(__dirname, '..', 'src', 'header.txt'), 'utf8');
const config = (domain) => ({ LOG_SERVICE_CONFIG: JSON.stringify({ worker: { domain } }) });

test('the committed (non-release) build carries no log endpoint and an unchanged header', async () => {
  const { resolveLogService, userscriptBuildOptions } = await load();
  assert.deepEqual(resolveLogService({ header, env: config('logs.example.com') }), { endpoint: '', header });
  const options = userscriptBuildOptions({ write: false, env: config('logs.example.com') });
  assert.equal(options.define.__LOG_SERVICE_ENDPOINT__, '""');
  assert.equal(options.minify, false);
});

test('release builds inject the endpoint and a matching @connect inside the metadata block', async () => {
  const { resolveLogService } = await load();
  const result = resolveLogService({ release: true, header, env: config('logs.example.com') });
  assert.equal(result.endpoint, 'https://logs.example.com/v1/logs');
  const lines = result.header.split('\n');
  const connect = lines.indexOf('// @connect      logs.example.com');
  assert.ok(connect > 0);
  assert.match(lines[connect - 1], /^\/\/ @connect\s+/);
  assert.ok(connect < lines.indexOf('// ==/UserScript=='));
  assert.equal(result.header.split('\n').length, header.split('\n').length + 1);
  // @match and the dependency @resource lines stay untouched.
  const pick = (text, key) => text.split('\n').filter((line) => line.startsWith(`// @${key}`));
  for (const key of ['match', 'resource', 'version', 'updateURL', 'downloadURL']) {
    assert.deepEqual(pick(result.header, key), pick(header, key));
  }
  const again = resolveLogService({ release: true, header: result.header, env: config('logs.example.com') });
  assert.equal(again.header, result.header, '@connect is not duplicated');
});

test('release builds fail loudly on a missing or malformed secret', async () => {
  const { resolveLogService } = await load();
  assert.throws(() => resolveLogService({ release: true, header, env: {} }), /LOG_SERVICE_CONFIG/);
  assert.throws(() => resolveLogService({ release: true, header, env: { LOG_SERVICE_CONFIG: '{' } }), /LOG_SERVICE_CONFIG/);
  for (const domain of ['https://logs.example.com', 'logs.example.com/v1', 'localhost', 'user@logs.example.com', 'Logs.Example.com']) {
    assert.throws(() => resolveLogService({ release: true, header, env: config(domain) }), /domain/, domain);
  }
});
