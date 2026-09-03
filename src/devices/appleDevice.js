// -----------------------------------------------------------------------------
// Device type: APPLE DEVICE (iPhone, iPad, Mac, Apple Watch, AirPods...).
//
// One Gladys device per device visible in Find My. Everything here is read-only
// sensors refreshed by POLLING (`poll_frequency`), because Apple offers no push
// channel: Gladys calls `onPoll` on each device at the interval declared here
// and the integration answers with the states below.
//
// The feature that matters for automations is `presence`: a plain binary
// sensor, so "when my iPhone arrives at home" is a normal Gladys scene trigger.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createHash } from 'node:crypto';
import {
  distanceInMeters,
  isPositionKnown,
  isPositionUsable,
  resolvePresence,
} from '../presence.js';
import { gladysPollFrequency } from '../config.js';

export const DEVICE_TYPE = 'apple-device';

export const FEATURE = {
  PRESENCE: 'presence',
  DISTANCE: 'distance',
  ACCURACY: 'accuracy',
  POSITION: 'position',
  LAST_SEEN: 'last-seen',
  BATTERY: 'battery',
  CHARGING: 'charging',
};

/**
 * Apple device ids are long opaque strings that may contain `+`, `/` or `=`.
 * Hash them into a short, stable, id-safe token: the external_id of a device
 * must never change once Gladys has created it.
 */
export function platformId(appleDeviceId) {
  return createHash('sha1').update(String(appleDeviceId)).digest('hex').slice(0, 16);
}

/** The Gladys external_id of an Apple device. */
export function deviceExternalId(gladys, appleDeviceId) {
  return gladys.externalIds(DEVICE_TYPE, platformId(appleDeviceId)).device;
}

function toPercent(batteryLevel) {
  // Apple reports a 0..1 ratio, Gladys wants 0..100.
  if (!Number.isFinite(batteryLevel) || batteryLevel < 0) {
    return null;
  }
  return Math.round(batteryLevel * 100);
}

/**
 * Reduce one raw Find My entry to the fields this integration uses. Nothing is
 * assumed present: Apple omits `location` on a device that has never reported,
 * and omits the battery on accessories.
 *
 * @param {object} raw one entry of the `content` array returned by Find My
 */
export function normalizeAppleDevice(raw = {}) {
  const location = raw.location || null;
  const batteryStatus = raw.batteryStatus || null;

  return {
    id: raw.id,
    name: raw.name || raw.deviceDisplayName || 'Apple device',
    model: raw.deviceDisplayName || raw.rawDeviceModel || raw.deviceModel || null,
    batteryLevel: toPercent(raw.batteryLevel),
    // `Charging` while plugged in, `Charged` once full: both mean "on power".
    charging: batteryStatus ? batteryStatus === 'Charging' || batteryStatus === 'Charged' : null,
    location: location
      ? {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          accuracy: Number(location.horizontalAccuracy),
          // Apple timestamps in milliseconds since the epoch.
          timestamp: Number(location.timeStamp) || null,
        }
      : null,
  };
}

/**
 * Build the discovery payload Gladys stores for this device.
 *
 * @param {object} gladys the SDK instance
 * @param {object} config normalized integration config
 * @param {object} device output of normalizeAppleDevice()
 */
