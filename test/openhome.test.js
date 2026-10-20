// -----------------------------------------------------------------------------
// The protocol layer, pure parts and the HTTP transport on the loopback
// interface: XML hardening, SOAP envelopes and faults, descriptions, SSDP
// answers, the OpenHome values (source list, DIDL-Lite, pins).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../src/constants.js';
import {
  deviceIdOf,
  isLanIPv4,
  parseDescription,
  parseLocation,
  parseSsdpHeaders,
  ssdpLocations,
} from '../src/openhome/description.js';
import { OpenhomeError } from '../src/openhome/errors.js';
import { decode, httpRequest } from '../src/openhome/http.js';
import {
  parseBool,
  parseIdArray,
  parseMetatext,
  parsePins,
  parseSourceXml,
  parseTrack,
  parseUint,
  playbackOf,
} from '../src/openhome/parse.js';
import { buildEnvelope, parseResponse } from '../src/openhome/soap.js';
import { XmlError, find, parseXml, textOf } from '../src/openhome/xml.js';
import { SOURCE_XML, TRACK, UDN, description } from './helpers/fakeOpenhome.js';

test('XML: a DOCTYPE or an entity declaration is refused, never expanded', () => {
  const bombs = [
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><a>&lol2;</a>',
    '<!DOCTYPE a SYSTEM "http://evil.example/x.dtd"><a/>',
    '<!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>',
  ];
  for (const xml of bombs) {
    assert.throws(() => parseXml(xml), XmlError);
  }
  // An unknown entity stays as written: nothing is looked up.
  assert.equal(textOf(parseXml('<a>&xxe; &amp; &#65;</a>')), '&xxe; & A');
});

test('XML: bounded depth, size and node count; attributes without prototype', () => {
  assert.throws(() => parseXml(`${'<a>'.repeat(100)}x`), /nested too deeply/);
  assert.throws(() => parseXml('<a/>'.padEnd(2_000, ' '), { maxLength: 1_000 }), /too large/);
  assert.throws(() => parseXml(`<r>${'<a/>'.repeat(20_001)}</r>`), /too many elements/);
  const el = parseXml('<a __proto__="x" constructor="y"/>');
  assert.equal(Object.getPrototypeOf(el.attrs), null);
  assert.equal({}.polluted, undefined);
  // Linear time on a pathological input.
  const started = Date.now();
  assert.throws(() => parseXml('<'.repeat(200_000)));
  assert.ok(Date.now() - started < 1_000);
});

test('SOAP: the envelope escapes its arguments; names are checked', () => {
  const xml = buildEnvelope('urn:av-openhome-org:service:Pins:1', 'ReadList', {
    Ids: '[1,2]<&>',
  });
  assert.match(xml, /<u:ReadList xmlns:u="urn:av-openhome-org:service:Pins:1">/);
  assert.match(xml, /<Ids>\[1,2\]&lt;&amp;&gt;<\/Ids>/);
  assert.throws(() => buildEnvelope('t', 'Bad Action'), OpenhomeError);
  assert.throws(() => buildEnvelope('t', 'Ok', { 'a><b': 1 }), OpenhomeError);
});

test('SOAP: out arguments, faults, unusable answers', () => {
  const ok =
    '<s:Envelope xmlns:s="x"><s:Body><u:VolumeResponse xmlns:u="y"><Value>42</Value></u:VolumeResponse></s:Body></s:Envelope>';
  const out = parseResponse('Volume', ok, 200);
  assert.equal(out.Value, '42');
  assert.equal(Object.getPrototypeOf(out), null);
  const fault =
    '<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>802</errorCode><errorDescription>Out of range</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
  assert.throws(
    () => parseResponse('SetVolume', fault, 500),
    (err) => err.code === 'fault' && err.upnpCode === '802' && /Out of range/.test(err.message),
  );
  assert.throws(
    () => parseResponse('Volume', 'not xml', 200),
    (err) => err.code === 'answer',
  );
  assert.throws(
    () => parseResponse('Volume', '<html/>', 404),
    (err) => err.code === 'status',
  );
  assert.throws(
    () => parseResponse('Volume', '<!DOCTYPE x><x/>', 200),
    (err) => err.code === 'answer',
  );
});

