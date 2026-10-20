// -----------------------------------------------------------------------------
// LinnApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js) and the fake OpenHome device on the loopback interface.
// The background round and the poll interval never fire: the tests drive
// them (only the short timers run: first poll, poll after a command, the
// wake-up checks).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LinnApp, muteIntent, parseVolumeCommand } from '../src/app.js';
import { httpRequest } from '../src/openhome/http.js';
import { NOTHING, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { UDN, startFakeDevice } from './helpers/fakeOpenhome.js';

const SELECTOR = 'linn';
const id = (key) => `ext:${SELECTOR}:openhome:${UDN}${key ? `:${key}` : ''}`;

const pending = new Set();
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => {
    if (ms > 1_000) {
      return { never: true };
    }
    const handle = globalThis.setTimeout(() => {
      pending.delete(handle);
      fn();
    }, ms);
    pending.add(handle);
    return handle;
  },
  clearTimeout: (handle) => {
    if (handle && !handle.never) {
      globalThis.clearTimeout(handle);
      pending.delete(handle);
    }
  },
};

const FAST = { ...TIMINGS, requestTimeout: 400, scanSeconds: 1, wakeCheckDelay: 30 };

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup(
  t,
  { deviceOptions, config = {}, scanResults = {}, timings = {}, request } = {},
) {
  const device = await startFakeDevice(deviceOptions);
  t.after(() => device.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { description_urls: device.location, ...config },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new LinnApp({
    gladys,
    logger,
    timers,
    timings: { ...FAST, ...timings },
    ...(request ? { request } : {}),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  return { device, gladys, app, logs };
}

async function discovered(gladys) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id()),
    'the device in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id());
}

async function createDevice(gladys) {
  const device = await discovered(gladys);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power')) !== undefined, 'the power state');
  await waitFor(() => gladys.fake.lastState(id('title')) !== undefined, 'the title');
  return device;
}

const set = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

test('a typed description URL becomes a Gladys device; its states once created', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await discovered(gladys);
  assert.equal(device.name, 'Kitchen (Majik DSM)');
  assert.deepEqual(device.params, [
    { name: 'LOCATION', value: fake.location },
    { name: 'MANUFACTURER', value: 'Linn' },
  ]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'play',
    'pause',
    'next',
    'previous',
    'playback',
    'source',
    'title',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  assert.ok(
    device.features.every((f) => f.category !== 'switch'),
    'no switch',
  );
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual(byKey.source.supported_options, [
    { value: 'source:0', label: 'Playlist' },
    { value: 'source:1', label: 'Radio' },
    { value: 'source:3', label: 'TV' },
    { value: 'pin:1', label: '1. FIP' },
    { value: 'pin:2', label: '2. Playstation 4' },
    { value: 'pin:4', label: '4. LP12' },
  ]);
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('source')), 'source:0');
  assert.equal(gladys.fake.lastState(id('title')), 'Beastie Boys - Sabotage');
});

