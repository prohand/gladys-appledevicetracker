// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates / publishDiscoveredDevices / setConfig / setConnectionStatus
//     / publishSceneEvent / requestWidgetRefresh
//     -> record the calls so tests can assert them
//   - publishChangedStates / forgetPublishedStates -> the SDK's dedup, same
//     rules (exact match, heartbeat, remembered only once accepted, 100 per
//     request), on top of this fake's publishStates so a test replacing it
//     still sees what goes out
//   - getHouses -> the `houses` list (set `housesError` to make it throw)
// No running Gladys server, no WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const configs = [];
  const connectionStatuses = [];
  const sceneEvents = [];
  const widgetRefreshes = [];
  // Last value accepted per feature, as the SDK remembers it.
  const publishedStates = new Map();

  return {
    published,
    discovered,
    configs,
    connectionStatuses,
    sceneEvents,
    widgetRefreshes,
    /** Set to an Error to make the next publishSceneEvent calls fail with it. */
    sceneEventError: null,
    // The devices the user actually created, as the SDK keeps them.
    devices: [],
    publishedStates,
    // The houses of Gladys, as GET /house answers them (sorted by name).
    houses: [],
    /** Set to an Error to make getHouses fail with it (a 403, Gladys down...). */
    housesError: null,

    async getHouses() {
      if (this.housesError) {
        throw this.housesError;
      }
      return this.houses;
    },

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async getDevices() {
      return this.devices;
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

    async publishChangedStates(states, { heartbeat } = {}) {
      const now = Date.now();
      const previous = new Map();
      const changed = states.filter((state) => {
        const id = state.device_feature_external_id;
        const last = previous.has(id) ? previous.get(id) : publishedStates.get(id);
        previous.set(id, { state: state.state, text: state.text, at: now });
        return (
          last === undefined ||
          last.state !== state.state ||
          last.text !== state.text ||
          (heartbeat !== undefined && now - last.at >= heartbeat)
        );
      });
      for (let start = 0; start < changed.length; start += 100) {
        const batch = changed.slice(start, start + 100);
        batch.forEach(({ device_feature_external_id: id, state, text }) => {
          publishedStates.set(id, { state, text, at: now });
        });
        try {
          await this.publishStates(batch);
        } catch (err) {
          batch.forEach(({ device_feature_external_id: id }) => publishedStates.delete(id));
          throw err;
        }
      }
      return { success: true, count: changed.length };
    },

    forgetPublishedStates(externalId) {
      if (externalId === undefined) {
        publishedStates.clear();
        return;
      }
      for (const id of [...publishedStates.keys()]) {
        if (id === externalId || id.startsWith(`${externalId}:`)) {
          publishedStates.delete(id);
        }
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

    async publishSceneEvent(key, data = {}) {
      if (this.sceneEventError) {
        throw this.sceneEventError;
      }
      sceneEvents.push({ key, data });
      return { success: true };
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
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
