// -----------------------------------------------------------------------------
// Several iCloud accounts read side by side.
//
// Apple lets a person belong to ONE family only. Someone already in another
// family (shared for Apple Music, for instance) cannot join the family of the
// main account, so their devices never show up through "Include family
// devices": the only way to read them is their own Apple ID. Hence a second,
// optional account.
//
// Each account gets a full AppleDeviceTracker of its own: its session, its
// two-factor flow, its retries, its backoff and its refresh loop are exactly the
// ones of the single-account integration, untouched. This class only puts
// together what spans the accounts:
//   - the catalog of the Discover tab (each publication replaces it);
//   - which account a Gladys device belongs to (rings, messages, polls);
//   - a device both accounts report: the main account keeps it;
//   - the "devices at home" count of the scene events, and the widgets.
//
// A Gladys device keeps its external_id whichever account reads it: the id is
// derived from the Apple device id, never from the account.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ACCOUNT, ACCOUNTS, sessionKeyOf } from './config.js';
import { buildDiscoveredDevices } from './devices/index.js';
import { AppleDeviceTracker, TRACKER_STATUS } from './tracker.js';

const logger = createLogger({ name: 'fleet' });

export class TrackerFleet {
  /**
   * @param {object} gladys the SDK instance
   * @param {object} [deps] handed to every tracker (injected in tests)
   */
  constructor(gladys, deps = {}) {
    this.gladys = gladys;
    /** `(account, code, error) => Promise`, set by index.js: see TRACKER_HEALTH. */
    this.onHealth = null;

    /** One tracker per account, in priority order (see claimedElsewhere). */
    this.trackers = {};
    for (const account of ACCOUNTS) {
      const tracker = new AppleDeviceTracker(gladys, {
        ...deps,
        sessionKey: sessionKeyOf(account),
        fleet: this,
        logger: createLogger({ name: account === ACCOUNT.MAIN ? 'tracker' : `tracker:${account}` }),
      });
      tracker.onHealth = (code, error) => this.onHealth?.(account, code, error);
      this.trackers[account] = tracker;
    }
  }

  /** The tracker of one account. */
  tracker(account) {
    return this.trackers[account];
  }

  /** Every tracker, main account first. */
  get all() {
    return ACCOUNTS.map((account) => this.trackers[account]);
  }

  get main() {
    return this.trackers[ACCOUNT.MAIN];
  }

  /**
   * The devices of every account, main account first. A device both accounts
   * list (the main one only caught up with it after the second one read it) is
   * kept once, until the next refresh of the second account drops it.
   */
  get devices() {
    const seen = new Set();
    return this.all
      .flatMap((tracker) => tracker.devices)
      .filter((device) => !seen.has(device.id) && seen.add(device.id));
  }

  /**
   * The status the widgets show: connected as soon as one account is (its
   * values are live), else waiting for a code if one account is.
   */
  get status() {
    const statuses = this.all.map((tracker) => tracker.status);
    if (statuses.includes(TRACKER_STATUS.CONNECTED)) {
      return TRACKER_STATUS.CONNECTED;
    }
    if (statuses.includes(TRACKER_STATUS.TWO_FACTOR_REQUIRED)) {
      return TRACKER_STATUS.TWO_FACTOR_REQUIRED;
    }
    return TRACKER_STATUS.DISCONNECTED;
  }

  /** Is at least one account signed in? */
  isConnected() {
    return this.all.some((tracker) => tracker.isConnected());
  }

  /**
   * Does an account listed BEFORE this one already report that Apple device?
   * The same iPhone can be seen through the family of the main account and
   * through its own Apple ID: the main account keeps it.
   *
   * @param {AppleDeviceTracker} tracker the account asking
   * @param {string} appleDeviceId the Apple id of the device
   */
  claimedElsewhere(tracker, appleDeviceId) {
    for (const other of this.all) {
      if (other === tracker) {
        return false;
      }
      if (other.devices.some((device) => device.id === appleDeviceId)) {
        return true;
      }
    }
    return false;
  }

  /** The tracker reading this Gladys device, or null. */
  ownerOf(externalId) {
    return this.all.find((tracker) => tracker.findByExternalId(externalId)) ?? null;
  }

  /** The tracker an Apple device (an object of its `devices`) comes from. */
  ownerOfDevice(device) {
    return this.all.find((tracker) => tracker.devices.includes(device)) ?? this.main;
  }

  /** The Apple device behind a Gladys external_id, whatever the account, or null. */
  findByExternalId(externalId) {
    return this.ownerOf(externalId)?.findByExternalId(externalId) ?? null;
  }

  /** The catalog of the Discover tab: the devices of every account. */
  async publishDiscoveredDevices() {
    const devices = this.devices;
    if (devices.length === 0) {
      return;
    }
    // The settings that shape a device (poll interval, accuracy) are shared:
    // any account's config carries them.
    const config = this.all.find((tracker) => tracker.config)?.config;
    await this.gladys.publishDiscoveredDevices(
      buildDiscoveredDevices(this.gladys, config, devices),
    );
  }

