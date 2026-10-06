# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

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

[Unreleased]: https://github.com/prohand/gladys-appledevicetracker/compare/v2.0.0...HEAD
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
