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
import { AppleDeviceTracker, TRACKER_HEALTH, TRACKER_STATUS } from './src/tracker.js';
import { normalizeMessage, positionOutputs } from './src/scenes.js';
import { WIDGET_ACTION, buildDeviceWidget, buildPresenceWidget, widgetTtl } from './src/widgets.js';

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
  unreachable: {
    en: 'Find My is not answering: the values shown are the last ones received.',
    fr: 'Localiser ne repond pas : les valeurs affichees sont les dernieres recues.',
  },
  stale: {
    en: 'The values have not been refreshed for a while: check the connection with "Test the iCloud connection".',
    fr: 'Les valeurs ne sont plus rafraichies depuis un moment : verifiez avec "Tester la connexion iCloud".',
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

/**
 * One device, as the "Test the iCloud connection" action names it: its name,
 * its battery level and what Apple says about the plug.
 *
 * `charging: null` is the answer of Find My for an accessory, and for a device
 * it could not reach — that is exactly the case that leaves the `Charging`
 * feature empty in Gladys, so it is said out loud rather than left blank.
 *
 * @param {object} device a device normalized by the tracker
 * @param {'en'|'fr'} lang
 */
function describeDevice(device, lang) {
  const parts = [];
  if (device.batteryLevel !== null) {
    parts.push(`${device.batteryLevel}%`);
  }
  if (device.charging === true) {
    parts.push(lang === 'fr' ? 'en charge' : 'charging');
  } else if (device.charging === false) {
    parts.push(lang === 'fr' ? 'pas en charge' : 'not charging');
  } else {
    parts.push(
      lang === 'fr'
        ? `charge inconnue (batteryStatus : ${device.batteryStatus ?? 'absent'})`
        : `charging state unknown (batteryStatus: ${device.batteryStatus ?? 'none'})`,
    );
  }
  return `${device.name} (${parts.join(', ')})`;
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
 * The tracker stopped (or resumed) updating the values: say it in the
 * Configuration screen.
 *
 * This is the channel that was missing. An iCloud session Apple would not renew
 * without a new two-factor code left the integration frozen on its last values
 * with a screen still saying "connected": the values simply stopped moving, and
 * nothing anywhere said why.
 */
tracker.onHealth = async (code, error) => {
  if (code === TRACKER_HEALTH.OK) {
    logger.info('The values are being refreshed again');
    await gladys
      .setConnectionStatus(true)
      .catch((err) => logger.error('setConnectionStatus failed', err));
    return;
  }

  logger.warn(`The values are not being refreshed any more (${code})`);
  if (code === TRACKER_HEALTH.TWO_FACTOR_REQUIRED) {
    await reportFailure(twoFactorMessage(tracker.twoFactorTarget, tracker.twoFactorError));
    return;
  }
  await reportFailure(
    MESSAGES[code === TRACKER_HEALTH.UNREACHABLE ? 'unreachable' : 'stale'],
    error,
  );
};

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
  // force: this event IS the creation, even for a device we already served
  // before — deleting a device and adding it again is how the user picks up a
  // change in its feature list, and the new features start out empty.
  await tracker.deviceCreated(device.external_id, { force: true });
});

// --- Device updated: the user clicked "Update" on the Discovery screen --------
// That button is how an EXISTING device picks up a feature added by a new
// version of the integration (the `Charging` one on 1.0.8, `Ring` before it):
// Gladys creates the missing features, empty, and they stay empty until a value
// is published on them. Nothing was listening to this event, so the dashboard
// showed "no value received" on the new row until the next heartbeat — or for
// ever, for a value that never moved. The whole device is re-published instead.
gladys.onDeviceUpdated(async (device) => {
  logger.info(`onDeviceUpdated <- ${device.external_id}`);
  await tracker.deviceCreated(device.external_id, { force: true });
});

