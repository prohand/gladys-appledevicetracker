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
  ACCOUNT,
  ACCOUNTS,
  accountConfig,
  hasCredentials,
  hasHomeCoordinates,
  hasSecondAccount,
  normalizeConfig,
  sameAccount,
  sameAppleIdTwice,
  sameSettings,
} from './src/config.js';
import { applyHomeHouse, fetchGladysHomeCoordinates } from './src/homeLocation.js';
import { TrackerFleet } from './src/fleet.js';
import { TRACKER_HEALTH, TRACKER_STATUS } from './src/tracker.js';
import { normalizeMessage, positionOutputs } from './src/scenes.js';
import { WIDGET_ACTION, buildDeviceWidget, buildPresenceWidget, widgetTtl } from './src/widgets.js';
import { localize } from './src/i18n.js';

// Last-resort net: a promise rejected with nobody listening (a handler the SDK
// emits without awaiting, a timer callback) makes Node stop the whole container
// by default — and the supervisor then restarts it into the same failure. Log
// it instead, so the integration keeps tracking the devices it can.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

const gladys = new GladysIntegration();
// One tracker per iCloud account (the second one is optional): see src/fleet.js.
const fleet = new TrackerFleet(gladys);

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Why the house picked in "House to measure presence from" gives no position
// (deleted, never placed on the map, permission missing), or null. Carried by
// every "connected" status: the tracker works, from the typed coordinates, but
// the user must know their pick is not the one in force.
let homeWarning = null;

/**
 * What is wrong with each account, as the message the Configuration screen
 * shows (null: nothing). Gladys has ONE connection status for the integration,
 * so the accounts are put together by reportStatus().
 */
const problems = { [ACCOUNT.MAIN]: null, [ACCOUNT.SECOND]: null };

const MESSAGES = {
  missingCredentials: {
    en: 'Fill in your Apple ID and password to connect.',
    fr: 'Renseignez votre identifiant Apple et votre mot de passe pour vous connecter.',
    de: 'Gib deine Apple-ID und dein Passwort ein, um dich zu verbinden.',
    es: 'Introduzca su ID de Apple y su contraseña para conectarse.',
  },
  twoFactorRequired: {
    en: 'Apple sent a code to your devices: enter it with the "Send the two-factor code" action.',
    fr: 'Apple a envoye un code sur vos appareils : saisissez-le avec l\'action "Envoyer le code de double authentification".',
    de: 'Apple hat einen Code an deine Geräte gesendet: Gib ihn mit der Aktion „Zwei-Faktor-Code übermitteln“ ein.',
    es: 'Apple ha enviado un código a sus dispositivos: introdúzcalo con la acción "Enviar el código de doble factor".',
  },
  unreachable: {
    en: 'Find My is not answering: the values shown are the last ones received.',
    fr: 'Localiser ne repond pas : les valeurs affichees sont les dernieres recues.',
    de: '„Wo ist?“ antwortet nicht: Die angezeigten Werte sind die zuletzt empfangenen.',
    es: 'Buscar no responde: los valores mostrados son los últimos recibidos.',
  },
  stale: {
    en: 'The values have not been refreshed for a while: check the connection with "Test the iCloud connection".',
    fr: 'Les valeurs ne sont plus rafraichies depuis un moment : verifiez avec "Tester la connexion iCloud".',
    de: 'Die Werte wurden seit einer Weile nicht aktualisiert: Prüfe die Verbindung mit „iCloud-Verbindung testen“.',
    es: 'Los valores no se actualizan desde hace un rato: compruebe la conexión con "Probar la conexión con iCloud".',
  },
  sameAppleId: {
    en: 'It is the same as the main Apple ID: enter another account, or empty these fields.',
    fr: "C'est le meme que l'identifiant principal : saisissez un autre compte, ou videz ces champs.",
    de: 'Sie ist dieselbe wie die Haupt-Apple-ID: Gib einen anderen Account ein oder leere diese Felder.',
    es: 'Es el mismo que el ID de Apple principal: introduzca otra cuenta o vacíe estos campos.',
  },
  signedOut: {
    en: 'Signed out: use "Test the iCloud connection" to sign in again.',
    fr: 'Deconnecte : utilisez "Tester la connexion iCloud" pour vous reconnecter.',
    de: 'Abgemeldet: Verwende „iCloud-Verbindung testen“, um dich erneut anzumelden.',
    es: 'Sesión cerrada: use "Probar la conexión con iCloud" para volver a iniciar sesión.',
  },
};

