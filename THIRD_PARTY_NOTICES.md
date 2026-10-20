# Third-party notices

This integration ports to JavaScript the logic of the following project: the
OpenHome services and actions it calls (Product `Standby`, `SetStandby`,
`SourceIndex`, `SetSourceIndex`, `SourceXml`; Volume `Volume`, `SetVolume`,
`Mute`, `SetMute`; Transport and its Playlist / Radio fallback for devices
without it; Info `Track`; Pins `GetDeviceMax`, `GetIdArray`, `ReadList`,
`InvokeIndex` with the slot minus one), the parsing of the source list and its
visibility values, the reading of the DIDL-Lite track metadata, and the
Linn description used as a test fixture (`test/fixtures/linndescription.xml`,
unchanged). Nothing of it is installed at runtime; its notice is reproduced
below.

## openhomedevice 2.7

<https://github.com/bazwilliams/openhomedevice> (the library behind the Home
Assistant Linn / OpenHome integration), version 2.7, commit `411fd74` of
2026-09-12

```
Copyright 2017 Barry John Williams <barry@bjw.me.uk>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Home Assistant, OpenHome integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/openhome>
(Apache License 2.0): only consulted, no code copied. That it finds the
devices by their OpenHome Product service and scales the volume from 0 to 100
is reused as a fact.

## LM1LC3N7/gladys-bluesound and LM1LC3N7/gladys-cambridge-audio

The hardened XML parser (`src/openhome/xml.js`, made stricter here: a
`DOCTYPE` is refused), the structure of the app, the volume cap rules and the
handler wiring follow integrations of the same author, under the Apache
License 2.0 of this repository.
