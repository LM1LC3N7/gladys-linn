# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-linn/commits/main