// How the messages name an account, once there are two of them.
const ACCOUNT_LABELS = {
  [ACCOUNT.MAIN]: {
    en: 'Main Apple ID',
    fr: 'Identifiant Apple principal',
    de: 'Haupt-Apple-ID',
    es: 'ID de Apple principal',
  },
  [ACCOUNT.SECOND]: {
    en: 'Second Apple ID',
    fr: 'Second identifiant Apple',
    de: 'Zweite Apple-ID',
    es: 'Segundo ID de Apple',
  },
};

/** The accounts in use: the main one, and the second one once filled in. */
function activeAccounts() {
  return hasSecondAccount(config) ? ACCOUNTS : [ACCOUNT.MAIN];
}

/**
 * A message about one account, prefixed with the account it is about when two
 * are in use. With one account the messages stay exactly as they always were.
 *
 * @param {string} account one of ACCOUNT
 * @param {Record<string, string>} message a multi-language message
 */
function aboutAccount(account, message) {
  if (activeAccounts().length < 2) {
    return message;
  }
  return localize(
    (lang) =>
      `${ACCOUNT_LABELS[account][lang]}${lang === 'fr' ? ' : ' : ': '}${message[lang] ?? message.en}`,
  );
}

/** Several multi-language messages as one. */
function joinMessages(messages) {
  return localize((lang) => messages.map((message) => message[lang] ?? message.en).join(' '));
}

/**
 * Show in the Configuration screen where the accounts stand.
 *
 * Connected as long as one account is being read: its values are live, and
 * what is wrong with the other one is shown as a warning beside it (with the
 * home warning, when the picked house gives no position). Never rejects:
 * failing to TELL the user must not become a second problem.
 */
async function reportStatus() {
  const accounts = activeAccounts();
  const issues = accounts
    .filter((account) => problems[account])
    .map((account) => aboutAccount(account, problems[account]));
  const working = accounts.some(
    (account) => !problems[account] && fleet.tracker(account).isConnected(),
  );
  try {
    if (issues.length === 0) {
      await gladys.setConnectionStatus(true, homeWarning ?? undefined);
    } else if (working) {
      await gladys.setConnectionStatus(
        true,
        joinMessages([...issues, homeWarning].filter(Boolean)),
      );
    } else {
      await gladys.setConnectionStatus(false, joinMessages(issues));
    }
  } catch (err) {
    logger.error('setConnectionStatus failed', err);
  }
}

/**
 * Record what is wrong with one account, log it, and show it.
 *
 * @param {string} account one of ACCOUNT
 * @param {Record<string, string>|null} message null when the account is fine
 * @param {Error} [err] the error behind it, for the logs
 */
async function setProblem(account, message, err) {
  if (message && err) {
    logger.error(aboutAccount(account, message).en, err);
  }
  problems[account] = message;
  await reportStatus();
}

/** "iCloud connection failed", with the next automatic attempt when there is one. */
function connectionFailedMessage(err, minutes) {
  return {
    en:
      `iCloud connection failed: ${err.message}` +
      (minutes ? `. Next attempt in ${minutes} min.` : ''),
    fr:
      `Connexion a iCloud impossible : ${err.message}` +
      (minutes ? `. Nouvel essai dans ${minutes} min.` : ''),
    de:
      `Verbindung zu iCloud fehlgeschlagen: ${err.message}` +
      (minutes ? `. Nächster Versuch in ${minutes} Min.` : ''),
    es:
      `No se ha podido conectar con iCloud: ${err.message}` +
      (minutes ? `. Próximo intento en ${minutes} min.` : ''),
  };
}

/**
 * The account an action is about. `main` and `second` are the user's choice;
 * anything else (the "automatic" default, or an older Gladys that sends no
 * field) picks the account waiting for a two-factor code, the main one first.
 *
 * @param {unknown} choice the `account` field of the action
 */
