# Test fixtures

- `linndescription.xml`: the UPnP description of a Linn device (Davaar
  firmware), unchanged, from the tests of
  [openhomedevice](https://github.com/bazwilliams/openhomedevice)
  (`tests/data/linndescription.xml`, commit `411fd74`, version 2.7), MIT
  License, Copyright 2017 Barry John Williams. The full notice is in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

The fake device of `test/helpers/fakeOpenhome.js` answers the SOAP actions
with values shaped after the fakes of the same tests (`LinnDeviceTest.py`).
