// -----------------------------------------------------------------------------
// One OpenHome device: its description, and every action the integration
// uses, as in openhomedevice (MIT, Barry John Williams) ported to JavaScript:
//
//   Product   Standby, SetStandby, SourceIndex, SetSourceIndex, SourceXml
//   Volume    Volume, SetVolume, Mute, SetMute, Characteristics (VolumeMax);
//             absent at unity gain
//   Transport TransportState, Play, Pause, Stop, SkipNext, SkipPrevious;
//             without it (older firmware, software players) the Radio or
//             Playlist service of the current source, as openhomedevice does
//   Info      Counters, Track, Metatext
//   Pins      GetDeviceMax, GetIdArray, ReadList, InvokeIndex (slot - 1)
//
// No queue here (src/queue.js, in the app) and no retry: one call, one
// request. Every request goes to the host and port of the description.
// -----------------------------------------------------------------------------

import { LIMITS, SERVICES, TIMINGS } from '../constants.js';
import { parseDescription, parseLocation } from './description.js';
import { OpenhomeError } from './errors.js';
import { httpRequest } from './http.js';
import {
  parseBool,
  parseIdArray,
  parseMetatext,
  parsePins,
  parseSourceXml,
  parseTrack,
  parseUint,
} from './parse.js';
import { soapCall } from './soap.js';
import { XmlError } from './xml.js';

/** Read a description URL -> the OpenHome device it describes (or undefined). */
export async function readDescription(location, { request = httpRequest, timeout, signal } = {}) {
  const url = location instanceof URL ? location : parseLocation(location);
  if (!url) {
    throw new OpenhomeError('refused', 'invalid description URL');
  }
  const { status, text } = await request({
    url,
    timeout: timeout ?? TIMINGS.requestTimeout,
    maxBytes: LIMITS.descriptionBytes,
    signal,
  });
  if (status !== 200) {
    throw new OpenhomeError('status', `description: HTTP ${status}`, { status });
  }
  try {
    return parseDescription(text, url);
  } catch (err) {
    throw new OpenhomeError(
      'answer',
      `description: ${err instanceof XmlError ? err.message : 'unreadable'}`,
    );
  }
}

const value = (out, name, action) => {
  if (!(name in out)) {
    throw new OpenhomeError('answer', `${action}: no ${name} in the answer`);
  }
  return out[name];
};

export class OpenhomeClient {
  /** `info`: what readDescription returned. */
  constructor(info, { request = httpRequest } = {}) {
    this.info = info;
    this.request = request;
  }

  has(service) {
    return Boolean(this.info.services?.[service]);
  }

  async call(service, action, args = {}, { timeout = TIMINGS.requestTimeout, signal } = {}) {
    const target = this.info.services?.[service];
    if (!target) {
      throw new OpenhomeError('refused', `this device has no ${service} service`);
    }
    return soapCall({
      controlUrl: target.controlUrl,
      serviceType: target.serviceType,
      action,
      args,
      timeout,
      signal,
      request: this.request,
    });
  }

  // --- Reads -------------------------------------------------------------------

  async standby(options) {
    const out = await this.call(SERVICES.PRODUCT, 'Standby', {}, options);
    const standby = parseBool(value(out, 'Value', 'Standby'));
    if (standby === undefined) {
      throw new OpenhomeError('answer', 'Standby: not a boolean');
    }
    return standby;
  }

  async sourceIndex(options) {
    const out = await this.call(SERVICES.PRODUCT, 'SourceIndex', {}, options);
    const index = parseUint(value(out, 'Value', 'SourceIndex'));
    if (index === undefined) {
      throw new OpenhomeError('answer', 'SourceIndex: not an index');
    }
    return index;
  }

  async sources(options) {
    const out = await this.call(SERVICES.PRODUCT, 'SourceXml', {}, options);
    const sources = parseSourceXml(value(out, 'Value', 'SourceXml'));
    if (!sources) {
      throw new OpenhomeError('answer', 'SourceXml: unreadable source list');
    }
    return sources;
  }

  async volume(options) {
    const out = await this.call(SERVICES.VOLUME, 'Volume', {}, options);
    const volume = parseUint(value(out, 'Value', 'Volume'));
    if (volume === undefined) {
      throw new OpenhomeError('answer', 'Volume: not a number');
    }
    return volume;
  }

  async mute(options) {
    const out = await this.call(SERVICES.VOLUME, 'Mute', {}, options);
    const mute = parseBool(value(out, 'Value', 'Mute'));
    if (mute === undefined) {
      throw new OpenhomeError('answer', 'Mute: not a boolean');
    }
    return mute;
  }

