// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates / publishDiscoveredDevices / setConfig / setConnectionStatus
//     -> record the calls so tests can assert them
// No running Gladys server, no WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const configs = [];
  const connectionStatuses = [];

  return {
    published,
    discovered,
    configs,
    connectionStatuses,
    // The devices the user actually created, as the SDK keeps them.
    devices: [],

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
          text: state.text,
        });
      }
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
      return { created: devices.length };
    },

    async setConfig(partialConfig) {
      configs.push(partialConfig);
      return { success: true };
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
      return { success: true };
    },
  };
}

/** A raw Find My entry, with the fields this integration reads. */
export function fakeFindMyDevice(overrides = {}) {
  return {
    id: 'AAAA-BBBB-CCCC',
    name: 'iPhone de Jean',
    deviceDisplayName: 'iPhone 15',
    batteryLevel: 0.87,
    batteryStatus: 'NotCharging',
    location: {
      latitude: 48.8566,
      longitude: 2.3522,
      horizontalAccuracy: 12,
      timeStamp: Date.now(),
      positionType: 'GPS',
    },
    ...overrides,
  };
}
