# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) that tracks Apple devices through **Find My**
(iCloud) and exposes them as **presence sensors**. One Gladys device per Find My device:
presence (binary, the scene trigger), distance from home, position accuracy, position (text),
position age, battery and charging (when reported), and a Ring button. Gladys 5.1+ adds widgets,
scene triggers and scene actions. AirTags and other Find My accessories are not readable through
this API (documented in the user docs).

## Commands

```bash
npm install
npm test                                   # node --test (built-in runner)
node --test test/srp.test.js               # one file
node --test --test-name-pattern "radius"   # one test by name
npm run lint                               # eslint .
npm run format:check                       # prettier --check . (CI gate)
npm run format                             # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, re-runs Prettier, tags, builds).

## Architecture

```
index.js                 SDK wiring: initialize(), 2FA actions, health reporting, widgets, scenes
src/config.js            defaults, bounds, Gladys poll tick (gladysPollFrequency), helpers
src/homeLocation.js      read the Gladys house position (pre-fills the home coordinates)
src/icloud/srp.js        Apple's SRP-6a sign-in maths
src/icloud/client.js     iCloud client: sign-in, 2FA (trusted devices / SMS), Find My calls
src/tracker.js           AppleDeviceTracker: session, refresh, polls, health, ring
src/presence.js          distance (great circle) and home/away decision with accuracy
src/devices/appleDevice.js  discovery payload and states of one device
src/devices/index.js     device helpers
src/scenes.js            scene trigger events and action outputs
src/widgets.js           dashboard widgets
```

### Invariants worth knowing

- **The iCloud session is stored in the Gladys config**, outside `config_schema`
  (`icloud_session`, JSON), with `gladys.setConfig()` — so a restart does not ask for a new
  two-factor code. The Apple ID password is a `secret` field. Never log either.
- **Two-factor flow**: Apple pushes a code to trusted devices (or SMS on request); the user types
  it with the `submit_2fa_code` action. The connection status names where the code was sent.
- **An expired session is replayed once** with a forced sign-in (refresh, ring, message all go
  through `withSessionRenewal`); if Apple wants a new 2FA code, `tracker.onHealth` reports it in
  the Configuration screen instead of freezing silently. At most one forced sign-in per 15 min
  (account lock risk), and failed refreshes back off exponentially.
- **A startup sign-in that fails on an outage** (network, Apple 5xx = `ICloudUnavailableError`)
  is retried by the tracker (1, 5, 15, 30 min); refused credentials and 2FA never are.
- **Polling**: devices carry `should_poll: true` (Gladys never polls without it) and the slowest
  Gladys tick not above the configured interval (Gladys only accepts 1 s–60 s in ms, any other
  value rejects the whole discovery). The configured interval (60–3600 s) is enforced by the
  tracker.
- **No fake values**: Apple's 0 % battery of an unreachable device is not published; charging is
  `input/binary` (a battery category fired false low-battery alerts); positions vaguer than
  `max_accuracy` are ignored. Stable values are re-published so Gladys never shows "no recent
  value".
- **States published before creation are lost**: `onDeviceCreated` / `onDeviceUpdated` force a
  read.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys). Ring is `button/push`.
- **Home coordinates are personal data**: pre-filled from the Gladys house (`"location": true` in
  the manifest), they only serve the distance computation.
- Widget, trigger and action keys are stored by users: never rename them.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` in sync with `DEFAULT_CONFIG`,
the bounds and the handlers (`gladys_version >=5.1.0`).

## Testing

No network: the iCloud endpoints are stubbed; SRP is checked against known vectors;
`test/helpers/fakeGladys.js` stands in for the SDK.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why** (many document real Apple
behaviours). User-facing messages are bilingual `{ en, fr }`; user docs in `docs/en.md` and
`docs/fr.md`, kept in sync. The container rootfs is read-only: write nothing.
