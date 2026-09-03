import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  buildDiscoveredDevices,
  buildStates,
  deviceExternalId,
  findAppleDeviceByExternalId,
  normalizeAppleDevices,
} from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, fakeFindMyDevice } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const config = normalizeConfig({
  home_latitude: 48.8566,
  home_longitude: 2.3522,
  home_radius: 150,
});

const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const stateOf = (states, key) =>
  states.find((s) => s.device_feature_external_id.endsWith(`:${key}`));

test('normalizeAppleDevices drops the entries without an id', () => {
  const devices = normalizeAppleDevices([fakeFindMyDevice(), { name: 'ghost' }, null]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'iPhone de Jean');
});

test('normalizeAppleDevices converts the battery ratio into a percentage', () => {
  const [device] = normalizeAppleDevices([fakeFindMyDevice({ batteryLevel: 0.42 })]);
  assert.equal(device.batteryLevel, 42);
});

test('a charging or fully charged device reports charging', () => {
  const [charging] = normalizeAppleDevices([fakeFindMyDevice({ batteryStatus: 'Charging' })]);
  const [charged] = normalizeAppleDevices([fakeFindMyDevice({ batteryStatus: 'Charged' })]);
  const [onBattery] = normalizeAppleDevices([fakeFindMyDevice({ batteryStatus: 'NotCharging' })]);
  assert.equal(charging.charging, true);
  assert.equal(charged.charging, true);
  assert.equal(onBattery.charging, false);
});

test('an accessory without battery or location is still a valid device', () => {
  const [device] = normalizeAppleDevices([
    { id: 'AIRTAG-1', name: 'AirTag keys', batteryLevel: -1, location: null },
  ]);
  assert.equal(device.batteryLevel, null);
  assert.equal(device.location, null);
  assert.equal(device.charging, null);
});

test('buildDiscoveredDevices exposes one Gladys device per Apple device', () => {
  const devices = normalizeAppleDevices([
    fakeFindMyDevice(),
    fakeFindMyDevice({ id: 'DDDD', name: 'iPad' }),
  ]);
  const discovered = buildDiscoveredDevices(gladys, config, devices);

  assert.equal(discovered.length, 2);
  const ids = discovered.map((device) => device.external_id);
  assert.equal(new Set(ids).size, 2, 'no two devices may share an external_id');
  for (const device of discovered) {
    assert.ok(device.name);
    assert.ok(device.features.length > 0);
  }
});

test('the external_id stays stable and id-safe whatever the Apple id looks like', () => {
  const messy = 'AbC+/dEf==\n';
  const first = deviceExternalId(gladys, messy);
  const second = deviceExternalId(gladys, messy);
  assert.equal(first, second, 'the same Apple id always maps to the same external_id');
  assert.match(first, /^apple-device:[0-9a-f]{16}$/);
});

test('every device carries a poll frequency Gladys accepts', () => {
  // Gladys only accepts an enum of milliseconds, capped at one minute: sending
  // the configured seconds would fail with "invalid poll frequency".
  const devices = normalizeAppleDevices([fakeFindMyDevice()]);
  const [device] = buildDiscoveredDevices(
    gladys,
    normalizeConfig({ poll_frequency: 600 }),
    devices,
  );
  assert.equal(device.poll_frequency, 60_000);
  // Gladys schedules a poll only for a device that asks for it: without this
  // flag onPoll is never called and the device stays empty on the dashboard.
  assert.equal(device.should_poll, true);
});

test('every feature declares the min/max Gladys requires', () => {
  // Gladys stores t_device_feature.min and .max as NOT NULL and rejects the whole
  // device with a 422 when a single feature omits them, binary and text included.
  const [device] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([fakeFindMyDevice()]),
  );
  for (const feature of device.features) {
    assert.equal(typeof feature.min, 'number', `${feature.name} has no min`);
    assert.equal(typeof feature.max, 'number', `${feature.name} has no max`);
    assert.ok(feature.max >= feature.min, `${feature.name} has max < min`);
  }
});

test('every feature uses a category/type pair Gladys knows how to name', () => {
  // A pair the interface does not know displays as an unnamed feature attached to
  // nothing: a distance sensor is a DECIMAL, never an INTEGER.
  const [device] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([fakeFindMyDevice()]),
  );
  const known = {
    [DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR]: [DEVICE_FEATURE_TYPES.SENSOR.BINARY],
    [DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR]: [DEVICE_FEATURE_TYPES.SENSOR.DECIMAL],
    [DEVICE_FEATURE_CATEGORIES.TEXT]: [DEVICE_FEATURE_TYPES.TEXT.TEXT],
    [DEVICE_FEATURE_CATEGORIES.DURATION]: [
      DEVICE_FEATURE_TYPES.DURATION.INTEGER,
      DEVICE_FEATURE_TYPES.DURATION.DECIMAL,
    ],
    [DEVICE_FEATURE_CATEGORIES.BATTERY]: [
      DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      DEVICE_FEATURE_TYPES.BATTERY.CHARGING,
    ],
  };
  for (const feature of device.features) {
    const types = known[feature.category];
    assert.ok(types, `${feature.name} uses an unexpected category ${feature.category}`);
    assert.ok(
      types.includes(feature.type),
      `${feature.name}: Gladys has no name for ${feature.category}/${feature.type}`,
    );
  }
});

test('the presence feature is a plain binary sensor, usable as a scene trigger', () => {
  const [device] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([fakeFindMyDevice()]),
  );
  const presence = featureOf(device, FEATURE.PRESENCE);
  assert.equal(presence.category, DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR);
  assert.equal(presence.type, DEVICE_FEATURE_TYPES.SENSOR.BINARY);
  assert.equal(presence.read_only, true);
  assert.equal(presence.keep_history, true);
});

