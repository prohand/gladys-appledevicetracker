import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppleDeviceTracker, TRACKER_STATUS } from '../src/tracker.js';
import { LOGIN_STATUS, SessionExpiredError } from '../src/icloud/client.js';
import { deviceExternalId } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, fakeFindMyDevice } from './helpers/fakeGladys.js';

const CONFIG = normalizeConfig({
  apple_id: 'john@example.com',
  apple_password: 'hunter2',
  home_latitude: 48.8566,
  home_longitude: 2.3522,
  home_radius: 150,
  poll_frequency: 300,
});

/** A stand-in for ICloudClient: no network, fully scripted. */
function createFakeClient({ loginStatus = LOGIN_STATUS.CONNECTED, devices = [] } = {}) {
  const client = {
    calls: { login: 0, fetchDevices: 0, playSound: [], forget: 0, requestCode: 0, saveSession: 0 },
    devices,
    loginStatus,
    failNextFetchWith: null,
    async login() {
      client.calls.login += 1;
      return client.loginStatus;
    },
    async fetchDevices() {
      client.calls.fetchDevices += 1;
      if (client.failNextFetchWith) {
        const error = client.failNextFetchWith;
        client.failNextFetchWith = null;
        throw error;
      }
      return client.devices;
    },
    async playSound(id) {
      client.calls.playSound.push(id);
    },
    async forgetSession() {
      client.calls.forget += 1;
    },
    async submitSecurityCode() {},
    twoFactorTarget: null,
    async requestSecurityCode() {
      client.calls.requestCode += 1;
      client.twoFactorTarget = { en: 'your trusted Apple devices', fr: 'vos appareils' };
      return client.twoFactorTarget;
    },
    async saveSession() {
      client.calls.saveSession += 1;
    },
  };
  return client;
}

function createTracker(options = {}) {
  const gladys = createFakeGladys();
  const client = createFakeClient(options);
  let clock = options.startTime ?? 1_000_000;
  const tracker = new AppleDeviceTracker(gladys, {
    createClient: () => client,
    now: () => clock,
  });
  return { gladys, client, tracker, advance: (ms) => (clock += ms) };
}

test('start() signs in, publishes the devices and their states', async () => {
  const { gladys, tracker } = createTracker({ devices: [fakeFindMyDevice()] });

  const status = await tracker.start(CONFIG);

  assert.equal(status, TRACKER_STATUS.CONNECTED);
  assert.equal(tracker.devices.length, 1);
  assert.equal(gladys.discovered.length, 1, 'the catalog is published once');
  assert.ok(gladys.published.some((s) => s.featureExternalId.endsWith(':presence')));
});

test('requestSecurityCode() asks Apple again and persists the mode', async () => {
  const { client, tracker } = createTracker({ loginStatus: LOGIN_STATUS.TWO_FACTOR_REQUIRED });

  assert.equal(tracker.hasClient(), false, 'nothing to ask before a sign-in');
  await assert.rejects(() => tracker.requestSecurityCode());

  await tracker.start(CONFIG);
  const target = await tracker.requestSecurityCode();

  assert.equal(client.calls.requestCode, 1);
  assert.equal(client.calls.saveSession, 1, 'the SMS mode must survive a restart');
  assert.equal(tracker.twoFactorTarget, target);
});

test('start() stops at the two-factor step without calling Find My', async () => {
  const { client, tracker } = createTracker({ loginStatus: LOGIN_STATUS.TWO_FACTOR_REQUIRED });

  const status = await tracker.start(CONFIG);

  assert.equal(status, TRACKER_STATUS.TWO_FACTOR_REQUIRED);
  assert.equal(tracker.isConnected(), false);
  assert.equal(client.calls.fetchDevices, 0);
});

test('the iCloud session is persisted in the Gladys config', async () => {
  const { gladys, tracker } = createTracker();
  tracker.config = CONFIG;
  await tracker.saveSession({ sessionToken: 'abc' });

  assert.deepEqual(gladys.configs, [{ icloud_session: '{"sessionToken":"abc"}' }]);
});

