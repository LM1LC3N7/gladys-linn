// -----------------------------------------------------------------------------
// The values of the OpenHome actions -> plain values (pure). Ported from
// openhomedevice (MIT, Barry John Williams): the source list and its
// visibility (Linn writes <Visible>true</Visible>, AURALiC writes 1), the
// track metadata in DIDL-Lite, the pins read from GetIdArray + ReadList.
// Everything read from a device is bounded, and nothing coming from it ever
// becomes an object key.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { cleanText } from './description.js';
import { childOf, childText, childrenOf, parseXml, textOf } from './xml.js';

/** "true" / "1" -> true, "false" / "0" -> false, anything else undefined. */
export function parseBool(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return undefined;
}

/** A non-negative integer of at most 9 digits, else undefined ('' is not 0). */
export function parseUint(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,9}$/.test(text) ? Number(text) : undefined;
}

/**
 * The Value of Product.SourceXml -> [{ index, name, type, visible }]. The
 * index counts the hidden sources, as SourceIndex does.
 */
export function parseSourceXml(xml) {
  let root;
  try {
    root = parseXml(xml, { maxLength: LIMITS.soapBytes });
  } catch {
    return undefined;
  }
  return childrenOf(root, 'Source')
    .slice(0, LIMITS.sources * 2)
    .map((source, index) => ({
      index,
      name: cleanText(childText(source, 'Name')) ?? `Source ${index + 1}`,
      type: cleanText(childText(source, 'Type'), 32) ?? '',
      visible: parseBool(childText(source, 'Visible')) === true,
    }));
}

/** What the transport states of OpenHome mean for Gladys. */
export function playbackOf(state) {
  const text = String(state ?? '').trim();
  if (text === 'Playing' || text === 'Buffering') return 'playing';
  if (text === 'Paused') return 'paused';
  if (text === 'Stopped' || text === 'Waiting') return 'stopped';
  return undefined;
}

/**
 * The Metadata of Info.Track (DIDL-Lite) -> { title, artist, album }; a
 * value is undefined when absent. Malformed metadata gives {}.
 */
export function parseTrack(metadata) {
  let item;
  try {
    const root = parseXml(metadata, { maxLength: LIMITS.soapBytes });
    item = root.name === 'item' ? root : childOf(root, 'item');
  } catch {
    return {};
  }
  if (!item) {
    return {};
  }
  // The first plain artist (no role), else the first one at all.
  const artists = childrenOf(item, 'artist');
  const artist = artists.find((a) => !a.attrs.role) ?? artists[0];
  return {
    title: cleanText(childText(item, 'title'), LIMITS.title),
    artist: cleanText(artist ? textOf(artist) : undefined, LIMITS.title),
    album: cleanText(childText(item, 'album'), LIMITS.title),
  };
}

/** The Metatext of a radio (Info.Metatext, DIDL-Lite too): its title, if any. */
export function parseMetatext(metatext) {
  const text = String(metatext ?? '').trim();
  if (!text) {
    return undefined;
  }
  if (!text.startsWith('<')) {
    return cleanText(text, LIMITS.title);
  }
  return parseTrack(text).title;
}

/** "Artist - Title", or the one that is known. */
export function nowPlayingLine({ title, artist } = {}) {
  const line = [artist, title].filter(Boolean).join(' - ');
  return line ? line.slice(0, LIMITS.title) : undefined;
}

/** A bounded JSON text -> the parsed value, or undefined. */
function parseJson(text) {
  const raw = String(text ?? '');
  if (raw.length > LIMITS.soapBytes) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The IdArray of Pins.GetIdArray: integers, bounded. */
export function parseIdArray(text) {
  const ids = parseJson(text);
  return Array.isArray(ids)
    ? ids.slice(0, LIMITS.pins * 2).map((id) => (Number.isInteger(id) && id >= 0 ? id : 0))
    : undefined;
}

/**
 * The pins: GetIdArray gives one id per slot (0 = empty), ReadList the
 * metadata of the ids asked. A pin is invoked by its slot, from 1 (Linn's
 * Kazoo shows them so): [{ index, title }].
 */
export function parsePins(idArray, listText, deviceMax) {
  const list = parseJson(listText);
  if (!Array.isArray(idArray) || !Array.isArray(list)) {
    return undefined;
  }
  const byId = new Map();
  for (const entry of list.slice(0, LIMITS.pins * 2)) {
    if (entry && typeof entry === 'object' && Number.isInteger(entry.id) && entry.id > 0) {
      byId.set(entry.id, entry);
    }
  }
  const max = Number.isInteger(deviceMax) && deviceMax > 0 ? deviceMax : idArray.length;
  const pins = [];
  for (let slot = 0; slot < Math.min(max, idArray.length, LIMITS.pins); slot += 1) {
    const entry = idArray[slot] > 0 ? byId.get(idArray[slot]) : undefined;
    const title = cleanText(typeof entry?.title === 'string' ? entry.title : undefined);
    if (entry && title) {
      pins.push({ index: slot + 1, title });
    }
  }
  return pins;
}
