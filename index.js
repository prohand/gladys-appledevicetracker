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

/**
 * The "waiting for the code" message, naming the destination Apple confirmed
 * (trusted devices or SMS) so the user knows where to look — and so that "I
 * received nothing" becomes a readable state instead of a guess.
 *
 * @param {{en: string, fr: string}|null} target where Apple says it sent it
 */
function twoFactorMessage(target, error = null) {
  // Apple refused to send anything: say so, instead of asking for a code that
  // is never going to arrive.
  if (error) {
    return {
      en: `Apple did not send a code: ${error}. Try the "Send me the code by SMS" action.`,
      fr: `Apple n'a pas envoye de code : ${error}. Essayez l'action "M'envoyer le code par SMS".`,
    };
  }
  if (!target) {
    return MESSAGES.twoFactorRequired;
  }
  return {
    en: `Apple sent a code to ${target.en}: enter it with the "Send the two-factor code" action.`,
    fr: `Apple a envoye un code sur ${target.fr} : saisissez-le avec l'action "Envoyer le code de double authentification".`,
  };
}

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
    // The user may have created a device while we were not listening: its
    // features exist now, so send them their values.
    await tracker.resync();
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
      await reportFailure(twoFactorMessage(tracker.twoFactorTarget, tracker.twoFactorError));
      return;
    }
    await tracker.publishDiscoveredDevices();
    await gladys.setConnectionStatus(true);
    await tracker.resync();
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

// --- Device created: the user added a discovered device to Gladys ------------
// This is the moment its features start existing: everything published before
// was dropped by the host API, so the device gets its values right away instead
// of waiting for the first poll.
gladys.onDeviceCreated(async (device) => {
  logger.info(`onDeviceCreated <- ${device.external_id}`);
  await tracker.deviceCreated(device.external_id);
});

// --- Command: the user presses a button on a device --------------------------
// The only writable feature of an Apple device is its ring button (a push
// button on the dashboard): the tracker refuses anything else, and a rejected
// handler is acked as a failed command instead of doing nothing in silence.
gladys.onSetValue(async (device, feature) => {
  logger.info(`onSetValue <- ${feature.external_id}`);
  const appleDevice = await tracker.setFeatureValue(device.external_id, feature.external_id);
  logger.info(`${appleDevice.name} is ringing`);
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Gladys calls this once per device, at the `poll_frequency` declared on it.
// The tracker collapses those calls into a single Find My request.
gladys.onPoll(async (device) => {
  logger.debug(`onPoll <- ${device.external_id}`);
  // pollDevice, not refresh: the first poll of a device is the catch-up path
  // for a creation we did not hear about (container restarted since).
  await tracker.pollDevice(device.external_id);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('submit_2fa_code', async (fields) => {
  const count = await tracker.submitSecurityCode(fields.code);
  await tracker.publishDiscoveredDevices();
  await gladys.setConnectionStatus(true);
  await tracker.resync();
  return {
    en: `Code accepted: ${count} device(s) found. This session is now trusted by Apple.`,
    fr: `Code accepte : ${count} appareil(s) trouve(s). Cette session est maintenant approuvee par Apple.`,
  };
});

// Nothing received? Apple only pushes the code when it is asked to: this button
// asks again (and falls back to an SMS for an account with no trusted device).
gladys.onAction('resend_2fa_code', async () => {
  if (tracker.isConnected()) {
    throw new Error('Already signed in to iCloud: no code is needed.');
  }
  if (!hasCredentials(config)) {
    throw new Error(MESSAGES.missingCredentials.en);
  }

  if (tracker.hasClient()) {
    await tracker.requestSecurityCode();
  } else {
    // No sign-in attempt yet (fresh start of the container): signing in asks
    // Apple for a code on its own.
    await initialize();
  }

  const target = tracker.twoFactorTarget;
  await reportFailure(twoFactorMessage(target, tracker.twoFactorError));
  return {
    en: `A new code was sent to ${target?.en ?? 'your trusted Apple devices'}.`,
    fr: `Un nouveau code a ete envoye sur ${target?.fr ?? 'vos appareils Apple de confiance'}.`,
  };
});

// The push to the Apple devices can stay silent (a device that never comes
// online, a notification the user cannot see): this button asks Apple for an
// SMS on a trusted phone number instead.
gladys.onAction('send_2fa_code_by_sms', async () => {
  if (tracker.isConnected()) {
    throw new Error('Already signed in to iCloud: no code is needed.');
  }
  if (!hasCredentials(config)) {
    throw new Error(MESSAGES.missingCredentials.en);
  }
  if (!tracker.hasClient()) {
    // No sign-in attempt yet (fresh start of the container): sign in first, so
    // Apple has a session to attach the SMS to.
    await initialize();
  }

  const target = await tracker.requestSecurityCode({ preferSms: true });
  await reportFailure(twoFactorMessage(target, tracker.twoFactorError));
  return {
    en: `A code was sent to ${target?.en ?? 'your trusted phone number'}.`,
    fr: `Un code a ete envoye par ${target?.fr ?? 'SMS sur votre numero de confiance'}.`,
  };
});

// The coordinates are pre-filled at startup, but the fields can stay empty (the
// house had no position yet, or this integration was not allowed to read it).
// This button re-runs the pre-fill and, this time, shows what went wrong.
gladys.onAction('refresh_home_location', async () => {
  let coordinates;
  try {
    coordinates = await fetchGladysHomeCoordinates(gladys, { strict: true });
  } catch (err) {
    throw new Error(
      `Gladys did not give the position of your house (${err.message}). ` +
        'Check that your house has an address in Settings > House.',
      { cause: err },
    );
  }
  if (!coordinates) {
    throw new Error(
      'Your Gladys house has no position yet: set its address in Settings > House, then try again.',
    );
  }

  const filled = {
    home_latitude: String(coordinates.latitude),
    home_longitude: String(coordinates.longitude),
  };
  await gladys.setConfig(filled);
  return {
    en: `Home coordinates updated: ${filled.home_latitude}, ${filled.home_longitude}. Reload the page to see them.`,
    fr: `Coordonnees du domicile mises a jour : ${filled.home_latitude}, ${filled.home_longitude}. Rechargez la page pour les voir.`,
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
        ? twoFactorMessage(tracker.twoFactorTarget, tracker.twoFactorError).en
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
