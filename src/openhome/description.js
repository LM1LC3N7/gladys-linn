// -----------------------------------------------------------------------------
// Discovery, pure: SSDP answers -> description URLs, a description document
// -> the OpenHome device it describes (identity, names, control URLs).
//
// The core sends the M-SEARCH from the host network and relays the raw
// answers: [{ source_ip, source_port, headers }]. A LOCATION is kept only
// when it is plain http on the address that answered, and that address is a
// private IPv4 one: an answer on the LAN must not steer the integration
// towards Gladys itself, another host or the Internet.
//
// A device is kept when its description (the root device or one of its
// embedded devices) has an OpenHome Product service. Every control URL is
// resolved against the description URL and must stay on the same host and
// port: a description never makes the integration post to another machine.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, SERVICES } from '../constants.js';
import { childOf, childText, childrenOf, parseXml } from './xml.js';

/**
 * A private IPv4 address of a local network: 10/8, 172.16/12, 192.168/16,
 * 100.64/10 and 169.254/16 but the cloud metadata address. Loopback, public,
 * broadcast and multicast addresses are never asked from what the network
 * says; the description URLs typed by the user are their choice.
 */
export function isLanIPv4(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) {
    return false;
  }
  const [a, b, , d] = host.split('.').map(Number);
  if (host === '169.254.169.254' || d === 255) {
    return false;
  }
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** A description URL: plain http, no credentials, no fragment, bounded. */
export function parseLocation(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || raw.length > 500) {
    return undefined;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || url.username || url.password || !url.hostname) {
    return undefined;
  }
  url.hash = '';
  return url;
}

/** The headers of one SSDP answer, by lower-case name (no prototype). */
export function parseSsdpHeaders(text) {
  const headers = Object.create(null);
  for (const line of String(text ?? '')
    .slice(0, 4096)
    .split(/\r?\n/)
    .slice(1, 40)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (/^[a-z0-9.-]{1,40}$/.test(name) && !(name in headers)) {
        headers[name] = line.slice(colon + 1).trim();
      }
    }
  }
  return headers;
}

/** The SSDP answers -> the description URLs to read (strings), at most LIMITS.descriptions. */
export function ssdpLocations(answers) {
  const locations = new Set();
  for (const answer of (Array.isArray(answers) ? answers : []).slice(0, LIMITS.ssdpAnswers)) {
    const ip = answer?.source_ip;
    if (!isLanIPv4(ip)) {
      continue;
    }
    const url = parseLocation(parseSsdpHeaders(answer.headers).location);
    if (url && url.hostname === ip && locations.size < LIMITS.descriptions) {
      locations.add(url.href);
    }
  }
  return [...locations];
}

/** "uuid:4C494E4E-..." -> "4c494e4e-...", or undefined when it is no plain identifier. */
export function deviceIdOf(udn) {
  const id = String(udn ?? '')
    .trim()
    .replace(/^uuid:/i, '')
    .toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : undefined;
}

const clean = (value, max = LIMITS.name) => {
  // Control characters out (C0 and DEL), spaces folded.
  const text = Array.from(String(value ?? ''))
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : undefined;
};

export { clean as cleanText };

/** The services of a <device>, by OpenHome service name: { serviceType, controlUrl }. */
function openhomeServices(device, base) {
  const services = Object.create(null);
  for (const service of childrenOf(childOf(device, 'serviceList'), 'service')) {
    const type = childText(service, 'serviceType') ?? '';
    const match = /^urn:av-openhome-org:service:([A-Za-z]+):(\d{1,3})$/.exec(type);
    if (!match || !Object.values(SERVICES).includes(match[1]) || match[1] in services) {
      continue;
    }
    let controlUrl;
    try {
      controlUrl = new URL(childText(service, 'controlURL') ?? '', base);
    } catch {
      continue;
    }
    // Same host and port as the description, plain http: never elsewhere.
    if (controlUrl.protocol === 'http:' && controlUrl.host === base.host) {
      controlUrl.hash = '';
      services[match[1]] = { serviceType: type, version: Number(match[2]), controlUrl };
    }
  }
  return services;
}

/**
 * A description document -> the OpenHome device it holds, or undefined:
 *   { id, udn, location, host, friendlyName, manufacturer, modelName, services }
 * The root device first, then its embedded devices (breadth first, bounded).
 */
export function parseDescription(xml, location) {
  const base = location instanceof URL ? location : parseLocation(location);
  if (!base) {
    return undefined;
  }
  const root = parseXml(xml, { maxLength: LIMITS.descriptionBytes * 2 });
  if (root.name !== 'root') {
    return undefined;
  }
  const queue = childrenOf(root, 'device');
  for (let i = 0; i < queue.length && i < 16; i += 1) {
    const device = queue[i];
    const services = openhomeServices(device, base);
    const id = deviceIdOf(childText(device, 'UDN'));
    if (services[SERVICES.PRODUCT] && id) {
      return {
        id,
        location: base.href,
        host: base.hostname,
        friendlyName: clean(childText(device, 'friendlyName')),
        manufacturer: clean(childText(device, 'manufacturer')),
        modelName: clean(childText(device, 'modelName')),
        services,
      };
    }
    queue.push(...childrenOf(childOf(device, 'deviceList'), 'device'));
  }
  return undefined;
}
