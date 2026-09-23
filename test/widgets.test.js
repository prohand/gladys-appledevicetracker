// -----------------------------------------------------------------------------
// The widget contents, checked against the rules Gladys applies to them.
//
// Gladys never rejects a whole content: it drops what breaks its rules (a
// component over the budget, a text too long, a missing field) and logs it on
// its side, where nobody looks. `validateWidgetContent` is the SDK copy of
// those rules: `[]` means "rendered exactly as sent".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  buildDeviceWidget,
  buildPresenceWidget,
  formatAge,
  formatDistance,
  textsFor,
  widgetTtl,
} from '../src/widgets.js';
import { FEATURE, summarizeDevice } from '../src/devices/index.js';
import { normalizeAppleDevice } from '../src/devices/appleDevice.js';
import { normalizeConfig } from '../src/config.js';
import { TRACKER_STATUS } from '../src/tracker.js';
import { fakeFindMyDevice } from './helpers/fakeGladys.js';

const CONFIG = normalizeConfig({
  apple_id: 'john@example.com',
  apple_password: 'hunter2',
  home_latitude: 48.8566,
  home_longitude: 2.3522,
});

const NOW = Date.now();

function summary(overrides = {}, present = true) {
  return summarizeDevice(CONFIG, normalizeAppleDevice(fakeFindMyDevice(overrides)), present, NOW);
}

const away = () =>
  summary(
    {
      name: 'iPhone de Marie',
      location: { latitude: 48.9066, longitude: 2.3522, horizontalAccuracy: 30, timeStamp: NOW },
    },
    false,
  );

const presence = (overrides = {}) =>
  buildPresenceWidget({
    status: TRACKER_STATUS.CONNECTED,
    summaries: [summary(), away()],
    refreshedMinutesAgo: 2,
    language: 'fr',
    units: 'metric',
    ttl: 300,
    ...overrides,
  });

const featureId = (feature) => `apple-device:abc:${feature}`;
const device = (overrides = {}) =>
  buildDeviceWidget({
    status: TRACKER_STATUS.CONNECTED,
    summary: summary(),
    featureId,
    language: 'en',
    units: 'metric',
    ttl: 300,
    ...overrides,
  });

test('the widgets know the statuses of the tracker', () => {
  // widgets.js compares with the raw strings, to stay free of the tracker.
  assert.equal(TRACKER_STATUS.CONNECTED, 'connected');
  assert.equal(TRACKER_STATUS.TWO_FACTOR_REQUIRED, '2fa_required');
});

test('the presence widget lists who is home and who is away', () => {
  const content = presence();

  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 300);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, '1 / 2');
  const { items } = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    items.map((item) => [item.label, item.value, item.color]),
    [
      ['iPhone de Jean', 'A la maison', 'success'],
      ['iPhone de Marie', 'Absent · 5,6 km', 'neutral'],
    ],
  );
  const button = content.components.find((c) => c.type === 'button');
  assert.deepEqual(button.action, { key: 'refresh' });
});

test('the presence widget stays within the 10 lines of a status list', () => {
  const summaries = Array.from({ length: 14 }, (_, index) => summary({ name: `iPhone ${index}` }));
  const content = presence({ summaries });

  assert.deepEqual(validateWidgetContent(content), []);
  const { items } = content.components.find((c) => c.type === 'status');
  assert.equal(items.length, 10);
  assert.deepEqual([items[9].label, items[9].value], ['Autres', '+5']);
});

test('the presence widget says why it is empty instead of showing nobody home', () => {
  for (const [status, summaries, pattern] of [
    [TRACKER_STATUS.TWO_FACTOR_REQUIRED, [summary()], /nouveau code/],
    [TRACKER_STATUS.DISCONNECTED, [summary()], /Pas connecte/],
    [TRACKER_STATUS.CONNECTED, [], /Decouverte/],
  ]) {
    const content = presence({ status, summaries });
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(content.components.length, 1);
    assert.match(content.components[0].text, pattern);
  }
});

test('the device widget fits the content budget of Gladys exactly', () => {
  const content = device();

  // 8 components, the most Gladys renders: nothing may be dropped.
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.length, 8);
  assert.deepEqual(
    content.components.map((c) => c.type),
    ['text', 'value', 'value', 'chart', 'status', 'button', 'button', 'button'],
  );
});

test('the device widget binds its tiles, chart and ring button to the features', () => {
  const content = device();
  const [battery, distance] = content.components.filter((c) => c.type === 'value');
  const chart = content.components.find((c) => c.type === 'chart');
  const [ring, map] = content.components.filter((c) => c.type === 'button');

  assert.equal(battery.device_feature, featureId(FEATURE.BATTERY));
  assert.equal(distance.device_feature, featureId(FEATURE.DISTANCE));
  assert.deepEqual(chart.device_features, [featureId(FEATURE.DISTANCE)]);
  assert.equal(chart.interval, 'last-day');
  assert.deepEqual([ring.device_feature, ring.value], [featureId(FEATURE.RING), 1]);
  assert.match(map.link.url, /^https:\/\/maps\.apple\.com\/\?ll=48\.856600,2\.352200&q=iPhone/);
});

test('the device widget leaves out what the device or Gladys does not have', () => {
  // An AirTag: no battery level, no charging state, never located yet — and a
  // Gladys that holds no Ring feature for it.
  const tag = summarizeDevice(
    CONFIG,
    normalizeAppleDevice({ id: 'T', name: 'AirTag', batteryStatus: 'High' }),
    null,
    NOW,
  );
  const content = device({
    summary: tag,
    featureId: (feature) => (feature === FEATURE.RING ? null : featureId(feature)),
  });

  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(!content.components.some((c) => c.device_feature === featureId(FEATURE.BATTERY)));
  assert.ok(!content.components.some((c) => c.type === 'button' && c.device_feature));
  assert.ok(
    !content.components.some((c) => c.type === 'button' && c.link),
    'no map without position',
  );
  const { items } = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    items.map((item) => [item.label, item.value]),
    [
      ['Presence', 'No position'],
      ['Last position', 'Unknown'],
    ],
  );
});

test('the device widget explains a device that left Find My', () => {
  const content = device({ summary: null });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(content.components[0].text, /not in the Find My list/);
});

test('distances read naturally, in the unit of the user', () => {
  assert.equal(formatDistance(0.35, 'en', 'metric'), '350 m');
  assert.equal(formatDistance(5.62, 'fr', 'metric'), '5,6 km');
  assert.equal(formatDistance(123.4, 'en', 'metric'), '123 km');
  assert.equal(formatDistance(16.09344, 'en', 'us'), '10 mi');
});

test('ages read naturally', () => {
  const t = textsFor('fr');
  assert.equal(formatAge(0, t), "a l'instant");
  assert.equal(formatAge(12, t), 'il y a 12 min');
  assert.equal(formatAge(150, t), 'il y a 3 h');
  assert.equal(formatAge(3000, t), 'il y a 2 j');
  assert.equal(formatAge(null, textsFor('de')), 'Unknown', 'English for any other language');
});

test('the widgets are re-read at the pace of Find My, within the bounds of Gladys', () => {
  assert.equal(widgetTtl({ poll_frequency: 300 }), 300);
  assert.equal(widgetTtl({ poll_frequency: 7200 }), 3600);
  assert.equal(widgetTtl({}), 300);
});