test('the volume is capped, the cap read just before sending', async (t) => {
  const { gladys, device: fake, app } = await setup(t, { config: { max_volume: 40 } });
  const device = await createDevice(gladys);
  let ack = await set(gladys, device, 'volume', 35);
  assert.equal(ack.success, true);
  assert.equal(fake.state.volume, 35);
  ack = await set(gladys, device, 'volume', 90);
  assert.equal(ack.success, true);
  assert.equal(fake.state.volume, 40, 'capped');
  app.config.maxVolume = 20;
  await set(gladys, device, 'volume', 30);
  assert.equal(fake.state.volume, 20, 'the new cap applies at once');
  for (const bad of ['', null, '12abc', 12.5, 101, -1]) {
    const refused = await set(gladys, device, 'volume', bad);
    assert.equal(refused.success, false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(fake.state.volume, 20);
});

test('unmuting lowers the volume to the cap first; a press toggles from the state read', async (t) => {
  const { gladys, device: fake } = await setup(t, { config: { max_volume: 25 } });
  const device = await createDevice(gladys);
  fake.state.mute = true;
  fake.state.volume = 80; // set with the knob while muted
  await set(gladys, device, 'mute');
  assert.equal(fake.state.mute, false);
  assert.equal(fake.state.volume, 25);
  const order = fake.calls.filter((c) => /^Volume#Set/.test(c));
  assert.deepEqual(order.slice(-2), ['Volume#SetVolume', 'Volume#SetMute']);
  await set(gladys, device, 'mute');
  assert.equal(fake.state.mute, true);
});

test('power on brings the volume back under the cap; standby is sent', async (t) => {
  const { gladys, device: fake } = await setup(t, { config: { max_volume: 30 } });
  const device = await createDevice(gladys);
  await set(gladys, device, 'standby');
  assert.equal(fake.state.standby, true);
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0 after standby');
  assert.equal(gladys.fake.lastState(id('title')), NOTHING);
  fake.state.volume = 70;
  await set(gladys, device, 'power_on');
  assert.equal(fake.state.standby, false);
  assert.equal(fake.state.volume, 30);
});

test('a source and a pin are selected; a hidden or unknown one is refused', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  let ack = await set(gladys, device, 'source', 'source:3');
  assert.equal(ack.success, true);
  assert.equal(fake.state.sourceIndex, 3);
  ack = await set(gladys, device, 'source', 'pin:4');
  assert.equal(ack.success, true);
  assert.equal(fake.state.invokedPin, 3, 'InvokeIndex is the slot - 1');
  for (const bad of ['source:2', 'source:9', 'pin:3', 'pin:x', '__proto__']) {
    const before = fake.calls.filter((c) => /SetSourceIndex|InvokeIndex/.test(c)).length;
    ack = await set(gladys, device, 'source', bad);
    assert.equal(ack.success, false, bad);
    assert.equal(
      fake.calls.filter((c) => /SetSourceIndex|InvokeIndex/.test(c)).length,
      before,
      `${bad}: nothing sent`,
    );
  }
});

test('a source chosen in standby wakes the device: the cap is applied', async (t) => {
  const { gladys, device: fake } = await setup(t, { config: { max_volume: 20 } });
  const device = await createDevice(gladys);
  fake.state.standby = true;
  fake.state.volume = 60;
  await set(gladys, device, 'source', 'source:1');
  assert.equal(fake.state.sourceIndex, 1);
  await waitFor(() => fake.state.volume === 20, 'the cap after the wake-up');
});

test('transport commands; without a Transport service, the source decides', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { services: ['Product', 'Volume', 'Info', 'Playlist', 'Radio'] },
  });
  const device = await createDevice(gladys);
  await set(gladys, device, 'pause');
  assert.equal(fake.state.transport, 'Paused');
  assert.ok(fake.calls.includes('Playlist#Pause'));
  fake.state.sourceIndex = 1; // Radio
  await set(gladys, device, 'play');
  assert.ok(fake.calls.includes('Radio#Play'));
  const ack = await set(gladys, device, 'next');
  assert.equal(ack.success, false, 'no next on a radio');
});

test('a device without volume service: no volume command sent', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { services: ['Product', 'Transport', 'Info'] },
  });
  const device = await createDevice(gladys);
  const ack = await set(gladys, device, 'volume', 10);
  assert.equal(ack.success, false);
  assert.ok(!fake.calls.some((c) => c.startsWith('Volume#')));
});

test('sent without confirmation, or refused when it cannot start in time', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { delays: { 'Volume#SetVolume': 600 } },
    timings: { commandBudget: 500, requestTimeout: 400 },
  });
  const device = await createDevice(gladys);
  const [volume, pause] = await Promise.all([
    set(gladys, device, 'volume', 10),
    set(gladys, device, 'pause'),
  ]);
  assert.equal(volume.success, false);
  assert.match(JSON.stringify(volume), /Volume sent, without confirmation/);
  assert.ok(fake.calls.includes('Volume#SetVolume'));
  assert.equal(pause.success, false);
  assert.match(JSON.stringify(pause), /busy, nothing sent/);
  assert.ok(!fake.calls.includes('Transport#Pause'), 'never sent late');
});

