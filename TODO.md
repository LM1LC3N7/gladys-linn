# TODO — Linn & OpenHome v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm run audit`, then update README, `docs/en.md`, `docs/fr.md`,
  `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (lot 11).

## Status

- [x] **Milestone 1 — core** (2026-10-20): SSDP search through the core
      (`upnp:rootdevice`, descriptions with an OpenHome Product service),
      typed description URLs, created devices read again from their
      `LOCATION` param; one device per UDN with power (read only), Power on,
      Standby, volume capped, mute, play, pause, next, previous, playback,
      source + pins list, title; polling one request at a time, commands
      before polls, standby and mute first; 3.5 s command budget; unreachable
      backoff and automatic search; "Check the players" and "List the sources
      and pins". Tested against a fake device on loopback HTTP and the Linn
      description of openhomedevice. No real device.
- [ ] **Milestone 2 — real players**: a tester's Linn (see below), captures
      of the SOAP answers turned into fixtures (anonymized).
- [ ] **Milestone 3 — more**: Songcast groups (Receiver / Sender), Radio
      `SetChannel` for a URL or a notification (with resume), balance,
      sleep timer, the `Product:3` `SourceXmlChangeCount` to read the source
      list only on change, a dashboard widget.
- [ ] **Milestone 4 — first release**: Docker image build check, store
      validator, Release workflow, topic (the main session publishes).

## To check on a real player

- Does a Linn answer the core's M-SEARCH for `upnp:rootdevice`? (UDA says
  every root device must.) Is the LOCATION on the address that answered?
- `SetStandby` with `1` / `0` (UPnP boolean), `SetMute` the same.
- `Volume` range on a Linn (0-100 in Kazoo; `Characteristics` gives
  `VolumeMax`): a device whose maximum is not 100 would need a scale.
- `Info.Counters` changes with each track and each radio text?
- `Pins.ReadList` with only the non-zero ids, as sent here (openhomedevice
  sends the whole IdArray, zeros included).
- What the transport state is on an HDMI or analogue input (no Transport
  action may apply: next / previous then fail with the device's fault).

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the first patch release gives 0.1.1).
- **Not a duplicate** (lot 11 proposal, line 14, checked 2026-10-20): no Linn
  or OpenHome integration in the core, the store, the forum thread or GitHub.
  `guim31/gladys-dlna` overlaps partly (generic UPnP AV, which a Linn also
  exposes): this integration only drives the OpenHome services DLNA has not
  got (sources, pins, standby) plus the OpenHome volume and transport, and
  says so in the docs, the manifest and the README.
- **Own client on `node:http`, no UPnP library**: openhomedevice (MIT,
  maintained, used by Home Assistant) is Python on async_upnp_client; its
  logic is ported (credited in THIRD_PARTY_NOTICES.md). The only runtime
  dependency stays the SDK.
- **`upnp:rootdevice` as the search target**: the core scans only the first
  ssdp entry of a manifest, and a device answering `Product:4` might not
  answer `Product:1`; every root device must answer `upnp:rootdevice`. The
  descriptions read are bounded (32 per search, 4 at a time, 256 KB each).
- **Polling, not GENA**: the container has no inbound port for the device to
  call back (the DLNA integration made the same choice).
- **Features like the Cambridge Audio integration**: power read only
  (`unknown/binary`), Power on / Standby buttons, no switch an "everything
  off" could reach; mute as `television/volume-mute` (a press: read, then
  set the opposite); the source and the pins in one `text/select`
  (`source:<index>`, `pin:<slot>`; keys forever).
- **Volume cap** 50 by default (1-100), read just before each send; unmuting
  lowers to the cap first; Power on, or a source / pin chosen in standby,
  checks the volume after the wake-up (within the command, then every 2.5 s,
  6 times).
- **Commands**: a 3.5 s budget, a request not started under 300 ms left;
  "not sent" / "sent, without confirmation" / the SOAP fault quoted. Standby
  is never blocked by the backoff of an unreachable device: tried once.
- **XML**: a `DOCTYPE` is refused (UPnP never sends one), only the five XML
  entities and numeric references are decoded, depth / size / nodes bounded.
- **No /data**: no secret, no state worth keeping (the created devices hold
  their description URL in Gladys).
- The store validator (`npx github:GladysAssistant/integration-store .`)
  could not be run from the development session: to run before publishing.