test('the distance feature is reported in kilometers', () => {
  const [device] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([fakeFindMyDevice()]),
  );
  const distance = featureOf(device, FEATURE.DISTANCE);
  assert.equal(distance.category, DEVICE_FEATURE_CATEGORIES.DISTANCE_SENSOR);
  assert.equal(distance.unit, DEVICE_FEATURE_UNITS.KM);
});

test('battery features are only declared on devices that report one', () => {
  const [withBattery] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([fakeFindMyDevice()]),
  );
  assert.ok(featureOf(withBattery, FEATURE.BATTERY));
  assert.ok(featureOf(withBattery, FEATURE.CHARGING));

  const [accessory] = buildDiscoveredDevices(
    gladys,
    config,
    normalizeAppleDevices([{ id: 'AIRTAG-1', name: 'AirTag', batteryLevel: -1 }]),
  );
  assert.equal(featureOf(accessory, FEATURE.BATTERY), undefined);
  assert.equal(featureOf(accessory, FEATURE.CHARGING), undefined);
});

test('a device at home publishes presence 1 and a distance close to zero', () => {
  const [device] = normalizeAppleDevices([fakeFindMyDevice()]);
  const { states, presence, ignored } = buildStates(gladys, config, device, null);

  assert.equal(ignored, false);
  assert.equal(presence, true);
  assert.equal(stateOf(states, FEATURE.PRESENCE).state, 1);
  assert.ok(stateOf(states, FEATURE.DISTANCE).state < 0.01);
  assert.equal(stateOf(states, FEATURE.POSITION).text, '48.856600,2.352200');
  assert.equal(stateOf(states, FEATURE.BATTERY).state, 87);
});

test('a device far from home publishes presence 0 and the distance in km', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: {
        latitude: 45.764,
        longitude: 4.8357,
        horizontalAccuracy: 30,
        timeStamp: Date.now(),
      },
    }),
  ]);
  const { states, presence } = buildStates(gladys, config, device, true);

  assert.equal(presence, false);
  assert.equal(stateOf(states, FEATURE.PRESENCE).state, 0);
  assert.ok(Math.abs(stateOf(states, FEATURE.DISTANCE).state - 392) < 2);
});

test('a position vaguer than max_accuracy keeps the previous presence', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: {
        latitude: 45.764,
        longitude: 4.8357,
        horizontalAccuracy: 5000,
        timeStamp: Date.now(),
      },
    }),
  ]);
  const { states, presence, ignored } = buildStates(gladys, config, device, true);

  assert.equal(ignored, true);
  assert.equal(presence, true, 'the device stays where it was');
  assert.equal(stateOf(states, FEATURE.PRESENCE).state, 1, 'the kept presence is republished');
  assert.ok(stateOf(states, FEATURE.BATTERY), 'the battery is still published');
});

test('a vague position still publishes the distance, the position and its accuracy', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: {
        latitude: 45.764,
        longitude: 4.8357,
        horizontalAccuracy: 3000,
        timeStamp: Date.now() - 5 * 60_000,
      },
    }),
  ]);
  const { states } = buildStates(gladys, config, device, true);

  assert.ok(Math.abs(stateOf(states, FEATURE.DISTANCE).state - 392) < 2);
  assert.equal(stateOf(states, FEATURE.POSITION).text, '45.764000,4.835700');
  assert.equal(stateOf(states, FEATURE.ACCURACY).state, 3000);
  assert.equal(stateOf(states, FEATURE.LAST_SEEN).state, 5);
});

test('a vague position still gives a first presence to a device that has none', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        horizontalAccuracy: 4000,
        timeStamp: Date.now(),
      },
    }),
  ]);
  const { states, presence } = buildStates(gladys, config, device, null);

  assert.equal(presence, true);
  assert.equal(stateOf(states, FEATURE.PRESENCE).state, 1);
});

test('a device Apple could not locate publishes its battery and nothing else', () => {
  const [device] = normalizeAppleDevices([fakeFindMyDevice({ location: null })]);
  const { states, presence, ignored } = buildStates(gladys, config, device, null);

  assert.equal(ignored, true);
  assert.equal(presence, null);
  assert.equal(stateOf(states, FEATURE.PRESENCE), undefined);
  assert.equal(stateOf(states, FEATURE.BATTERY).state, 87);
});

test('a position at (0, 0) is not a position', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: { latitude: 0, longitude: 0, horizontalAccuracy: 10, timeStamp: Date.now() },
    }),
  ]);
  const { states, ignored } = buildStates(gladys, config, device, null);

  assert.equal(ignored, true);
  assert.equal(stateOf(states, FEATURE.DISTANCE), undefined);
});

test('the position age is published in minutes', () => {
  const [device] = normalizeAppleDevices([
    fakeFindMyDevice({
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        horizontalAccuracy: 10,
        timeStamp: Date.now() - 10 * 60_000,
      },
    }),
  ]);
  const { states } = buildStates(gladys, config, device, null);
  assert.equal(stateOf(states, FEATURE.LAST_SEEN).state, 10);
});

test('findAppleDeviceByExternalId routes an external_id back to its Apple device', () => {
  const devices = normalizeAppleDevices([
    fakeFindMyDevice(),
    fakeFindMyDevice({ id: 'DDDD', name: 'iPad' }),
  ]);
  const target = devices[1];
  const found = findAppleDeviceByExternalId(gladys, devices, deviceExternalId(gladys, target.id));
  assert.equal(found, target);
  assert.equal(findAppleDeviceByExternalId(gladys, devices, 'nope'), null);
});
