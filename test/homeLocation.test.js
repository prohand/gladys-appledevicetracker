// -----------------------------------------------------------------------------
// The home position from the Gladys houses: the picked house, and the pre-fill.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_HOUSE_PROBLEM,
  applyHomeHouse,
  fetchGladysHomeCoordinates,
  homeHouseWarning,
  houseCoordinates,
  resolveHomeHouse,
} from '../src/homeLocation.js';
import { hasHomeCoordinates } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

/** A fake SDK whose getHouses answers these houses (sorted by name, as Gladys). */
function fakeGladysWithHouses(houses) {
  const gladys = createFakeGladys();
  gladys.houses = houses;
  return gladys;
}

const LYON = {
  id: '1',
  name: 'Appartement',
  selector: 'appartement',
  latitude: 45.75,
  longitude: 4.85,
};
const BEACH = {
  id: '2',
  name: 'Maison de plage',
  selector: 'plage',
  latitude: 43.3,
  longitude: 5.4,
};
const UNLOCATED = { id: '3', name: 'Chalet', selector: 'chalet', latitude: null, longitude: null };

test('houseCoordinates reads the position of a Gladys house', () => {
  assert.deepEqual(houseCoordinates(LYON), { latitude: 45.75, longitude: 4.85 });
  assert.deepEqual(houseCoordinates({ latitude: '48.8566', longitude: '2.3522' }), {
    latitude: 48.8566,
    longitude: 2.3522,
  });
});

test('houseCoordinates rejects a house without a real position', () => {
  assert.equal(houseCoordinates(null), null);
  assert.equal(houseCoordinates({ name: 'Home' }), null);
  // Never placed on the map: null, which must never become a latitude of 0.
  assert.equal(houseCoordinates(UNLOCATED), null);
  assert.equal(houseCoordinates({ latitude: null, longitude: 5 }), null);
  assert.equal(houseCoordinates({ latitude: '', longitude: 5 }), null);
  // A house created without an address by an older Gladys: (0, 0).
  assert.equal(houseCoordinates({ latitude: 0, longitude: 0 }), null);
  assert.equal(houseCoordinates({ latitude: 120, longitude: 2 }), null);
});

test('fetchGladysHomeCoordinates returns the first located house', async () => {
  const gladys = fakeGladysWithHouses([UNLOCATED, LYON, BEACH]);
  assert.deepEqual(await fetchGladysHomeCoordinates(gladys), { latitude: 45.75, longitude: 4.85 });
});

test('fetchGladysHomeCoordinates follows the picked house', async () => {
  const gladys = fakeGladysWithHouses([LYON, BEACH]);
  assert.deepEqual(await fetchGladysHomeCoordinates(gladys, { house: 'plage' }), {
    latitude: 43.3,
    longitude: 5.4,
  });
  // A picked house with no position is not swapped for another one.
  gladys.houses = [LYON, UNLOCATED];
  assert.equal(await fetchGladysHomeCoordinates(gladys, { house: 'chalet' }), null);
});

test('no house at all: the coordinates stay to the user', async () => {
  assert.equal(await fetchGladysHomeCoordinates(fakeGladysWithHouses([])), null);
  assert.equal(await fetchGladysHomeCoordinates(fakeGladysWithHouses([UNLOCATED])), null);
  // An SDK without getHouses (unit tests, older SDK) must not throw either.
  assert.equal(await fetchGladysHomeCoordinates({}), null);
});

test('strict mode surfaces the reason instead of an empty field', async () => {
  // What a missing `"location": true` in the manifest looks like: the host API
  // refuses, and the user deserves to read why when they press the button.
  const gladys = fakeGladysWithHouses([LYON]);
  gladys.housesError = Object.assign(new Error('Forbidden'), { status: 403 });

  assert.equal(await fetchGladysHomeCoordinates(gladys), null, 'startup stays best effort');
  await assert.rejects(() => fetchGladysHomeCoordinates(gladys, { strict: true }), /Forbidden/);
});

