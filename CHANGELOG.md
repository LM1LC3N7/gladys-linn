# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-21

### Added

- One device per Linn or OpenHome player, found by an SSDP search through
  Gladys or by the URL of its UPnP description: power state, Power on and
  Standby buttons, volume 0-100 and mute, play, pause, next, previous,
  playback state, title playing, and one list of the sources and the pins
  of the player.
- A volume cap (50 by default): the volume set from Gladys never goes above
  it, and unmuting or waking a player up brings it back under the cap first.
- The state read every 10 seconds (5 to 300), one request at a time per
  player; an unreachable player is shown as off and tried again at spaced
  intervals, with an automatic search for its new address.
- "Check the players" and "List the sources and pins" buttons.
- Bounded answers and a linear XML parser that refuses any `DOCTYPE`.
- Every request is one job of the device queue, bounded by the deadline of
  its command: Standby cancels the read in flight and the command still
  reading, and a command waiting before it that could wake the player (Power
  on, source, pin, play, next, previous) is no longer sent ("not sent (Standby
  went first)"); Standby only waits for a write already sent. Power on is acked within the 5 s Gladys waits.
- A `VolumeMax` over 100 is ignored (0-100 kept): the scale only ever makes a
  player quieter.
- Play, next and previous on a player in standby check the volume cap after
  the wake-up, like Power on, a source and a pin.
- Mute: a scene sending 0 unmutes (cap first); a press of the button toggles.
- A pin is invoked only if its slot still holds the same pin on the player.
- The volume is scaled when the player's maximum (`VolumeMax`) is not 100.
- An HTTP error after the request reached the player says "sent, without
  confirmation", never "not sent"; only an HTTP 200 is a success.
- The entity decoding stays linear on a long run of `&`.
- Devices neither created nor seen by the last search are forgotten.
- "Check the players" answers within 25 s.

[Unreleased]: https://github.com/LM1LC3N7/gladys-linn/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-linn/releases/tag/v0.1.1
