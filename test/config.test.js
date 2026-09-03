import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
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
