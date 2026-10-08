# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Fixed

- A sign-in that fails at startup because of the network or an Apple outage is now retried on its own (after 1, 5, 15, then every 30 minutes) instead of leaving the integration idle until "Test the iCloud connection"; the Configuration screen says when the next attempt is due.
- While Find My keeps failing, it is asked less and less often (1, 2, 4, 8… minutes, up to 30 minutes or the configured interval) instead of on every Gladys tick.
- A session Find My keeps refusing triggers at most one full password sign-in every 15 minutes, so the Apple account is not put at risk of being locked.
- A server error (HTTP 5xx) from Apple's sign-in service is treated as an outage: the saved session is kept instead of being replaced by a full sign-in.
- Ringing a device or showing a message on it right after the iCloud session expired now signs in again and goes through, like a refresh does.

### Changed

- Node.js 22 or later is required to run the integration outside its Docker image.
- The Docker image installs exactly the locked dependencies and leaves no npm cache behind.

## [2.2.0] - 2026-10-07

### Fixed

- A WebSocket reconnection while iCloud does not answer no longer stops the container (the `connected` handler never rejects any more).

### Changed

- Pull requests run the store admission checks; Dependabot keeps dependencies and actions up to date.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- The home coordinates pre-filled from the Gladys house are no longer written to the logs: they are personal data.

## [2.0.0] - 2026-09-23

### Added

- Dashboard widgets, scene triggers and scene actions for Gladys 5.1

## [1.0.10] - 2026-09-20

### Fixed

- Sign in again for real when Find My rejects the session

## [1.0.9] - 2026-09-19

### Fixed

- Stop the charging state from staying empty in Gladys

## [1.0.8] - 2026-09-19

### Added

- Bring the charging state back, outside the battery category

## [1.0.7] - 2026-09-19

### Fixed

- Stop the integration from freezing its values in silence

## [1.0.6] - 2026-09-19

### Fixed

- Drop the charging feature that fired a daily false low-battery alert

## [1.0.5] - 2026-09-12

### Fixed

- Stop publishing the fake 0% battery Apple sends for unreachable devices

## [1.0.4] - 2026-09-04

### Fixed

- Make the ring feature a real push button, not an on/off switch

## [1.0.3] - 2026-09-04

### Added

- Ring a device from the dashboard, and fix the store cover image

## [1.0.2] - 2026-09-03

### Fixed

- Read the Find My accessory lists, and say why AirTags never appear
- Drop the AirTag promise from the store image

## [1.0.1] - 2026-09-03

First public release.

### Added

- Apple Device Tracker external integration for Gladys
- Pre-fill the home coordinates from the Gladys house

### Changed

- Send a poll frequency Gladys accepts on published devices

### Fixed

- Allow decimal home coordinates and refresh the cover image
- Drop the unsupported "step" key from the manifest
- Ask Gladys for the house position, and Apple for the 2FA code
- Ask Apple for the 2FA code with a method it accepts
- Declare min/max on every feature and drop the unnamed one
- Keep publishing values so Gladys stops saying "no recent value"
- Publish the values of a device as soon as it is created
- Publish the location features again, and refresh on time

[Unreleased]: https://github.com/prohand/gladys-appledevicetracker/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-appledevicetracker/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-appledevicetracker/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.10...v2.0.0
[1.0.10]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-appledevicetracker/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-appledevicetracker/releases/tag/v1.0.1
