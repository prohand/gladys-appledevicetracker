// -----------------------------------------------------------------------------
// The integration's brain: it owns the iCloud client, the device cache and the
// publication to Gladys.
//
// It exists because Gladys polls PER DEVICE while Find My answers for ALL
// devices in one call: polling five iPhones must not mean five calls to Apple
// every cycle. `refresh()` therefore de-duplicates — a call started less than
// half a poll interval ago is reused, and concurrent calls share the same
// in-flight request.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ICloudClient, LOGIN_STATUS, SessionExpiredError } from './icloud/client.js';
import {
  buildDiscoveredDevices,
  buildStates,
  deviceExternalId,
  findAppleDeviceByExternalId,
  normalizeAppleDevices,
} from './devices/index.js';

const logger = createLogger({ name: 'tracker' });

// Never call Apple more often than this, whatever Gladys asks: Find My is rate
// limited on their side, and a fleet of devices all polling at once would hit it.
const MIN_REFRESH_INTERVAL_MS = 30_000;

// The host API accepts up to 100 states per POST /state.
const STATES_PER_BATCH = 100;

export const TRACKER_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTED: 'connected',
  TWO_FACTOR_REQUIRED: '2fa_required',
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

    this.config = null;
    this.client = null;
    this.status = TRACKER_STATUS.DISCONNECTED;

    /** @type {object[]} last devices reported by Find My, normalized */
    this.devices = [];
    /** Presence per Apple device id, feeding the hysteresis. */
    this.presence = new Map();
    /** Last value published per feature, so we only publish what changed. */
    this.lastValues = new Map();

    this.lastRefreshAt = 0;
    this.inflightRefresh = null;
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
    return this.status;
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
    this.config = config;
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
    return this.devices.length;
  }

  /** Drop the saved session, so the next start() runs a full sign-in. */
  async forgetSession() {
    if (this.client) {
      await this.client.forgetSession();
    }
    this.status = TRACKER_STATUS.DISCONNECTED;
    this.devices = [];
    this.presence.clear();
    this.lastValues.clear();
    this.lastRefreshAt = 0;
    this.deviceSignature = null;
  }

  isConnected() {
    return this.status === TRACKER_STATUS.CONNECTED;
  }

  /**
   * Refresh every device from Find My and publish what changed.
   *
   * @param {{ force?: boolean }} [options] force skips the freshness check
   */
  async refresh({ force = false } = {}) {
    if (!this.client || !this.isConnected()) {
      return this.devices;
    }

    // A refresh already running: join it instead of calling Apple twice.
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    const maxAge = Math.max(MIN_REFRESH_INTERVAL_MS, (this.config.poll_frequency * 1000) / 2);
    if (!force && this.now() - this.lastRefreshAt < maxAge) {
      return this.devices;
    }

    this.inflightRefresh = this.doRefresh();
    try {
      return await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  async doRefresh() {
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
    this.lastRefreshAt = this.now();
    logger.info(`Find My returned ${this.devices.length} device(s)`);

    // A device added to (or removed from) the account shows up here: re-publish
    // the catalog first, so the states below always land on an existing device.
    const signature = this.devices.map((device) => device.id).join('|');
    if (signature !== this.deviceSignature) {
      this.deviceSignature = signature;
      await this.publishDiscoveredDevices();
    }

    await this.publishStates();
    return this.devices;
  }

  /** Publish the states of every known device, skipping unchanged values. */
  async publishStates() {
    const states = [];

    for (const device of this.devices) {
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
        if (this.lastValues.get(state.device_feature_external_id) === value) {
          continue; // unchanged: do not spend the state rate limit on it
        }
        this.lastValues.set(state.device_feature_external_id, value);
        states.push(state);
      }
    }

    for (let index = 0; index < states.length; index += STATES_PER_BATCH) {
      await this.gladys.publishStates(states.slice(index, index + STATES_PER_BATCH));
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

  /** External_id of an Apple device, used by the tests and the logs. */
  externalIdOf(device) {
    return deviceExternalId(this.gladys, device.id);
  }
}