  /** The service that answers for the transport of a source type. */
  transportService(sourceType) {
    if (this.has(SERVICES.TRANSPORT)) return SERVICES.TRANSPORT;
    if (sourceType === 'Radio' && this.has(SERVICES.RADIO)) return SERVICES.RADIO;
    if (sourceType === 'Playlist' && this.has(SERVICES.PLAYLIST)) return SERVICES.PLAYLIST;
    return undefined;
  }

  /** Playing, Paused, Stopped, Buffering, Waiting..., or undefined when nothing can tell. */
  async transportState(sourceType, options) {
    const service = this.transportService(sourceType);
    if (!service) {
      return undefined;
    }
    const out = await this.call(service, 'TransportState', {}, options);
    return String(out.State ?? out.Value ?? '').slice(0, 20) || undefined;
  }

  /** Info.Counters: { track, metatext } (the counts change with the track / the radio text). */
  async counters(options) {
    if (!this.has(SERVICES.INFO)) {
      return undefined;
    }
    const out = await this.call(SERVICES.INFO, 'Counters', {}, options);
    return { track: parseUint(out.TrackCount), metatext: parseUint(out.MetatextCount) };
  }

  async track(options) {
    const out = await this.call(SERVICES.INFO, 'Track', {}, options);
    return parseTrack(out.Metadata);
  }

  async metatext(options) {
    const out = await this.call(SERVICES.INFO, 'Metatext', {}, options);
    return parseMetatext(out.Value);
  }

  /**
   * The pins, one request per call so the app can queue each one (a
   * Standby never waits behind the three): the slot count, the id of each
   * slot (0 = empty), then the metadata of the ids set.
   */
  async pinDeviceMax(options) {
    const out = await this.call(SERVICES.PINS, 'GetDeviceMax', {}, options);
    return parseUint(out.DeviceMax);
  }

  async pinIds(options) {
    const ids = parseIdArray((await this.call(SERVICES.PINS, 'GetIdArray', {}, options)).IdArray);
    if (!ids) {
      throw new OpenhomeError('answer', 'GetIdArray: unreadable');
    }
    return ids;
  }

  /** [{ index, id, title }] for the slots of `ids` that are set. */
  async pinList(ids, max, options) {
    const listed = ids.filter((id) => id > 0);
    if (listed.length === 0) {
      return [];
    }
    const list = await this.call(
      SERVICES.PINS,
      'ReadList',
      { Ids: JSON.stringify(listed) },
      options,
    );
    const pins = parsePins(ids, list.List, max);
    if (!pins) {
      throw new OpenhomeError('answer', 'ReadList: unreadable');
    }
    return pins;
  }

  /** Volume.Characteristics: the device's maximum volume step, or undefined. */
  async volumeMax(options) {
    const out = await this.call(SERVICES.VOLUME, 'Characteristics', {}, options);
    const max = parseUint(out.VolumeMax);
    return max > 0 ? max : undefined;
  }

  // --- Commands ----------------------------------------------------------------

  setStandby(standby, options) {
    return this.call(SERVICES.PRODUCT, 'SetStandby', { Value: standby ? 1 : 0 }, options);
  }

  setSourceIndex(index, options) {
    return this.call(SERVICES.PRODUCT, 'SetSourceIndex', { Value: index }, options);
  }

  setVolume(volume, options) {
    return this.call(SERVICES.VOLUME, 'SetVolume', { Value: volume }, options);
  }

  setMute(mute, options) {
    return this.call(SERVICES.VOLUME, 'SetMute', { Value: mute ? 1 : 0 }, options);
  }

  /** play, pause, stop, next, previous: through the service of the source. */
  transport(command, sourceType, options) {
    const service = this.transportService(sourceType);
    const actions =
      service === SERVICES.TRANSPORT
        ? { play: 'Play', pause: 'Pause', stop: 'Stop', next: 'SkipNext', previous: 'SkipPrevious' }
        : service === SERVICES.PLAYLIST
          ? { play: 'Play', pause: 'Pause', stop: 'Stop', next: 'Next', previous: 'Previous' }
          : service === SERVICES.RADIO
            ? { play: 'Play', pause: 'Pause', stop: 'Stop' }
            : {};
    const action = actions[command];
    if (!action) {
      throw new OpenhomeError('refused', `${command} is not possible on this source`);
    }
    return this.call(service, action, {}, options);
  }

  /** A pin by its slot (from 1). */
  invokePin(slot, options) {
    return this.call(SERVICES.PINS, 'InvokeIndex', { Index: slot - 1 }, options);
  }
}
