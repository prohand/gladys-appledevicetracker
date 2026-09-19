// -----------------------------------------------------------------------------
// The integration's brain: it owns the iCloud client, the device cache and the
// publication to Gladys.
//
// It exists because Gladys polls PER DEVICE while Find My answers for ALL
// devices in one call: polling five iPhones must not mean five calls to Apple
// every cycle. `refresh()` therefore de-duplicates — a call younger than the
// configured interval is reused, and concurrent calls share the same in-flight
// request. That cache is also what makes the configured interval real: Gladys
// cannot tick slower than once a minute, so a 300 s setting means four ticks
// out of five are answered from memory.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ICloudClient, LOGIN_STATUS, SessionExpiredError } from './icloud/client.js';
import {
  FEATURE,
  buildDiscoveredDevices,
  buildStates,
  deviceExternalId,
  featureExternalId,
  findAppleDeviceByExternalId,
  normalizeAppleDevices,
} from './devices/index.js';

const logger = createLogger({ name: 'tracker' });

// Never call Apple more often than this, whatever Gladys asks: Find My is rate
// limited on their side, and a fleet of devices all polling at once would hit it.
const MIN_REFRESH_INTERVAL_MS = 30_000;

// Gladys ticks at most once a minute (its poll_frequency enum stops there), so
// the configured interval is enforced HERE: a tick landing a few seconds early
// must still refresh, otherwise a 300 s interval would drift to 360 s.
const POLL_TOLERANCE_MS = 5_000;

// The host API accepts up to 100 states per POST /state.
const STATES_PER_BATCH = 100;

// Gladys marks a value as outdated when nothing has been published for it for a
// while (48 h by default, less if the user lowered the setting) and then shows
// "no recent value" instead of the value. A device that does not move publishes
// nothing — same position, same battery — so every value is re-published at
// least this often, even unchanged, to keep it alive on the dashboard.
const STATE_HEARTBEAT_MS = 30 * 60 * 1000;

// How many refreshes in a row must fail before the Configuration screen says
// the integration is broken. Apple answers 503 now and then, and a single miss
// is invisible to the user (the next tick fixes it): only a streak means the
// values on the dashboard have really stopped moving.
const UNHEALTHY_AFTER_FAILURES = 3;

// A dashboard is considered stale when nothing has been refreshed for three
// intervals — never less than this, so a 60 s interval does not raise an alarm
// on a two-minute hiccup.
const STALE_MIN_MS = 15 * 60 * 1000;

export const TRACKER_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTED: 'connected',
  TWO_FACTOR_REQUIRED: '2fa_required',
};

/**
 * Is the integration still doing its job — i.e. still updating the values?
 *
 * The iCloud session is the part that breaks in real life: Apple invalidates it
 * after a while, and when the trust token has expired too it asks for a NEW
 * two-factor code. The tracker then leaves the CONNECTED state, every later
 * refresh returns immediately, and the dashboard keeps showing the last values
 * for ever — with the Configuration screen still green, since nothing ever told
 * Gladys otherwise. These codes are that missing channel: the tracker reports
 * them and index.js turns them into the connection status the user sees.
 */
export const TRACKER_HEALTH = {
  OK: 'ok',
  TWO_FACTOR_REQUIRED: '2fa_required',
  UNREACHABLE: 'unreachable',
  STALE: 'stale',
};

