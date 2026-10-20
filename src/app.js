// -----------------------------------------------------------------------------
// The integration: the OpenHome devices it knows (an SSDP search through the
// Gladys core, the description URLs typed by the user, the devices already
// created), one poll loop per created device (the container has no inbound
// port, so no UPnP eventing), the Gladys devices built from them, the
// commands (validated before anything is sent, the volume capped by the
// configuration, one request at a time per device, each command within the
// 5 s Gladys waits for its ack) and the configuration buttons.
// index.js only wires the SDK handlers to it (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { DEVICE_TYPE, FEATURES, LIMITS, SERVICES, SSDP_ST, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { buildDevice, deviceName, featureKey, parseOption, stateList } from './model.js';
import { OpenhomeClient, readDescription } from './openhome/client.js';
import { deviceIdOf, parseLocation, ssdpLocations } from './openhome/description.js';
import { OpenhomeError } from './openhome/errors.js';
import { httpRequest } from './openhome/http.js';
import { DeviceQueue } from './queue.js';

export { SSDP_ST };

/** Commands that go before the other commands waiting: quieting down never waits. */
const URGENT = new Set([FEATURES.STANDBY, FEATURES.MUTE]);

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A command error that tells exactly what happened to the request. */
export class CommandError extends Error {
  constructor(message, { sent = false } = {}) {
    super(message);
    this.name = 'CommandError';
    this.sent = sent;
  }
}

