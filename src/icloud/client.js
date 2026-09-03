// -----------------------------------------------------------------------------
// iCloud "Find My" client.
//
// This is the only file that talks to Apple. It covers the three steps a
// browser goes through on icloud.com:
//
//   1. SRP sign-in on idmsa.apple.com  (src/icloud/srp.js does the maths)
//   2. two-factor validation, then a TRUST token so later restarts do not ask
//      for a new code
//   3. accountLogin on setup.icloud.com, which hands out the per-account
//      service URLs — the one we need is `findme`
//
// Then `fetchDevices()` calls the same `refreshClient` endpoint the Find My web
// app calls, and returns the raw device list.
//
// Apple documents none of this: it is a private API and it can change without
// notice. Everything here is therefore defensive — no field is assumed present,
// and an expired session is detected and replayed rather than crashing the
// integration.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createSrpClient, derivePasswordKey } from './srp.js';

const logger = createLogger({ name: 'icloud' });

const AUTH_ENDPOINT = 'https://idmsa.apple.com/appleauth/auth';
const SETUP_ENDPOINT = 'https://setup.icloud.com/setup/ws/1';
const HOME_ENDPOINT = 'https://www.icloud.com';

// Public key of the iCloud web sign-in widget: not a secret, it is served to
// every browser that opens icloud.com.
const WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';
const CLIENT_BUILD_NUMBER = '2523Project37';
const CLIENT_MASTERING_NUMBER = '2523B41';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const REQUEST_TIMEOUT_MS = 20_000;

/** Sign-in outcomes returned by `login()`. */
export const LOGIN_STATUS = {
  CONNECTED: 'connected',
  TWO_FACTOR_REQUIRED: '2fa_required',
};

/**
 * Where Apple can send the six-digit code. An account with at least one trusted
 * Apple device gets a push; an account whose only second factor is a phone
 * number needs an explicit SMS request (and validates on another endpoint).
 */
export const TWO_FACTOR_MODE = {
  DEVICE: 'device',
  SMS: 'sms',
};

/** Thrown when the saved session is no longer accepted: a full sign-in is due. */
export class SessionExpiredError extends Error {}

/** Thrown when Apple refuses the credentials or the security code. */
export class AuthenticationError extends Error {}

function readErrorMessage(body, status) {
  if (body && typeof body === 'object') {
    const serviceError = Array.isArray(body.serviceErrors) ? body.serviceErrors[0] : null;
    const message =
      serviceError?.message ||
      body.error?.message ||
      (typeof body.error === 'string' ? body.error : null) ||
      body.reason;
    if (message) {
      return message;
    }
  }
  return `HTTP ${status}`;
}

export class ICloudClient {
  /**
   * @param {object} options
   * @param {string} options.appleId account email
   * @param {string} options.password account password
   * @param {object} [options.session] session restored from the Gladys config
   * @param {(session: object) => Promise<void>} [options.onSessionChange] called
   *   whenever the session changes, so the caller can persist it
   * @param {typeof fetch} [options.fetchImpl] injected in tests
   */
  constructor({ appleId, password, session = {}, onSessionChange, fetchImpl = fetch }) {
    this.appleId = appleId;
    this.password = password;
    this.onSessionChange = onSessionChange;
    this.fetchImpl = fetchImpl;

    // Restored session (may be empty on a first run).
    this.clientId = session.clientId || `auth-${randomUUID().toLowerCase()}`;
    this.sessionToken = session.sessionToken || null;
    this.trustToken = session.trustToken || null;
    this.accountCountryCode = session.accountCountryCode || null;
    this.sessionId = session.sessionId || null;
    this.scnt = session.scnt || null;
    this.cookies = new Map(Object.entries(session.cookies || {}));
    this.webservices = session.webservices || {};

    this.awaiting2FA = false;
    // How (and where) Apple sends the code for THIS sign-in. Persisted: the
    // container can restart between the code request and the code entry.
    this.twoFactorMode = session.twoFactorMode || TWO_FACTOR_MODE.DEVICE;
    this.twoFactorPhoneId = session.twoFactorPhoneId ?? null;
    this.twoFactorTarget = session.twoFactorTarget || null;
  }

