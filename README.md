# Apple Device Tracker — Gladys external integration

Track the position of your Apple devices through **Find My** and use them as
**presence sensors** in [Gladys Assistant](https://gladysassistant.com).

Built on the official [JavaScript integration
template](https://github.com/GladysAssistant/integration-template-js) and the
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> User documentation: [`docs/en.md`](./docs/en.md) —
> [`docs/fr.md`](./docs/fr.md) (Gladys re-hosts them and links to them from the
> Configuration screen).

## What it does

One Gladys device per device visible in Find My, refreshed by **polling** at the
`poll_frequency` you configure:

| Feature            | Category / type                  | Notes                             |
| ------------------ | -------------------------------- | --------------------------------- |
| Presence           | `presence-sensor` / `binary`     | The scene trigger: 1 when at home |
| Distance from home | `distance-sensor` / `decimal` km | Great-circle distance             |
| Position accuracy  | `distance-sensor` / `integer` m  | Apple's own uncertainty radius    |
| Position           | `text` / `text`                  | `latitude,longitude`              |
| Position age       | `duration` / `integer` minutes   | How stale Apple's last fix is     |
| Battery            | `battery` / `integer` %          | Only on devices that report one   |
| Charging           | `battery` / `charging`           | Only on devices that report one   |

Presence is deliberately a plain binary sensor, so it works as a normal Gladys
scene trigger with no extra glue.

## How it works

Apple has no official Find My API, so the integration talks to the same
endpoints the icloud.com web app uses:

1. **SRP-6a sign-in** on `idmsa.apple.com` ([`src/icloud/srp.js`](./src/icloud/srp.js)).
   The password never leaves the process: only a cryptographic proof is sent,
   and the server's own proof is verified back.
2. **Two-factor validation**, then a **trust token** so later restarts sign in
   silently. The session (tokens + cookies) is persisted through
   `setConfig` under a key kept out of the manifest schema, never shown in the
   UI.
3. **`refreshClient`** on the account's Find My service URL, which returns every
   device with its position and battery.

Two rules turn a raw GPS fix into a usable presence sensor
([`src/presence.js`](./src/presence.js)):

- a position vaguer than `max_accuracy` is **ignored** rather than teleporting
  the device;
- a device becomes present inside `home_radius` but only absent past **125%**
  of it, so a phone parked at the edge of the zone does not flap.

Gladys polls **per device** while Find My answers for **all** devices at once,
so [`src/tracker.js`](./src/tracker.js) collapses the per-device polls into a
single call to Apple (in-flight de-duplication + a freshness window), and only
publishes the values that actually changed — the host API rate-limits states.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no iCloud logic)
├─ src/
│  ├─ tracker.js                     # sign-in, device cache, refresh, publication
│  ├─ presence.js                    # haversine + presence rules (accuracy, hysteresis)
│  ├─ config.js                      # config defaults, normalization and bounds
│  ├─ icloud/
│  │  ├─ client.js                   #   the only file that talks to Apple
│  │  └─ srp.js                      #   SRP-6a client (RFC 5054, 2048-bit, SHA-256)
│  └─ devices/
│     ├─ index.js                    #   registry: raw Find My list <-> Gladys devices
│     └─ appleDevice.js              #   one Apple device: features and states
├─ docs/en.md, docs/fr.md            # user documentation, linked from Gladys
├─ gladys-assistant-integration.json # manifest (config schema, actions, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## Configuration

Everything is filled in from the Gladys Configuration screen — see
[`docs/en.md`](./docs/en.md) for the step-by-step, including the two-factor
code.

| Key              | Default | Meaning                                    |
| ---------------- | ------- | ------------------------------------------ |
| `apple_id`       | —       | Apple ID email (required)                  |
| `apple_password` | —       | Apple ID password, stored as a secret      |
| `home_latitude`  | 48.8566 | Home position, decimal degrees (required)  |
| `home_longitude` | 2.3522  | Home position, decimal degrees (required)  |
| `home_radius`    | 150     | Meters, radius marking a device as present |
| `poll_frequency` | 300     | Seconds between two refreshes (60–3600)    |
| `max_accuracy`   | 500     | Meters, above which a position is ignored  |
| `include_family` | true    | Include the Family Sharing devices         |

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="apple-device-tracker" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, via the built-in `node --test` runner
```

The tests cover the parts that can be checked without an Apple account: the SRP
exchange is verified against an independent SRP-6a server implementation, the
iCloud client against a scripted Apple (status codes, headers, cookies, expired
sessions), and the presence rules, the device mapping and the polling
de-duplication against fixtures.

## Publishing a new version

Actions → **Release** → pick patch / minor / major. The workflow bumps
`package.json` and the manifest, tags, and builds the multi-arch image to
`ghcr.io`.

## Caveat

Apple publishes no official Find My API and can change these endpoints without
notice. Use the integration with that in mind: it is a best-effort client of a
private interface, not a supported product.

## License

[Apache-2.0](./LICENSE)
