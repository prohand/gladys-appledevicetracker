import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackerFleet } from '../src/fleet.js';
import { TRACKER_HEALTH, TRACKER_STATUS } from '../src/tracker.js';
import { LOGIN_STATUS } from '../src/icloud/client.js';
import { ACCOUNT, accountConfig, normalizeConfig } from '../src/config.js';
import { FEATURE, deviceExternalId, featureExternalId } from '../src/devices/index.js';
import { createFakeGladys, fakeFindMyDevice } from './helpers/fakeGladys.js';
import { SCENE_TRIGGER } from '../src/scenes.js';

const CONFIG = normalizeConfig({
  apple_id: 'john@example.com',
  apple_password: 'hunter2',
  apple_id_2: 'jane@example.com',
  apple_password_2: 'swordfish',
  home_latitude: 48.8566,
  home_longitude: 2.3522,
  home_radius: 150,
  poll_frequency: 300,
});

// At home, and two kilometres away.
const HOME = { latitude: 48.8566, longitude: 2.3522 };
const AWAY = { latitude: 48.8766, longitude: 2.3522 };

/** A device of Find My, at a given place. */
function device(id, name, place = HOME) {
  return fakeFindMyDevice({
    id,
    name,
    location: { ...place, horizontalAccuracy: 10, timeStamp: Date.now(), positionType: 'GPS' },
  });
}

/** A scripted iCloud client (no network), one per Apple ID. */
function createFakeClient({ devices = [], loginStatus = LOGIN_STATUS.CONNECTED } = {}) {
  const client = {
    devices,
    loginStatus,
    failFetchWith: null,
    sessionChanges: [],
    calls: { login: 0, fetchDevices: 0, playSound: [], sendMessage: [], forget: 0 },
    options: null,
    async login() {
      client.calls.login += 1;
      return client.loginStatus;
    },
    async fetchDevices(options) {
      client.calls.fetchDevices += 1;
      client.fetchOptions = options;
      if (client.failFetchWith) {
        throw client.failFetchWith;
      }
      return client.devices;
    },
    async playSound(id) {
      client.calls.playSound.push(id);
    },
    async sendMessage(id, text) {
      client.calls.sendMessage.push({ id, text });
    },
    async forgetSession() {
      client.calls.forget += 1;
      await client.options.onSessionChange({});
    },
    async submitSecurityCode() {},
  };
  return client;
}

function createFleet({ main = {}, second = {} } = {}) {
  const gladys = createFakeGladys();
  const clients = {
    [CONFIG.apple_id]: createFakeClient(main),
    [CONFIG.apple_id_2]: createFakeClient(second),
  };
  const fleet = new TrackerFleet(gladys, {
    createClient: (options) => {
      const client = clients[options.appleId];
      client.options = options;
      return client;
    },
  });
  const health = [];
  fleet.onHealth = async (account, code) => health.push({ account, code });
  return {
    gladys,
    fleet,
    health,
    mainClient: clients[CONFIG.apple_id],
    secondClient: clients[CONFIG.apple_id_2],
  };
}

/** Sign both accounts in, main first (as index.js does). */
async function startBoth(fleet, config = CONFIG) {
  await fleet.tracker(ACCOUNT.MAIN).start(accountConfig(config, ACCOUNT.MAIN));
  await fleet.tracker(ACCOUNT.SECOND).start(accountConfig(config, ACCOUNT.SECOND));
}

test('each account signs in with its own Apple ID and family setting', async () => {
  const { fleet, mainClient, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  assert.equal(mainClient.options.password, 'hunter2');
  assert.equal(secondClient.options.password, 'swordfish');
  assert.equal(mainClient.fetchOptions.includeFamily, true);
  assert.equal(secondClient.fetchOptions.includeFamily, false, 'off by default on the second');
  fleet.stop();
});

test('each account saves its session under its own key', async () => {
  const { gladys, fleet } = createFleet();
  await startBoth(fleet);

  await fleet.tracker(ACCOUNT.MAIN).saveSession({ sessionToken: 'a' });
  await fleet.tracker(ACCOUNT.SECOND).saveSession({ sessionToken: 'b' });

  assert.deepEqual(gladys.configs.slice(-2), [
    { icloud_session: '{"sessionToken":"a"}' },
    { icloud_session_2: '{"sessionToken":"b"}' },
  ]);
  fleet.stop();
});

test('the catalog lists the devices of both accounts, never just the last one read', async () => {
  const { gladys, fleet } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  const last = gladys.discovered.at(-1);
  assert.deepEqual(
    last.map((entry) => entry.name).sort(),
    ['iPhone de Jean', 'iPhone de Marie'],
    'publishing the second account must not wipe out the first one',
  );
  assert.equal(fleet.devices.length, 2);
  fleet.stop();
});

test('a device both accounts see is read by the main one only', async () => {
  const shared = device('SHARED', 'iPhone de Marie');
  const { fleet } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean'), shared] },
    second: { devices: [shared] },
  });
  await startBoth(fleet);

  assert.deepEqual(
    fleet.tracker(ACCOUNT.SECOND).devices.map((d) => d.id),
    [],
    'the second account leaves it to the main one',
  );
  assert.equal(fleet.devices.length, 2);
  fleet.stop();
});