test('a saved session is restored and handed to the client', async () => {
  const gladys = createFakeGladys();
  let received = null;
  const tracker = new AppleDeviceTracker(gladys, {
    createClient: (options) => {
      received = options;
      return createFakeClient();
    },
  });

  await tracker.start(normalizeConfig({ ...CONFIG, icloud_session: '{"sessionToken":"saved"}' }));
  assert.equal(received.session.sessionToken, 'saved');
});

test('an unreadable saved session does not stop the sign-in', async () => {
  const gladys = createFakeGladys();
  let received = null;
  const tracker = new AppleDeviceTracker(gladys, {
    createClient: (options) => {
      received = options;
      return createFakeClient();
    },
  });

  await tracker.start(normalizeConfig({ ...CONFIG, icloud_session: 'not json' }));
  assert.deepEqual(received.session, {});
});

test('Gladys polling every device only triggers ONE call to Apple', async () => {
  const devices = [
    fakeFindMyDevice({ id: 'A' }),
    fakeFindMyDevice({ id: 'B' }),
    fakeFindMyDevice({ id: 'C' }),
  ];
  const { client, tracker } = createTracker({ devices });
  await tracker.start(CONFIG);
  assert.equal(client.calls.fetchDevices, 1);

  // Gladys calls onPoll once per device, back to back.
  await Promise.all([tracker.refresh(), tracker.refresh(), tracker.refresh()]);

  assert.equal(client.calls.fetchDevices, 1, 'the cached result is reused');
});

test('a refresh past the poll interval calls Apple again', async () => {
  const { client, tracker, advance } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  // Gladys ticks every minute whatever the setting: those early ticks are
  // answered from the cache.
  advance(240_000); // 4 minutes, still under the 300 s interval
  await tracker.refresh();
  assert.equal(client.calls.fetchDevices, 1);

  advance(60_000); // the fifth tick, past it
  await tracker.refresh();
  assert.equal(client.calls.fetchDevices, 2);
});