test('description: the OpenHome services, on the host of the description only', () => {
  const info = parseDescription(description(), 'http://192.168.1.30:55178/desc.xml');
  assert.equal(info.id, UDN);
  assert.equal(info.friendlyName, 'Kitchen');
  assert.equal(info.modelName, 'Majik DSM');
  assert.deepEqual(Object.keys(info.services).sort(), [
    'Info',
    'Pins',
    'Playlist',
    'Product',
    'Radio',
    'Transport',
    'Volume',
  ]);
  assert.equal(
    info.services.Volume.controlUrl.href,
    `http://192.168.1.30:55178/${UDN}/av.openhome.org-Volume/control`,
  );
  // A control URL on another host is dropped; without Product, no device.
  const elsewhere = description().replace(
    `<controlURL>/${UDN}/av.openhome.org-Product/control`,
    '<controlURL>http://10.0.0.9/steal',
  );
  assert.equal(parseDescription(elsewhere, 'http://192.168.1.30:55178/desc.xml'), undefined);
  // A plain DLNA renderer is not an OpenHome device.
  const dlna = description({ services: [] });
  assert.equal(parseDescription(dlna, 'http://192.168.1.30:1/d.xml'), undefined);
});

test('description: the real Linn fixture of openhomedevice', () => {
  const xml = readFileSync(new URL('./fixtures/linndescription.xml', import.meta.url), 'latin1');
  const info = parseDescription(xml, 'http://mydevice:12345/desc.xml');
  assert.equal(info.id, '4c494e4e-1234-ab12-abcd-01234567819f');
  assert.equal(info.services.Product.version, 4);
  assert.ok(info.services.Pins && info.services.Transport && info.services.Info);
});

test('SSDP: only http locations on the LAN address that answered', () => {
  const answer = (ip, location) => ({
    source_ip: ip,
    source_port: 1900,
    headers: `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLocation: ${location}\r\nST: upnp:rootdevice\r\n\r\n`,
  });
  assert.deepEqual(
    ssdpLocations([
      answer('192.168.1.30', 'http://192.168.1.30:55178/desc.xml'),
      answer('192.168.1.30', 'http://192.168.1.30:55178/desc.xml'),
      answer('192.168.1.31', 'http://192.168.1.99/desc.xml'),
      answer('192.168.1.32', 'https://192.168.1.32/desc.xml'),
      answer('8.8.8.8', 'http://8.8.8.8/desc.xml'),
      answer('127.0.0.1', 'http://127.0.0.1/desc.xml'),
      answer('169.254.169.254', 'http://169.254.169.254/latest'),
      { source_ip: '10.0.0.2' },
      null,
    ]),
    ['http://192.168.1.30:55178/desc.xml'],
  );
  const many = Array.from({ length: 200 }, (_, i) =>
    answer('10.0.0.2', `http://10.0.0.2/${i}.xml`),
  );
  assert.ok(ssdpLocations(many).length <= LIMITS.descriptions);
  const headers = parseSsdpHeaders('HTTP/1.1 200 OK\r\n__proto__: x\r\nLOCATION: y\r\n');
  assert.equal(headers.location, 'y');
  assert.equal(Object.getPrototypeOf(headers), null);
});

test('addresses and identifiers', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1']) {
    assert.ok(isLanIPv4(ip), ip);
  }
  for (const ip of [
    '8.8.8.8',
    '127.0.0.1',
    '172.32.0.1',
    '169.254.169.254',
    '192.168.1.255',
    'x',
  ]) {
    assert.ok(!isLanIPv4(ip), ip);
  }
  assert.equal(parseLocation('ftp://x/y'), undefined);
  assert.equal(parseLocation('http://user:pw@x/y'), undefined);
  assert.equal(deviceIdOf(`uuid:${UDN.toUpperCase()}`), UDN);
  assert.equal(deviceIdOf('uuid:__proto__'), undefined);
  assert.equal(deviceIdOf('uuid:a b'), undefined);
});

test('values: booleans and numbers are strict', () => {
  assert.equal(parseBool('true'), true);
  assert.equal(parseBool('1'), true);
  assert.equal(parseBool('False'), false);
  assert.equal(parseBool(''), undefined);
  assert.equal(parseUint('42'), 42);
  assert.equal(parseUint(''), undefined, "'' is not 0");
  assert.equal(parseUint('-1'), undefined);
  assert.equal(parseUint('1e3'), undefined);
  assert.equal(playbackOf('Buffering'), 'playing');
  assert.equal(playbackOf('Paused'), 'paused');
  assert.equal(playbackOf('Waiting'), 'stopped');
  assert.equal(playbackOf('Weird'), undefined);
});

