# Linn & OpenHome for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for
**Linn** network players and the other **OpenHome** devices, 100 % local
(UPnP on the LAN):

- one Gladys device per player, found by an SSDP search through the Gladys
  core (or by the URL of its UPnP description);
- power state, **Power on** and **Standby** buttons;
- volume (0-100) **capped** by the configuration, mute;
- play, pause, next, previous, playback state, title playing;
- the **sources** of the player and its **pins** (the presets of the Linn
  app) in one list.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

**Not the DLNA integration.** [guim31/gladys-dlna](https://github.com/guim31/gladys-dlna)
drives generic UPnP AV renderers (`AVTransport`, `RenderingControl`: URLs,
media servers, notifications). This integration only drives the OpenHome
services, never the UPnP AV ones: Product (sources, standby) and Pins, which
DLNA has not got, plus the OpenHome Volume, Transport and Info. Both can run
side by side; the volume cap does not apply to what the DLNA integration sends.

**Never tested with a real device**: written from
[openhomedevice](https://github.com/bazwilliams/openhomedevice) 2.7 (MIT, the
library of the Home Assistant integration), tested against a fake device.
Unofficial integration, not affiliated with Linn Products.

## Requirements

- Gladys Assistant 5.1.0 or later (mediated network discovery).
- The players on the same network as Gladys for the SSDP search; a player on
  another subnet is added by the URL of its description.

## How it works

- **Discovery**: the container sits on a Docker bridge, where SSDP multicast
  never arrives. The core sends the M-SEARCH (`upnp:rootdevice`, manifest
  `network_discovery`) and relays the raw answers; the integration reads the
  descriptions and keeps the devices with an OpenHome Product service.
- **State**: no inbound port, so no UPnP eventing: each created player is read
  every 10 s (configurable), one SOAP request at a time, only the changes
  published.
- **Safety**: the volume set from Gladys never goes above the cap (unmuting
  and waking up included); no switch an "everything off" could reach; a
  command is answered within 3.5 s, "not sent" or "sent, without
  confirmation" said exactly; Standby cancels the read in flight and any
  command that has not written yet: it only waits for a write already sent.
- **Hostile answers**: descriptions bounded to 256 KB, SOAP answers to 64 KB,
  a linear XML parser that refuses any `DOCTYPE` (no entity ever resolved),
  no redirect, control URLs kept on the host of the description, SSDP
  locations only on the private address that answered.
- No runtime dependency besides the Gladys SDK (`node:http` for UPnP).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npx --yes github:GladysAssistant/integration-store .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and [TODO.md](TODO.md) for
the status and the decisions.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
