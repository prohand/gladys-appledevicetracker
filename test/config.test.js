import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT,
  DEFAULT_CONFIG,
  GLADYS_POLL_FREQUENCIES_MS,
  accountConfig,
  hasSecondAccount,
  sameAppleIdTwice,
  sessionKeyOf,
  gladysPollFrequency,
  hasCredentials,
  normalizeConfig,
  sameAccount,
  sameSettings,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig coerces the numeric strings coming from the form', () => {
  const config = normalizeConfig({ home_latitude: '45.5', poll_frequency: '600' });
  assert.equal(config.home_latitude, 45.5);
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig accepts the coordinates typed with a comma or spaces', () => {
  const config = normalizeConfig({ home_latitude: ' 48,8566 ', home_longitude: '2,3522' });
  assert.equal(config.home_latitude, 48.8566);
  assert.equal(config.home_longitude, 2.3522);
});

test('an empty coordinate falls back to the default instead of 0', () => {
  const config = normalizeConfig({ home_latitude: '', home_longitude: '   ' });
  assert.equal(config.home_latitude, DEFAULT_CONFIG.home_latitude);
  assert.equal(config.home_longitude, DEFAULT_CONFIG.home_longitude);
});

test('normalizeConfig clamps the values to the manifest bounds', () => {
  const config = normalizeConfig({ poll_frequency: 5, home_radius: 999999, max_accuracy: 1 });
  assert.equal(config.poll_frequency, 60, 'never hammer Apple every 5 seconds');
  assert.equal(config.home_radius, 10000);
  assert.equal(config.max_accuracy, 10);
});