// --- Device deleted: drop what we remembered about it ------------------------
// Its features no longer exist, so the values remembered for them are stale:
// keeping them would make a device re-created under the same external_id look
// "already published" and leave it empty on the dashboard.
gladys.onDeviceDeleted(async (device) => {
  logger.info(`onDeviceDeleted <- ${device.external_id}`);
  tracker.forgetDevice(device.external_id);
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

  // Named with what Apple says about their battery: "the Charging feature is
  // empty" is otherwise impossible to tell from "Apple sends no charging state
  // for this device" without reading the logs.
  const names = tracker.devices.map((device) => describeDevice(device, 'en')).join(', ');
  const nomsFr = tracker.devices.map((device) => describeDevice(device, 'fr')).join(', ');
  return {
    en: `iCloud OK: ${tracker.devices.length} device(s) — ${names}`,
    fr: `iCloud OK : ${tracker.devices.length} appareil(s) — ${nomsFr}`,
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

// --- Scene actions (Gladys 5.1+) ---------------------------------------------
// Declared in the manifest `scene_actions`: Gladys draws the cards of the scene
// editor and hands over the fields already checked, scene variables rendered.
// The `device` fields come from a `"source": "devices"` select, so they carry
// the external_id of one of our devices. Throwing fails that action only: the
// scene logs it and goes on.

// A message on the screen of a device: "Dinner is ready", "Call home".
gladys.onSceneAction('send_message', async (fields) => {
  const message = normalizeMessage(fields.message);
  const device = await tracker.sendMessage(fields.device, message, {
    sound: fields.sound === true,
  });
  logger.info(`Scene action send_message -> message shown on ${device.name}`);
});

// Fresh positions before the scene reads a presence ("am I the last one out?").
// The tracker never calls Apple more than once every 30 s, whatever the scenes
// ask: this is also what keeps an arrival scene that runs this action from
// looping on itself.
gladys.onSceneAction('refresh_positions', async () => {
  await tracker.refreshNow();
  const devices = tracker.createdDevices();
  return {
    devices_at_home: devices.filter((device) => tracker.summaryOf(device).present === true).length,
    devices_count: devices.length,
  };
});

// Where one device is, as plain values: `{{…map_url}}` in a message is a link
// straight to the map.
gladys.onSceneAction('get_device_position', async (fields) => {
  if (fields.refresh === true) {
    await tracker.refreshNow();
  }
  const device = tracker.findByExternalId(fields.device);
  if (!device) {
    throw new Error('This device is not in the Find My list any more');
  }
  return positionOutputs(tracker.summaryOf(device));
});

// --- Dashboard widgets (Gladys 5.1+) -----------------------------------------
// Declared in the manifest `widgets`: Gladys asks for the content when a
// dashboard shows one, and draws it itself (src/widgets.js builds it). Answered
// from the tracker's memory, never by calling Apple: a dashboard open on a wall
// must not cost a Find My request per display.

// Who is home: the devices picked in the widget settings, or all of them.
gladys.onWidgetGet('presence', async ({ settings, language, units }) => {
  const picked = Array.isArray(settings?.devices) ? settings.devices : [];
  const devices = tracker
    .createdDevices()
    .filter((device) => picked.length === 0 || picked.includes(tracker.externalIdOf(device)));
  return buildPresenceWidget({
    status: tracker.status,
    summaries: devices.map((device) => tracker.summaryOf(device)),
    refreshedMinutesAgo: tracker.refreshedMinutesAgo(),
    language,
    units,
    ttl: widgetTtl(config),
  });
});

// One device in detail.
gladys.onWidgetGet('device', async ({ settings, language, units }) => {
  const device = tracker.findByExternalId(settings?.device);
  return buildDeviceWidget({
    status: tracker.status,
    summary: device ? tracker.summaryOf(device) : null,
    featureId: (feature) => tracker.featureIdOf(device, feature),
    language,
    units,
    ttl: widgetTtl(config),
  });
});

// The Refresh button of both widgets. Gladys re-reads the widget on its own
// after a successful action.
async function refreshFromWidget(actionKey) {
  if (actionKey !== WIDGET_ACTION.REFRESH) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  await tracker.refreshNow();
  return { en: 'Positions updated', fr: 'Positions mises a jour' };
}
gladys.onWidgetAction('presence', refreshFromWidget);
gladys.onWidgetAction('device', refreshFromWidget);

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
