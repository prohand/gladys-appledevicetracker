// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module holds the defaults and normalizes the received object, so the
// rest of the code never deals with `undefined` or with a number that arrived
// as a string from the form.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (see test/manifest.test.js).
export const DEFAULT_CONFIG = {
  apple_id: '',
  apple_password: '',
  // The coordinates are required text fields in the manifest (no `default`
  // there): these values only cover a config saved before they were filled in.
  home_latitude: 48.8566, // Paris
  home_longitude: 2.3522,
  home_radius: 150, // meters, radius marking a device as "at home"
  poll_frequency: 300, // seconds, how often Gladys asks for a refresh
  max_accuracy: 500, // meters, positions vaguer than this are ignored
  include_family: true, // also expose Family Sharing devices
  // Internal key, NOT in config_schema: the iCloud session (tokens + cookies)
  // saved with `setConfig` so a restart does not ask for a new 2FA code.
  icloud_session: '',
};

// Bounds mirrored from the manifest, applied here too: the form validates the
// user input, but a config restored from an older version must not be able to
// hammer Apple every second.
const BOUNDS = {
  home_latitude: [-90, 90],
  home_longitude: [-180, 180],
  home_radius: [20, 10000],
  poll_frequency: [60, 3600],
  max_accuracy: [10, 20000],
};

// The coordinates are text fields in the manifest (a `number` input rounds
// 48.8566 to 49, and the manifest has no `step`), so the value arrives as a
// string typed by hand: trim it, and accept the comma used as a decimal
// separator in French.
function toNumber(raw, key) {
  let input = raw ?? DEFAULT_CONFIG[key];
  if (typeof input === 'string') {
    input = input.trim().replace(',', '.');
    if (input === '') {
      return DEFAULT_CONFIG[key];
    }
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG[key];
  }
  const [min, max] = BOUNDS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    apple_id: String(raw.apple_id ?? '').trim(),
    apple_password: String(raw.apple_password ?? ''),
    home_latitude: toNumber(raw.home_latitude, 'home_latitude'),
    home_longitude: toNumber(raw.home_longitude, 'home_longitude'),
    home_radius: toNumber(raw.home_radius, 'home_radius'),
    poll_frequency: toNumber(raw.poll_frequency, 'poll_frequency'),
    max_accuracy: toNumber(raw.max_accuracy, 'max_accuracy'),
    // A checkbox arrives as a boolean; anything but an explicit false is true.
    include_family: raw.include_family !== false,
    icloud_session: String(raw.icloud_session ?? ''),
  };
}

/**
 * True when the user has filled in the credentials the integration needs to
 * even try to sign in.
 */
export function hasCredentials(config) {
  return config.apple_id.length > 0 && config.apple_password.length > 0;
}

/**
 * True when the two configs describe the SAME iCloud account: used on a config
 * update to decide between "just re-publish the devices" and "sign in again".
 */
export function sameAccount(a, b) {
  return a.apple_id === b.apple_id && a.apple_password === b.apple_password;
}

// Keys the user actually sets in the Configuration screen. `icloud_session` is
// deliberately NOT one of them: the integration writes it itself, and that write
// comes back as a config update — reacting to it would call Apple for nothing.
const SETTINGS_KEYS = [
  'home_latitude',
  'home_longitude',
  'home_radius',
  'poll_frequency',
  'max_accuracy',
  'include_family',
];

/** True when no user-facing setting changed between the two configs. */
export function sameSettings(a, b) {
  return SETTINGS_KEYS.every((key) => a[key] === b[key]);
}