test('concurrent refreshes share the same in-flight request', async () => {
  const { client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  // start() already made one call; the two forced refreshes below share a
  // single one because the second joins the in-flight request.
  await Promise.all([tracker.refresh({ force: true }), tracker.refresh({ force: true })]);
  assert.equal(client.calls.fetchDevices, 2);
});

test('unchanged values are not published again', async () => {
  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const firstBatch = gladys.published.length;
  assert.ok(firstBatch > 0);

  // Same position, same battery: only the position age moves.
  client.devices = [fakeFindMyDevice()];
  await tracker.refresh({ force: true });

  const republished = gladys.published.slice(firstBatch).map((s) => s.featureExternalId);
  assert.ok(
    republished.every((id) => id.endsWith(':last-seen')),
    `only the position age should change, got ${republished.join(', ')}`,
  );
});

test('an unchanged value is published again once Gladys would call it outdated', async () => {
  const { gladys, client, tracker, advance } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const firstBatch = gladys.published.length;

  // Nothing moved for half an hour: Gladys must still hear about it, otherwise
  // the dashboard ends up showing "no recent value" on a device that is simply
  // sitting at home.
  client.devices = [fakeFindMyDevice()];
  advance(30 * 60 * 1000);
  await tracker.refresh({ force: true });

  const republished = gladys.published.slice(firstBatch).map((s) => s.featureExternalId);
  assert.ok(republished.some((id) => id.endsWith(':presence')));
  assert.ok(republished.some((id) => id.endsWith(':battery')));
});

test('deviceCreated() gives the freshly created device its values right away', async () => {
  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const firstBatch = gladys.published.length;
  const externalId = tracker.externalIdOf(tracker.devices[0]);

  // The user has just added the device in Gladys: the states published before
  // that were dropped by the host, so everything is published again — without
  // calling Apple, and without waiting for the first poll.
  await tracker.deviceCreated(externalId);

  const republished = gladys.published.slice(firstBatch).map((s) => s.featureExternalId);
  assert.ok(republished.some((id) => id.endsWith(':presence')));
  assert.ok(republished.some((id) => id.endsWith(':battery')));
  assert.equal(client.calls.fetchDevices, 1, 'no extra call to Apple');

  // The event is not replayed: a second creation of the same device is a no-op.
  const secondBatch = gladys.published.length;
  await tracker.deviceCreated(externalId);
  assert.equal(gladys.published.length, secondBatch);
});

test('resync() republishes the devices the user created while we were away', async () => {
  const { gladys, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const firstBatch = gladys.published.length;

  // A device created while the container was down: we never saw the event, and
  // the values published before it existed were dropped. The SDK device list is
  // what tells us it is real now.
  gladys.devices = [{ external_id: tracker.externalIdOf(tracker.devices[0]) }];
  await tracker.resync();

  const republished = gladys.published.slice(firstBatch).map((s) => s.featureExternalId);
  assert.ok(republished.some((id) => id.endsWith(':presence')));
});

test('the first poll of a device publishes its states again, straight from the cache', async () => {
  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const firstBatch = gladys.published.length;
  const externalId = tracker.externalIdOf(tracker.devices[0]);

  // Catch-up path: the creation event was missed (container restarted since),
  // so the first poll republishes everything from the still-fresh cache.
  await tracker.pollDevice(externalId);

  const republished = gladys.published.slice(firstBatch).map((s) => s.featureExternalId);
  assert.ok(republished.some((id) => id.endsWith(':presence')));
  assert.equal(client.calls.fetchDevices, 1, 'no extra call to Apple');

  // The next polls are ordinary ticks again.
  const secondBatch = gladys.published.length;
  await tracker.pollDevice(externalId);
  assert.equal(gladys.published.length, secondBatch, 'nothing changed, nothing published');
});

test('the catalog is re-published when a new Apple device shows up', async () => {
  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice({ id: 'A' })] });
  await tracker.start(CONFIG);
  assert.equal(gladys.discovered.length, 1);

  await tracker.refresh({ force: true });
  assert.equal(gladys.discovered.length, 1, 'an unchanged list is not re-published');

  client.devices = [fakeFindMyDevice({ id: 'A' }), fakeFindMyDevice({ id: 'B', name: 'iPad' })];
  await tracker.refresh({ force: true });
  assert.equal(gladys.discovered.length, 2);
  assert.equal(gladys.discovered[1].length, 2);
});

test('presence keeps its hysteresis across two refreshes', async () => {
  const justOutside = (id) =>
    fakeFindMyDevice({
      id,
      location: {
        // ~160 m north of home: inside the 125% leave margin of a 150 m radius.
        latitude: 48.8566 + 0.00144,
        longitude: 2.3522,
        horizontalAccuracy: 10,
        timeStamp: Date.now(),
      },
    });

  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice({ id: 'A' })] });
  await tracker.start(CONFIG);
  assert.equal(tracker.presence.get('A'), true);

  client.devices = [justOutside('A')];
  await tracker.refresh({ force: true });

  assert.equal(tracker.presence.get('A'), true, 'GPS noise does not send the device away');
  assert.ok(
    !gladys.published
      .slice(1)
      .some((s) => s.featureExternalId.endsWith(':presence') && s.state === 0),
  );
});

