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
- [x] **Milestone 1 fixes — review 1** (2026-10-21): one queue job per
      request, bounded by the deadline of its command (Power on acked in
      time, its cap check in steps); every command cancels the read in
      flight (Standby also cancels a command still reading, waits only for a
      write already sent); Play / Next / Previous
      in standby check the cap; HTTP errors after the request = "sent,
      without confirmation", only a 200 is a success; linear entity
      decoding; mute 0 = unmute; pin slot read again; VolumeMax scaling;
      unused records forgotten; "Check" bounded to 25 s.
- [x] **Milestone 1 fixes — review 2** (2026-10-21): a Standby also
      cancels a command still in its read phase (its reads carry the job
      signal, the job is marked writing just before its first write, and a
      cancelled command never writes afterwards); a `VolumeMax` of 100 or
      more is ignored (scale only downwards).
- [x] **Milestone 1 fixes — review 3** (2026-10-21): a command that can
      wake the player (Power on, source, pin, play, next, previous) and was
      still waiting when a Standby arrived is not sent (`standbySeq` kept
      at its arrival, checked at the start of its job).
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
- `Volume.Characteristics` on a Linn: `VolumeMax` 100 expected (the volume
  is scaled otherwise; a device without the action is taken as 0-100).
- Does Play / Next on a Linn in standby wake it (ohMediaPlayer activates the
  source)? The cap is checked after either way.
- What the dashboard sends for a `television/volume-mute` press (1 assumed,
  as `PushDeviceFeature`).
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
  `guim31/gladys-dlna` overlaps functionally when a Linn also exposes UPnP AV
  (volume, playback), never in code or protocol: this integration drives the
  OpenHome services only (Product and Pins, which DLNA has not got, plus the
  OpenHome Volume, Transport and Info), never AVTransport or RenderingControl.
  The docs, the manifest and the README say so, and that the cap does not
  apply to a player also driven by the DLNA integration.
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
  off" could reach; mute as `television/volume-mute` (a press, which the
  dashboard sends as 1: read, then set the opposite; 0 = unmute, so a scene
  can unmute without knowing the state; the cap first); the source and the pins in one `text/select`
  (`source:<index>`, `pin:<slot>`; keys forever).
- **Volume cap** 50 by default (1-100), read just before each send; unmuting
  lowers to the cap first; Power on, or a source / pin / Play / Next /
  Previous in standby, checks the volume after the wake-up (within the
  command budget, then every 2.5 s, 6 times; a Standby stops it). The cap is
  in percent, scaled to `VolumeMax` only when it is under 100 (a wrong
  value may make a player quieter, never louder; to confirm on a real one).
- **Commands**: a 3.5 s budget, a request not started under 300 ms left;
  "not sent" / "sent, without confirmation" (any HTTP answer, even an
  error, means the request arrived) / the SOAP fault quoted. One queue job
  per request; every command cancels the read in flight (the queue moves on
  even if the request ignores its signal), a write is never cancelled.
  Standby is never blocked by the backoff of an unreachable device: tried
  once. A pin is invoked only if `GetIdArray` read again shows the same id
  in its slot.
- **Records**: a device neither created nor seen by the last search is
  forgotten (a host announcing many UDNs never fills the table for good).
- **XML**: a `DOCTYPE` is refused (UPnP never sends one), only the five XML
  entities and numeric references are decoded, depth / size / nodes bounded.
- **No /data**: no secret, no state worth keeping (the created devices hold
  their description URL in Gladys).
- The store validator (`npx github:GladysAssistant/integration-store .`)
  could not be run from the development session: to run before publishing.
