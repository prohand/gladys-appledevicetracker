// -----------------------------------------------------------------------------
// Pre-filling the home coordinates from the Gladys house.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCoordinates, fetchGladysHomeCoordinates } from '../src/homeLocation.js';
import { hasHomeCoordinates } from '../src/config.js';

/** A fake SDK whose httpClient answers from a map of paths. */
function fakeGladysWithHouse(responses) {
  const calls = [];
  return {
    calls,
    httpClient: {
      async get(path) {
        calls.push(path);
        const answer = responses[path];
        if (answer === undefined) {
          throw new Error('NOT_FOUND');
        }
        return answer;
      },
    },
  };
}

test('extractCoordinates reads the usual shapes of the host API', () => {
  const expected = { latitude: 48.8566, longitude: 2.3522 };
  assert.deepEqual(extractCoordinates({ latitude: 48.8566, longitude: 2.3522 }), expected);
  assert.deepEqual(extractCoordinates({ house: expected }), expected);
  assert.deepEqual(extractCoordinates({ houses: [expected] }), expected);
  assert.deepEqual(extractCoordinates([{ name: 'Home', ...expected }]), expected);
  assert.deepEqual(extractCoordinates({ latitude: '48.8566', longitude: '2.3522' }), expected);
});

test('extractCoordinates rejects a house without a real position', () => {
  assert.equal(extractCoordinates(null), null);
  assert.equal(extractCoordinates({ name: 'Home' }), null);
  assert.equal(extractCoordinates({ latitude: null, longitude: null }), null);
  // A house created without an address: Gladys stores (0, 0), not a position.
  assert.equal(extractCoordinates({ latitude: 0, longitude: 0 }), null);
  assert.equal(extractCoordinates({ latitude: 120, longitude: 2 }), null);
});

test('a house with no position does not stop the search of the next one', () => {
  assert.deepEqual(
    extractCoordinates({
      houses: [
        { latitude: 0, longitude: 0 },
        { latitude: 45, longitude: 5 },
      ],
    }),
    {
      latitude: 45,
      longitude: 5,
    },
  );
});

test('fetchGladysHomeCoordinates returns the position of the house', async () => {
  const gladys = fakeGladysWithHouse({
    '/house': { houses: [{ latitude: 45.75, longitude: 4.85 }] },
  });
  assert.deepEqual(await fetchGladysHomeCoordinates(gladys), { latitude: 45.75, longitude: 4.85 });
  assert.deepEqual(gladys.calls, ['/house']);
});

test('an endpoint the host API does not serve is not an error', async () => {
  const gladys = fakeGladysWithHouse({ '/houses': [{ latitude: 45.75, longitude: 4.85 }] });
  assert.deepEqual(await fetchGladysHomeCoordinates(gladys), { latitude: 45.75, longitude: 4.85 });
  assert.deepEqual(gladys.calls, ['/house', '/houses']);
});

test('no house at all: the coordinates stay to the user', async () => {
  const gladys = fakeGladysWithHouse({});
  assert.equal(await fetchGladysHomeCoordinates(gladys), null);
  // An SDK without an httpClient (unit tests, older SDK) must not throw either.
  assert.equal(await fetchGladysHomeCoordinates({}), null);
});

test('hasHomeCoordinates tells a filled config from an empty one', () => {
  assert.equal(hasHomeCoordinates({ home_latitude: '48.8566', home_longitude: '2.3522' }), true);
  assert.equal(hasHomeCoordinates({ home_latitude: 48.8566, home_longitude: 2.3522 }), true);
  assert.equal(hasHomeCoordinates({ home_latitude: '48,8566', home_longitude: '2,3522' }), true);
  assert.equal(hasHomeCoordinates({}), false);
  assert.equal(hasHomeCoordinates({ home_latitude: '48.8566' }), false);
  assert.equal(hasHomeCoordinates({ home_latitude: '  ', home_longitude: '2.3522' }), false);
  assert.equal(hasHomeCoordinates({ home_latitude: 'chez moi', home_longitude: '2.3522' }), false);
});
