// -----------------------------------------------------------------------------
// The home position, taken from the Gladys houses.
//
// The user already gave their position to Gladys when they created their house
// (Settings > House): asking for it a second time, by hand, in this
// integration is both boring and a good way to typo a decimal. Two ways in:
//
//   - the "House to measure presence from" field (`home_house`, a select with
//     `source: "houses"`, Gladys 5.2+): the user picks one of their houses BY
//     NAME, the integration receives its selector and reads its position here.
//     A picked house wins over the typed coordinates — on an install with
//     several houses, it is the only way to say which one is "home";
//   - the pre-fill: when the typed coordinates are missing, they are filled in
//     with the position of the picked house, or of the first located one, and
//     saved — the Configuration screen then shows them, and the user only has
//     to correct them if they want a different reference point.
//
// The houses are read through `gladys.getHouses()` (`GET /house`), which is
// GATED: the manifest must declare `"location": true`, otherwise Gladys
// answers 403. A house never placed on the map has `latitude: null`, which is
// reported, never read as 0 — that is the Gulf of Guinea, thousands of
// kilometres from any home. Every failure is non-fatal: the typed coordinates
// stay in force, and the reason is said instead of whispered.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'home-location' });

/** Why a picked house could not give the home position. */
export const HOME_HOUSE_PROBLEM = {
  /** The manifest permission is missing: only a re-install grants it. */
  DENIED: 'denied',
  /** Gladys did not answer (network, core restarting...). */
  UNAVAILABLE: 'unavailable',
  /** The house was deleted (or renamed) since the user picked it. */
  NOT_FOUND: 'not_found',
  /** The house exists but was never placed on the map. */
  NOT_LOCATED: 'not_located',
};

/** A number that is really a coordinate (Gladys stores them as numbers). */
function toCoordinate(raw, max) {
  // `Number(null)` and `Number('')` are 0, a valid coordinate: a missing value
  // must stay missing.
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  const value = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > max) {
    return null;
  }
  return value;
}

/**
 * The position of one house of `gladys.getHouses()`.
 *
 * @param {{ latitude?: unknown, longitude?: unknown }|null} house
 * @returns {{ latitude: number, longitude: number }|null} null when the house
 * has no real position
 */
export function houseCoordinates(house) {
  if (!house || typeof house !== 'object') {
    return null;
  }
  const latitude = toCoordinate(house.latitude, 90);
  const longitude = toCoordinate(house.longitude, 180);
  if (latitude === null || longitude === null) {
    return null;
  }
  // (0, 0) is the "no position" of a house created by an older Gladys without
  // an address, not a buoy in the Gulf of Guinea: treat it as missing.
  if (latitude === 0 && longitude === 0) {
    return null;
  }
  return { latitude, longitude };
}

/** True for the refusal Gladys answers when `"location": true` is missing. */
function isDenied(err) {
  return String(err?.status) === '403';
}

/**
 * Read the houses, or say why not.
 *
 * @param {object} gladys the SDK instance
 * @returns {Promise<{ houses: object[], problem: string|null, error: Error|null }>}
 */
async function readHouses(gladys) {
  try {
    const houses = await gladys.getHouses();
    return { houses: Array.isArray(houses) ? houses : [], problem: null, error: null };
  } catch (err) {
    if (isDenied(err)) {
      // The single most likely reason for empty coordinates: say it instead of
      // whispering it.
      logger.warn('GET /house refused (403): the integration is not allowed to read your houses');
      return { houses: [], problem: HOME_HOUSE_PROBLEM.DENIED, error: err };
    }
    logger.warn(`Reading the Gladys houses failed: ${err.message}`);
    return { houses: [], problem: HOME_HOUSE_PROBLEM.UNAVAILABLE, error: err };
  }
}

/**
 * The house the user picked in `home_house`, and its position.
 *
 * @param {object} gladys the SDK instance
 * @param {string} selector the stored value of the field: a house selector
 * @returns {Promise<{ house: object|null, coordinates: object|null, problem: string|null, error: Error|null }>}
 */
export async function resolveHomeHouse(gladys, selector) {
  const { houses, problem, error } = await readHouses(gladys);
  if (problem) {
    return { house: null, coordinates: null, problem, error };
  }
  // A house deleted since the user picked it keeps its selector in the config
  // (the core only refuses it at the next save of the form).
  const house = houses.find((entry) => entry?.selector === selector) ?? null;
  if (!house) {
    return { house: null, coordinates: null, problem: HOME_HOUSE_PROBLEM.NOT_FOUND, error: null };
  }
  const coordinates = houseCoordinates(house);
  if (!coordinates) {
    return { house, coordinates: null, problem: HOME_HOUSE_PROBLEM.NOT_LOCATED, error: null };
  }
  return { house, coordinates, problem: null, error: null };
}