  /** How many of the devices created in Gladys are at home, every account together. */
  devicesAtHome() {
    return this.createdDevices().filter(
      (device) => this.ownerOfDevice(device).presence.get(device.id) === true,
    ).length;
  }

  /** The Apple devices the user created in Gladys, every account together. */
  createdDevices() {
    return this.devices.filter((device) => this.main.isCreated(this.externalIdOf(device)));
  }

  /**
   * Refresh every signed-in account. One account failing does not hide the
   * other's values (each one reports its own health): the error is only given
   * back when no account could be read.
   *
   * @param {{ force?: boolean }} [options] see AppleDeviceTracker.refresh
   */
  async refresh(options = {}) {
    await this.settle(
      this.all.filter((tracker) => tracker.hasClient()),
      (tracker) => tracker.refresh(options),
    );
    return this.devices;
  }

  /** Read Find My now for every signed-in account (widget button, scene action). */
  async refreshNow() {
    const connected = this.all.filter((tracker) => tracker.isConnected());
    if (connected.length === 0) {
      // Not signed in anywhere: the main account words why.
      return this.main.refreshNow();
    }
    await this.settle(connected, (tracker) => tracker.refreshNow());
    return this.devices;
  }

  /**
   * Run one call on each tracker, side by side; reject with the first error
   * only when every call failed.
   */
  async settle(trackers, call) {
    const results = await Promise.allSettled(trackers.map(call));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0 && failures.length === results.length) {
      throw failures[0].reason;
    }
    for (const failure of failures) {
      logger.warn(`One iCloud account could not be read: ${failure.reason?.message}`);
    }
  }

  /** Publish again the states of the devices created in Gladys, every account. */
  async resync() {
    for (const tracker of this.all) {
      if (tracker.hasClient()) {
        await tracker.resync();
      }
    }
  }

  /**
   * A device was created (or updated) in Gladys: the account reading it gives
   * it its values. A device no account knows yet goes to the main one, which
   * asks Apple before giving up — as with a single account.
   */
  async deviceCreated(externalId, options) {
    await (this.ownerOf(externalId) ?? this.main).deviceCreated(externalId, options);
  }

  /** Gladys polls one device: the account reading it answers. */
  async pollDevice(externalId) {
    return (this.ownerOf(externalId) ?? this.main).pollDevice(externalId);
  }

  /** A device was deleted in Gladys: every account forgets it. */
  forgetDevice(externalId) {
    for (const tracker of this.all) {
      tracker.forgetDevice(externalId);
    }
  }

  /** A command from the dashboard or a scene (the ring button). */
  async setFeatureValue(deviceId, featureId) {
    return (this.ownerOf(deviceId) ?? this.main).setFeatureValue(deviceId, featureId);
  }

  /** Make one device play the Find My sound. */
  async ring(externalId) {
    return (this.ownerOf(externalId) ?? this.main).ring(externalId);
  }

  /** Show a message on the screen of one device. */
  async sendMessage(externalId, text, options) {
    return (this.ownerOf(externalId) ?? this.main).sendMessage(externalId, text, options);
  }

  /** Where one Apple device stands, in plain values. */
  summaryOf(device) {
    return this.ownerOfDevice(device).summaryOf(device);
  }

  /** External_id of an Apple device (the same whatever the account). */
  externalIdOf(device) {
    return this.main.externalIdOf(device);
  }

  /** The external_id of one feature of a device, or null (see the tracker). */
  featureIdOf(device, feature) {
    return this.ownerOfDevice(device).featureIdOf(device, feature);
  }

  /**
   * How long ago Find My was last read, in minutes: the OLDEST read among the
   * signed-in accounts, so a widget never looks fresher than its stalest value.
   */
  refreshedMinutesAgo() {
    const ages = this.all
      .filter((tracker) => tracker.isConnected())
      .map((tracker) => tracker.refreshedMinutesAgo())
      .filter((age) => age !== null);
    return ages.length > 0 ? Math.max(...ages) : null;
  }

  /**
   * The user emptied the fields of an account: sign it out, drop its devices
   * from the catalog and its saved session from the config.
   *
   * @param {string} account one of ACCOUNT
   */
  async removeAccount(account) {
    const tracker = this.trackers[account];
    const hadSomething = tracker.hasClient() || tracker.devices.length > 0;
    await tracker.forgetSession();
    // No client: nothing to refresh, ring or ask a code for on this account.
    tracker.client = null;
    if (hadSomething) {
      await this.gladys.setConfig({ [sessionKeyOf(account)]: '' });
      await this.publishDiscoveredDevices();
    }
  }

  /** Stop every timer of every account (shutdown). */
  stop() {
    for (const tracker of this.all) {
      tracker.stop();
    }
  }
}
