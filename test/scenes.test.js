import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MESSAGE_LENGTH,
  normalizeMessage,
  positionOutputs,
  presenceEventData,
} from '../src/scenes.js';
import { summarizeDevice } from '../src/devices/index.js';
import { normalizeAppleDevice } from '../src/devices/appleDevice.js';
import { normalizeConfig } from '../src/config.js';
import { fakeFindMyDevice } from './helpers/fakeGladys.js';

const CONFIG = normalizeConfig({ home_latitude: 48.8566, home_longitude: 2.3522 });

test('an arrival carries the device filter and the variables of the scene', () => {
  const summary = summarizeDevice(CONFIG, normalizeAppleDevice(fakeFindMyDevice()), true);

  assert.deepEqual(presenceEventData('apple-device:abc', summary, 2), {
    device: 'apple-device:abc',
    device_name: 'iPhone de Jean',
    distance_km: 0,
    battery: 87,
    devices_at_home: 2,
  });
});

test('the position outputs are plain values, null when unknown', () => {
  const located = positionOutputs(
    summarizeDevice(CONFIG, normalizeAppleDevice(fakeFindMyDevice()), true),
  );
  assert.equal(located.at_home, true);
  assert.equal(located.latitude, 48.8566);
  assert.equal(located.accuracy_m, 12);
  assert.equal(located.position_age_min, 0);
  assert.equal(located.charging, false);
  assert.match(located.map_url, /^https:\/\/maps\.apple\.com\//);

  const lost = positionOutputs(
    summarizeDevice(CONFIG, normalizeAppleDevice({ id: 'T', name: 'AirTag' }), null),
  );
  assert.equal(lost.device_name, 'AirTag');
  for (const key of ['at_home', 'distance_km', 'latitude', 'map_url', 'battery']) {
    assert.equal(lost[key], null, `${key} must stay empty, never a made-up 0`);
  }
});

test('the message is trimmed, bounded, and never empty', () => {
  assert.equal(normalizeMessage('  A table !  '), 'A table !');
  assert.equal(normalizeMessage('x'.repeat(900)).length, MAX_MESSAGE_LENGTH);
  assert.throws(() => normalizeMessage('   '), /empty/);
  assert.throws(() => normalizeMessage(undefined), /empty/);
});