test('a SOAP fault is reported as refused by the device', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { faults: { 'Product#SetStandby': true } },
  });
  const device = await createDevice(gladys);
  const ack = await set(gladys, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /refused: 401 Invalid Action/);
  assert.equal(fake.state.standby, false);
});

test('an unreachable device: power 0, unreachable badge, spaced retries', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  await createDevice(gladys);
  await fake.close();
  const record = app.records.get(UDN);
  await app.poll(record);
  await app.poll(record);
  assert.equal(record.state, null);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.ok(app.backoff(record.failures) >= TIMINGS.backoffBase);
  assert.match(JSON.stringify(gladys.fake.connectionStatus.message), /Kitchen/);
});

test('every connected republishes the status and the Discovery list', async (t) => {
  const { gladys, app } = await setup(t);
  await createDevice(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/api/v1/integrations/devices/discovered').length;
  await app.start(await gladys.getConfig(), { connected: true });
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status published again');
  const after = gladys.fake.bodies('POST', '/api/v1/integrations/devices/discovered').length;
  assert.ok(after > discoveries || gladys.fake.discoveredDevices.length > 0);
});

test('the buttons answer in English and French', async (t) => {
  const { gladys } = await setup(t);
  await createDevice(gladys);
  const check = await gladys.fake.action('check_devices');
  assert.equal(check.success, true);
  const text = JSON.stringify(check);
  assert.match(text, /Kitchen \(Majik DSM\): on, Playlist, volume 30/);
  assert.match(text, /Plafond de volume : 50 %/);
  const sources = JSON.stringify(await gladys.fake.action('list_sources'));
  assert.match(sources, /4\. LP12/);
  assert.match(sources, /Épingles/);
});

test('SSDP answers outside the LAN are never read', async (t) => {
  const { gladys, logs } = await setup(t, {
    scanResults: {
      ssdp: [
        {
          source_ip: '8.8.8.8',
          source_port: 1900,
          headers: 'HTTP/1.1 200 OK\r\nLOCATION: http://8.8.8.8:80/desc.xml\r\n\r\n',
        },
        {
          source_ip: '192.168.1.30',
          source_port: 1900,
          headers: 'HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:1/desc.xml\r\n\r\n',
        },
      ],
    },
  });
  await discovered(gladys);
  assert.ok(logs.some((l) => /2 SSDP answer\(s\), 1 OpenHome device/.test(l)));
});

test('parseVolumeCommand is strict', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand('42'), 42);
  for (const bad of [null, undefined, '', true, 12.5, '12abc', 101, -1, '1e2']) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test.after(() => {
  for (const handle of pending) {
    globalThis.clearTimeout(handle);
  }
});

// --- Review 1 -----------------------------------------------------------------

const timed = async (promise) => {
  const started = Date.now();
  const result = await promise;
  return { ...result, ms: Date.now() - started };
};

test('Standby during a slow wake-up: never blocked, Power on acked in time', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    config: { max_volume: 50 },
    timings: { requestTimeout: 3_000, wakeCheckDelay: 2_000 },
  });
  const device = await createDevice(gladys);
  fake.state.standby = true;
  fake.state.volume = 80;
  // A slow player: every read of the wake-up check takes 2.8 s.
  for (const key of ['Product#Standby', 'Volume#Volume', 'Volume#SetVolume']) {
    fake.delays[key] = 2_800;
  }
  const on = timed(set(gladys, device, 'power_on'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const off = timed(set(gladys, device, 'standby'));
  const [powerOn, standby] = await Promise.all([on, off]);
  assert.ok(powerOn.ms < 4_000, `Power on acked after ${powerOn.ms} ms`);
  assert.equal(powerOn.success, true);
  assert.equal(standby.success, true, JSON.stringify(standby));
  assert.ok(standby.ms < 1_500, `Standby acked after ${standby.ms} ms`);
  assert.equal(fake.state.standby, true, 'the player is in standby');
});