export function buildDevice(gladys, config, device) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(device.id));

  const features = [
    {
      name: 'Presence',
      external_id: ids.feature(FEATURE.PRESENCE),
      category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      // Gladys refuses a feature whose min/max is null, binary included: 0 = away, 1 = home.
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: 'Distance from home',
      external_id: ids.feature(FEATURE.DISTANCE),
      category: DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.KM,
      min: 0,
      max: 20000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: 'Position accuracy',
      external_id: ids.feature(FEATURE.ACCURACY),
      category: DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR,
      // A distance sensor is a DECIMAL in Gladys: the INTEGER type has no name in the
      // interface and the feature is displayed blank.
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.M,
      min: 0,
      max: 100000,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: 'Position',
      external_id: ids.feature(FEATURE.POSITION),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      // The value is a string, but Gladys still requires numeric bounds.
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: 'Position age',
      external_id: ids.feature(FEATURE.LAST_SEEN),
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
      unit: DEVICE_FEATURE_UNITS.MINUTES,
      min: 0,
      max: 100000,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
  ];

  // Accessories (AirTag, AirPods) report no battery percentage: only declare the
  // battery features on the devices that actually have them.
  if (device.batteryLevel !== null) {
    features.push({
      name: 'Battery',
      external_id: ids.feature(FEATURE.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }
  if (device.charging !== null) {
    features.push({
      name: 'Charging',
      external_id: ids.feature(FEATURE.CHARGING),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.CHARGING,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    });
  }

  return {
    name: device.name,
    external_id: ids.device,
    // Gladys only schedules a poll for a device that ASKS for it: `poll_frequency`
    // alone is just a number stored on the row, the scheduler picks the devices
    // on `should_poll`. Without this flag onPoll was never called and a freshly
    // created device stayed empty on the dashboard.
    should_poll: true,
    // Gladys calls onPoll on this device at this interval, in MILLISECONDS and
    // only among the values it accepts (see gladysPollFrequency): the user
    // interval in seconds is honoured by the tracker, not by Gladys.
    poll_frequency: gladysPollFrequency(config.poll_frequency),
    params: [
      { name: 'apple_device_id', value: String(device.id) },
      ...(device.model ? [{ name: 'apple_model', value: String(device.model) }] : []),
    ],
    features,
  };
}

/**
 * Build the states to publish for one device.
 *
 * @param {object} gladys the SDK instance
 * @param {object} config normalized integration config
 * @param {object} device output of normalizeAppleDevice()
 * @param {boolean|null} wasPresent previous presence, for the hysteresis
 * @returns {{ states: object[], presence: boolean|null, ignored: boolean }}
 *   `ignored` is true when the position was missing, or too vague to move the
 *   presence sensor.
 */
export function buildStates(gladys, config, device, wasPresent = null) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformId(device.id));
  const states = [];

  if (device.batteryLevel !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.BATTERY),
      state: device.batteryLevel,
    });
  }
  if (device.charging !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.CHARGING),
      state: device.charging ? 1 : 0,
    });
  }

  // No position at all: nothing to compute, and no presence to invent.
  if (!isPositionKnown(device.location)) {
    return { states, presence: wasPresent, ignored: true };
  }

  const { latitude, longitude, accuracy, timestamp } = device.location;
  const distance = distanceInMeters(
    { latitude: config.home_latitude, longitude: config.home_longitude },
    { latitude, longitude },
  );

  // A fix vaguer than max_accuracy must not MOVE the presence sensor — that is
  // what would fire the automations wrongly — but the informative sensors below
  // are published all the same: a device located by Wi-Fi (often 1 to 3 km of
  // accuracy) used to publish nothing but its battery, and Gladys showed "no
  // recent value" on every other feature, forever.
  const accurate = isPositionUsable(device.location, config.max_accuracy);
  // wasPresent === null: nothing has ever been resolved for this device, so a
  // vague fix is still better than an empty sensor. The hysteresis takes over
  // from the next accurate fix on.
  const presence =
    accurate || wasPresent === null
      ? resolvePresence({ distance, radius: config.home_radius, wasPresent })
      : wasPresent;

  states.push(
    { device_feature_external_id: ids.feature(FEATURE.PRESENCE), state: presence ? 1 : 0 },
    {
      device_feature_external_id: ids.feature(FEATURE.DISTANCE),
      // Kilometers, rounded to the meter: enough for a distance sensor.
      state: Math.round(distance) / 1000,
    },
    {
      device_feature_external_id: ids.feature(FEATURE.POSITION),
      text: `${latitude.toFixed(6)},${longitude.toFixed(6)}`,
    },
  );

  if (Number.isFinite(accuracy)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.ACCURACY),
      state: Math.round(accuracy),
    });
  }
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const ageMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    states.push({
      device_feature_external_id: ids.feature(FEATURE.LAST_SEEN),
      state: ageMinutes,
    });
  }

  return { states, presence, ignored: !accurate };
}
