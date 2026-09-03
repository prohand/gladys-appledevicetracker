// -----------------------------------------------------------------------------
// Turning a GPS position into presence.
//
// A raw "latitude/longitude" is not usable as-is for home automation: a phone
// sitting on a table reports a slightly different position every few minutes,
// and a position derived from a Wi-Fi network can be off by a kilometer. Two
// rules keep the presence sensor stable:
//
//   1. a position vaguer than `max_accuracy` is IGNORED (the previous state is
//      kept) rather than teleporting the device;
//   2. the device becomes present inside `home_radius`, but only becomes absent
//      past 125% of it (hysteresis) — without it, a device parked on the edge
//      of the radius would flip on and off on every poll and fire your
//      automations each time.
// -----------------------------------------------------------------------------

/** How far past the radius a device must be before it counts as gone. */
export const LEAVE_MARGIN = 1.25;

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two positions, in meters (haversine).
 * @param {{ latitude: number, longitude: number }} from
 * @param {{ latitude: number, longitude: number }} to
 */
export function distanceInMeters(from, to) {
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Is this position trustworthy enough to move the presence state?
 * @param {{ latitude: number, longitude: number, accuracy: number }|null} location
 * @param {number} maxAccuracy accuracy radius above which we ignore the fix
 */
export function isPositionUsable(location, maxAccuracy) {
  if (!location) {
    return false;
  }
  const { latitude, longitude, accuracy } = location;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }
  // Apple reports (0, 0) when it has no fix at all.
  if (latitude === 0 && longitude === 0) {
    return false;
  }
  if (Number.isFinite(accuracy) && accuracy > maxAccuracy) {
    return false;
  }
  return true;
}

/**
 * Decide whether a device is at home, with hysteresis around the radius.
 *
 * @param {object} params
 * @param {number} params.distance distance to home, in meters
 * @param {number} params.radius configured home radius, in meters
 * @param {boolean|null} params.wasPresent previous state (null on first read)
 * @returns {boolean} true when the device counts as being at home
 */
export function resolvePresence({ distance, radius, wasPresent }) {
  if (wasPresent === true) {
    // Already home: stay home until clearly outside.
    return distance <= radius * LEAVE_MARGIN;
  }
  return distance <= radius;
}