test('values: source list, track metadata, radio text', () => {
  assert.deepEqual(parseSourceXml(SOURCE_XML), [
    { index: 0, name: 'Playlist', type: 'Playlist', visible: true },
    { index: 1, name: 'Radio', type: 'Radio', visible: true },
    { index: 2, name: 'UPnP AV', type: 'UpnpAv', visible: false },
    { index: 3, name: 'TV', type: 'Hdmi', visible: true },
  ]);
  // AURALiC writes <Visible>1</Visible>.
  assert.equal(
    parseSourceXml(
      '<SourceList><Source><Name>A</Name><Type>Analog</Type><Visible>1</Visible></Source></SourceList>',
    )[0].visible,
    true,
  );
  assert.equal(parseSourceXml('<!DOCTYPE x><x/>'), undefined);
  assert.deepEqual(parseTrack(TRACK), {
    title: 'Sabotage',
    artist: 'Beastie Boys',
    album: 'Ill Communication',
  });
  assert.deepEqual(parseTrack('garbage <'), {});
  assert.deepEqual(parseTrack(''), {});
  assert.equal(parseMetatext('Now: Song'), 'Now: Song');
  assert.equal(parseMetatext(''), undefined);
  assert.equal(parseTrack('<x>\u0001ctrl</x>').title, undefined);
});

test('values: pins from GetIdArray and ReadList', () => {
  const ids = parseIdArray('[1,2,0,3,0,0]');
  const list = JSON.stringify([
    { id: 1, title: 'Sky' },
    { id: 2, title: 'Playstation 4' },
    { id: 3, title: 'LP12', __proto__: { polluted: true } },
  ]);
  assert.deepEqual(parsePins(ids, list, 6), [
    { index: 1, id: 1, title: 'Sky' },
    { index: 2, id: 2, title: 'Playstation 4' },
    { index: 4, id: 3, title: 'LP12' },
  ]);
  assert.equal(parsePins(ids, 'not json', 6), undefined);
  assert.equal(parseIdArray('{"a":1}'), undefined);
  assert.deepEqual(parseIdArray('[1,"x",-3]'), [1, 0, 0]);
  assert.equal({}.polluted, undefined);
});

test('HTTP: size cap, no redirect, deadline, Latin-1 declaration', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      res.end('x'.repeat(10_000));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.com/' });
      res.end();
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
    } else {
      res.writeHead(200);
      res.end(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9</a>', 'latin1'));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    httpRequest({ url: new URL(`${base}/big`), maxBytes: 1_000 }),
    (err) => err.code === 'too_large' && err.maybeSent === true,
  );
  await assert.rejects(
    httpRequest({ url: new URL(`${base}/redirect`), maxBytes: 1_000 }),
    (err) => err.code === 'redirect' && err.maybeSent === true,
  );
  await assert.rejects(
    httpRequest({ url: new URL(`${base}/slow`), maxBytes: 1_000, timeout: 100 }),
    (err) => err.code === 'timeout' && err.unreachable,
  );
  await assert.rejects(
    httpRequest({ url: new URL('https://127.0.0.1/'), maxBytes: 1_000 }),
    (err) => err.code === 'refused',
  );
  const { text } = await httpRequest({ url: new URL(`${base}/latin`), maxBytes: 1_000 });
  assert.equal(textOf(parseXml(text)), 'café');
  assert.equal(decode(Buffer.from('<a>é</a>')), '<a>é</a>');
  assert.equal(find(parseXml('<a><b><c>1</c></b></a>'), 'c').children[0], '1');
});

test('XML: 256k `&` without `;` stay linear, in a text and in an attribute', () => {
  const amps = '&'.repeat(256 * 1024);
  for (const xml of [`<a>${amps}</a>`, `<a b="${amps}"/>`]) {
    const started = Date.now();
    parseXml(xml);
    const ms = Date.now() - started;
    assert.ok(ms < 250, `${ms} ms`);
  }
  assert.equal(textOf(parseXml('<a>&amp;&#x41;&lt;&unknown;&</a>')), '&A<&unknown;&');
});

test('SOAP: only a 200 is a success; an answer after the request means maybe sent', () => {
  const ok =
    '<s:Envelope xmlns:s="x"><s:Body><u:SetVolumeResponse xmlns:u="y"></u:SetVolumeResponse></s:Body></s:Envelope>';
  assert.equal(Object.keys(parseResponse('SetVolume', ok, 200)).length, 0);
  assert.throws(
    () => parseResponse('SetVolume', ok, 500),
    (err) => err.code === 'status' && err.maybeSent === true,
  );
  assert.throws(
    () => parseResponse('SetVolume', 'Internal Server Error', 500),
    (err) => err.code === 'status' && err.maybeSent === true,
  );
  assert.throws(
    () => parseResponse('SetVolume', '<x/>', 200),
    (err) => err.code === 'answer' && err.maybeSent === true,
  );
});