test('an expired session is renewed once, then the refresh is retried', async () => {
  const { client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const loginsBefore = client.calls.login;

  client.failNextFetchWith = new SessionExpiredError('expired');
  await tracker.refresh({ force: true });

  assert.equal(client.calls.login, loginsBefore + 1, 'signed in again');
  assert.equal(tracker.devices.length, 1, 'the refresh went through after the new sign-in');
});

test('an expired session that needs a new code surfaces as such', async () => {
  const { client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  client.failNextFetchWith = new SessionExpiredError('expired');
  client.loginStatus = LOGIN_STATUS.TWO_FACTOR_REQUIRED;

  await assert.rejects(() => tracker.refresh({ force: true }), /two-factor/);
  assert.equal(tracker.status, TRACKER_STATUS.TWO_FACTOR_REQUIRED);
});

test('a non-session error is propagated instead of triggering a sign-in loop', async () => {
  const { client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);
  const loginsBefore = client.calls.login;

  client.failNextFetchWith = new Error('Find My is down');
  await assert.rejects(() => tracker.refresh({ force: true }), /Find My is down/);
  assert.equal(client.calls.login, loginsBefore);
});

test('ring() sends the Find My sound to the right Apple device', async () => {
  const devices = [fakeFindMyDevice({ id: 'A' }), fakeFindMyDevice({ id: 'B', name: 'iPad' })];
  const { gladys, client, tracker } = createTracker({ devices });
  await tracker.start(CONFIG);

  const rung = await tracker.ring(deviceExternalId(gladys, 'B'));

  assert.equal(rung.name, 'iPad');
  assert.deepEqual(client.calls.playSound, ['B']);
});

test('ring() explains itself when the device left the Find My list', async () => {
  const { tracker } = createTracker({ devices: [fakeFindMyDevice({ id: 'A' })] });
  await tracker.start(CONFIG);
  await assert.rejects(() => tracker.ring('apple-device:unknown'), /not in the Find My list/);
});

test('forgetSession() clears every cached trace of the account', async () => {
  const { client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  await tracker.forgetSession();

  assert.equal(client.calls.forget, 1);
  assert.equal(tracker.status, TRACKER_STATUS.DISCONNECTED);
  assert.deepEqual(tracker.devices, []);
  assert.equal(tracker.presence.size, 0);
  assert.equal(tracker.lastValues.size, 0);
});

test('refresh() does nothing while the integration is not connected', async () => {
  const { client, tracker } = createTracker({ loginStatus: LOGIN_STATUS.TWO_FACTOR_REQUIRED });
  await tracker.start(CONFIG);
  await tracker.refresh({ force: true });
  assert.equal(client.calls.fetchDevices, 0);
});

test('the last known position survives a refresh where Apple locates nothing', async () => {
  const { gladys, client, tracker } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  // Same device, but Apple could not reach it this time: no `location` at all.
  client.devices = [fakeFindMyDevice({ location: null })];
  gladys.published.length = 0;
  await tracker.refresh({ force: true });

  const [device] = tracker.devices;
  assert.ok(device.location, 'the device keeps the position of the previous refresh');
  assert.equal(device.location.latitude, 48.8566);
});

test('a slow call to Apple does not make the next tick skip a refresh', async () => {
  const { client, tracker, advance } = createTracker({ devices: [fakeFindMyDevice()] });
  const config = normalizeConfig({ ...CONFIG, poll_frequency: 60 });

  // Apple answers in 8 s: measured from the END of the call, the next tick (60 s
  // after the previous one) looked too early and the values were refreshed
  // every 120 s instead of every 60 s.
  const slowFetch = client.fetchDevices;
  client.fetchDevices = async (...args) => {
    advance(8_000);
    return slowFetch(...args);
  };

  await tracker.start(config);
  assert.equal(client.calls.fetchDevices, 1);

  // 60 s after the tick that started that slow call.
  advance(52_000);
  await tracker.refresh();
  assert.equal(client.calls.fetchDevices, 2, 'the tick refreshes on time');

  tracker.stopPolling();
});

test('a failed refresh does not hold the next tick back', async () => {
  const { client, tracker, advance } = createTracker({ devices: [fakeFindMyDevice()] });
  await tracker.start(CONFIG);

  client.failNextFetchWith = new Error('Apple is down');
  advance(300_000);
  await assert.rejects(() => tracker.refresh());

  advance(1_000);
  await tracker.refresh();
  assert.equal(client.calls.fetchDevices, 3, 'the failure is retried on the next tick');

  tracker.stopPolling();
});
