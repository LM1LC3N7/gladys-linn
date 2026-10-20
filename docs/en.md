# Linn and OpenHome for Gladys

Drive your **Linn** network players (DS, DSM, Majik, Selekt, Klimax…) and the
other **OpenHome** devices from Gladys, locally, without any cloud: power on,
standby, volume, mute, source, pins (the presets of the Linn app), play,
pause, next, previous and the title playing.

> **Important.** This integration has never been tested with a real device:
> it was written from the `openhomedevice` library (the one of Home
> Assistant) and tested against a fake device only. Your feedback is welcome.
> Unofficial integration, not affiliated with Linn Products.

## This is not the DLNA integration

The [DLNA integration by guim31](https://github.com/guim31/gladys-dlna)
(`guim31/gladys-dlna`) drives any generic UPnP AV renderer (the
`AVTransport` and `RenderingControl` services): play a URL or a media server,
volume, playback. It works with a Linn too.

This one takes another path: it only talks to the **OpenHome services**
(`urn:av-openhome-org`), never to `AVTransport` or `RenderingControl`. It brings
what DLNA has not got:

- the **sources** of the device (Playlist, Radio, Songcast, HDMI, analogue,
  digital inputs…), picked from a list;
- the **pins** set in the Linn app: a radio, a playlist, an input, recalled in
  one click;
- **standby** (power on, standby, power state);
  It also drives the volume (**capped**), the mute, the playback and the title,
  through the OpenHome Volume, Transport and Info services.

It does not play URLs, browse media servers or play notifications: keep the
DLNA integration for that. Both can run side by side; the same player can
then be created in each. Beware: the volume cap of this integration does not
apply to what the DLNA integration sends to the same player.

## Installation

1. In Gladys, install the **Linn & OpenHome** integration.
2. Choose the **volume cap** (50 by default) in its configuration.
3. Open the **Discovery** tab: the players found by the SSDP search (run by
   Gladys on your network) are listed. Create them.

A player on another subnet or VLAN is not found by SSDP: type the URL of its
**UPnP description** in the configuration instead (optional field, for
example `http://192.168.1.30:55178/<uuid>/Upnp/device.xml`). A UPnP discovery
tool on your computer shows it.

## What you get

| Feature        | Gladys type                | Note                                                  |
| -------------- | -------------------------- | ----------------------------------------------------- |
| Power          | binary state (read only)   | 1 on, 0 in standby or unreachable                     |
| Power on       | button                     | wakes the player from standby                         |
| Standby        | button                     | puts the player in standby                            |
| Volume         | music / volume (0 to 100)  | capped; absent when the player has a fixed volume     |
| Mute           | button (television / mute) | a press reads the state, sets the opposite; 0 unmutes |
| Play, pause    | music buttons              |                                                       |
| Next, previous | music buttons              | not on a radio                                        |
| Playback       | music state (read only)    | 1 playing, 0 otherwise                                |
| Source         | list                       | the visible sources, then the pins ("3. FIP")         |
| Now playing    | text (read only)           | "Artist - Title" (or the radio text); "—" otherwise   |

On purpose, no **switch**: an "everything off" or "everything on" from a
voice assistant or a scene never wakes up or cuts your player.

## Volume cap

The volume asked from Gladys (dashboard, scene, voice assistant) never goes
above the cap of the configuration: a higher volume is set to the cap. The
cap is read just before sending: a new value saved applies at once. The volume
set on the player itself (knob, remote, app) is not changed, except where
Gladys would make it audible:

- **Unmuting**: if the volume is above the cap, it is lowered to the cap
  first, then the mute is removed.
- **Power on**, or a source, a pin, Play, Next or Previous while the player is
  in standby (a Linn then leaves standby): after the wake-up, the volume is read and lowered to the cap if above it.
  If the player takes time to wake up, the integration checks again every
  2.5 s for about 15 s, unless Standby is pressed meanwhile.

The cap is a percentage: when the player announces a maximum volume other
than 100 (`Volume.Characteristics`), the volume and the cap are scaled to its
steps.

## Reading the state

The container of the integration has no inbound port: UPnP events (GENA)
cannot reach it. The integration therefore reads each created player at a
regular interval (10 s by default, 5 to 300 s): standby, source, volume, mute,
playback state, and the title only when its counters say it changed. One
request at a time per player. In standby, only the standby is read. The
source list and the pins are read again every 30 minutes, or when an unknown
source is selected.

A player that stops answering is shown as off, named in the status of the
integration, and tried again at spaced intervals (up to 5 minutes). A new
SSDP search then runs by itself at most every 10 minutes, to follow a new
address (the player is recognized by its UDN).

## Commands

Every command gets an answer within 4 seconds (Gladys waits 5 seconds): each
request is bounded by what is left of that time, and the cap check after a
wake-up goes on in the background if needed. A command that could not leave
says "not sent"; a command that left but whose answer is missing or unusable
(timeout, HTTP error) says "sent, without confirmation"; a refusal by the
player (a SOAP fault) is quoted as is.

A command cancels the state read in flight and goes before it; Standby and
mute also go before the other commands waiting: **Standby never waits for a
slow player**. A source is checked against the list read again from the
player before sending; for a pin, the slot is read again and must still hold
the same pin (else nothing is sent).

Mute: the dashboard button sends a press, which sets the opposite of the state
read. A scene sending 0 unmutes (cap applied); if already unmuted, nothing is
sent.

## Configuration buttons

- **Check the players**: the state of each created player (power, source,
  volume, mute) and the cap in force, within 25 seconds (a player that could
  not be read in time says "not read").
- **List the sources and pins**: runs the search again, then lists the
  visible sources and the pins of each player.

## Security, data and privacy

- The integration asks for no account and no password: OpenHome has none. It
  writes nothing on disk. Nothing leaves your local network.
- The answers of the players are bounded (256 KB for a description, 64 KB for
  a SOAP answer) and read by a linear XML parser that refuses any `DOCTYPE`:
  no external or internal entity is ever resolved.
- An SSDP answer is kept only when its description URL is `http` on the
  private address that answered; every control URL must stay on the same
  machine and port as the description.

## Known limits

- No Songcast (room groups), URL playback, notification, balance, sleep timer
  or firmware update.
- No UPnP events: a change made on the player shows at the next read at the
  latest.
- Never tested with a real device: the real answers may differ.