export class LinnApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'linn' }),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    request = httpRequest,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.request = request;
    this.config = normalizeConfig();
    /** device id (UDN) -> record (see recordOf) */
    this.records = new Map();
    /** device ids created in Gladys */
    this.created = new Set();
    this.started = false;
    this.generation = 0;
    this.tickTimer = undefined;
    this.lastStatus = undefined;
    this.lastAutoScan = -Infinity;
    this.scanning = undefined;
    this.warned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The poll loops are kept (a reconnection to
   * Gladys never makes the devices asked faster); what was "already
   * published" is forgotten, since the core forgot it too: the status and
   * the Discovery list are published again.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (this.config.invalid.length > 0) {
      this.logger.warn(`Description URLs ignored at position ${this.config.invalid.join(', ')}`);
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('search the devices', () => this.scan());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const record of this.records.values()) {
      this.stopPolling(record);
      this.cancelWakeCheck(record);
    }
    return Promise.resolve();
  }

  /** The background round: the automatic search for a lost device, the status. */
  tick() {
    return Promise.resolve()
      .then(() => this.autoScan())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Known devices -----------------------------------------------------------

  /** A record from a description: the device, its client, its queue, its last poll. */
  recordOf(info) {
    let record = this.records.get(info.id);
    if (!record) {
      if (this.records.size >= LIMITS.devices * 2) {
        return undefined;
      }
      record = {
        id: info.id,
        sources: [],
        pins: [],
        listsAt: -Infinity,
        queue: new DeviceQueue(),
        state: undefined,
        failures: 0,
        timer: undefined,
        polling: false,
        counters: undefined,
        track: undefined,
        radioText: undefined,
        wake: undefined,
      };
      this.records.set(info.id, record);
    }
    if (record.location && record.location !== info.location) {
      this.logger.info(`${deviceName(record)}: new description address`);
    }
    record.location = info.location;
    record.name = info.friendlyName ?? record.name;
    record.model = info.modelName ?? record.model;
    record.manufacturer = info.manufacturer ?? record.manufacturer;
    record.client = new OpenhomeClient(info, { request: this.request });
    return record;
  }

  externalId(record) {
    return this.gladys.externalIds(DEVICE_TYPE, record.id).device;
  }

  /** The record of a Gladys device, by its external id. */
  recordOfDevice(device) {
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const id = String(device?.external_id ?? '').startsWith(prefix)
      ? String(device.external_id).slice(prefix.length)
      : undefined;
    return id ? this.records.get(id) : undefined;
  }

  /** The created devices, from what Gladys keeps (the SDK holds `gladys.devices` up to date). */
  async refreshCreated() {
    await this.gladys.getDevices().catch((err) => {
      this.logger.warn(`Reading the Gladys devices failed: ${err.message}`);
    });
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const created = new Map();
    for (const device of this.gladys.devices ?? []) {
      const id = String(device.external_id ?? '').startsWith(prefix)
        ? deviceIdOf(device.external_id.slice(prefix.length))
        : undefined;
      if (id && created.size < LIMITS.devices) {
        const location = (device.params ?? []).find((p) => p.name === 'LOCATION')?.value;
        created.set(id, { name: device.name, location });
      }
    }
    this.created = new Set(created.keys());
    // A created device never read since the start: its description, from its params.
    await mapLimit(
      [...created].filter(([id, c]) => !this.records.get(id)?.client && parseLocation(c.location)),
      this.timings.scanConcurrency,
      ([id, c]) => this.describe(c.location, id).catch(() => undefined),
    );
    for (const record of this.records.values()) {
      if (this.created.has(record.id) && record.client) {
        this.startPolling(record);
      } else {
        this.stopPolling(record);
      }
    }
  }

  async deviceCreated(device) {
    await this.refreshCreated();
    const record = this.recordOfDevice(device);
    if (record) {
      this.schedulePoll(record, 0);
    }
    await this.updateStatus();
  }

  async deviceDeleted() {
    await this.refreshCreated();
    await this.updateStatus();
  }

  // --- Discovery ---------------------------------------------------------------

  /** Read one description; only an OpenHome device with the expected id (if given) is kept. */
  async describe(location, expectedId) {
    const info = await readDescription(location, {
      request: this.request,
      timeout: this.timings.requestTimeout,
    });
    if (!info || (expectedId && info.id !== expectedId)) {
      return undefined;
    }
    const record = this.recordOf(info);
    if (record && this.now() - record.listsAt >= this.timings.listsTtl) {
      await this.readLists(record).catch((err) =>
        this.logger.debug?.(`${deviceName(record)}: lists unavailable (${err.message})`),
      );
    }
    return record;
  }

  /** The source list and the pins, through the queue of the device. */
  async readLists(record) {
    const sources = await record.queue.run(() => record.client.sources(this.requestOptions()));
    const pins = await record.queue
      .run(() => record.client.pins(this.requestOptions()))
      .catch(() => record.pins);
    record.sources = sources;
    record.pins = pins;
    record.listsAt = this.now();
  }

  requestOptions(timeout = this.timings.requestTimeout) {
    return { timeout };
  }

  /**
   * Search the network (SSDP through the core), read the descriptions found,
   * the URLs typed and those of the created devices, publish the Discovery
   * list. One search at a time.
   */
  scan() {
    if (!this.scanning) {
      this.scanning = this.doScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async doScan() {
    let answers = [];
    try {
      answers = await this.gladys.scanNetwork('ssdp', {
        timeoutSeconds: this.timings.scanSeconds,
      });
    } catch (err) {
      this.warnOnce(
        `scan:${err.message}`,
        `SSDP search unavailable (${err.message}): only the typed URLs and the created devices are read`,
      );
    }
    const locations = [
      ...new Set([
        ...ssdpLocations(answers),
        ...this.config.urls,
        ...[...this.records.values()]
          .filter((r) => this.created.has(r.id) && r.location)
          .map((r) => r.location),
      ]),
    ].slice(0, LIMITS.descriptions + LIMITS.urls);
    const found = await mapLimit(locations, this.timings.scanConcurrency, (location) =>
      this.describe(location).catch((err) => {
        this.logger.debug?.(`No OpenHome description read: ${err.message}`);
        return undefined;
      }),
    );
    const records = [...new Set(found.filter(Boolean))];
    this.logger.info(
      `Discovery: ${answers.length} SSDP answer(s), ${records.length} OpenHome device(s)`,
    );
    const known = [...this.records.values()].filter(
      (r) => r.client && (records.includes(r) || this.created.has(r.id)),
    );
    await this.publishDiscovered(known);
    for (const record of known) {
      if (this.created.has(record.id)) {
        this.startPolling(record);
      }
    }
    return records;
  }

  async publishDiscovered(records = [...this.records.values()].filter((r) => r.client)) {
    const devices = records
      .slice(0, LIMITS.devices)
      .sort((a, b) => deviceName(a).localeCompare(deviceName(b)))
      .map((record) => buildDevice(this.gladys, record));
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** While a created device does not answer, a search at most every autoScanInterval. */
  async autoScan() {
    const lost = [...this.records.values()].some((r) => this.created.has(r.id) && r.state === null);
    if (!lost || this.now() - this.lastAutoScan < this.timings.autoScanInterval) {
      return;
    }
    this.lastAutoScan = this.now();
    await this.scan();
  }

  // --- Polling -----------------------------------------------------------------

  startPolling(record) {
    if (!this.started || record.polling) {
      return;
    }
    record.polling = true;
    this.schedulePoll(record, 0);
  }

  stopPolling(record) {
    record.polling = false;
    this.timers.clearTimeout(record.timer);
    record.timer = undefined;
  }

  schedulePoll(record, delay) {
    if (!record.polling || !this.started) {
      return;
    }
    this.timers.clearTimeout(record.timer);
    record.timer = this.timers.setTimeout(() => {
      record.timer = undefined;
      this.poll(record).catch((err) => this.logger.warn(`Poll failed: ${err.message}`));
    }, delay);
  }

  backoff(failures) {
    return Math.min(
      this.timings.backoffMax,
      this.timings.backoffBase * 2 ** Math.max(0, failures - this.timings.offlineAfter),
    );
  }

  /** One poll, then the next one: the interval, or the backoff of an unreachable device. */
  async poll(record) {
    const generation = this.generation;
    let next = this.config.pollInterval;
    try {
      const state = await this.readState(record);
      if (generation !== this.generation) {
        return;
      }
      const wasLost = record.state === null;
      record.failures = 0;
      record.state = state;
      if (wasLost || record.transport !== 'local') {
        await this.publishTransport(record, 'local');
      }
      if (this.now() - record.listsAt >= this.timings.listsTtl || this.unknownSource(record)) {
        await this.refreshLists(record);
      }
      await this.publishStates(record);
      if (wasLost) {
        this.logger.info(`${deviceName(record)} answers again`);
        await this.updateStatus();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      record.failures += 1;
      if (err instanceof OpenhomeError && !err.unreachable) {
        // The device answers, but not as expected: kept, said once.
        this.warnOnce(`poll:${record.id}:${err.code}`, `${deviceName(record)}: ${err.message}`);
      } else if (record.failures >= this.timings.offlineAfter) {
        if (record.state !== null) {
          this.logger.info(
            `${deviceName(record)} does not answer (${err.message}); tried again at spaced intervals`,
          );
          record.state = null;
          await this.publishTransport(record, 'unreachable');
          await this.publishStates(record);
          await this.updateStatus();
        }
        next = Math.max(next, this.backoff(record.failures));
      }
    } finally {
      this.schedulePoll(record, next);
    }
  }

  /** A source index the list does not know (a new one, or the list never read). */
  unknownSource(record) {
    const index = record.state?.sourceIndex;
    return Number.isInteger(index) && !record.sources.some((s) => s.index === index);
  }

  async refreshLists(record) {
    const before = JSON.stringify([record.sources, record.pins]);
    record.listsAt = this.now(); // tried: not again before the TTL, even on failure
    try {
      await this.readLists(record);
    } catch (err) {
      this.logger.debug?.(`${deviceName(record)}: lists unavailable (${err.message})`);
      return;
    }
    if (JSON.stringify([record.sources, record.pins]) !== before) {
      // The options of the "Source" dropdown follow (Gladys updates them).
      await this.publishDiscovered().catch((err) =>
        this.logger.warn(`Publishing the source lists failed: ${err.message}`),
      );
    }
  }

  /** The state of a device, one request at a time through its queue. */
  async readState(record) {
    const { client, queue } = record;
    const ask = (job) => queue.run(() => job(this.requestOptions()), 'poll');
    const standby = await ask((o) => client.standby(o));
    if (standby) {
      record.counters = undefined;
      return { standby: true };
    }
    const state = { standby: false };
    state.sourceIndex = await ask((o) => client.sourceIndex(o));
    if (client.has(SERVICES.VOLUME)) {
      state.volume = await ask((o) => client.volume(o));
      state.mute = await ask((o) => client.mute(o));
    }
    const type = this.sourceOf(record, state.sourceIndex)?.type;
    state.transport = await ask((o) => client.transportState(type, o)).catch(() => undefined);
    // The track only when the counters say it changed (or are unknown).
    const counters = await ask((o) => client.counters(o)).catch(() => undefined);
    const same = (key) => counters?.[key] !== undefined && counters[key] === record.counters?.[key];
    if (client.has(SERVICES.INFO)) {
      if (!same('track')) {
        record.track = await ask((o) => client.track(o)).catch(() => record.track);
      }
      if (!same('metatext')) {
        record.radioText = await ask((o) => client.metatext(o)).catch(() => record.radioText);
      }
    }
    record.counters = counters;
    state.track = record.track;
    state.radioText = record.radioText;
    return state;
  }

  sourceOf(record, index) {
    return record.sources.find((s) => s.index === index);
  }

  async publishStates(record) {
    if (!this.created.has(record.id)) {
      return;
    }
    const states = stateList(this.gladys, record, record.state);
    if (states.length === 0) {
      return;
    }
    await this.gladys
      .publishChangedStates(states, { heartbeat: 30 * 60_000 })
      .catch((err) => this.logger.warn(`States of ${deviceName(record)} failed: ${err.message}`));
  }

  async publishAllStates() {
    for (const record of this.records.values()) {
      await this.publishStates(record);
    }
  }

  async publishTransport(record, transport) {
    record.transport = transport;
    if (!this.created.has(record.id)) {
      return;
    }
    await this.gladys
      .publishTransports([{ external_id: this.externalId(record), transport }])
      .catch((err) =>
        this.logger.warn(`Transport of ${deviceName(record)} failed: ${err.message}`),
      );
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    if (this.config.invalid.length > 0) {
      await this.setStatus(true, T.invalidUrls(this.config.invalid));
      return;
    }
    const created = [...this.records.values()].filter((r) => this.created.has(r.id));
    if (this.created.size === 0) {
      await this.setStatus(true, T.noDevice);
      return;
    }
    const lost = created.filter((r) => r.state === null).map((r) => deviceName(r));
    const missing = this.created.size - created.length;
    if (lost.length > 0 || missing > 0) {
      await this.setStatus(true, T.unreachable([...lost, ...(missing ? [`+${missing}`] : [])]));
      return;
    }
    await this.setStatus(true, T.ok(this.created.size, created.length));
  }

  // --- Commands ----------------------------------------------------------------

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** One request of a command, within what is left of its budget. */
  async send(record, started, label, job, { write = true } = {}) {
    const left = this.remaining(started);
    if (left < this.timings.minRequest) {
      throw new CommandError(`${deviceName(record)}: ${label} not sent (no time left)`);
    }
    try {
      return await job(this.requestOptions(Math.min(this.timings.requestTimeout, left)));
    } catch (err) {
      if (!(err instanceof OpenhomeError)) {
        throw err;
      }
      if (err.code === 'fault') {
        throw new CommandError(`${deviceName(record)}: ${err.message}`, { sent: true });
      }
      if (write && err.maybeSent) {
        throw new CommandError(
          `${deviceName(record)}: ${label} sent, without confirmation (${err.message})`,
          { sent: true },
        );
      }
      throw new CommandError(`${deviceName(record)}: ${label} not sent (${err.message})`);
    }
  }

  /**
   * A command from Gladys. Validated before anything is sent; run in the
   * queue of the device (urgent ones first); refused, never sent late, when
   * it could not start within the budget; a quick poll follows.
   */
  async setValue(device, feature, value) {
    const started = this.now();
    const record = this.recordOfDevice(device);
    if (!record?.client) {
      throw new CommandError('Unknown OpenHome device: run a Discovery scan');
    }
    const key = featureKey(this.externalId(record), feature?.external_id);
    const command = this.validate(record, key, value);
    const lane = URGENT.has(key) ? 'urgent' : 'command';
    try {
      return await record.queue.run(() => {
        if (this.remaining(started) < this.timings.minRequest) {
          throw new CommandError(`${deviceName(record)}: busy, nothing sent`);
        }
        return this.command(record, key, command, started);
      }, lane);
    } finally {
      this.schedulePoll(record, 300);
    }
  }

  /** The value of a command, checked before the queue: an invalid one never waits. */
  validate(record, key, value) {
    switch (key) {
      case FEATURES.VOLUME: {
        const volume = parseVolumeCommand(value);
        if (volume === undefined) {
          throw new CommandError(`${deviceName(record)}: invalid volume, nothing sent`);
        }
        if (!record.client.has(SERVICES.VOLUME)) {
          throw new CommandError(
            `${deviceName(record)}: no volume control on this device (fixed volume), nothing sent`,
          );
        }
        return volume;
      }
      case FEATURES.SOURCE: {
        const option = parseOption(value);
        if (!option) {
          throw new CommandError(`${deviceName(record)}: unknown source, nothing sent`);
        }
        return option;
      }
      case FEATURES.MUTE:
        if (!record.client.has(SERVICES.VOLUME)) {
          throw new CommandError(`${deviceName(record)}: no mute on this device, nothing sent`);
        }
        return undefined;
      case FEATURES.POWER_ON:
      case FEATURES.STANDBY:
      case FEATURES.PLAY:
      case FEATURES.PAUSE:
      case FEATURES.NEXT:
      case FEATURES.PREVIOUS:
        return undefined;
      default:
        throw new CommandError(`Feature "${String(key).slice(0, 32)}" cannot be commanded`);
    }
  }

  async command(record, key, value, started) {
    const { client } = record;
    const send = (label, job, options) => this.send(record, started, label, job, options);
    const read = (label, job) => send(label, job, { write: false });
    switch (key) {
      case FEATURES.STANDBY:
        this.cancelWakeCheck(record);
        await send('Standby', (o) => client.setStandby(true, o));
        return;
      case FEATURES.POWER_ON:
        await send('Power on', (o) => client.setStandby(false, o));
        await this.capAfterWake(record, started);
        return;
      case FEATURES.VOLUME: {
        // The cap is read here, just before the request leaves: a
        // configuration saved while the command waited applies.
        const cap = this.config.maxVolume;
        const target = Math.min(value, cap);
        if (target < value) {
          this.logger.info(`${deviceName(record)}: volume ${value} capped to ${cap}`);
        }
        await send('Volume', (o) => client.setVolume(target, o));
        return;
      }
      case FEATURES.MUTE: {
        // Gladys sends a press: the mute is read just before, the opposite set.
        const muted = await read('Mute', (o) => client.mute(o));
        if (muted) {
          // Unmuting never plays above the cap: lowered first when above it.
          const volume = await read('Mute', (o) => client.volume(o));
          const cap = this.config.maxVolume;
          if (volume > cap) {
            this.logger.info(`${deviceName(record)}: volume ${volume} lowered to ${cap} first`);
            await send('Mute', (o) => client.setVolume(cap, o));
          }
        }
        await send('Mute', (o) => client.setMute(!muted, o));
        return;
      }
      case FEATURES.PLAY:
      case FEATURES.PAUSE:
      case FEATURES.NEXT:
      case FEATURES.PREVIOUS: {
        let type;
        if (!client.has(SERVICES.TRANSPORT)) {
          // Radio or Playlist: the source read again decides which service answers.
          const index = await read(key, (o) => client.sourceIndex(o));
          type = this.sourceOf(record, index)?.type;
        }
        await send(key, (o) => client.transport(key, type, o));
        return;
      }
      case FEATURES.SOURCE:
        return this.selectSource(record, value, started, send, read);
      default:
        throw new CommandError(`Feature "${String(key).slice(0, 32)}" cannot be commanded`);
    }
  }

  async selectSource(record, option, started, send, read) {
    const { client } = record;
    // Selecting a source wakes a device in standby: the cap is checked after.
    const standby = await read('Source', (o) => client.standby(o));
    if (option.kind === 'source') {
      // The list belongs to the device: read again, the index must be a visible source.
      const sources = await read('Source', (o) => client.sources(o));
      record.sources = sources;
      if (!sources.some((s) => s.index === option.index && s.visible)) {
        throw new CommandError(`${deviceName(record)}: source not available now, nothing sent`);
      }
      await send('Source', (o) => client.setSourceIndex(option.index, o));
    } else {
      if (!client.has(SERVICES.PINS) || !record.pins.some((p) => p.index === option.index)) {
        throw new CommandError(`${deviceName(record)}: pin not set on the device, nothing sent`);
      }
      await send('Pin', (o) => client.invokePin(option.index, o));
    }
    if (standby) {
      await this.capAfterWake(record, started);
    }
  }

  // --- The cap after a wake-up ------------------------------------------------------

  /**
   * A device leaves standby at the volume it had: brought back to the cap,
   * within what is left of the command first, then in the background while
   * the device is still waking up. The ack never depends on it.
   */
  async capAfterWake(record, started) {
    this.cancelWakeCheck(record);
    if (!record.client.has(SERVICES.VOLUME)) {
      return;
    }
    const done = await this.capVolume(
      record,
      Math.min(this.timings.requestTimeout, this.remaining(started) - 100),
    ).catch(() => false);
    if (!done) {
      this.wakeCheck(record, 1);
    }
  }

  /** True when settled (lowered, or nothing to lower), false when the device cannot tell yet. */
  async capVolume(record, timeout) {
    if (timeout < this.timings.minRequest) {
      return false;
    }
    const options = this.requestOptions(timeout);
    if (await record.client.standby(options)) {
      return false;
    }
    const volume = await record.client.volume(options);
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    this.logger.info(`${deviceName(record)}: woke up at volume ${volume}, lowered to ${cap}`);
    await record.client.setVolume(cap, options);
    return true;
  }

  cancelWakeCheck(record) {
    if (record.wake) {
      this.timers.clearTimeout(record.wake.timer);
      record.wake = undefined;
    }
  }

  wakeCheck(record, attempt) {
    const chain = { timer: undefined };
    if (attempt === 1) {
      this.cancelWakeCheck(record);
    }
    record.wake = chain;
    chain.timer = this.timers.setTimeout(async () => {
      if (record.wake !== chain || !this.started) {
        return;
      }
      const done = await record.queue
        .run(() => this.capVolume(record, this.timings.requestTimeout), 'command')
        .catch(() => false);
      if (record.wake !== chain) {
        return;
      }
      if (done || attempt >= this.timings.wakeChecks) {
        record.wake = undefined;
        if (!done) {
          this.logger.warn(
            `${deviceName(record)}: volume not checked against the cap after wake-up`,
          );
        }
        return;
      }
      this.wakeCheck(record, attempt + 1);
    }, this.timings.wakeCheckDelay);
  }

  // --- Configuration screen buttons ------------------------------------------------

  async checkDevices() {
    await this.refreshCreated();
    const lines = [];
    for (const record of [...this.records.values()].filter((r) => this.created.has(r.id))) {
      try {
        const state = await this.readState(record);
        record.state = state;
        lines.push(
          T.checkLine(deviceName(record), {
            ...state,
            sourceName: this.sourceOf(record, state.sourceIndex)?.name,
          }),
        );
      } catch (err) {
        lines.push(T.checkLine(deviceName(record), undefined, err.message));
      }
    }
    await this.updateStatus();
    if (lines.length === 0) {
      return T.noDevice;
    }
    return T.check(lines, this.config.maxVolume);
  }

  async listSources() {
    const records = await this.scan();
    const known = [...new Set([...records, ...this.records.values()])].filter(
      (r) => r.client && (records.includes(r) || this.created.has(r.id)),
    );
    if (known.length === 0) {
      return T.noneFound;
    }
    const blocks = [];
    for (const record of known) {
      await this.refreshLists(record);
      blocks.push(
        T.sourcesOf(
          deviceName(record),
          record.sources.filter((s) => s.visible).map((s) => s.name),
          record.pins.map((p) => `${p.index}. ${p.title}`),
        ),
      );
    }
    return {
      en: blocks.map((b) => b.en).join('\n\n'),
      fr: blocks.map((b) => b.fr).join('\n\n'),
    };
  }
}
