// -----------------------------------------------------------------------------
// Scene triggers and scene actions (Gladys 5.1+).
//
// The manifest declares them (`scene_triggers`, `scene_actions`), Gladys draws
// the cards of the scene editor, and this file holds what the integration
// sends and answers:
//
//   - a TRIGGER says "this just happened": a device arrived home, a device
//     left home, iCloud wants a new two-factor code. One event per transition,
//     never a repeat of a value that did not move (that is what the features
//     are for);
//   - an ACTION is an operation a scene runs: show a message on a device, ask
//     Find My for fresh positions, read where a device is. Its outputs are
//     plain values the next actions of the scene can use ({{…}}).
//
// A key published here is stored in the users' scenes: it is never renamed.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGER = {
  ARRIVED_HOME: 'device_arrived_home',
  LEFT_HOME: 'device_left_home',
  SIGN_IN_REQUIRED: 'sign_in_required',
};

export const SCENE_ACTION = {
  SEND_MESSAGE: 'send_message',
  REFRESH_POSITIONS: 'refresh_positions',
  GET_POSITION: 'get_device_position',
};

// Longer than any sane notification, short enough for a phone screen.
export const MAX_MESSAGE_LENGTH = 500;

/**
 * The data of an arrival or a departure event.
 *
 * `device` is the filter of the trigger card (the devices the user picked,
 * compared with the external_id); the other keys are the variables the scene
 * can use in its messages.
 *
 * @param {string} externalId the Gladys external_id of the device
 * @param {object} summary output of summarizeDevice()
 * @param {number} devicesAtHome devices at home once this one is counted
 */
export function presenceEventData(externalId, summary, devicesAtHome) {
  return {
    device: externalId,
    device_name: summary.name,
    distance_km: summary.distanceKm,
    battery: summary.batteryLevel,
    devices_at_home: devicesAtHome,
  };
}

/**
 * The outputs of the "Get the position of a device" action.
 *
 * Unknown values are null: Gladys drops them, and a scene reading one gets an
 * empty value instead of a made-up 0.
 *
 * @param {object} summary output of summarizeDevice()
 */
export function positionOutputs(summary) {
  return {
    device_name: summary.name,
    at_home: summary.present,
    distance_km: summary.distanceKm,
    latitude: summary.latitude,
    longitude: summary.longitude,
    accuracy_m: summary.accuracy,
    position_age_min: summary.ageMinutes,
    battery: summary.batteryLevel,
    charging: summary.charging,
    map_url: summary.mapUrl,
  };
}

/**
 * The message a scene asked to show, checked before Apple sees it.
 *
 * @param {unknown} text the `message` field, scene variables already rendered
 */
export function normalizeMessage(text) {
  const message = typeof text === 'string' ? text.trim() : '';
  if (!message) {
    throw new Error('The message to show is empty');
  }
  return message.slice(0, MAX_MESSAGE_LENGTH);
}