test('a ring goes through the account that reads the device', async () => {
  const { gladys, fleet, mainClient, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  const externalId = deviceExternalId(gladys, 'B');
  const ringId = featureExternalId(gladys, 'B', FEATURE.RING);
  const rung = await fleet.setFeatureValue(externalId, ringId);
  await fleet.sendMessage(externalId, 'Dinner is ready');

  assert.equal(rung.name, 'iPhone de Marie');
  assert.deepEqual(secondClient.calls.playSound, ['B']);
  assert.deepEqual(mainClient.calls.playSound, []);
  assert.deepEqual(secondClient.calls.sendMessage, [{ id: 'B', text: 'Dinner is ready' }]);
  fleet.stop();
});

test('one account failing does not fail the refresh of the other', async () => {
  const { fleet, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  secondClient.failFetchWith = new Error('Apple 503');
  const devices = await fleet.refresh({ force: true });

  assert.equal(devices.length, 2, 'the last known devices of the failing account stay');
  fleet.stop();
});

test('the refresh fails when no account could be read', async () => {
  const { fleet, mainClient, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  mainClient.failFetchWith = new Error('Apple 503');
  secondClient.failFetchWith = new Error('Apple 503');
  await assert.rejects(() => fleet.refresh({ force: true }), /Apple 503/);
  fleet.stop();
});

test('the arrival events count the devices at home across both accounts', async () => {
  const { gladys, fleet, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie', AWAY)] },
  });
  gladys.devices = [
    { external_id: deviceExternalId(gladys, 'A'), features: [] },
    { external_id: deviceExternalId(gladys, 'B'), features: [] },
  ];
  await startBoth(fleet);

  secondClient.devices = [device('B', 'iPhone de Marie', HOME)];
  await fleet.tracker(ACCOUNT.SECOND).refresh({ force: true });

  const arrival = gladys.sceneEvents.find((event) => event.key === SCENE_TRIGGER.ARRIVED_HOME);
  assert.ok(arrival, 'Marie arrived');
  assert.equal(arrival.data.devices_at_home, 2, 'Jean (main account) is home too');
  assert.equal(fleet.devicesAtHome(), 2);
  assert.equal(fleet.createdDevices().length, 2);
  fleet.stop();
});

test('the status is connected as soon as one account is', async () => {
  const { fleet } = createFleet({ second: { loginStatus: LOGIN_STATUS.TWO_FACTOR_REQUIRED } });
  assert.equal(fleet.status, TRACKER_STATUS.DISCONNECTED);

  await fleet.tracker(ACCOUNT.SECOND).start(accountConfig(CONFIG, ACCOUNT.SECOND));
  assert.equal(fleet.status, TRACKER_STATUS.TWO_FACTOR_REQUIRED);

  await fleet.tracker(ACCOUNT.MAIN).start(accountConfig(CONFIG, ACCOUNT.MAIN));
  assert.equal(fleet.status, TRACKER_STATUS.CONNECTED);
  assert.equal(fleet.isConnected(), true);
  fleet.stop();
});

test('the health of each account is reported with the account', async () => {
  const { fleet, health } = createFleet({
    second: { loginStatus: LOGIN_STATUS.TWO_FACTOR_REQUIRED },
  });
  await startBoth(fleet);

  await fleet.refresh();

  assert.ok(
    health.some(
      (h) => h.account === ACCOUNT.SECOND && h.code === TRACKER_HEALTH.TWO_FACTOR_REQUIRED,
    ),
  );
  assert.ok(!health.some((h) => h.account === ACCOUNT.MAIN && h.code !== TRACKER_HEALTH.OK));
  fleet.stop();
});

test('removing the second account drops its devices and its saved session', async () => {
  const { gladys, fleet, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
    second: { devices: [device('B', 'iPhone de Marie')] },
  });
  await startBoth(fleet);

  await fleet.removeAccount(ACCOUNT.SECOND);

  assert.equal(secondClient.calls.forget, 1);
  assert.equal(fleet.tracker(ACCOUNT.SECOND).hasClient(), false);
  assert.deepEqual(gladys.configs.at(-1), { icloud_session_2: '' });
  assert.deepEqual(
    gladys.discovered.at(-1).map((entry) => entry.name),
    ['iPhone de Jean'],
  );
  fleet.stop();
});

test('removing an account never used writes nothing', async () => {
  const { gladys, fleet } = createFleet();
  await fleet.removeAccount(ACCOUNT.SECOND);
  assert.deepEqual(gladys.configs, []);
  assert.deepEqual(gladys.discovered, []);
});

test('with the second account unused, the fleet behaves like one tracker', async () => {
  const { gladys, fleet, secondClient } = createFleet({
    main: { devices: [device('A', 'iPhone de Jean')] },
  });
  await fleet.tracker(ACCOUNT.MAIN).start(accountConfig(CONFIG, ACCOUNT.MAIN));

  await fleet.refresh({ force: true });
  await fleet.resync();

  assert.equal(secondClient.calls.login, 0, 'never signed in');
  assert.equal(fleet.devices.length, 1);
  assert.equal(fleet.findByExternalId(deviceExternalId(gladys, 'A')).name, 'iPhone de Jean');
  assert.equal(fleet.findByExternalId('unknown'), null);
  fleet.stop();
});