export class AppleDeviceTracker {
  /**
   * @param {object} gladys the SDK instance
   * @param {{ createClient?: Function, now?: () => number }} [deps] injected in tests
   */
  constructor(gladys, deps = {}) {
    this.gladys = gladys;
    this.createClient = deps.createClient ?? ((options) => new ICloudClient(options));
    this.now = deps.now ?? (() => Date.now());
    /** `(code, error) => Promise`, set by index.js: see TRACKER_HEALTH. */
    this.onHealth = deps.onHealth ?? null;

    this.config = null;
    this.client = null;
    this.status = TRACKER_STATUS.DISCONNECTED;

    /** @type {object[]} last devices reported by Find My, normalized */
    this.devices = [];
    /** Presence per Apple device id, feeding the hysteresis. */
    this.presence = new Map();
    /** Last position Apple gave us per device id (see keepLastKnownLocations). */
    this.lastLocations = new Map();
    /** Last battery level Apple gave us per device id (see keepLastKnownBattery). */
    this.lastBatteries = new Map();
    /** `{ value, publishedAt }` per feature, so we only publish what changed. */
    this.lastValues = new Map();
    /** Apple device ids whose states must be published again, unchanged or not. */
    this.pendingFullPublish = new Set();
    /** Gladys external_ids already polled, to spot a device the user just created. */
    this.polledDevices = new Set();

    this.lastRefreshAt = 0;
    this.inflightRefresh = null;
    /** Last health reported, so the same news is not pushed on every tick. */
    this.health = null;
    /** Refreshes that failed in a row (see UNHEALTHY_AFTER_FAILURES). */
    this.failedRefreshes = 0;
    /** Handle of the integration's own refresh loop (see startPolling). */
    this.pollTimer = null;
    /** Signature of the device list, to re-publish only when it changes. */
    this.deviceSignature = null;
  }

  /** Sign in to iCloud, then publish the devices when it worked. */
  async start(config) {
    this.config = config;

    let session = {};
    if (config.icloud_session) {
      try {
        session = JSON.parse(config.icloud_session);
      } catch {
        logger.warn('The saved iCloud session is unreadable, signing in from scratch');
      }
    }

    this.client = this.createClient({
      appleId: config.apple_id,
      password: config.apple_password,
      session,
      onSessionChange: (updated) => this.saveSession(updated),
    });

    const result = await this.client.login();
    if (result === LOGIN_STATUS.TWO_FACTOR_REQUIRED) {
      this.status = TRACKER_STATUS.TWO_FACTOR_REQUIRED;
      return this.status;
    }

    this.status = TRACKER_STATUS.CONNECTED;
    await this.refresh({ force: true });
    this.startPolling();
    return this.status;
  }

