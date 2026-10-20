import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseBounded, parseUrls } from '../src/config.js';
import { MAX_VOLUME, POLL_INTERVAL } from '../src/constants.js';

test('defaults', () => {
  assert.deepEqual(normalizeConfig(), {
    urls: [],
    invalid: [],
    maxVolume: MAX_VOLUME.default,
    pollInterval: POLL_INTERVAL.default * 1000,
  });
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), normalizeConfig({}));
});

test('the volume cap and the interval are bounded integers', () => {
  assert.equal(parseBounded('30', MAX_VOLUME), 30);
  assert.equal(parseBounded(0, MAX_VOLUME), 1);
  assert.equal(parseBounded(250, MAX_VOLUME), 100);
  assert.equal(parseBounded(33.6, MAX_VOLUME), 34);
  for (const bad of ['', '  ', null, undefined, true, 'abc', NaN]) {
    assert.equal(parseBounded(bad, MAX_VOLUME), MAX_VOLUME.default, String(bad));
  }
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 5_000);
  assert.equal(normalizeConfig({ poll_interval: 9_999 }).pollInterval, 300_000);
});

test('description URLs: plain http with a path, invalid ones by position', () => {
  assert.deepEqual(
    parseUrls(
      'http://192.168.1.30:55178/a/Upnp/device.xml, https://x/y ftp://x/y\nhttp://192.168.1.30:55178/a/Upnp/device.xml http://x/ http://u:p@x/d.xml',
    ),
    { urls: ['http://192.168.1.30:55178/a/Upnp/device.xml'], invalid: [2, 3, 5, 6] },
  );
  assert.equal(
    parseUrls(
      Array(50)
        .fill('http://h/d.xml')
        .map((u, i) => `${u}?${i}`)
        .join(' '),
    ).urls.length,
    20,
  );
});