  /** The part of the state worth persisting between two container restarts. */
  toSession() {
    return {
      clientId: this.clientId,
      sessionToken: this.sessionToken,
      trustToken: this.trustToken,
      accountCountryCode: this.accountCountryCode,
      sessionId: this.sessionId,
      scnt: this.scnt,
      cookies: Object.fromEntries(this.cookies),
      webservices: this.webservices,
      twoFactorMode: this.twoFactorMode,
      twoFactorPhoneId: this.twoFactorPhoneId,
      twoFactorTarget: this.twoFactorTarget,
    };
  }

  async saveSession() {
    if (this.onSessionChange) {
      await this.onSessionChange(this.toSession());
    }
  }

  // --- HTTP plumbing ---------------------------------------------------------

  cookieHeader() {
    if (this.cookies.size === 0) {
      return null;
    }
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  storeCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // An expired cookie is Apple's way of clearing it.
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    const cookie = this.cookieHeader();
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    this.storeCookies(response);

    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  authHeaders() {
    return {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Origin: HOME_ENDPOINT,
      Referer: `${HOME_ENDPOINT}/`,
      'X-Apple-Widget-Key': WIDGET_KEY,
      'X-Apple-OAuth-Client-Id': WIDGET_KEY,
      'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
      'X-Apple-OAuth-Redirect-URI': HOME_ENDPOINT,
      'X-Apple-OAuth-Require-Grant-Code': 'true',
      'X-Apple-OAuth-Response-Mode': 'web_message',
      'X-Apple-OAuth-Response-Type': 'code',
      'X-Apple-OAuth-State': this.clientId,
      ...(this.sessionId ? { 'X-Apple-ID-Session-Id': this.sessionId } : {}),
      ...(this.scnt ? { scnt: this.scnt } : {}),
    };
  }

  // Apple carries the session state in RESPONSE HEADERS, not in the body: every
  // answer of the sign-in flow can refresh one of them, so keep what we get and
  // never overwrite a known value with an empty one.
  rememberAuthHeaders(headers) {
    const fields = {
      sessionToken: 'x-apple-session-token',
      sessionId: 'x-apple-id-session-id',
      scnt: 'scnt',
      accountCountryCode: 'x-apple-id-account-country',
      trustToken: 'x-apple-twosv-trust-token',
    };
    for (const [property, header] of Object.entries(fields)) {
      const value = headers.get(header);
      if (value) {
        this[property] = value;
      }
    }
  }

  // --- Sign-in ---------------------------------------------------------------

  /**
   * Sign in, reusing the saved session when Apple still accepts it.
   * @returns {Promise<string>} one of LOGIN_STATUS
   */
  async login() {
    if (this.sessionToken) {
      try {
        await this.accountLogin();
        logger.info('Signed in to iCloud with the saved session');
        this.awaiting2FA = false;
        return LOGIN_STATUS.CONNECTED;
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) {
          throw err;
        }
        logger.info('The saved iCloud session expired, signing in again');
      }
    }

    const needs2FA = await this.authenticateWithSrp();
    if (needs2FA) {
      this.awaiting2FA = true;
      // Ask Apple to actually SEND the code. Skipping this step is how you wait
      // for a code that never arrives: the 409 alone does not guarantee the
      // push, and an account whose only second factor is a phone number gets
      // nothing at all until an SMS is explicitly requested.
      try {
        await this.requestSecurityCode();
      } catch (err) {
        logger.warn(`Could not ask Apple to send the two-factor code: ${err.message}`);
      }
      await this.saveSession();
      return LOGIN_STATUS.TWO_FACTOR_REQUIRED;
    }

    await this.accountLogin();
    this.awaiting2FA = false;
    return LOGIN_STATUS.CONNECTED;
  }

  /**
   * Run the SRP exchange against idmsa.apple.com.
   * @returns {Promise<boolean>} true when Apple asks for a two-factor code
   */
  async authenticateWithSrp() {
    const srp = createSrpClient({ accountName: this.appleId });

    const init = await this.request(`${AUTH_ENDPOINT}/signin/init`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: {
        a: srp.publicKey.toString('base64'),
        accountName: this.appleId,
        protocols: ['s2k', 's2k_fo'],
      },
    });
    this.rememberAuthHeaders(init.headers);

