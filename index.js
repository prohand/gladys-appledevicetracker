// -----------------------------------------------------------------------------
// Entry point of the Apple Device Tracker integration.
//
// This file only wires the SDK to the tracker (src/tracker.js): no iCloud call
// and no device logic here. It:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. signs in to iCloud and publishes the discovered Apple devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import {
  hasCredentials,
  hasHomeCoordinates,
  normalizeConfig,
  sameAccount,
  sameSettings,
} from './src/config.js';
import { fetchGladysHomeCoordinates } from './src/homeLocation.js';
import { AppleDeviceTracker, TRACKER_STATUS } from './src/tracker.js';

const gladys = new GladysIntegration();
const tracker = new AppleDeviceTracker(gladys);

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

const MESSAGES = {
  missingCredentials: {
    en: 'Fill in your Apple ID and password to connect.',
    fr: 'Renseignez votre identifiant Apple et votre mot de passe pour vous connecter.',
  },
  twoFactorRequired: {
    en: 'Apple sent a code to your devices: enter it with the "Send the two-factor code" action.',
    fr: 'Apple a envoye un code sur vos appareils : saisissez-le avec l\'action "Envoyer le code de double authentification".',
  },
};

/** Report a failure both in the logs and in the Configuration screen. */
async function reportFailure(message, err) {
  if (err) {
    logger.error(message.en, err);
  }
  await gladys
    .setConnectionStatus(false, message)
    .catch((e) => logger.error('setConnectionStatus failed', e));
}

/**
 * Pre-fill the home coordinates with the position of the Gladys house, when the
 * user has not set them yet. Written back with `setConfig` so the Configuration
 * screen shows the fields filled in (and the user can still correct them).
 *
 * @param {Record<string, unknown>} raw the config as returned by the SDK
 * @returns {Promise<Record<string, unknown>>} the config to use from now on
 */
async function prefillHomeCoordinates(raw) {
  if (hasHomeCoordinates(raw)) {
    return raw;
  }

  const coordinates = await fetchGladysHomeCoordinates(gladys);
  if (!coordinates) {
    logger.info('Gladys has no house position: fill in the home coordinates by hand');
    return raw;
  }

  // Saved as text: the fields are `string` in the manifest, and a string keeps
  // every decimal (a `number` input would round them).
  const filled = {
    home_latitude: String(coordinates.latitude),
    home_longitude: String(coordinates.longitude),
  };
  logger.info(
    `Home coordinates pre-filled from the Gladys house (${filled.home_latitude}, ${filled.home_longitude})`,
  );
  await gladys.setConfig(filled).catch((err) => logger.error('Saving the coordinates failed', err));
  return { ...raw, ...filled };
}

/** Sign in to iCloud and publish what Find My reports. */
async function initialize() {
  const previous = config;
  config = normalizeConfig(await prefillHomeCoordinates(await gladys.getConfig()));
  tracker.updateConfig(config);

  // This runs on every (re)connection to Gladys, including a WebSocket that
  // dropped for a few seconds. Signing in to Apple again for that would be
  // rude: when the session is still up on the same account, just re-publish.
  if (tracker.isConnected() && sameAccount(previous, config)) {
    logger.info('Still signed in to iCloud, re-publishing the devices');
    await tracker.publishDiscoveredDevices();
    await gladys.setConnectionStatus(true);
    await tracker.refresh();
    return;
  }

  if (!hasCredentials(config)) {
    logger.info('Waiting for the Apple ID and password to be filled in');
    await reportFailure(MESSAGES.missingCredentials);
    return;
  }

  try {
    const status = await tracker.start(config);
    if (status === TRACKER_STATUS.TWO_FACTOR_REQUIRED) {
      logger.info('Two-factor code required');
      await reportFailure(MESSAGES.twoFactorRequired);
      return;
    }
    await tracker.publishDiscoveredDevices();
    await gladys.setConnectionStatus(true);
    logger.info(`Connected to iCloud, tracking ${tracker.devices.length} device(s)`);
  } catch (err) {
    await reportFailure(
      {
        en: `iCloud connection failed: ${err.message}`,
        fr: `Connexion a iCloud impossible : ${err.message}`,
      },
      err,
    );
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing the Find My device list');
  await tracker.refresh({ force: true });
  await tracker.publishDiscoveredDevices();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Gladys calls this once per device, at the `poll_frequency` declared on it.
// The tracker collapses those calls into a single Find My request.
gladys.onPoll(async (device) => {
  logger.debug(`onPoll <- ${device.external_id}`);
  await tracker.refresh();
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('submit_2fa_code', async (fields) => {
  const count = await tracker.submitSecurityCode(fields.code);
  await tracker.publishDiscoveredDevices();
  await gladys.setConnectionStatus(true);
  return {
    en: `Code accepted: ${count} device(s) found. This session is now trusted by Apple.`,
    fr: `Code accepte : ${count} appareil(s) trouve(s). Cette session est maintenant approuvee par Apple.`,
  };
});

gladys.onAction('check_connection', async () => {
  if (!tracker.isConnected()) {
    // Not connected yet (or session lost): try a full sign-in from the action.
    await initialize();
  } else {
    await tracker.refresh({ force: true });
  }

  if (!tracker.isConnected()) {
    throw new Error(
      tracker.status === TRACKER_STATUS.TWO_FACTOR_REQUIRED
        ? MESSAGES.twoFactorRequired.en
        : MESSAGES.missingCredentials.en,
    );
  }

  const names = tracker.devices.map((device) => device.name).join(', ');
  return {
    en: `iCloud OK: ${tracker.devices.length} device(s) — ${names}`,
    fr: `iCloud OK : ${tracker.devices.length} appareil(s) — ${names}`,
  };
});

gladys.onAction('forget_session', async () => {
  await tracker.forgetSession();
  await gladys.setConnectionStatus(false, MESSAGES.missingCredentials);
  return {
    en: 'Saved session deleted. Use "Test the iCloud connection" to sign in again.',
    fr: 'Session enregistree supprimee. Utilisez "Tester la connexion iCloud" pour vous reconnecter.',
  };
});

// The `identify` action targets ONE device chosen by the user: its manifest
// field declares `"source": "devices"`, so the Configuration screen fills the
// select with the integration's own devices and the handler receives the
// chosen external_id.
gladys.onAction('identify', async (fields) => {
  logger.info(`Action identify <- ${fields.device}`);
  const device = await tracker.ring(fields.device);
  return {
    en: `${device.name} is ringing.`,
    fr: `${device.name} sonne.`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  const previous = config;
  config = normalizeConfig(newConfig);

  // The account changed (or credentials were filled in): sign in again.
  if (!sameAccount(previous, config)) {
    logger.info('onConfigUpdated -> the Apple account changed, signing in again');
    await tracker.forgetSession();
    await initialize();
    return;
  }

  // Nothing the user set changed: this update is the integration saving its own
  // iCloud session (a config key outside the schema). Just keep the new object.
  if (sameSettings(previous, config)) {
    tracker.updateConfig(config);
    return;
  }

  // Same account: the home position, the radius or the poll frequency moved.
  // Re-publish the devices (poll_frequency lives on them) and re-evaluate the
  // presence with the new settings. publishDiscoveredDevices is idempotent.
  logger.info('onConfigUpdated -> new settings applied');
  tracker.updateConfig(config);
  await tracker.publishDiscoveredDevices();
  if (tracker.isConnected()) {
    await tracker.refresh({ force: true });
  }
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs the integration's own (re)initialization.
gladys.on('connected', async () => {
  await initialize();
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Apple Device Tracker integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
