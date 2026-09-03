// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a template with a fixed catalog, the devices of this integration are
// DISCOVERED at runtime: whatever Find My reports for the account. So the
// registry is not a static list of blueprints but a small set of helpers over
// the list Apple last returned.
//
// One device type lives in `appleDevice.js`; this file only maps between the
// Apple side (opaque device ids) and the Gladys side (external_ids).
// -----------------------------------------------------------------------------

import {
  appleDeviceId,
  buildDevice,
  deviceExternalId,
  normalizeAppleDevice,
} from './appleDevice.js';

export {
  DEVICE_TYPE,
  FEATURE,
  appleDeviceId,
  buildStates,
  deviceExternalId,
  normalizeAppleDevice,
} from './appleDevice.js';

/**
 * Normalize the raw Find My payload, dropping the entries we cannot use.
 * A device with no id can never get a stable external_id.
 *
 * @param {object[]} rawDevices the entries returned by Find My
 */
export function normalizeAppleDevices(rawDevices = []) {
  return rawDevices
    .filter((raw) => raw && appleDeviceId(raw))
    .map((raw) => normalizeAppleDevice(raw));
}

/**
 * Build the discovery payload for Gladys (one device per Apple device).
 */
export function buildDiscoveredDevices(gladys, config, devices) {
  return devices.map((device) => buildDevice(gladys, config, device));
}

/**
 * Find the Apple device behind a Gladys external_id (routing onPoll and the
 * `identify` action back to the right device).
 */
export function findAppleDeviceByExternalId(gladys, devices, externalId) {
  return devices.find((device) => deviceExternalId(gladys, device.id) === externalId) || null;
}