function pickAccount(choice) {
  const accounts = activeAccounts();
  if (choice === ACCOUNT.SECOND && !accounts.includes(ACCOUNT.SECOND)) {
    throw new Error('No second Apple ID is filled in the configuration.');
  }
  if (ACCOUNTS.includes(choice)) {
    return choice;
  }
  const waiting =
    accounts.find(
      (account) => fleet.tracker(account).status === TRACKER_STATUS.TWO_FACTOR_REQUIRED,
    ) ?? accounts.find((account) => !fleet.tracker(account).isConnected());
  return waiting ?? ACCOUNT.MAIN;
}

/**
 * The "waiting for the code" message, naming the destination Apple confirmed
 * (trusted devices or SMS) so the user knows where to look — and so that "I
 * received nothing" becomes a readable state instead of a guess.
 *
 * @param {{en: string, fr: string, de?: string, es?: string}|null} target where
 * Apple says it sent it (the German and Spanish texts carry their preposition)
 */
function twoFactorMessage(target, error = null) {
  // Apple refused to send anything: say so, instead of asking for a code that
  // is never going to arrive.
  if (error) {
    return {
      en: `Apple did not send a code: ${error}. Try the "Send me the code by SMS" action.`,
      fr: `Apple n'a pas envoye de code : ${error}. Essayez l'action "M'envoyer le code par SMS".`,
      de: `Apple hat keinen Code gesendet: ${error}. Versuche die Aktion „Code per SMS anfordern“.`,
      es: `Apple no ha enviado ningún código: ${error}. Pruebe la acción "Enviarme el código por SMS".`,
    };
  }
  if (!target) {
    return MESSAGES.twoFactorRequired;
  }
  return {
    en: `Apple sent a code to ${target.en}: enter it with the "Send the two-factor code" action.`,
    fr: `Apple a envoye un code sur ${target.fr} : saisissez-le avec l'action "Envoyer le code de double authentification".`,
    de: `Apple hat einen Code ${target.de ?? target.en} gesendet: Gib ihn mit der Aktion „Zwei-Faktor-Code übermitteln“ ein.`,
    es: `Apple ha enviado un código ${target.es ?? target.en}: introdúzcalo con la acción "Enviar el código de doble factor".`,
  };
}

// How the "Test the iCloud connection" action words the charging state.
const CHARGING_WORDS = {
  en: {
    charging: 'charging',
    notCharging: 'not charging',
    unknown: (status) => `charging state unknown (batteryStatus: ${status ?? 'none'})`,
  },
  fr: {
    charging: 'en charge',
    notCharging: 'pas en charge',
    unknown: (status) => `charge inconnue (batteryStatus : ${status ?? 'absent'})`,
  },
  de: {
    charging: 'wird geladen',
    notCharging: 'wird nicht geladen',
    unknown: (status) => `Ladezustand unbekannt (batteryStatus: ${status ?? 'keiner'})`,
  },
  es: {
    charging: 'cargando',
    notCharging: 'no está cargando',
    unknown: (status) => `estado de carga desconocido (batteryStatus: ${status ?? 'ninguno'})`,
  },
};

/**
 * One device, as the "Test the iCloud connection" action names it: its name,
 * its battery level and what Apple says about the plug.
 *
 * `charging: null` is the answer of Find My for an accessory, and for a device
 * it could not reach — that is exactly the case that leaves the `Charging`
 * feature empty in Gladys, so it is said out loud rather than left blank.
 *
 * @param {object} device a device normalized by the tracker
 * @param {string} lang one of LANGUAGES (English for any other)
 */
