// -----------------------------------------------------------------------------
// Known devices -> Gladys devices and states (pure). One Gladys device per
// OpenHome device, keyed by its UPnP UDN: the address and the port of a Linn
// device may change (DHCP, reboot), its UDN does not.
//
// The categories and types are the ones of the Gladys core: `music` like the
// core Sonos service (volume, play, pause, next, previous, playback state),
// `television/volume-mute` for the mute press (music has no mute type),
// `text/select` for the source and the pins, `text/text` for the title,
// `button/push` for "Power on" and "Standby", and the power state read only
// (`unknown/binary`): no switch, nothing an "everything on / off" (voice
// assistants, scenes) could turn into a command. No unit: the core lists none
// for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS, NOTHING } from './constants.js';
import { nowPlayingLine, playbackOf } from './openhome/parse.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.PLAY]: { name: 'Play', category: C.MUSIC, type: T.MUSIC.PLAY, min: 1, max: 1 },
  [FEATURES.PAUSE]: { name: 'Pause', category: C.MUSIC, type: T.MUSIC.PAUSE, min: 1, max: 1 },
  [FEATURES.NEXT]: { name: 'Next', category: C.MUSIC, type: T.MUSIC.NEXT, min: 1, max: 1 },
  [FEATURES.PREVIOUS]: {
    name: 'Previous',
    category: C.MUSIC,
    type: T.MUSIC.PREVIOUS,
    min: 1,
    max: 1,
  },
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.TITLE]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/** The options of the "Source" dropdown: the visible sources, then the pins. */
export function sourceOptions(device) {
  const sources = (device.sources ?? [])
    .filter((s) => s.visible)
    .slice(0, LIMITS.sources)
    .map((s) => ({ value: `source:${s.index}`, label: s.name }));
  const pins = (device.pins ?? [])
    .slice(0, LIMITS.pins)
    .map((p) => ({ value: `pin:${p.index}`, label: `${p.index}. ${p.title}` }));
  return [...sources, ...pins];
}

/** "source:3" -> { kind: 'source', index: 3 }, "pin:2" -> { kind: 'pin', index: 2 }, else undefined. */
export function parseOption(value) {
  const match = /^(source|pin):(\d{1,3})$/.exec(String(value ?? '').trim());
  return match ? { kind: match[1], index: Number(match[2]) } : undefined;
}

export function deviceName(device) {
  const name = device.name || `OpenHome ${device.id.slice(0, 8)}`;
  return device.model && !name.includes(device.model) ? `${name} (${device.model})` : name;
}

export function buildDevice(gladys, device) {
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  return {
    name: deviceName(device),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'LOCATION', value: device.location },
      ...(device.manufacturer ? [{ name: 'MANUFACTURER', value: device.manufacturer }] : []),
    ],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(device) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `deviceExternalId`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a device. `state` is the last poll ({ standby, sourceIndex,
 * volume, mute, transport, track }), `null` for a device that does not
 * answer (power 0 only), undefined for "nothing known" (nothing published).
 */
export function stateList(gladys, device, state) {
  if (state === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [{ device_feature_external_id: id(FEATURES.POWER), state: state.standby ? 0 : 1 }];
  if (state.standby) {
    states.push(
      { device_feature_external_id: id(FEATURES.PLAYBACK), state: 0 },
      { device_feature_external_id: id(FEATURES.TITLE), text: NOTHING },
    );
    return states;
  }
  if (Number.isInteger(state.volume)) {
    states.push({
      device_feature_external_id: id(FEATURES.VOLUME),
      state: Math.min(100, state.volume),
    });
  }
  if (typeof state.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: state.mute ? 1 : 0 });
  }
  const option = `source:${state.sourceIndex}`;
  if (sourceOptions(device).some((o) => o.value === option)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: option });
  }
  const playback = playbackOf(state.transport);
  if (playback !== undefined) {
    states.push({
      device_feature_external_id: id(FEATURES.PLAYBACK),
      state: playback === 'playing' ? 1 : 0,
    });
  }
  states.push({
    device_feature_external_id: id(FEATURES.TITLE),
    text: nowPlayingLine(state.track) ?? state.radioText ?? NOTHING,
  });
  return states;
}
