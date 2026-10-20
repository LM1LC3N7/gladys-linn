// -----------------------------------------------------------------------------
// The integration: the OpenHome devices it knows (an SSDP search through the
// Gladys core, the description URLs typed by the user, the devices already
// created), one poll loop per created device (the container has no inbound
// port, so no UPnP eventing), the Gladys devices built from them, the
// commands (validated before anything is sent, the volume capped by the
// configuration, one request at a time per device, each command within the
// 5 s Gladys waits for its ack) and the configuration buttons.
// index.js only wires the SDK handlers to it (src/handlers.js).
//
// Every request to a device is one job of its queue (src/queue.js), with a
// timeout that never goes past the deadline of what it belongs to (a
// command, a volume check, the "Check" button). Standby cancels the read in
// flight and goes first: it never waits behind a slow device.
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

/**
 * The value of a mute press: 0 (number or "0") asks to unmute; anything
 * else is a press of the push button (the dashboard sends 1 every time), so
 * the integration sets the opposite of the mute read from the device.
 */
export const muteIntent = (value) => (value === 0 || value === '0' ? 'unmute' : 'toggle');

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

/** A cancelled read (Standby went first) or a deadline reached: not a device failure. */
const isCancel = (err) => err?.code === 'aborted' || err?.code === 'deadline';