function describeDevice(device, lang) {
  const words = CHARGING_WORDS[lang] ?? CHARGING_WORDS.en;
  const parts = [];
  if (device.batteryLevel !== null) {
    parts.push(`${device.batteryLevel}%`);
  }
  if (device.charging === true) {
    parts.push(words.charging);
  } else if (device.charging === false) {
    parts.push(words.notCharging);
  } else {
    parts.push(words.unknown(device.batteryStatus));
  }
  return `${device.name} (${parts.join(', ')})`;
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
fleet.onHealth = async (account, code, error) => {
  const tracker = fleet.tracker(account);
  if (code === TRACKER_HEALTH.OK) {
    logger.info(`The values are being refreshed again (${account} account)`);
    await setProblem(account, null);
    return;
  }

  logger.warn(`The values are not being refreshed any more (${account} account: ${code})`);
  if (code === TRACKER_HEALTH.TWO_FACTOR_REQUIRED) {
    await setProblem(account, twoFactorMessage(tracker.twoFactorTarget, tracker.twoFactorError));
    return;
  }
  await setProblem(
    account,
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

  // The picked house first, when there is one: the typed fields are its fallback.
  const coordinates = await fetchGladysHomeCoordinates(gladys, { house: raw.home_house });
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
  // The coordinates themselves are personal data: they go to the
  // configuration, never to the logs.
  logger.info('Home coordinates pre-filled from the Gladys house');
  await gladys.setConfig(filled).catch((err) => logger.error('Saving the coordinates failed', err));
  return { ...raw, ...filled };
}

/**
 * The config in force: the raw one, with the position of the picked house
 * replacing the typed coordinates when it has one. Houses have no update event:
 * a house moved in Gladys is read again on the next (re)connection or save.
 *
 * @param {Record<string, unknown>} raw the config as returned by the SDK
 */
async function resolveConfig(raw) {
  const { config: resolved, warning } = await applyHomeHouse(gladys, raw);
  homeWarning = warning;
  return normalizeConfig(resolved);
}

/**
 * Sign in to one iCloud account and publish what Find My reports for it. Never
 * rejects: what went wrong is recorded in `problems`, for reportStatus().
 *
 * @param {string} account one of ACCOUNT
 * @param {object} previous the config in force before this initialization
 */
async function initializeAccount(account, previous) {
  const tracker = fleet.tracker(account);
  const own = accountConfig(config, account);

  if (account === ACCOUNT.SECOND && (!hasSecondAccount(config) || sameAppleIdTwice(config))) {
    // Emptied (or never filled): sign it out and take its devices out of the
    // Discover tab. The same Apple ID twice is refused rather than read twice.
    await fleet.removeAccount(account);
    problems[account] = hasSecondAccount(config) ? MESSAGES.sameAppleId : null;
    return;
  }

  // This runs on every (re)connection to Gladys, including a WebSocket that
  // dropped for a few seconds. Signing in to Apple again for that would be
  // rude: when the session is still up on the same account, just re-publish.
  if (tracker.isConnected() && sameAccount(accountConfig(previous, account), own)) {
    logger.info(`Still signed in to iCloud (${account} account), re-publishing the devices`);
    problems[account] = null;
    try {
      await fleet.publishDiscoveredDevices();
      await tracker.refresh();
      // The user may have created a device while we were not listening: its
      // features exist now, so send them their values.
      await tracker.resync();
    } catch (err) {
      logger.error(`Refreshing the ${account} account failed`, err);
      problems[account] = connectionFailedMessage(err, null);
    }
    return;
  }

  if (!hasCredentials(own)) {
    logger.info(`Waiting for the Apple ID and password of the ${account} account`);
    problems[account] = MESSAGES.missingCredentials;
    return;
  }

  try {
    const status = await tracker.start(own);
    if (status === TRACKER_STATUS.TWO_FACTOR_REQUIRED) {
      logger.info(`Two-factor code required (${account} account)`);
      problems[account] = twoFactorMessage(tracker.twoFactorTarget, tracker.twoFactorError);
      return;
    }
    problems[account] = null;
    await fleet.publishDiscoveredDevices();
    await tracker.resync();
    logger.info(
      `Connected to iCloud (${account} account), tracking ${tracker.devices.length} device(s)`,
    );
  } catch (err) {
    // An outage (network not up yet, Apple 503) is retried by the tracker on
    // its own: say when, so the user knows there is nothing to do but wait.
    problems[account] = connectionFailedMessage(err, tracker.startRetryMinutes);
    logger.error(aboutAccount(account, problems[account]).en, err);
  }
}

/** Sign in to every iCloud account and publish what Find My reports. */
async function initialize() {
  const previous = config;
  config = await resolveConfig(await prefillHomeCoordinates(await gladys.getConfig()));
  updateTrackerConfigs();

  // One after the other, main account first: a device both accounts see is
  // kept by the main one (see TrackerFleet.claimedElsewhere), which works best
  // when the main one has read Find My first. The status is shown after each
  // account, so a slow second sign-in does not hold back the first one's.
  for (const account of ACCOUNTS) {
    await initializeAccount(account, previous);
    await reportStatus();
  }
}

/** Hand every tracker the config of its own account. */
function updateTrackerConfigs() {
  for (const account of ACCOUNTS) {
    fleet.tracker(account).updateConfig(accountConfig(config, account));
  }
}

// A sign-in that failed on an outage is retried through the whole
// initialization, so the catalog and the connection status follow it.
for (const tracker of fleet.all) {
  tracker.onStartRetry = () => initialize();
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing the Find My device list');
  await fleet.refresh({ force: true });
  await fleet.publishDiscoveredDevices();
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
  await fleet.deviceCreated(device.external_id, { force: true });
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
  await fleet.deviceCreated(device.external_id, { force: true });
});

// --- Device deleted: drop what we remembered about it ------------------------
// Its features no longer exist, so the values remembered for them are stale:
// keeping them would make a device re-created under the same external_id look
// "already published" and leave it empty on the dashboard.
gladys.onDeviceDeleted(async (device) => {
  logger.info(`onDeviceDeleted <- ${device.external_id}`);
  fleet.forgetDevice(device.external_id);
});

// --- Command: the user presses a button on a device --------------------------
// The only writable feature of an Apple device is its ring button (a push
// button on the dashboard): the tracker refuses anything else, and a rejected
// handler is acked as a failed command instead of doing nothing in silence.
gladys.onSetValue(async (device, feature) => {
  logger.info(`onSetValue <- ${feature.external_id}`);
  const appleDevice = await fleet.setFeatureValue(device.external_id, feature.external_id);
  logger.info(`${appleDevice.name} is ringing`);
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Gladys calls this once per device, at the `poll_frequency` declared on it.
// The tracker collapses those calls into a single Find My request.
gladys.onPoll(async (device) => {
  logger.debug(`onPoll <- ${device.external_id}`);
  // pollDevice, not refresh: the first poll of a device is the catch-up path
  // for a creation we did not hear about (container restarted since).
  await fleet.pollDevice(device.external_id);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('submit_2fa_code', async (fields) => {
  const account = pickAccount(fields.account);
  const tracker = fleet.tracker(account);
  const count = await tracker.submitSecurityCode(fields.code);
  problems[account] = null;
  await fleet.publishDiscoveredDevices();
  await reportStatus();
  await tracker.resync();
  return aboutAccount(account, {
    en: `Code accepted: ${count} device(s) found. This session is now trusted by Apple.`,
    fr: `Code accepte : ${count} appareil(s) trouve(s). Cette session est maintenant approuvee par Apple.`,
    de: `Code akzeptiert: ${count} Gerät(e) gefunden. Apple stuft diese Sitzung jetzt als vertrauenswürdig ein.`,
    es: `Código aceptado: ${count} dispositivo(s) encontrado(s). Apple considera ahora esta sesión de confianza.`,
  });
});

/**
 * The account a "send me a code" action is about, checked: signed out, with its
 * credentials filled in.
 */
function accountAskingForCode(choice) {
  const account = pickAccount(choice);
  if (fleet.tracker(account).isConnected()) {
    throw new Error(
      `${aboutAccount(account, { en: 'Already signed in to iCloud' }).en}: no code is needed.`,
    );
  }
  if (!hasCredentials(accountConfig(config, account))) {
    throw new Error(aboutAccount(account, MESSAGES.missingCredentials).en);
  }
  return account;
}

/**
 * The answer of a "send me a code" action whose new sign-in attempt needed no
 * code after all (Apple honoured the trust token): the account is connected.
 */
async function connectedWithoutCode(account, tracker) {
  problems[account] = null;
  await fleet.publishDiscoveredDevices();
  await reportStatus();
  await tracker.resync();
  return aboutAccount(account, {
    en: `Signed in again, no code was needed: ${tracker.devices.length} device(s) found.`,
    fr: `Reconnecte, aucun code n'etait necessaire : ${tracker.devices.length} appareil(s) trouve(s).`,
    de: `Erneut angemeldet, kein Code nötig: ${tracker.devices.length} Gerät(e) gefunden.`,
    es: `Sesión iniciada de nuevo, no hacía falta código: ${tracker.devices.length} dispositivo(s) encontrado(s).`,
  });
}

// Nothing received? Apple only pushes the code when it is asked to: this button
// asks again (and falls back to an SMS for an account with no trusted device).
gladys.onAction('resend_2fa_code', async (fields = {}) => {
  const account = accountAskingForCode(fields.account);
  const tracker = fleet.tracker(account);

  if (tracker.hasClient()) {
    await tracker.requestSecurityCode();
    if (tracker.isConnected()) {
      return connectedWithoutCode(account, tracker);
    }
  } else {
    // No sign-in attempt yet (fresh start of the container): signing in asks
    // Apple for a code on its own.
    await initialize();
  }

  const target = tracker.twoFactorTarget;
  await setProblem(account, twoFactorMessage(target, tracker.twoFactorError));
  return aboutAccount(account, {
    en: `A new code was sent to ${target?.en ?? 'your trusted Apple devices'}.`,
    fr: `Un nouveau code a ete envoye sur ${target?.fr ?? 'vos appareils Apple de confiance'}.`,
    de: `Ein neuer Code wurde ${target?.de ?? 'an deine vertrauenswürdigen Apple-Geräte'} gesendet.`,
    es: `Se ha enviado un nuevo código ${target?.es ?? 'a sus dispositivos Apple de confianza'}.`,
  });
});

// The push to the Apple devices can stay silent (a device that never comes
// online, a notification the user cannot see): this button asks Apple for an
// SMS on a trusted phone number instead.
gladys.onAction('send_2fa_code_by_sms', async (fields = {}) => {
  const account = accountAskingForCode(fields.account);
  const tracker = fleet.tracker(account);
  if (!tracker.hasClient()) {
    // No sign-in attempt yet (fresh start of the container): sign in first, so
    // Apple has a session to attach the SMS to.
    await initialize();
  }

  const target = await tracker.requestSecurityCode({ preferSms: true });
  if (tracker.isConnected()) {
    return connectedWithoutCode(account, tracker);
  }
  await setProblem(account, twoFactorMessage(target, tracker.twoFactorError));
  return aboutAccount(account, {
    en: `A code was sent to ${target?.en ?? 'your trusted phone number'}.`,
    fr: `Un code a ete envoye par ${target?.fr ?? 'SMS sur votre numero de confiance'}.`,
    de: `Ein Code wurde ${target?.de ?? 'per SMS an deine vertrauenswürdige Telefonnummer'} gesendet.`,
    es: `Se ha enviado un código ${target?.es ?? 'por SMS a su número de teléfono de confianza'}.`,
  });
});

// The coordinates are pre-filled at startup, but the fields can stay empty (the
// house had no position yet, or this integration was not allowed to read it).
// This button re-runs the pre-fill and, this time, shows what went wrong.
gladys.onAction('refresh_home_location', async () => {
  let coordinates;
  try {
    coordinates = await fetchGladysHomeCoordinates(gladys, {
      strict: true,
      house: config.home_house,
    });
  } catch (err) {
    // The picked house is deleted or not on the map: already worded for the user.
    if (err.homeHouseProblem) {
      throw err;
    }
    throw new Error(
      `Gladys did not give the position of your house (${err.message}). ` +
        'Check that your house has an address in Settings > Houses.',
      { cause: err },
    );
  }
  if (!coordinates) {
    throw new Error(
      'Your Gladys house has no position yet: set its address in Settings > Houses, then try again.',
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
    de: `Koordinaten des Zuhauses aktualisiert: ${filled.home_latitude}, ${filled.home_longitude}. Lade die Seite neu, um sie zu sehen.`,
    es: `Coordenadas del hogar actualizadas: ${filled.home_latitude}, ${filled.home_longitude}. Recargue la página para verlas.`,
  };
});

gladys.onAction('check_connection', async () => {
  const accounts = activeAccounts();
  if (accounts.some((account) => !fleet.tracker(account).isConnected())) {
    // An account not connected yet (or session lost): try a full sign-in from
    // the action. The accounts still signed in are just refreshed by it.
    await initialize();
  } else {
    await fleet.refresh({ force: true });
  }

  const connected = accounts.filter((account) => fleet.tracker(account).isConnected());
  const issues = accounts
    .filter((account) => problems[account])
    .map((account) => aboutAccount(account, problems[account]));
  if (connected.length === 0) {
    throw new Error(issues.length > 0 ? joinMessages(issues).en : MESSAGES.missingCredentials.en);
  }

  // Named with what Apple says about their battery: "the Charging feature is
  // empty" is otherwise impossible to tell from "Apple sends no charging state
  // for this device" without reading the logs.
  const report = connected.map((account) => {
    const { devices } = fleet.tracker(account);
    const count = devices.length;
    const header = {
      en: `iCloud OK: ${count} device(s)`,
      fr: `iCloud OK : ${count} appareil(s)`,
      de: `iCloud OK: ${count} Gerät(e)`,
      es: `iCloud OK: ${count} dispositivo(s)`,
    };
    return aboutAccount(
      account,
      localize(
        (lang) =>
          `${header[lang]} — ${devices.map((device) => describeDevice(device, lang)).join(', ')}${accounts.length > 1 ? '.' : ''}`,
      ),
    );
  });
  // The account that does not work is named too: the action answered "OK"
  // while the second Apple ID was waiting for a code.
  return joinMessages([...report, ...issues]);
});

gladys.onAction('forget_session', async (fields = {}) => {
  // "Both" unless one account is picked: the action used to sign out the only
  // account there was.
  const accounts = ACCOUNTS.includes(fields.account) ? [pickAccount(fields.account)] : ACCOUNTS;
  for (const account of accounts) {
    await fleet.tracker(account).forgetSession();
    problems[account] = activeAccounts().includes(account) ? MESSAGES.signedOut : null;
  }
  await reportStatus();
  const message = {
    en: 'Saved session deleted. Use "Test the iCloud connection" to sign in again.',
    fr: 'Session enregistree supprimee. Utilisez "Tester la connexion iCloud" pour vous reconnecter.',
    de: 'Gespeicherte Sitzung gelöscht. Verwende „iCloud-Verbindung testen“, um dich erneut anzumelden.',
    es: 'Sesión guardada eliminada. Use "Probar la conexión con iCloud" para volver a iniciar sesión.',
  };
  return accounts.length === 1 ? aboutAccount(accounts[0], message) : message;
});

// The `identify` action targets ONE device chosen by the user: its manifest
// field declares `"source": "devices"`, so the Configuration screen fills the
// select with the integration's own devices and the handler receives the
// chosen external_id.
gladys.onAction('identify', async (fields) => {
  logger.info(`Action identify <- ${fields.device}`);
  const device = await fleet.ring(fields.device);
  return {
    en: `${device.name} is ringing.`,
    fr: `${device.name} sonne.`,
    de: `${device.name} klingelt.`,
    es: `${device.name} está sonando.`,
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
  const device = await fleet.sendMessage(fields.device, message, {
    sound: fields.sound === true,
  });
  logger.info(`Scene action send_message -> message shown on ${device.name}`);
});

// Fresh positions before the scene reads a presence ("am I the last one out?").
// The tracker never calls Apple more than once every 30 s, whatever the scenes
// ask: this is also what keeps an arrival scene that runs this action from
// looping on itself.
gladys.onSceneAction('refresh_positions', async () => {
  await fleet.refreshNow();
  const devices = fleet.createdDevices();
  return {
    devices_at_home: devices.filter((device) => fleet.summaryOf(device).present === true).length,
    devices_count: devices.length,
  };
});

// Where one device is, as plain values: `{{…map_url}}` in a message is a link
// straight to the map.
gladys.onSceneAction('get_device_position', async (fields) => {
  if (fields.refresh === true) {
    await fleet.refreshNow();
  }
  const device = fleet.findByExternalId(fields.device);
  if (!device) {
    throw new Error('This device is not in the Find My list any more');
  }
  return positionOutputs(fleet.summaryOf(device));
});

// --- Dashboard widgets (Gladys 5.1+) -----------------------------------------
// Declared in the manifest `widgets`: Gladys asks for the content when a
// dashboard shows one, and draws it itself (src/widgets.js builds it). Answered
// from the tracker's memory, never by calling Apple: a dashboard open on a wall
// must not cost a Find My request per display.

// Who is home: the devices picked in the widget settings, or all of them.
gladys.onWidgetGet('presence', async ({ settings, language, units }) => {
  const picked = Array.isArray(settings?.devices) ? settings.devices : [];
  const devices = fleet
    .createdDevices()
    .filter((device) => picked.length === 0 || picked.includes(fleet.externalIdOf(device)));
  return buildPresenceWidget({
    status: fleet.status,
    summaries: devices.map((device) => fleet.summaryOf(device)),
    refreshedMinutesAgo: fleet.refreshedMinutesAgo(),
    language,
    units,
    ttl: widgetTtl(config),
  });
});

// One device in detail.
gladys.onWidgetGet('device', async ({ settings, language, units }) => {
  const device = fleet.findByExternalId(settings?.device);
  return buildDeviceWidget({
    status: fleet.status,
    summary: device ? fleet.summaryOf(device) : null,
    featureId: (feature) => fleet.featureIdOf(device, feature),
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
  await fleet.refreshNow();
  return {
    en: 'Positions updated',
    fr: 'Positions mises a jour',
    de: 'Positionen aktualisiert',
    es: 'Posiciones actualizadas',
  };
}
gladys.onWidgetAction('presence', refreshFromWidget);
gladys.onWidgetAction('device', refreshFromWidget);

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  const previous = config;
  const previousWarning = homeWarning;
  config = await resolveConfig(newConfig);

  // An account changed (or credentials were filled in, or emptied): sign it in
  // again. The other account is left alone: initialize() only re-publishes it.
  const changed = ACCOUNTS.filter(
    (account) => !sameAccount(accountConfig(previous, account), accountConfig(config, account)),
  );
  if (changed.length > 0) {
    for (const account of changed) {
      logger.info(`onConfigUpdated -> the ${account} Apple account changed, signing in again`);
      await fleet.tracker(account).forgetSession();
    }
    await initialize();
    return;
  }

  // A house picked, deleted or placed on the map since: the Configuration
  // screen must stop (or start) saying the typed coordinates are in force.
  if (fleet.isConnected() && JSON.stringify(homeWarning) !== JSON.stringify(previousWarning)) {
    await reportStatus();
  }

  // Nothing the user set changed: this update is the integration saving its own
  // iCloud session (a config key outside the schema). Just keep the new object.
  if (sameSettings(previous, config)) {
    updateTrackerConfigs();
    return;
  }

  // Same accounts: the home position, the radius or the poll frequency moved.
  // Re-publish the devices (poll_frequency lives on them) and re-evaluate the
  // presence with the new settings. publishDiscoveredDevices is idempotent.
  logger.info('onConfigUpdated -> new settings applied');
  updateTrackerConfigs();
  await fleet.publishDiscoveredDevices();
  if (fleet.isConnected()) {
    await fleet.refresh({ force: true });
  }
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs the integration's own (re)initialization.
gladys.on('connected', async () => {
  // The SDK emits this event without awaiting it: a rejection escaping here is
  // an unhandled one, and Node takes the whole container down with it. A WebSocket
  // that comes back while iCloud does not answer (Gladys restarted during an
  // internet outage) used to do exactly that, from the "still signed in" path.
  try {
    await initialize();
  } catch (err) {
    logger.error('Initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: `Initialization failed: ${err.message}`,
        fr: `L'initialisation a échoué : ${err.message}`,
        de: `Die Initialisierung ist fehlgeschlagen: ${err.message}`,
        es: `La inicialización ha fallado: ${err.message}`,
      })
      .catch((e) => logger.error('setConnectionStatus failed', e));
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  fleet.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Apple Device Tracker integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