test('Standby during a slow read of the pins: never blocked', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  for (const key of ['Pins#GetDeviceMax', 'Pins#GetIdArray', 'Pins#ReadList']) {
    fake.delays[key] = 2_500;
  }
  const record = app.records.get(UDN);
  app.timings = { ...app.timings, requestTimeout: 3_000 };
  const reading = app.readLists(record).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const standby = await timed(set(gladys, device, 'standby'));
  assert.equal(standby.success, true, JSON.stringify(standby));
  assert.ok(standby.ms < 1_000, `Standby acked after ${standby.ms} ms`);
  assert.equal(fake.state.standby, true);
  await reading;
});

test('an HTTP 500 after the device acted: "sent, without confirmation"', async (t) => {
  const request = async (options) => {
    const answer = await httpRequest(options);
    return /#SetVolume"$/.test(options.headers?.SOAPACTION ?? '')
      ? { status: 500, text: 'Internal Server Error' }
      : answer;
  };
  const { gladys, device: fake } = await setup(t, { request });
  const device = await createDevice(gladys);
  const ack = await set(gladys, device, 'volume', 40);
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /Volume sent, without confirmation \(SetVolume: HTTP 500\)/);
  assert.equal(fake.state.volume, 40);
});

test('Play on a player in standby that wakes on Play: the cap is applied', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    config: { max_volume: 50 },
    deviceOptions: { wakeOnPlay: true },
  });
  const device = await createDevice(gladys);
  fake.state.standby = true;
  fake.state.volume = 85;
  const ack = await set(gladys, device, 'play');
  assert.equal(ack.success, true);
  assert.equal(fake.state.standby, false);
  await waitFor(() => fake.state.volume === 50, 'the cap after Play');
});

test('mute: 0 unmutes (cap first), a press toggles, nothing sent when already as asked', async (t) => {
  const { gladys, device: fake } = await setup(t, { config: { max_volume: 30 } });
  const device = await createDevice(gladys);
  fake.state.mute = false;
  const before = fake.calls.filter((c) => c === 'Volume#SetMute').length;
  await set(gladys, device, 'mute', 0);
  assert.equal(fake.calls.filter((c) => c === 'Volume#SetMute').length, before, 'nothing sent');
  fake.state.mute = true;
  fake.state.volume = 70;
  await set(gladys, device, 'mute', 0);
  assert.equal(fake.state.mute, false);
  assert.equal(fake.state.volume, 30);
  await set(gladys, device, 'mute', 1);
  assert.equal(fake.state.mute, true, 'a press toggles');
  assert.equal(muteIntent('0'), 'unmute');
  assert.equal(muteIntent(1), 'toggle');
  assert.equal(muteIntent(null), 'toggle');
});

test('a pin set again on the device since the list was read is refused', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  fake.state.pinSlots[3] = 9;
  fake.state.pins[9] = { id: 9, title: 'Other' };
  const ack = await set(gladys, device, 'source', 'pin:4');
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /pin 4 changed on the device, nothing sent/);
  assert.ok(!fake.calls.includes('Pins#InvokeIndex'));
});

test('a device whose VolumeMax is not 100: the volume and the cap are scaled', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    config: { max_volume: 50 },
    deviceOptions: { volumeMax: 50 },
  });
  fake.state.volume = 15;
  const device = await createDevice(gladys);
  await waitFor(() => gladys.fake.lastState(id('volume')) === 30, 'the volume in percent');
  await set(gladys, device, 'volume', 90);
  assert.equal(fake.state.volume, 25, '50 % of 50 steps');
});

test('records neither created nor seen again are forgotten', async (t) => {
  const { gladys, app } = await setup(t);
  await discovered(gladys);
  assert.equal(app.records.size, 1);
  await app.start({ description_urls: '' });
  assert.equal(app.records.size, 0);
});

test('"Check the players" stops at its time limit', async (t) => {
  const { gladys, device: fake } = await setup(t, { timings: { checkBudget: 300 } });
  await createDevice(gladys);
  fake.delays['Product#Standby'] = 350;
  const check = JSON.stringify(await gladys.fake.action('check_devices'));
  assert.match(check, /not read|pas de réponse/);
});