/** A read that may fail without failing the poll, but never hides a cancellation. */
const soft = (promise, fallback) =>
  promise.catch((err) => {
    if (isCancel(err)) {
      throw err;
    }
    return fallback;
  });

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

  // --- Requests ------------------------------------------------------------------

  /**
   * One request to a device, as one job of its queue. Its timeout never goes
   * past `deadline`; under `minRequest` left, it is not started (code
   * 'deadline'). A read is abortable (Standby cancels it), a write is not.
   */
  ask(record, job, { lane = 'poll', deadline = Infinity, write = false } = {}) {
    return record.queue.run(
      (signal) => {
        const left = deadline - this.now();
        if (left < this.timings.minRequest) {
          throw new OpenhomeError('deadline', 'no time left');
        }
        return job({ timeout: Math.min(this.timings.requestTimeout, left), signal });
      },
      lane,
      { abortable: !write },
    );
  }

  /** Device volume steps <-> percent (VolumeMax is 100 on a Linn; other devices may differ). */
  toPercent(record, raw) {
    const max = record.volumeMax ?? 100;
    return Math.min(100, Math.round((raw * 100) / max));
  }

  toRaw(record, percent) {
    const max = record.volumeMax ?? 100;
    return Math.round((percent * max) / 100);
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
        volumeMax: undefined,
        queue: new DeviceQueue(),
        state: undefined,
        failures: 0,
        timer: undefined,
        polling: false,
        counters: undefined,
        track: undefined,
        radioText: undefined,
        wake: undefined,
        /** bumped by every Standby: a volume check started before stops */
        standbySeq: 0,
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

  /** Forget a record that is neither created nor seen by the last search. */
  dropRecord(record) {
    this.stopPolling(record);
    this.cancelWakeCheck(record);
    record.queue.close();
    this.records.delete(record.id);
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

  /**
   * The source list, the pins and the volume scale: one queue job per
   * request (a Standby never waits behind them).
   */
  async readLists(record) {
    const { client } = record;
    const sources = await this.ask(record, (o) => client.sources(o));
    let pins = record.pins;
    if (client.has(SERVICES.PINS)) {
      try {
        const max = await this.ask(record, (o) => client.pinDeviceMax(o));
        const ids = await this.ask(record, (o) => client.pinIds(o));
        pins = await this.ask(record, (o) => client.pinList(ids, max, o));
      } catch (err) {
        if (isCancel(err)) {
          throw err;
        }
      }
    } else {
      pins = [];
    }
    if (client.has(SERVICES.VOLUME) && record.volumeMax === undefined) {
      // A device without Characteristics is taken as 0-100, like a Linn.
      record.volumeMax = await soft(
        this.ask(record, (o) => client.volumeMax(o)),
        undefined,
      );
      record.volumeMax ??= 100;
      if (record.volumeMax !== 100) {
        this.logger.info(`${deviceName(record)}: volume steps 0-${record.volumeMax}, scaled`);
      }
    }
    record.sources = sources;
    record.pins = pins;
    record.listsAt = this.now();
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
    // What the last search did not see and nobody created is forgotten: a
    // host announcing many devices once never fills the table for good.
    for (const record of [...this.records.values()]) {
      if (!records.includes(record) && !this.created.has(record.id)) {
        this.dropRecord(record);
      }
    }
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
      if (generation !== this.generation || isCancel(err)) {
        // Cancelled by a Standby: not a failure; the command asks a poll soon.
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

  /** The state of a device, one request at a time through its queue (volume in percent). */
  async readState(record, { deadline = Infinity } = {}) {
    const { client } = record;
    const ask = (job) => this.ask(record, job, { deadline });
    const standby = await ask((o) => client.standby(o));
    if (standby) {
      record.counters = undefined;
      return { standby: true };
    }
    const state = { standby: false };
    state.sourceIndex = await ask((o) => client.sourceIndex(o));
    if (client.has(SERVICES.VOLUME)) {
      state.volume = this.toPercent(record, await ask((o) => client.volume(o)));
      state.mute = await ask((o) => client.mute(o));
    }
    const type = this.sourceOf(record, state.sourceIndex)?.type;
    state.transport = await soft(
      ask((o) => client.transportState(type, o)),
      undefined,
    );
    // The track only when the counters say it changed (or are unknown).
    const counters = await soft(
      ask((o) => client.counters(o)),
      undefined,
    );
    const same = (key) => counters?.[key] !== undefined && counters[key] === record.counters?.[key];
    if (client.has(SERVICES.INFO)) {
      if (!same('track')) {
        record.track = await soft(
          ask((o) => client.track(o)),
          record.track,
        );
      }
      if (!same('metatext')) {
        record.radioText = await soft(
          ask((o) => client.metatext(o)),
          record.radioText,
        );
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

  /** One request of a command (inside its queue job), within what is left of its budget. */
  async send(record, started, label, job, { write = true } = {}) {
    const left = this.remaining(started);
    if (left < this.timings.minRequest) {
      throw new CommandError(`${deviceName(record)}: ${label} not sent (no time left)`);
    }
    try {
      return await job({ timeout: Math.min(this.timings.requestTimeout, left) });
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
   * queue of the device (urgent ones first, Standby cancelling the read in
   * flight); refused, never sent late, when it could not start within the
   * budget. A command that may have woken the device is followed by the cap
   * check, within what is left of the budget; a quick poll follows.
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
    if (key === FEATURES.STANDBY) {
      // Whatever was checking the volume after a wake-up stops here.
      record.standbySeq += 1;
      this.cancelWakeCheck(record);
    }
    try {
      const job = record.queue.run(
        () => {
          if (this.remaining(started) < this.timings.minRequest) {
            throw new CommandError(`${deviceName(record)}: busy, nothing sent`);
          }
          return this.command(record, key, command, started);
        },
        lane,
        { abortable: false },
      );
      // A read in flight (poll, list, volume check) is cancelled: a command
      // never waits behind a slow read, and a write is never cancelled.
      record.queue.preempt();
      const result = await job;
      if (result?.wake) {
        await this.capAfterWake(record, started);
      }
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
        return muteIntent(value);
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

  /** The requests of a command, inside its queue job. Resolves { wake } when it may have woken the device. */
  async command(record, key, value, started) {
    const { client } = record;
    const send = (label, job, options) => this.send(record, started, label, job, options);
    const read = (label, job) => send(label, job, { write: false });
    switch (key) {
      case FEATURES.STANDBY:
        await send('Standby', (o) => client.setStandby(true, o));
        return undefined;
      case FEATURES.POWER_ON:
        await send('Power on', (o) => client.setStandby(false, o));
        return { wake: true };
      case FEATURES.VOLUME: {
        // The cap is read here, just before the request leaves: a
        // configuration saved while the command waited applies.
        const cap = this.config.maxVolume;
        const target = Math.min(value, cap);
        if (target < value) {
          this.logger.info(`${deviceName(record)}: volume ${value} capped to ${cap}`);
        }
        await send('Volume', (o) => client.setVolume(this.toRaw(record, target), o));
        return undefined;
      }
      case FEATURES.MUTE: {
        // The mute is read just before: a press sets the opposite, 0 unmutes.
        const muted = await read('Mute', (o) => client.mute(o));
        const wanted = value === 'unmute' ? false : !muted;
        if (wanted === muted) {
          return undefined;
        }
        if (!wanted) {
          // Unmuting never plays above the cap: lowered first when above it.
          const volume = this.toPercent(record, await read('Mute', (o) => client.volume(o)));
          const cap = this.config.maxVolume;
          if (volume > cap) {
            this.logger.info(`${deviceName(record)}: volume ${volume} lowered to ${cap} first`);
            await send('Mute', (o) => client.setVolume(this.toRaw(record, cap), o));
          }
        }
        await send('Mute', (o) => client.setMute(wanted, o));
        return undefined;
      }
      case FEATURES.PLAY:
      case FEATURES.PAUSE:
      case FEATURES.NEXT:
      case FEATURES.PREVIOUS: {
        // Play, next or previous may wake a device in standby (Linn
        // firmware activates the source): the cap is then checked after.
        const standby = await read(key, (o) => client.standby(o));
        let type;
        if (!client.has(SERVICES.TRANSPORT)) {
          // Radio or Playlist: the source read again decides which service answers.
          const index = await read(key, (o) => client.sourceIndex(o));
          type = this.sourceOf(record, index)?.type;
        }
        await send(key, (o) => client.transport(key, type, o));
        return { wake: standby };
      }
      case FEATURES.SOURCE:
        return this.selectSource(record, value, read, send);
      default:
        throw new CommandError(`Feature "${String(key).slice(0, 32)}" cannot be commanded`);
    }
  }

  async selectSource(record, option, read, send) {
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
      const pin = record.pins.find((p) => p.index === option.index);
      if (!client.has(SERVICES.PINS) || !pin) {
        throw new CommandError(`${deviceName(record)}: pin not set on the device, nothing sent`);
      }
      // The slot may have been set again since the list was read: its id must match.
      const ids = await read('Pin', (o) => client.pinIds(o));
      if (ids[option.index - 1] !== pin.id) {
        record.listsAt = -Infinity; // read the pins again at the next poll
        throw new CommandError(
          `${deviceName(record)}: pin ${option.index} changed on the device, nothing sent`,
        );
      }
      await send('Pin', (o) => client.invokePin(option.index, o));
    }
    return { wake: standby };
  }

  // --- The cap after a wake-up ------------------------------------------------------

  /**
   * A device leaves standby at the volume it had: brought back to the cap,
   * within what is left of the command first, then in the background while
   * the device is still waking up. The ack never waits past the budget, and
   * a Standby pressed meanwhile stops it.
   */
  async capAfterWake(record, started) {
    this.cancelWakeCheck(record);
    if (!record.client.has(SERVICES.VOLUME)) {
      return;
    }
    const seq = record.standbySeq;
    const deadline = started + this.timings.commandBudget;
    const done = await this.capVolume(record, deadline, seq).catch(() => false);
    if (!done && seq === record.standbySeq) {
      this.wakeCheck(record, 1, seq);
    }
  }

  /**
   * Standby, volume, then SetVolume when above the cap: one queue job each,
   * none past `deadline`. True when settled (lowered, nothing to lower, or a
   * Standby came), false when the device cannot tell yet.
   */
  async capVolume(record, deadline, seq) {
    const { client } = record;
    const options = { lane: 'command', deadline };
    const stopped = () => seq !== record.standbySeq;
    if (await this.ask(record, (o) => client.standby(o), options)) {
      return stopped();
    }
    if (stopped()) return true;
    const volume = this.toPercent(record, await this.ask(record, (o) => client.volume(o), options));
    if (stopped()) return true;
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    this.logger.info(`${deviceName(record)}: woke up at volume ${volume}, lowered to ${cap}`);
    await this.ask(record, (o) => client.setVolume(this.toRaw(record, cap), o), {
      ...options,
      write: true,
    });
    return true;
  }

  cancelWakeCheck(record) {
    if (record.wake) {
      this.timers.clearTimeout(record.wake.timer);
      record.wake = undefined;
    }
  }

  wakeCheck(record, attempt, seq) {
    const chain = { timer: undefined };
    if (attempt === 1) {
      this.cancelWakeCheck(record);
    }
    record.wake = chain;
    chain.timer = this.timers.setTimeout(async () => {
      if (record.wake !== chain || !this.started || seq !== record.standbySeq) {
        return;
      }
      const deadline = this.now() + 3 * this.timings.requestTimeout;
      const done = await this.capVolume(record, deadline, seq).catch(() => false);
      if (record.wake !== chain) {
        return;
      }
      if (done || attempt >= this.timings.wakeChecks || seq !== record.standbySeq) {
        record.wake = undefined;
        if (!done) {
          this.logger.warn(
            `${deviceName(record)}: volume not checked against the cap after wake-up`,
          );
        }
        return;
      }
      this.wakeCheck(record, attempt + 1, seq);
    }, this.timings.wakeCheckDelay);
  }

  // --- Configuration screen buttons ------------------------------------------------

  /** Within timings.checkBudget (the button waits 30 s): the players left are said "not read". */
  async checkDevices() {
    const deadline = this.now() + this.timings.checkBudget;
    await this.refreshCreated();
    const lines = [];
    for (const record of [...this.records.values()].filter((r) => this.created.has(r.id))) {
      try {
        const state = await this.readState(record, { deadline });
        record.state = state;
        lines.push(
          T.checkLine(deviceName(record), {
            ...state,
            sourceName: this.sourceOf(record, state.sourceIndex)?.name,
          }),
        );
      } catch (err) {
        lines.push(
          err?.code === 'deadline'
            ? T.notRead(deviceName(record))
            : T.checkLine(deviceName(record), undefined, err.message),
        );
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
