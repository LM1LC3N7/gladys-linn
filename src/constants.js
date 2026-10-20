// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-linn (+https://github.com/LM1LC3N7/gladys-linn)';

/** `gladys.externalIds(DEVICE_TYPE, <uuid of the device>)`. */
export const DEVICE_TYPE = 'openhome';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or unreachable). */
  POWER: 'power',
  /** Push button: Product.SetStandby(false). */
  POWER_ON: 'power_on',
  /** Push button: Product.SetStandby(true). */
  STANDBY: 'standby',
  /** 0..100, capped by the `max_volume` option. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the device. */
  MUTE: 'mute',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  /** Read only: 1 playing, 0 otherwise. */
  PLAYBACK: 'playback',
  /** Select: the visible sources (`source:<index>`) then the pins (`pin:<n>`). */
  SOURCE: 'source',
  /** Read only: "Artist - Title" of what plays. */
  TITLE: 'title',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_devices',
  LIST: 'list_sources',
});

/**
 * The SSDP search target. The core sends one M-SEARCH (only the first ssdp
 * entry of a manifest is scanned): the root devices answer, and only those
 * whose description has an OpenHome Product service are kept.
 */
export const SSDP_ST = 'upnp:rootdevice';

/** The OpenHome services used, by service id suffix. */
export const SERVICES = Object.freeze({
  PRODUCT: 'Product',
  VOLUME: 'Volume',
  TRANSPORT: 'Transport',
  INFO: 'Info',
  PLAYLIST: 'Playlist',
  RADIO: 'Radio',
  PINS: 'Pins',
});

/** The volume cap of the configuration, in percent. */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 50 });

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = Object.freeze({ min: 5, max: 300, default: 10 });

export const TIMINGS = Object.freeze({
  /** One SOAP request or description read. */
  requestTimeout: 3_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-device queue and every request included) gets `commandBudget`; a
   * command that could not start within it is refused, never sent late.
   */
  commandBudget: 3_500,
  /** Under this much budget left, a request is not started. */
  minRequest: 300,
  /** A device that just came back from standby is checked against the cap this often... */
  wakeCheckDelay: 2_500,
  /** ...this many times. */
  wakeChecks: 6,
  /** Backoff of an unreachable device: base, doubled up to max. */
  backoffBase: 10_000,
  backoffMax: 5 * 60_000,
  /** Failed polls in a row before a device is called unreachable. */
  offlineAfter: 2,
  /** The source list and the pins are read again this often. */
  listsTtl: 30 * 60_000,
  /** While a created device is unreachable, an automatic SSDP search at most this often. */
  autoScanInterval: 10 * 60_000,
  /** SSDP listening time. */
  scanSeconds: 5,
  /** Descriptions read at the same time during a search. */
  scanConcurrency: 4,
  /** The "Check the players" button reads within this (its manifest timeout is 30 s). */
  checkBudget: 25_000,
  /** Background round: status, automatic search. */
  tick: 60_000,
});

export const LIMITS = Object.freeze({
  /** A description document (a Linn one is about 40 KB). */
  descriptionBytes: 256 * 1024,
  /** A SOAP answer (source list, pins, track metadata). */
  soapBytes: 64 * 1024,
  /** SSDP answers kept from one search, and descriptions read. */
  ssdpAnswers: 64,
  descriptions: 32,
  /** Description URLs typed in the configuration. */
  urls: 20,
  /** Sources and pins kept from one answer. */
  sources: 40,
  pins: 40,
  /** Length of a published title, and of a name. */
  title: 200,
  name: 64,
  /** Gladys devices handled. */
  devices: 20,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
