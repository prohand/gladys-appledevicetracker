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
| Charging           | `input` / `binary`               | Only on devices that report one   |
| Ring               | `button` / `push`                | Command: plays the Find My sound  |

Presence is deliberately a plain binary sensor, so it works as a normal Gladys
scene trigger with no extra glue.

`Charging` is an `input`/`binary` sensor and NOT the `battery`/`charging` pair
Gladys has for it: the core warns "battery level under 10%" for every feature of
the `battery` CATEGORY below the threshold, whatever its TYPE
(`device.checkBatteries` never reads it). A charging sensor holds 0 or 1, so it
was read as "0%" and fired a false low-battery alert every day on every phone.
`input`/`binary` is the generic read-only binary sensor of Gladys — same 0/1
value, same use in a scene, outside the category that check scans.

Its `external_id` moved with it (`charging-state`, not `charging`), so the old
battery-category feature of a device created before 1.0.6 is never fed again.
That old row keeps alerting until it is removed: **Discovery** tab of the
integration, **Update** on the device, and Gladys deletes the features that are
no longer in the payload.

Every measurement is read-only; `Ring` is the one writable feature. The pair
`button`/`push` is what Gladys renders as a real PUSH BUTTON on the dashboard,
right next to the presence of that phone (a `switch`/`binary` would land on the
on/off toggle instead — the interface routes every `binary` type there — and a
toggle is the wrong control for "ring now"). It is write-only, like the
remote-control keys of a television: Apple reports nothing back, so the feature
carries no state and no history, and a press is just a press. The same
operation stays available for a device the user has not created yet, through
the "Make a device ring" action of the Configuration screen.

## Widgets, scene triggers and scene actions (Gladys 5.1+)

Declared in the manifest (`widgets`, `scene_triggers`, `scene_actions`), drawn
by Gladys itself — hence `gladys_version: ">=5.1.0"` (an older Gladys refuses
the unknown manifest fields).

| Kind          | Key                   | What it does                                                   |
| ------------- | --------------------- | -------------------------------------------------------------- |
| Widget        | `presence`            | Who is home: one status line per device, refresh button        |
| Widget        | `device`              | One device: live battery/distance tiles, 24 h chart, ring, map |
| Scene trigger | `device_arrived_home` | Presence 0 → 1, filter on the devices                          |
| Scene trigger | `device_left_home`    | Presence 1 → 0, filter on the devices                          |
| Scene trigger | `sign_in_required`    | iCloud starts asking for a new two-factor code                 |
| Scene action  | `send_message`        | Shows a text on the device screen (Find My `sendMessage`)      |
| Scene action  | `refresh_positions`   | Reads Find My now; outputs devices at home / tracked           |
| Scene action  | `get_device_position` | Outputs position, distance, battery, Apple Maps link           |

The rules they follow ([`src/scenes.js`](./src/scenes.js),
[`src/widgets.js`](./src/widgets.js)):

- **One event per transition.** Arrival and departure fire on a presence
  CHANGE only — never on the first reading after a start (every phone at home
  would "arrive" again on each restart), and only for the devices created in
  Gladys. They go out after the states, so a scene reading the Presence feature
  finds the new value. `sign_in_required` fires on the status change, not on
  every tick that hits the same wall.
- **A refused event is never fatal.** `publishSceneEvent` errors are logged
  (a 404 once), the states and the refresh loop carry on.
- **Widgets never call Apple.** Their content is built from the tracker's
  memory; the tiles and the chart are bound to the features, so Gladys keeps
  them live on its own. The status lines are re-read at `ttl_seconds` (the
  refresh interval) or sooner, when a refresh published new values
  (`requestWidgetRefresh`).
- **User-driven reads are floored.** The widget Refresh button and the refresh
  scene actions go through `refreshNow()`: one Find My call every 30 s at most,
  which also stops an arrival scene that refreshes from looping on itself.
- **Checked like Gladys checks them.** The tests run every widget content
  through the SDK's `validateWidgetContent` (budget of 8 components included),
  and the manifest tests keep keys, handlers, variables and outputs in sync.

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
Every value is still re-published at least every **30 minutes**, unchanged or
not: Gladys marks a value it has not heard about in a while as outdated and
shows "no recent value" instead of it. Same idea when Gladys polls a device for
the first time: the user has just created it, everything published before that
was dropped, so its states are sent again straight away.
Gladys accepts only its own enum of poll frequencies (milliseconds, one minute
at most), so the devices are published with that one-minute tick and the
freshness window is what enforces your `poll_frequency`.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no iCloud logic)
├─ src/
│  ├─ tracker.js                     # sign-in, device cache, refresh, publication
│  ├─ presence.js                    # haversine + presence rules (accuracy, hysteresis)
│  ├─ config.js                      # config defaults, normalization and bounds
│  ├─ scenes.js                      # scene trigger data and scene action outputs
│  ├─ widgets.js                     # dashboard widget contents (pure functions)
│  ├─ icloud/
│  │  ├─ client.js                   #   the only file that talks to Apple
│  │  └─ srp.js                      #   SRP-6a client (RFC 5054, 2048-bit, SHA-256)
│  └─ devices/
│     ├─ index.js                    #   registry: raw Find My list <-> Gladys devices
│     └─ appleDevice.js              #   one Apple device: features and states
├─ docs/en.md, docs/fr.md            # user documentation, linked from Gladys
├─ cover.svg, cover.png              # store cover: the SVG is the source (see below)
├─ gladys-assistant-integration.json # manifest (config, actions, widgets, scenes…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## Configuration

Everything is filled in from the Gladys Configuration screen — see
[`docs/en.md`](./docs/en.md) for the step-by-step, including the two-factor
code.

| Key              | Default | Meaning                                     |
| ---------------- | ------- | ------------------------------------------- |
| `apple_id`       | —       | Apple ID email (required)                   |
| `apple_password` | —       | Apple ID password, stored as a secret       |
| `home_latitude`  | 48.8566 | Home position, decimal degrees (pre-filled) |
| `home_longitude` | 2.3522  | Home position, decimal degrees (pre-filled) |
| `home_radius`    | 150     | Meters, radius marking a device as present  |
| `poll_frequency` | 300     | Seconds between two Find My calls (60–3600) |
| `max_accuracy`   | 500     | Meters, above which a position is ignored   |
| `include_family` | true    | Include the Family Sharing devices          |

The coordinates are pre-filled from the position of your Gladys house
(`GET /house` on the host API), which is why the manifest declares
`"location": true` — without that permission Gladys answers 403 and the fields
stay empty.

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

## The store cover

`cover.png` is the image the Gladys store shows (referenced by `cover_image` in
the manifest). It is generated from `cover.svg`, the source to edit — never the
PNG:

```bash
chromium --headless --screenshot=cover.png --window-size=800,534 cover.svg
```

Keep the 800×534 size: the manifest points at the file in `main`, so a new
cover is live as soon as it is merged.

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
