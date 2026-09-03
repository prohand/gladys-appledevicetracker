import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAVE_MARGIN,
  distanceInMeters,
  isPositionUsable,
  resolvePresence,
} from '../src/presence.js';

const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const LYON = { latitude: 45.764, longitude: 4.8357 };

test('distanceInMeters matches the known Paris-Lyon great-circle distance', () => {
  const distance = distanceInMeters(PARIS, LYON);
  // ~392 km as the crow flies; 1 km of tolerance covers the earth-radius model.
  assert.ok(Math.abs(distance - 392_000) < 1_000, `got ${Math.round(distance)} m`);
});

test('distanceInMeters is zero for the same point and symmetric', () => {
  assert.equal(Math.round(distanceInMeters(PARIS, PARIS)), 0);
  assert.equal(
    Math.round(distanceInMeters(PARIS, LYON)),
    Math.round(distanceInMeters(LYON, PARIS)),
  );
});

test('a position more accurate than the threshold is usable', () => {
  assert.equal(isPositionUsable({ ...PARIS, accuracy: 20 }, 500), true);
});

test('a position vaguer than the threshold is ignored', () => {
  assert.equal(isPositionUsable({ ...PARIS, accuracy: 2000 }, 500), false);
});

test('a missing or empty position is ignored', () => {
  assert.equal(isPositionUsable(null, 500), false);
  assert.equal(isPositionUsable({ latitude: 0, longitude: 0, accuracy: 10 }, 500), false);
  assert.equal(isPositionUsable({ latitude: NaN, longitude: 2, accuracy: 10 }, 500), false);
});

test('a position with no accuracy reported is still usable', () => {
  assert.equal(isPositionUsable({ ...PARIS, accuracy: NaN }, 500), true);
});

test('a device inside the radius is present', () => {
  assert.equal(resolvePresence({ distance: 80, radius: 150, wasPresent: null }), true);
});

test('a device outside the radius is absent', () => {
  assert.equal(resolvePresence({ distance: 400, radius: 150, wasPresent: null }), false);
});

test('hysteresis: a device already home stays home just past the radius', () => {
  // 160 m with a 150 m radius: GPS noise, not a departure.
  assert.equal(resolvePresence({ distance: 160, radius: 150, wasPresent: true }), true);
  // The same 160 m does NOT make an absent device arrive.
  assert.equal(resolvePresence({ distance: 160, radius: 150, wasPresent: false }), false);
});

test('hysteresis: past the leave margin the device really leaves', () => {
  const distance = 150 * LEAVE_MARGIN + 1;
  assert.equal(resolvePresence({ distance, radius: 150, wasPresent: true }), false);
});