test('normalizeConfig falls back to the default on an unusable number', () => {
  const config = normalizeConfig({ poll_frequency: 'soon' });
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('normalizeConfig trims the Apple ID but never the password', () => {
  const config = normalizeConfig({ apple_id: '  john@example.com ', apple_password: ' pass ' });
  assert.equal(config.apple_id, 'john@example.com');
  assert.equal(config.apple_password, ' pass ');
});

test('include_family defaults to true and only an explicit false disables it', () => {
  assert.equal(normalizeConfig().include_family, true);
  assert.equal(normalizeConfig({ include_family: false }).include_family, false);
});

test('hasCredentials is false until both fields are filled in', () => {
  assert.equal(hasCredentials(normalizeConfig()), false);
  assert.equal(hasCredentials(normalizeConfig({ apple_id: 'john@example.com' })), false);
  assert.equal(
    hasCredentials(normalizeConfig({ apple_id: 'john@example.com', apple_password: 'x' })),
    true,
  );
});

test('sameAccount only looks at the credentials', () => {
  const base = normalizeConfig({ apple_id: 'a@b.c', apple_password: 'x' });
  const moved = normalizeConfig({ apple_id: 'a@b.c', apple_password: 'x', home_radius: 900 });
  const other = normalizeConfig({ apple_id: 'other@b.c', apple_password: 'x' });
  assert.equal(sameAccount(base, moved), true);
  assert.equal(sameAccount(base, other), false);
});

test('saving the iCloud session is not a settings change', () => {
  const before = normalizeConfig({ apple_id: 'a@b.c', apple_password: 'x' });
  const after = normalizeConfig({ apple_id: 'a@b.c', apple_password: 'x', icloud_session: '{}' });
  assert.equal(sameSettings(before, after), true, 'no Apple call should be triggered by it');

  const moved = normalizeConfig({ apple_id: 'a@b.c', apple_password: 'x', home_radius: 900 });
  assert.equal(sameSettings(before, moved), false);
});

test('the poll frequency sent to Gladys is one of the values it accepts', () => {
  // Gladys stores it as an enum of milliseconds; anything else is rejected with
  // "invalid poll frequency" when the devices are published.
  assert.equal(gladysPollFrequency(300), 60_000);
  assert.equal(gladysPollFrequency(3600), 60_000);
  assert.equal(gladysPollFrequency(60), 60_000);
  assert.equal(gladysPollFrequency(30), 30_000);
  // Below the smallest allowed value, fall back to it rather than to zero.
  assert.equal(gladysPollFrequency(0.5), 1_000);
  for (const seconds of [60, 120, 300, 900, 3600]) {
    assert.ok(GLADYS_POLL_FREQUENCIES_MS.includes(gladysPollFrequency(seconds)));
  }
});

test('picking a home house is a setting change', () => {
  const before = normalizeConfig({ home_latitude: '48.8566', home_longitude: '2.3522' });
  const picked = normalizeConfig({
    home_latitude: '48.8566',
    home_longitude: '2.3522',
    home_house: ' maison ',
  });
  assert.equal(before.home_house, '');
  assert.equal(picked.home_house, 'maison');
  assert.equal(sameSettings(before, picked), false);
});

test('the Gladys poll ticks come from the SDK enum', () => {
  assert.deepEqual(GLADYS_POLL_FREQUENCIES_MS, [1000, 2000, 10000, 15000, 30000, 60000]);
  assert.equal(gladysPollFrequency(300), 60000);
});

test('the second account is optional and off until something is typed in it', () => {
  const config = normalizeConfig({ apple_id: 'john@example.com', apple_password: 'x' });
  assert.equal(hasSecondAccount(config), false);
  assert.equal(config.include_family_2, false, 'its family is not read unless asked');
  assert.equal(hasSecondAccount(normalizeConfig({ apple_id_2: '  jane@example.com ' })), true);
  assert.equal(
    normalizeConfig({ apple_id_2: '  jane@example.com ' }).apple_id_2,
    'jane@example.com',
  );
  assert.equal(normalizeConfig({ include_family_2: true }).include_family_2, true);
});

test('accountConfig hands each account its own credentials, family flag and session', () => {
  const config = normalizeConfig({
    apple_id: 'john@example.com',
    apple_password: 'a',
    icloud_session: '{"s":1}',
    apple_id_2: 'jane@example.com',
    apple_password_2: 'b',
    icloud_session_2: '{"s":2}',
    home_radius: 300,
  });

  const main = accountConfig(config, ACCOUNT.MAIN);
  const second = accountConfig(config, ACCOUNT.SECOND);

  assert.deepEqual(
    [main.apple_id, main.apple_password, main.include_family, main.icloud_session],
    ['john@example.com', 'a', true, '{"s":1}'],
  );
  assert.deepEqual(
    [second.apple_id, second.apple_password, second.include_family, second.icloud_session],
    ['jane@example.com', 'b', false, '{"s":2}'],
  );
  assert.equal(second.home_radius, 300, 'the home settings are shared');
  assert.equal(hasCredentials(second), true);
  assert.equal(sessionKeyOf(ACCOUNT.MAIN), 'icloud_session');
  assert.equal(sessionKeyOf(ACCOUNT.SECOND), 'icloud_session_2');
});

test('a change of the second account is told apart from one of the main account', () => {
  const before = normalizeConfig({ apple_id: 'john@example.com', apple_password: 'a' });
  const after = normalizeConfig({
    ...before,
    apple_id_2: 'jane@example.com',
    apple_password_2: 'b',
  });

  assert.equal(
    sameAccount(accountConfig(before, ACCOUNT.MAIN), accountConfig(after, ACCOUNT.MAIN)),
    true,
    'filling in the second account must not sign the main one out',
  );
  assert.equal(
    sameAccount(accountConfig(before, ACCOUNT.SECOND), accountConfig(after, ACCOUNT.SECOND)),
    false,
  );
  assert.equal(sameSettings(after, { ...after, icloud_session_2: '{}' }), true);
  assert.equal(sameSettings(after, { ...after, include_family_2: true }), false);
});

test('the same Apple ID typed twice is spotted, whatever its case', () => {
  const twice = normalizeConfig({ apple_id: 'John@example.com', apple_id_2: 'john@EXAMPLE.com' });
  assert.equal(sameAppleIdTwice(twice), true);
  assert.equal(sameAppleIdTwice(normalizeConfig({ apple_id: 'john@example.com' })), false);
});