test('strict mode names the problem of the picked house', async () => {
  const gladys = fakeGladysWithHouses([LYON, UNLOCATED]);
  await assert.rejects(
    () => fetchGladysHomeCoordinates(gladys, { strict: true, house: 'chalet' }),
    (err) =>
      err.homeHouseProblem === HOME_HOUSE_PROBLEM.NOT_LOCATED && /"Chalet"/.test(err.message),
  );
  await assert.rejects(
    () => fetchGladysHomeCoordinates(gladys, { strict: true, house: 'gone' }),
    (err) => err.homeHouseProblem === HOME_HOUSE_PROBLEM.NOT_FOUND,
  );
});

test('resolveHomeHouse tells every way a picked house can fail', async () => {
  const gladys = fakeGladysWithHouses([LYON, UNLOCATED]);
  assert.deepEqual((await resolveHomeHouse(gladys, 'appartement')).coordinates, {
    latitude: 45.75,
    longitude: 4.85,
  });
  assert.equal((await resolveHomeHouse(gladys, 'chalet')).problem, HOME_HOUSE_PROBLEM.NOT_LOCATED);
  // Deleted since the user picked it: the stored selector matches nothing.
  assert.equal((await resolveHomeHouse(gladys, 'gone')).problem, HOME_HOUSE_PROBLEM.NOT_FOUND);

  gladys.housesError = Object.assign(new Error('Forbidden'), { status: 403 });
  assert.equal((await resolveHomeHouse(gladys, 'chalet')).problem, HOME_HOUSE_PROBLEM.DENIED);
  gladys.housesError = new Error('ECONNRESET');
  assert.equal((await resolveHomeHouse(gladys, 'chalet')).problem, HOME_HOUSE_PROBLEM.UNAVAILABLE);
});

test('the picked house wins over the typed coordinates', async () => {
  const gladys = fakeGladysWithHouses([LYON, BEACH]);
  const raw = { home_house: 'plage', home_latitude: '48.8566', home_longitude: '2.3522' };

  const { config, warning } = await applyHomeHouse(gladys, raw);

  assert.equal(config.home_latitude, '43.3');
  assert.equal(config.home_longitude, '5.4');
  assert.equal(warning, null);
  // In memory only: nothing is written over what the user typed.
  assert.deepEqual(gladys.configs, []);
});

test('no house picked: the typed coordinates stay, and Gladys is not asked', async () => {
  const gladys = fakeGladysWithHouses([LYON]);
  gladys.getHouses = async () => assert.fail('no house to read');
  const raw = { home_latitude: '48.8566', home_longitude: '2.3522' };

  assert.deepEqual(await applyHomeHouse(gladys, raw), { config: raw, warning: null });
  assert.deepEqual(await applyHomeHouse(gladys, { ...raw, home_house: '  ' }), {
    config: { ...raw, home_house: '  ' },
    warning: null,
  });
});

test('a picked house without a position is reported, never taken as 0,0', async () => {
  const gladys = fakeGladysWithHouses([LYON, UNLOCATED]);
  const raw = { home_house: 'chalet', home_latitude: '48.8566', home_longitude: '2.3522' };

  const { config, warning } = await applyHomeHouse(gladys, raw);

  assert.equal(config, raw, 'the typed coordinates stay in force');
  assert.match(warning.en, /"Chalet" has no position/);
  assert.match(warning.fr, /"Chalet" n'a pas de position/);
});

test('every home house warning is bilingual', () => {
  for (const problem of Object.values(HOME_HOUSE_PROBLEM)) {
    const warning = homeHouseWarning(problem, { name: 'Chalet' });
    assert.ok(warning.en.length > 0 && warning.fr.length > 0, problem);
    assert.match(warning.en, /typed below/);
    assert.doesNotMatch(homeHouseWarning(problem, null, { meanwhile: false }).en, /typed below/);
  }
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
