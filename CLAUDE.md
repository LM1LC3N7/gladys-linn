# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its
only runtime dependency (UPnP goes through `node:http`). It drives Linn
players and other OpenHome devices through their OpenHome UPnP services on
the LAN: one device per UDN, polled (no inbound port, so no GENA). Local
only. Unofficial: not affiliated with Linn Products. Not the DLNA
integration (`guim31/gladys-dlna`): OpenHome services only.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # regenerate cover.png (800×534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit; the CI
runs the tests on Node 22 and 24.

## Architecture

```
index.js                   SDK bootstrap only
src/handlers.js            every SDK handler -> the app (shared with the tests)
src/app.js                 LinnApp: discovery, records, polling, commands,
                           volume cap, status, buttons
src/queue.js               one request at a time per device, commands first
src/model.js               features, Gladys device, states (pure)
src/config.js              config_schema normalized
src/constants.js           frozen keys, timings, limits
src/i18n.js                runtime texts (en/fr)
src/openhome/http.js       the only network access (GET / POST, deadline,
                           size cap, no redirect, Connection: close)
src/openhome/xml.js        the hardened XML parser (DOCTYPE refused)
src/openhome/soap.js       envelope, out arguments, faults
src/openhome/description.js SSDP answers, descriptions, LAN checks (pure)
src/openhome/parse.js      source list, DIDL-Lite, pins, booleans (pure)
src/openhome/client.js     the OpenHome actions of one device
test/helpers/              a fake OpenHome device on loopback HTTP
test/fixtures/             the Linn description of openhomedevice (MIT)
```

## Rules

- **Keys are forever**: the feature keys (`FEATURES`), the external id
  `openhome:<udn>`, the option values `source:<index>` / `pin:<slot>` and the
  manifest keys are stored in user scenes and dashboards. Never rename them.
- **Volume cap**: every path that can make a player louder from Gladys
  (volume, unmute, power on, source, pin, play, next or previous in standby) goes through the cap,
  read just before the request leaves.
- **No switch** for power: read-only state plus push buttons.
- **Commands**: 3.5 s budget, never sent late, the result said exactly (any
  HTTP answer means the request arrived). One queue job per request, its
  timeout bounded by the deadline it belongs to; every command cancels the
  read in flight, and Standby also cancels a command that has not written yet
  (it only waits for a write already sent, never cancelled).
- **Hostile answers**: bounded sizes (`LIMITS`), the XML parser refuses a
  `DOCTYPE`, nothing read from a device becomes an object key, control URLs
  stay on the host of the description, SSDP locations on the address that
  answered.
- **Read-only rootfs**: write nothing on disk.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }`; `test/manifest.test.js` ties the
  manifest to the code; `docs/en.md` and `docs/fr.md` kept in sync.
- **Tests never touch the network** beyond the loopback fake device.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.