    if (init.status !== 200 || !init.body) {
      throw new AuthenticationError(
        `iCloud refused the sign-in request: ${readErrorMessage(init.body, init.status)}`,
      );
    }

    const { salt, b, c, iteration, protocol } = init.body;
    if (!salt || !b || !c || !iteration) {
      throw new AuthenticationError('iCloud returned an unexpected sign-in challenge');
    }

    const saltBytes = Buffer.from(salt, 'base64');
    const passwordKey = derivePasswordKey(this.password, saltBytes, iteration, protocol);
    const { proof, expectedServerProof } = srp.computeSession({
      serverPublicKey: Buffer.from(b, 'base64'),
      salt: saltBytes,
      passwordKey,
    });

    const complete = await this.request(
      `${AUTH_ENDPOINT}/signin/complete?isRememberMeEnabled=true`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: {
          accountName: this.appleId,
          c,
          m1: proof.toString('base64'),
          m2: expectedServerProof.toString('base64'),
          rememberMe: true,
          trustTokens: this.trustToken ? [this.trustToken] : [],
        },
      },
    );
    this.rememberAuthHeaders(complete.headers);

    // 409: credentials accepted, Apple now wants the two-factor code.
    if (complete.status === 409) {
      logger.info('iCloud accepted the password and is asking for a two-factor code');
      return true;
    }
    if (complete.status === 401 || complete.status === 403) {
      throw new AuthenticationError(
        `iCloud rejected the Apple ID or the password: ${readErrorMessage(
          complete.body,
          complete.status,
        )}`,
      );
    }
    if (complete.status < 200 || complete.status >= 300) {
      throw new AuthenticationError(
        `iCloud sign-in failed: ${readErrorMessage(complete.body, complete.status)}`,
      );
    }

    return false;
  }

  /**
   * Read the two-factor state Apple keeps for this sign-in attempt: how many
   * trusted devices the account has, and which phone numbers can receive an
   * SMS. Best effort — an unreadable answer just means "assume trusted devices".
   *
   * @returns {Promise<object|null>} the auth info, or null when Apple did not
   * serve one
   */
  async fetchAuthInfo() {
    const response = await this.request(AUTH_ENDPOINT, { headers: this.authHeaders() });
    this.rememberAuthHeaders(response.headers);
    if (response.status < 200 || response.status >= 300 || !response.body) {
      logger.debug(`No two-factor details from Apple (HTTP ${response.status})`);
      return null;
    }
    return response.body;
  }

  /** Push a new code on the trusted Apple devices. @returns {Promise<boolean>} */
  async pushCodeToTrustedDevices() {
    const response = await this.request(`${AUTH_ENDPOINT}/verify/trusteddevice`, {
      method: 'PUT',
      headers: this.authHeaders(),
    });
    this.rememberAuthHeaders(response.headers);

    if (response.status < 200 || response.status >= 300) {
      logger.warn(
        `Apple did not push the code to the trusted devices: ` +
          `${readErrorMessage(response.body, response.status)}`,
      );
      return false;
    }

    this.twoFactorMode = TWO_FACTOR_MODE.DEVICE;
    this.twoFactorPhoneId = null;
    this.twoFactorTarget = {
      en: 'your trusted Apple devices',
      fr: 'vos appareils Apple de confiance',
    };
    logger.info('Apple pushed a two-factor code to the trusted devices');
    return true;
  }

  /** Send a code by SMS to one trusted phone number. @returns {Promise<boolean>} */
  async sendCodeBySms(phone) {
    const response = await this.request(`${AUTH_ENDPOINT}/verify/phone`, {
      method: 'PUT',
      headers: this.authHeaders(),
      body: { phoneNumber: { id: phone.id }, mode: 'sms' },
    });
    this.rememberAuthHeaders(response.headers);

    if (response.status < 200 || response.status >= 300) {
      logger.warn(
        `Apple refused to send the code by SMS: ` +
          `${readErrorMessage(response.body, response.status)}`,
      );
      return false;
    }

    const number = phone.numberWithDialCode || phone.obfuscatedNumber || `#${phone.id}`;
    this.twoFactorMode = TWO_FACTOR_MODE.SMS;
    this.twoFactorPhoneId = phone.id;
    this.twoFactorTarget = { en: `an SMS to ${number}`, fr: `un SMS au ${number}` };
    logger.info(`Apple sent a two-factor code by SMS to ${number}`);
    return true;
  }

  /**
   * Ask Apple to SEND the six-digit code, and remember how: the endpoint that
   * validates the code is not the same for a push and for an SMS.
   *
   * Called right after the 409 of the sign-in, and again by the "resend the
   * code" action.
   *
   * @returns {Promise<{en: string, fr: string}>} where the code was sent
   */
  async requestSecurityCode() {
    const info = await this.fetchAuthInfo();
    const deviceCount = Number(info?.trustedDeviceCount ?? 0);
    const phones = [
      ...(info?.trustedPhoneNumber ? [info.trustedPhoneNumber] : []),
      ...(Array.isArray(info?.trustedPhoneNumbers) ? info.trustedPhoneNumbers : []),
    ].filter((phone) => phone && phone.id !== undefined);

    // The usual case: at least one trusted device (or no details at all, so we
    // assume the usual case). SMS is the fallback, for an account whose only
    // second factor is a phone number.
    if (!info || deviceCount > 0 || phones.length === 0) {
      if (await this.pushCodeToTrustedDevices()) {
        return this.twoFactorTarget;
      }
    }

    for (const phone of phones) {
      if (await this.sendCodeBySms(phone)) {
        return this.twoFactorTarget;
      }
    }

    throw new AuthenticationError(
      'Apple did not send a two-factor code: check that your Apple ID has a ' +
        'trusted device or a trusted phone number',
    );
  }

  /**
   * Send the 6-digit code the user received, then ask Apple to TRUST this
   * session so the next restarts sign in silently.
   */
  async submitSecurityCode(code) {
    const cleanCode = String(code).replace(/\D/g, '');
    if (cleanCode.length !== 6) {
      throw new AuthenticationError('The two-factor code must be 6 digits');
    }

    // A code received by SMS is validated on the phone endpoint: sending it to
    // the trusted-device one gets it rejected even when it is the right code.
    const bySms = this.twoFactorMode === TWO_FACTOR_MODE.SMS && this.twoFactorPhoneId !== null;
    const response = await this.request(
      bySms
        ? `${AUTH_ENDPOINT}/verify/phone/securitycode`
        : `${AUTH_ENDPOINT}/verify/trusteddevice/securitycode`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: bySms
          ? {
              phoneNumber: { id: this.twoFactorPhoneId },
              securityCode: { code: cleanCode },
              mode: 'sms',
            }
          : { securityCode: { code: cleanCode } },
      },
    );
    this.rememberAuthHeaders(response.headers);

    if (response.status < 200 || response.status >= 300) {
      throw new AuthenticationError(
        `iCloud rejected the code: ${readErrorMessage(response.body, response.status)}`,
      );
    }

    const trust = await this.request(`${AUTH_ENDPOINT}/2sv/trust`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    this.rememberAuthHeaders(trust.headers);

    await this.accountLogin();
    this.awaiting2FA = false;
    logger.info('Two-factor validated, this session is now trusted by Apple');
  }

  /**
   * Exchange the session token for the per-account service URLs (`findme`).
   * @throws {SessionExpiredError} when Apple no longer accepts the session
   */
  async accountLogin() {
    if (!this.sessionToken) {
      throw new SessionExpiredError('No iCloud session token');
    }

    const url =
      `${SETUP_ENDPOINT}/accountLogin?clientBuildNumber=${CLIENT_BUILD_NUMBER}` +
      `&clientMasteringNumber=${CLIENT_MASTERING_NUMBER}&clientId=${this.clientId}`;

    const response = await this.request(url, {
      method: 'POST',
      headers: {
        Origin: HOME_ENDPOINT,
        Referer: `${HOME_ENDPOINT}/`,
      },
      body: {
        accountCountryCode: this.accountCountryCode,
        dsWebAuthToken: this.sessionToken,
        extended_login: true,
        trustToken: this.trustToken || '',
      },
    });

    if (response.status === 421 || response.status === 450 || response.status === 500) {
      throw new SessionExpiredError('The iCloud session is no longer valid');
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new AuthenticationError(
        `iCloud sign-in failed: ${readErrorMessage(response.body, response.status)}`,
      );
    }
    if (response.body.hsaChallengeRequired === true) {
      throw new SessionExpiredError('iCloud is asking for a new two-factor code');
    }

    this.webservices = response.body.webservices || {};
    if (!this.findMyUrl()) {
      throw new AuthenticationError(
        'This Apple account has no Find My service: enable Find My in your iCloud settings',
      );
    }

    await this.saveSession();
  }

  findMyUrl() {
    const service = this.webservices?.findme;
    if (!service || service.status === 'inactive' || !service.url) {
      return null;
    }
    return service.url;
  }

  isAuthenticated() {
    return Boolean(this.sessionToken) && Boolean(this.findMyUrl()) && !this.awaiting2FA;
  }

  /** Drop the saved session: the next login() runs a full sign-in. */
  async forgetSession() {
    this.sessionToken = null;
    this.trustToken = null;
    this.sessionId = null;
    this.scnt = null;
    this.cookies.clear();
    this.webservices = {};
    this.awaiting2FA = false;
    this.twoFactorMode = TWO_FACTOR_MODE.DEVICE;
    this.twoFactorPhoneId = null;
    this.twoFactorTarget = null;
    this.clientId = `auth-${randomUUID().toLowerCase()}`;
    await this.saveSession();
  }

  // --- Find My ---------------------------------------------------------------

  // The context the Find My web app sends with every call. `fmly` is the flag
  // that asks Apple to include (or leave out) the devices shared through Family
  // Sharing — that is what the `include_family` setting drives.
  clientContext(includeFamily = true) {
    return {
      appName: 'iCloud Find (Web)',
      appVersion: '2.0',
      timezone: process.env.TZ || 'Europe/Paris',
      inactiveTime: 0,
      apiVersion: '3.0',
      fmly: includeFamily,
      shouldLocate: true,
      selectedDevice: 'all',
      deviceListVersion: 1,
    };
  }

  findMyRequest(path, body) {
    const url =
      `${this.findMyUrl()}/fmipservice/client/web/${path}` +
      `?clientBuildNumber=${CLIENT_BUILD_NUMBER}` +
      `&clientMasteringNumber=${CLIENT_MASTERING_NUMBER}&clientId=${this.clientId}`;
    return this.request(url, {
      method: 'POST',
      headers: {
        Origin: HOME_ENDPOINT,
        Referer: `${HOME_ENDPOINT}/`,
      },
      body,
    });
  }

  /**
   * Ask Find My for the current position of every device of the account.
   * @param {{ includeFamily?: boolean }} [options]
   * @returns {Promise<object[]>} the raw device entries reported by Apple
   */
  async fetchDevices({ includeFamily = true } = {}) {
    if (!this.findMyUrl()) {
      throw new SessionExpiredError('Not signed in to Find My');
    }

    const response = await this.findMyRequest('refreshClient', {
      clientContext: this.clientContext(includeFamily),
    });

    if (response.status === 401 || response.status === 421 || response.status === 450) {
      throw new SessionExpiredError('The iCloud session expired while reading Find My');
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new Error(
        `Find My refused the request: ${readErrorMessage(response.body, response.status)}`,
      );
    }

    return Array.isArray(response.body.content) ? response.body.content : [];
  }

  /** Make one device play the Find My sound. */
  async playSound(deviceId) {
    if (!this.findMyUrl()) {
      throw new SessionExpiredError('Not signed in to Find My');
    }

    const response = await this.findMyRequest('playSound', {
      device: deviceId,
      subject: 'Gladys is looking for this device',
      clientContext: this.clientContext(),
    });

    if (response.status === 401 || response.status === 421 || response.status === 450) {
      throw new SessionExpiredError('The iCloud session expired while ringing the device');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Find My refused to ring the device: ${readErrorMessage(response.body, response.status)}`,
      );
    }
  }
}