  /**
   * The integration's OWN refresh loop.
   *
   * Gladys polls the devices it has created, and that used to be the only clock
   * here — so nothing was ever refreshed while no device existed yet, and a
   * Gladys that stops polling (a device the user never created, a scheduler
   * that skipped it) meant a dashboard frozen forever. The loop below is that
   * clock: `refresh()` still de-duplicates, so a tick landing on top of a
   * Gladys poll costs nothing.
   */
  startPolling() {
    this.stopPolling();
    const interval = Math.max(MIN_REFRESH_INTERVAL_MS, this.config.poll_frequency * 1000);
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => logger.error('Scheduled refresh failed', err));
    }, interval);
    // A timer must never be the reason the process stays alive.
    this.pollTimer.unref?.();
  }

  /**
   * One tick of that loop: refresh, and check the dashboard is still alive.
   *
   * The staleness check is the safety net under every reason a refresh can stop
   * happening — a session Apple will not renew without a new code, a Find My
   * that has been failing for an hour, a refresh that never came back. Values
   * that stopped being updated must never be a silent state: the user is told,
   * in the Configuration screen, instead of being left to notice on their own
   * that their phone has been "at home" since Tuesday.
   */
  async tick() {
    // Only when nothing more precise has been reported: a refresh that already
    // said "Apple wants a new code" must not have its message replaced by a
    // vaguer one on the next tick.
    const unnoticed = this.health === null || this.health === TRACKER_HEALTH.OK;
    const staleAfter = Math.max(STALE_MIN_MS, 3 * this.config.poll_frequency * 1000);
    if (unnoticed && this.lastRefreshAt > 0 && this.now() - this.lastRefreshAt > staleAfter) {
      await this.reportHealth(TRACKER_HEALTH.STALE);
    }
    await this.refresh();
  }

  /**
   * Report a change of health to the caller (index.js owns setConnectionStatus).
   *
   * Only a CHANGE is reported: the loop ticks every `poll_frequency` seconds and
   * Gladys has no use for the same "still broken" message every minute. Errors
   * raised by the report itself are swallowed on purpose — failing to TELL the
   * user about a problem must not become a second problem.
   *
   * @param {string} code one of TRACKER_HEALTH
   * @param {Error|null} [error] what went wrong, for the logs
   */
  async reportHealth(code, error = null) {
    if (code === this.health) {
      return;
    }
    this.health = code;
    if (!this.onHealth) {
      return;
    }
    try {
      await this.onHealth(code, error);
    } catch (err) {
      logger.error('Reporting the integration health failed', err);
    }
  }

  /** Stop the refresh loop (sign-out, or before re-arming it). */
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Persist the iCloud session in the integration config (key outside the schema). */
  async saveSession(session) {
    const serialized = JSON.stringify(session);
    if (this.config) {
      this.config.icloud_session = serialized;
    }
    await this.gladys.setConfig({ icloud_session: serialized });
  }

  /** Apply a config change that does not require signing in again. */
  updateConfig(config) {
    const previousFrequency = this.config?.poll_frequency;
    this.config = config;
    // The user moved the interval: the loop must tick at the new pace.
    if (this.pollTimer && previousFrequency !== config.poll_frequency) {
      this.startPolling();
    }
  }

  /** True once a sign-in has been attempted: the client can talk to Apple. */
  hasClient() {
    return this.client !== null;
  }

  /** Where Apple sent the two-factor code, to tell the user where to look. */
  get twoFactorTarget() {
    return this.client?.twoFactorTarget ?? null;
  }

  /** Why Apple sent nothing, when it did not. */
  get twoFactorError() {
    return this.client?.twoFactorError ?? null;
  }

  /**
   * Ask Apple to send the two-factor code again.
   * @param {{ preferSms?: boolean }} [options] force the SMS route
   */
  async requestSecurityCode(options = {}) {
    if (!this.client) {
      throw new Error('Not signed in to iCloud yet');
    }
    const target = await this.client.requestSecurityCode(options);
    // The mode (and the phone id) drive the endpoint validating the code: keep
    // them across a restart of the container.
    await this.client.saveSession();
    return target;
  }

  /** Validate the two-factor code the user typed in the Configuration screen. */
  async submitSecurityCode(code) {
    if (!this.client) {
      throw new Error('Not signed in to iCloud yet');
    }
    await this.client.submitSecurityCode(code);
    this.status = TRACKER_STATUS.CONNECTED;
    await this.refresh({ force: true });
    this.startPolling();
    return this.devices.length;
  }

  /** Drop the saved session, so the next start() runs a full sign-in. */
  async forgetSession() {
    this.stopPolling();
    if (this.client) {
      await this.client.forgetSession();
    }
    this.status = TRACKER_STATUS.DISCONNECTED;
    this.devices = [];
    this.presence.clear();
    this.lastLocations.clear();
    this.lastBatteries.clear();
    this.lastValues.clear();
    this.pendingFullPublish.clear();
    this.polledDevices.clear();
    this.lastRefreshAt = 0;
    this.deviceSignature = null;
    this.health = null;
    this.failedRefreshes = 0;
  }

  isConnected() {
    return this.status === TRACKER_STATUS.CONNECTED;
  }

  /**
   * The user just created one of the discovered devices in Gladys: give it its
   * values NOW.
   *
   * Discovered devices only become real devices when the user adds them, and
   * the host API silently drops the states of a feature that does not exist
   * yet: everything published before that add is lost, and the dedup in
   * `publishStates` would then keep quiet until a value moves — the device
   * would sit on the dashboard with no value at all for hours. So its states
   * are published again, from the cache when it is still fresh.
   *
   * Called both from the `device-created` event (immediate) and from the first
   * poll of a device (the catch-up path, for a creation we did not hear about:
   * container restarted, WebSocket down at that moment).
   *
   * @param {string} externalId the Gladys external_id of the created device
   * @param {{ force?: boolean }} [options] `force` republishes even for a device
   *   already known: the `device-created` event is the user creating it AGAIN
   *   (deleted then re-added, which is how a device picks up a change in its
   *   feature list), and its brand-new features hold no value at all. Without
   *   it, the guard below took that event for a duplicate and the device stayed
   *   empty on the dashboard until a value moved — up to half an hour.
   */
  async deviceCreated(externalId, { force = false } = {}) {
    if (!externalId || (!force && this.polledDevices.has(externalId))) {
      return;
    }
    this.polledDevices.add(externalId);

    let device = this.findByExternalId(externalId);
    if (!device && this.isConnected()) {
      // Gladys knows a device our cache does not: ask Apple before giving up.
      await this.refresh({ force: true });
      device = this.findByExternalId(externalId);
    }
    if (!device) {
      logger.warn(`Device ${externalId} is not in the Find My list: no state to publish`);
      return;
    }

    this.pendingFullPublish.add(device.id);
    await this.publishStates();
  }

  /**
   * The user deleted one of our devices in Gladys: forget everything we knew
   * about it.
   *
   * Its features are gone, so the values remembered for them are stale — and
   * they are exactly what would make a device created again under the same
   * external_id look "already published" to the dedup below.
   *
   * @param {string} externalId the Gladys external_id of the deleted device
   */
  forgetDevice(externalId) {
    if (!externalId) {
      return;
    }
    this.polledDevices.delete(externalId);
    for (const key of this.lastValues.keys()) {
      // Feature external_ids are the device one, plus the feature key.
      if (key === externalId || key.startsWith(`${externalId}:`)) {
        this.lastValues.delete(key);
      }
    }
  }

  /**
   * Publish the states of every device the user has ALREADY created in Gladys,
   * unchanged or not.
   *
   * Runs on each (re)connection to Gladys: a device created while the container
   * was down (or while the WebSocket was) never triggered `deviceCreated`, and
   * the values published before it existed were dropped by the host. The SDK
   * keeps the list of real devices up to date (`gladys.devices`, refreshed on
   * every reconnection), so it tells us exactly which ones to serve.
   */
  async resync() {
    const known = Array.isArray(this.gladys.devices) ? this.gladys.devices : [];
    for (const gladysDevice of known) {
      const device = this.findByExternalId(gladysDevice.external_id);
      if (device) {
        this.polledDevices.add(gladysDevice.external_id);
        this.pendingFullPublish.add(device.id);
      }
    }
    await this.publishStates();
  }

  /**
   * Gladys polls ONE device: refresh like any other tick, but treat the first
   * poll of a device as the moment the user created it in Gladys.
   *
   * @param {string} externalId the Gladys external_id of the polled device
   */
  async pollDevice(externalId) {
    await this.deviceCreated(externalId);
    return this.refresh();
  }

  /**
   * Refresh every device from Find My and publish what changed.
   *
   * @param {{ force?: boolean }} [options] force skips the freshness check
   */
  async refresh({ force = false } = {}) {
    if (!this.client || !this.isConnected()) {
      // Nothing will be refreshed in this state and the values are about to go
      // stale: report it rather than tick in silence for ever.
      if (this.status === TRACKER_STATUS.TWO_FACTOR_REQUIRED) {
        await this.reportHealth(TRACKER_HEALTH.TWO_FACTOR_REQUIRED);
      }
      return this.devices;
    }

    // A refresh already running: join it instead of calling Apple twice.
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    const maxAge = Math.max(
      MIN_REFRESH_INTERVAL_MS,
      this.config.poll_frequency * 1000 - POLL_TOLERANCE_MS,
    );
    if (!force && this.now() - this.lastRefreshAt < maxAge) {
      return this.devices;
    }

    this.inflightRefresh = this.doRefresh();
    try {
      const devices = await this.inflightRefresh;
      this.failedRefreshes = 0;
      await this.reportHealth(TRACKER_HEALTH.OK);
      return devices;
    } catch (err) {
      this.failedRefreshes += 1;
      if (this.status === TRACKER_STATUS.TWO_FACTOR_REQUIRED) {
        // Apple wants a new code: no amount of retrying will fix this one, only
        // the user can, so the Configuration screen has to say it.
        await this.reportHealth(TRACKER_HEALTH.TWO_FACTOR_REQUIRED, err);
      } else if (this.failedRefreshes >= UNHEALTHY_AFTER_FAILURES) {
        await this.reportHealth(TRACKER_HEALTH.UNREACHABLE, err);
      }
      throw err;
    } finally {
      this.inflightRefresh = null;
    }
  }

  async doRefresh() {
    // Measured BEFORE calling Apple, not after: the refresh loop ticks every
    // `poll_frequency` seconds from the tick, so a call that takes a few
    // seconds used to push `lastRefreshAt` past the next tick — that tick was
    // then judged "too early" and skipped, and a 60 s interval updated the
    // values every 120 s.
    const startedAt = this.now();
    let rawDevices;
    try {
      rawDevices = await this.client.fetchDevices({ includeFamily: this.config.include_family });
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) {
        throw err;
      }
      // Expired session: sign in again once, then retry.
      logger.info('The iCloud session expired, signing in again');
      const result = await this.client.login();
      if (result === LOGIN_STATUS.TWO_FACTOR_REQUIRED) {
        this.status = TRACKER_STATUS.TWO_FACTOR_REQUIRED;
        throw new Error('iCloud is asking for a new two-factor code', { cause: err });
      }
      rawDevices = await this.client.fetchDevices({ includeFamily: this.config.include_family });
    }

    this.devices = normalizeAppleDevices(rawDevices);
    this.keepLastKnownLocations();
    this.keepLastKnownBattery();
    // Only on success: a failed call must not hold the next tick back.
    this.lastRefreshAt = startedAt;
    logger.info(`Find My returned ${this.devices.length} device(s)`);

    // A device added to (or removed from) the account shows up here: re-publish
    // the catalog first, so the states below always land on an existing device.
    //
    // The battery feature is part of the signature, not just the ids: it is only
    // declared for a device that reports a battery, so a phone discovered while
    // Apple could not reach it would otherwise keep a catalog entry with no
    // battery row until the account itself changed.
    const signature = this.devices
      .map((device) => `${device.id}/${device.batteryLevel !== null}`)
      .join('|');
    if (signature !== this.deviceSignature) {
      this.deviceSignature = signature;
      await this.publishDiscoveredDevices();
    }

    await this.publishStates();
    return this.devices;
  }

  /**
   * Carry the last known position over to a refresh that carries none.
   *
   * Apple drops `location` from the payload of a device it could not reach on
   * that cycle (asleep, no network, still being located). Publishing nothing
   * for it makes Gladys show "no recent value" on every position feature a few
   * hours later, when the device has simply not moved. Find My itself shows the
   * last known position in that case — so do we, and `Position age` keeps
   * growing since it is computed from Apple's own timestamp.
   */
  keepLastKnownLocations() {
    for (const device of this.devices) {
      if (device.location) {
        this.lastLocations.set(device.id, device.location);
      } else {
        const known = this.lastLocations.get(device.id);
        if (known) {
          device.location = known;
        }
      }
    }
  }

  /**
   * Carry the last known battery over to a refresh that carries none.
   *
   * Same story as the positions: Apple reports no battery for a device it could
   * not reach on that cycle, and the normalization reads the bogus 0% of that
   * payload as "unknown" rather than publishing it. Without this, a phone that
   * goes offline for a while stops publishing its battery altogether, Gladys
   * shows "no recent value" on a battery that has simply not been read again,
   * and the battery features come and go from the catalog on every round trip.
   *
   * Find My itself shows the last battery it knew in that case, so do we.
   */
  keepLastKnownBattery() {
    for (const device of this.devices) {
      if (device.batteryLevel === null) {
        device.batteryLevel = this.lastBatteries.get(device.id) ?? null;
      }
      this.lastBatteries.set(device.id, device.batteryLevel);
    }
  }

  /**
   * Publish the states of every known device.
   *
   * An unchanged value is normally skipped — the host API rate-limits states —
   * but not forever: past STATE_HEARTBEAT_MS it is published again so Gladys
   * keeps considering it recent, and a device flagged by `pollDevice` is
   * published in full straight away.
   */
  async publishStates() {
    const states = [];
    const republished = [];
    const now = this.now();

    for (const device of this.devices) {
      // The user just created this device in Gladys: it missed everything
      // published before, so send it the whole picture.
      const republishAll = this.pendingFullPublish.has(device.id);
      if (republishAll) {
        republished.push(device.id);
      }
      const wasPresent = this.presence.has(device.id) ? this.presence.get(device.id) : null;
      const result = buildStates(this.gladys, this.config, device, wasPresent);

      if (result.ignored) {
        logger.debug(`${device.name}: position ignored (too vague or missing)`);
      }
      if (result.presence !== null) {
        if (result.presence !== wasPresent) {
          logger.info(`${device.name} is now ${result.presence ? 'at home' : 'away'}`);
        }
        this.presence.set(device.id, result.presence);
      }

      for (const state of result.states) {
        const value = state.state ?? state.text;
        const last = this.lastValues.get(state.device_feature_external_id);
        const unchanged = last !== undefined && last.value === value;
        if (!republishAll && unchanged && now - last.publishedAt < STATE_HEARTBEAT_MS) {
          continue; // unchanged and still recent for Gladys: not worth a state
        }
        states.push(state);
      }
    }

    for (let index = 0; index < states.length; index += STATES_PER_BATCH) {
      const batch = states.slice(index, index + STATES_PER_BATCH);
      await this.gladys.publishStates(batch);
      // Remembered as published only once Gladys has ACCEPTED them. They used
      // to be recorded before the call: a POST that failed (the 300 states per
      // minute limit of the host API, a core restarting) was remembered as sent
      // all the same, and the dedup above then skipped those values until they
      // moved again — a feature that does not move, like a battery, stayed
      // empty for half an hour.
      for (const state of batch) {
        this.lastValues.set(state.device_feature_external_id, {
          value: state.state ?? state.text,
          publishedAt: now,
        });
      }
    }
    // Same reason: the "this device missed everything" flag is only cleared
    // once the whole picture really went through.
    for (const id of republished) {
      this.pendingFullPublish.delete(id);
    }
    return states;
  }

  /** The discovery payload for the devices currently known. */
  buildDiscoveredDevices() {
    return buildDiscoveredDevices(this.gladys, this.config, this.devices);
  }

  /** Publish the discovered devices to Gladys. */
  async publishDiscoveredDevices() {
    if (this.devices.length === 0) {
      return;
    }
    await this.gladys.publishDiscoveredDevices(this.buildDiscoveredDevices());
  }

  /** The Apple device behind a Gladys external_id, or null. */
  findByExternalId(externalId) {
    return findAppleDeviceByExternalId(this.gladys, this.devices, externalId);
  }

  /** Make one device play the Find My sound (the `identify` action). */
  async ring(externalId) {
    const device = this.findByExternalId(externalId);
    if (!device) {
      throw new Error('This device is not in the Find My list any more');
    }
    await this.client.playSound(device.id);
    return device;
  }

  /**
   * A command sent from the dashboard or a scene (`onSetValue`).
   *
   * Every measurement of a device is read-only: the one writable feature is the
   * ring button, so anything else is refused rather than silently ignored (a
   * rejected handler is acked as failed, and the user sees it).
   *
   * The button is a push button: a press is a press, so the value it carries is
   * not read — and nothing is published back, the feature holds no state.
   *
   * @param {string} deviceId the Gladys external_id of the targeted device
   * @param {string} featureId the Gladys external_id of the actioned feature
   * @returns {Promise<object>} the Apple device that was made to ring
   */
  async setFeatureValue(deviceId, featureId) {
    const device = this.findByExternalId(deviceId);
    if (!device) {
      throw new Error('This device is not in the Find My list any more');
    }
    if (featureId !== this.ringFeatureOf(device)) {
      throw new Error(`The feature ${featureId} is read-only`);
    }

    await this.client.playSound(device.id);
    return device;
  }

  /** External_id of the ring button of an Apple device. */
  ringFeatureOf(device) {
    return featureExternalId(this.gladys, device.id, FEATURE.RING);
  }

  /** External_id of an Apple device, used by the tests and the logs. */
  externalIdOf(device) {
    return deviceExternalId(this.gladys, device.id);
  }
}
