// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { LIMITS, MAX_VOLUME, POLL_INTERVAL } from './constants.js';
import { parseLocation } from './openhome/description.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  description_urls: '',
  max_volume: MAX_VOLUME.default,
  poll_interval: POLL_INTERVAL.default,
};

/** An integer within bounds; anything unreadable ('' , null, true, 'abc') gives the default. */
export function parseBounded(raw, { min, max, default: fallback }) {
  const number = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * The description URLs typed by the user (for a device SSDP cannot reach):
 * plain http, separated by commas, spaces or new lines. An invalid entry is
 * reported by its position only (never echoed in full).
 *   -> { urls: [string], invalid: [positions] }
 */
export function parseUrls(text) {
  const urls = [];
  const invalid = [];
  String(text ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .forEach((entry, index) => {
      const url = parseLocation(entry);
      if (!url || url.pathname === '/') {
        invalid.push(index + 1);
      } else if (!urls.includes(url.href) && urls.length < LIMITS.urls) {
        urls.push(url.href);
      }
    });
  return { urls, invalid };
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const { urls, invalid } = parseUrls(c.description_urls);
  return {
    urls,
    invalid,
    maxVolume: parseBounded(c.max_volume, MAX_VOLUME),
    pollInterval: parseBounded(c.poll_interval, POLL_INTERVAL) * 1000,
  };
}