/**
 * What the Configuration screen says when the picked house gives no position.
 * The typed coordinates (or the default ones) stay in force meanwhile.
 *
 * @param {string} problem one of HOME_HOUSE_PROBLEM
 * @param {object|null} house the picked house, when it was found
 * @param {{ meanwhile?: boolean }} [options] `meanwhile: false` leaves out the
 * fallback sentence (an action answering the user has nothing in force to tell)
 * @returns {{ en: string, fr: string }}
 */
export function homeHouseWarning(problem, house = null, { meanwhile = true } = {}) {
  const name = house?.name ? ` "${house.name}"` : '';
  const fallback = meanwhile
    ? {
        en: ' Meanwhile, presence is measured from the home coordinates typed below.',
        fr: ' En attendant, la presence est mesuree depuis les coordonnees saisies plus bas.',
      }
    : { en: '', fr: '' };
  const messages = {
    [HOME_HOUSE_PROBLEM.DENIED]: {
      en: 'Gladys refused to give the position of your houses: reinstall the integration to grant it the location permission.',
      fr: "Gladys a refuse de donner la position de vos maisons : reinstallez l'integration pour lui accorder l'autorisation de localisation.",
    },
    [HOME_HOUSE_PROBLEM.UNAVAILABLE]: {
      en: 'The Gladys houses could not be read.',
      fr: 'Les maisons de Gladys sont illisibles pour le moment.',
    },
    [HOME_HOUSE_PROBLEM.NOT_FOUND]: {
      en: 'The house picked in "House to measure presence from" no longer exists in Gladys: pick another one.',
      fr: 'La maison choisie dans "Maison de reference" n\'existe plus dans Gladys : choisissez-en une autre.',
    },
    [HOME_HOUSE_PROBLEM.NOT_LOCATED]: {
      en: `Your house${name} has no position in Gladys: place it on the map in Settings > Houses, or pick another one.`,
      fr: `Votre maison${name} n'a pas de position dans Gladys : placez-la sur la carte dans Parametres > Maisons, ou choisissez-en une autre.`,
    },
  };
  const message = messages[problem] ?? messages[HOME_HOUSE_PROBLEM.UNAVAILABLE];
  return { en: message.en + fallback.en, fr: message.fr + fallback.fr };
}

/**
 * Put the position of the picked house in the config, when there is one: it
 * wins over the typed coordinates. In memory only — the typed fields keep what
 * the user wrote, and stay the fallback if the house is later deleted or
 * loses its position.
 *
 * @param {object} gladys the SDK instance
 * @param {Record<string, unknown>} raw the config as returned by the SDK
 * @returns {Promise<{ config: Record<string, unknown>, warning: {en: string, fr: string}|null }>}
 */
export async function applyHomeHouse(gladys, raw = {}) {
  const selector = String(raw.home_house ?? '').trim();
  if (!selector) {
    return { config: raw, warning: null };
  }
  const { house, coordinates, problem } = await resolveHomeHouse(gladys, selector);
  if (!coordinates) {
    logger.warn(
      `The picked house gives no home position (${problem}): using the typed coordinates`,
    );
    return { config: raw, warning: homeHouseWarning(problem, house) };
  }
  // The coordinates themselves are personal data: they go to the config in
  // memory, never to the logs.
  logger.info('Presence is measured from the picked Gladys house');
  return {
    config: {
      ...raw,
      home_latitude: String(coordinates.latitude),
      home_longitude: String(coordinates.longitude),
    },
    warning: null,
  };
}

/**
 * Ask Gladys for the coordinates of the house, best effort: the picked house
 * when there is one, otherwise the first one placed on the map (the houses
 * come sorted by name).
 *
 * @param {object} gladys the SDK instance
 * @param {{ strict?: boolean, house?: string }} [options] `strict` throws the
 * reason instead of returning null, so a user-triggered action can show it;
 * `house` is the selector picked in `home_house`
 * @returns {Promise<{ latitude: number, longitude: number }|null>} null when
 * Gladys has no house position, or does not serve one to integrations
 */
export async function fetchGladysHomeCoordinates(gladys, { strict = false, house = '' } = {}) {
  if (typeof gladys?.getHouses !== 'function') {
    return null;
  }

  const selector = String(house ?? '').trim();
  if (selector) {
    const resolved = await resolveHomeHouse(gladys, selector);
    if (strict && resolved.problem) {
      const message = homeHouseWarning(resolved.problem, resolved.house, { meanwhile: false });
      const err = new Error(message.en, { cause: resolved.error ?? undefined });
      // Already worded for the user: the action shows it as it is.
      err.homeHouseProblem = resolved.problem;
      throw err;
    }
    return resolved.coordinates;
  }

  const { houses, problem, error } = await readHouses(gladys);
  if (problem) {
    if (strict) {
      throw error;
    }
    return null;
  }
  for (const entry of houses) {
    const coordinates = houseCoordinates(entry);
    if (coordinates) {
      return coordinates;
    }
  }
  logger.info('GET /house answered, but no house has a position yet');
  return null;
}
