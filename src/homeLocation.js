// -----------------------------------------------------------------------------
// Pre-filling the home coordinates from Gladys.
//
// The user already gave their position to Gladys when they created their house
// (Settings > House): asking for it a second time, by hand, in this
// integration is both boring and a good way to typo a decimal. So when the
// coordinates are missing from our config, we ask the host API for the house
// and save what it answers — the Configuration screen then shows the fields
// already filled in, and the user only has to correct them if they want a
// different reference point.
//
// The house is NOT part of the documented integration API (contract C.2 covers
// /device, /config, /status...): this is best effort. Every failure — endpoint
// unknown, token not allowed, unexpected body — is swallowed and simply leaves
// the fields empty, exactly as before.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'home-location' });

// Tried in order, first usable answer wins.
const HOUSE_ENDPOINTS = ['/house', '/houses'];

// Keys a payload may hide the house behind, depending on the endpoint.
const WRAPPER_KEYS = ['house', 'houses', 'home', 'data'];

/** A number that is really a coordinate (Gladys stores them as numbers). */
function toCoordinate(raw, max) {
  const value = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > max) {
    return null;
  }
  return value;
}

/**
 * Find a `{ latitude, longitude }` pair in whatever the host API answered.
 * Handles the object itself, a list of houses, and the usual wrappers.
 *
 * @param {unknown} payload body returned by the host API
 * @returns {{ latitude: number, longitude: number }|null}
 */
export function extractCoordinates(payload) {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = extractCoordinates(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const latitude = toCoordinate(payload.latitude, 90);
  const longitude = toCoordinate(payload.longitude, 180);
  // (0, 0) is the "no position" of a house created without an address, not a
  // buoy in the Gulf of Guinea: treat it as missing.
  if (latitude !== null && longitude !== null && !(latitude === 0 && longitude === 0)) {
    return { latitude, longitude };
  }

  for (const key of WRAPPER_KEYS) {
    if (payload[key] !== undefined) {
      const found = extractCoordinates(payload[key]);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Ask Gladys for the coordinates of the house, best effort.
 *
 * @param {object} gladys the SDK instance (its `httpClient` is used directly:
 * the SDK exposes no typed method for the house)
 * @returns {Promise<{ latitude: number, longitude: number }|null>} null when
 * Gladys has no house position, or does not serve one to integrations
 */
export async function fetchGladysHomeCoordinates(gladys) {
  const httpClient = gladys?.httpClient;
  if (typeof httpClient?.get !== 'function') {
    return null;
  }

  for (const path of HOUSE_ENDPOINTS) {
    try {
      const coordinates = extractCoordinates(await httpClient.get(path));
      if (coordinates) {
        return coordinates;
      }
    } catch (err) {
      logger.debug(`GET ${path} did not give the house position: ${err.message}`);
    }
  }
  return null;
}
