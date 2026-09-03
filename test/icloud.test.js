// -----------------------------------------------------------------------------
// The iCloud client against a scripted Apple: no network, but the real request
// bodies, the real headers and the real status codes Apple answers with.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AuthenticationError,
  ICloudClient,
  LOGIN_STATUS,
  SessionExpiredError,
  TWO_FACTOR_MODE,
} from '../src/icloud/client.js';

const SALT = randomBytes(16).toString('base64');
const SERVER_B = randomBytes(256).toString('base64');

/**
 * A scripted Apple. Each entry matches a URL fragment and returns
 * `{ status, body, headers }`; every call is recorded for the assertions.
 */
function createFakeApple(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    });

    // A key starting with `http` matches the URL exactly (the two-factor info
    // lives at the root of the auth endpoint, a substring of every other auth
    // URL); the others are matched as fragments, first one wins.
    const route =
      routes[url] ??
      routes[Object.keys(routes).find((f) => !f.startsWith('http') && url.includes(f)) ?? ''];
    if (!route) {
      throw new Error(`Unexpected call to ${url}`);
    }
    const { status = 200, body = null, headers = {} } = route;
    return new Response(body === null ? null : JSON.stringify(body), {
      status: status === 204 ? 204 : status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };
  return { calls, fetchImpl, find: (fragment) => calls.filter((c) => c.url.includes(fragment)) };
}

const SIGNIN_INIT = {
  status: 200,
  body: { salt: SALT, b: SERVER_B, c: 'challenge-token', iteration: 20, protocol: 's2k' },
};

// After a 409, the client asks Apple to SEND the code: it reads the two-factor
// info, then pushes to the trusted devices (or sends an SMS). Every scenario
// going through a 409 needs these routes.
const AUTH_INFO_URL = 'https://idmsa.apple.com/appleauth/auth';

const TRUSTED_DEVICE_ROUTES = {
  [AUTH_INFO_URL]: { status: 200, body: { trustedDeviceCount: 2 } },
  '/verify/trusteddevice': { status: 202 },
};

const SMS_ROUTES = {
  [AUTH_INFO_URL]: {
    status: 200,
    body: {
      trustedDeviceCount: 0,
      trustedPhoneNumbers: [{ id: 3, numberWithDialCode: '+33 •• •• •• 42' }],
    },
  },
  '/verify/phone': { status: 200 },
};

const ACCOUNT_LOGIN_OK = {
  status: 200,
  body: {
    dsInfo: { dsid: '1234' },
    webservices: { findme: { url: 'https://p42-fmipweb.icloud.com', status: 'active' } },
  },
};

function createClient(routes, session = {}) {
  const apple = createFakeApple(routes);
  const client = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    session,
    fetchImpl: apple.fetchImpl,
  });
  return { client, apple };
}

test('the sign-in sends a 2048-bit public key and the two Apple SRP protocols', async () => {
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    ...TRUSTED_DEVICE_ROUTES,
  });

  await client.login();

  const [init] = apple.find('/signin/init');
  assert.equal(init.method, 'POST');
  assert.equal(init.body.accountName, 'john@example.com');
  assert.deepEqual(init.body.protocols, ['s2k', 's2k_fo']);
  assert.equal(Buffer.from(init.body.a, 'base64').length, 256);
  assert.equal(init.headers['X-Apple-Widget-Key'].length, 64);
});

test('the password itself is never sent to Apple, only the SRP proof', async () => {
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
  });

  await client.login();

  const serialized = JSON.stringify(apple.calls);
  assert.ok(!serialized.includes('hunter2'), 'the password must never leave the process');

  const [complete] = apple.find('/signin/complete');
  assert.equal(Buffer.from(complete.body.m1, 'base64').length, 32);
  assert.equal(Buffer.from(complete.body.m2, 'base64').length, 32);
  assert.equal(complete.body.c, 'challenge-token');
});

test('a 409 on complete means "two-factor code required"', async () => {
  const { client } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409, headers: { scnt: 'scnt-value' } },
    ...TRUSTED_DEVICE_ROUTES,
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);
  assert.equal(client.isAuthenticated(), false);
  assert.equal(client.scnt, 'scnt-value');
});

test('the 409 is followed by an explicit request to SEND the code', async () => {
  // Apple does not push anything just because the sign-in stopped on a 409:
  // without this call, the user waits for a code that never arrives.
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    ...TRUSTED_DEVICE_ROUTES,
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);

  const [push] = apple.find('/verify/trusteddevice');
  // GET: idmsa.apple.com answers 405 (Allow: GET, POST, OPTIONS) on a PUT, and
  // the code is then never sent.
  assert.equal(push.method, 'GET', 'the code is requested, not just awaited');
  assert.equal(client.twoFactorMode, TWO_FACTOR_MODE.DEVICE);
  assert.match(client.twoFactorTarget.fr, /appareils Apple/);
});

test('an account that only reports hasTrustedDevices still gets the push', async () => {
  // Apple describes the trusted devices with `hasTrustedDevices` on a modern
  // two-factor account, and never sends `trustedDeviceCount`. Reading only the
  // count made the client skip the push and jump to the SMS: the user with an
  // iPhone in front of them received nothing at all.
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    [AUTH_INFO_URL]: {
      status: 200,
      body: {
        hasTrustedDevices: true,
        trustedPhoneNumbers: [{ id: 3, numberWithDialCode: '+33 •• •• •• 42' }],
      },
    },
    '/verify/trusteddevice': { status: 202 },
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);

  assert.equal(apple.find('/verify/phone').length, 0, 'no SMS while a device can be pushed');
  assert.equal(apple.find('/verify/trusteddevice').length, 1);
  assert.equal(client.twoFactorMode, TWO_FACTOR_MODE.DEVICE);
});

test('the SMS can be asked for explicitly, even with trusted devices', async () => {
  const { client } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    [AUTH_INFO_URL]: {
      status: 200,
      body: {
        hasTrustedDevices: true,
        trustedPhoneNumbers: [{ id: 3, numberWithDialCode: '+33 •• •• •• 42' }],
      },
    },
    '/verify/trusteddevice': { status: 202 },
    '/verify/phone': { status: 200 },
  });

  await client.login();
  await client.requestSecurityCode({ preferSms: true });

  assert.equal(client.twoFactorMode, TWO_FACTOR_MODE.SMS);
  assert.equal(client.twoFactorPhoneId, 3);
});

test('the client never sends a method the Apple auth endpoint refuses', async () => {
  // `idmsa.apple.com` allows GET, POST and OPTIONS only: any other verb comes
  // back as a 405, silently, and no code is ever sent.
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    '/securitycode': { status: 204 },
    ...SMS_ROUTES,
    '/2sv/trust': { status: 204, headers: { 'X-Apple-Session-Token': 'session-token' } },
    '/accountLogin': ACCOUNT_LOGIN_OK,
  });

  await client.login();
  await client.submitSecurityCode('123456');

  for (const call of apple.calls.filter((c) => c.url.includes('idmsa.apple.com'))) {
    assert.ok(['GET', 'POST'].includes(call.method), `${call.method} ${call.url} would be a 405`);
  }
});

test('an account with no trusted device gets the code by SMS', async () => {
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    '/securitycode': { status: 204 },
    ...SMS_ROUTES,
    '/2sv/trust': { status: 204, headers: { 'X-Apple-Session-Token': 'session-token' } },
    '/accountLogin': ACCOUNT_LOGIN_OK,
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);

  const [sms] = apple.find('/verify/phone');
  assert.equal(sms.method, 'POST');
  assert.deepEqual(sms.body, { phoneNumber: { id: 3 }, mode: 'sms' });
  assert.equal(client.twoFactorMode, TWO_FACTOR_MODE.SMS);
  assert.match(client.twoFactorTarget.fr, /\+33/);

  // A code received by SMS is validated on the phone endpoint, with the number
  // it was sent to: the trusted-device endpoint would reject it.
  await client.submitSecurityCode('123456');
  const [validation] = apple.find('/verify/phone/securitycode');
  assert.deepEqual(validation.body, {
    phoneNumber: { id: 3 },
    securityCode: { code: '123456' },
    mode: 'sms',
  });
});

test('the two-factor mode survives a restart of the container', async () => {
  // The user enters the code minutes later: the container may have restarted in
  // between, and the SMS mode must be restored from the saved session.
  const saved = [];
  const apple = createFakeApple({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    ...SMS_ROUTES,
  });
  const client = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    fetchImpl: apple.fetchImpl,
    onSessionChange: (session) => saved.push(session),
  });

  await client.login();

  const restored = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    session: saved.at(-1),
    fetchImpl: apple.fetchImpl,
  });
  assert.equal(restored.twoFactorMode, TWO_FACTOR_MODE.SMS);
  assert.equal(restored.twoFactorPhoneId, 3);
});

test('Apple refusing to send the code does not break the sign-in', async () => {
  // The user can still type a code received another way, and use the "send me a
  // new code" action.
  const { client } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    [AUTH_INFO_URL]: { status: 200, body: { trustedDeviceCount: 1 } },
    '/verify/trusteddevice': { status: 412, body: { reason: 'no trusted device' } },
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);
  assert.equal(client.twoFactorTarget, null);
});

test('a wrong password is reported as an authentication error', async () => {
  const { client } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': {
      status: 401,
      body: { serviceErrors: [{ message: 'Your Apple ID or password was incorrect.' }] },
    },
  });

  await assert.rejects(() => client.login(), AuthenticationError);
});

test('a sign-in without two-factor goes straight to the Find My service URL', async () => {
  const { client } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': {
      status: 200,
      headers: {
        'X-Apple-Session-Token': 'session-token',
        'X-Apple-ID-Account-Country': 'FRA',
      },
    },
    '/accountLogin': ACCOUNT_LOGIN_OK,
  });

  assert.equal(await client.login(), LOGIN_STATUS.CONNECTED);
  assert.equal(client.isAuthenticated(), true);
  assert.equal(client.findMyUrl(), 'https://p42-fmipweb.icloud.com');
});

test('submitting the code trusts the session and saves the trust token', async () => {
  const saved = [];
  const apple = createFakeApple({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    '/securitycode': { status: 204 },
    ...TRUSTED_DEVICE_ROUTES,
    '/2sv/trust': {
      status: 204,
      headers: {
        'X-Apple-Twosv-Trust-Token': 'trust-token',
        'X-Apple-Session-Token': 'session-token',
      },
    },
    '/accountLogin': ACCOUNT_LOGIN_OK,
  });
  const client = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    fetchImpl: apple.fetchImpl,
    onSessionChange: (session) => saved.push(session),
  });

  await client.login();
  await client.submitSecurityCode('123 456');

  const [code] = apple.find('/securitycode');
  assert.deepEqual(code.body, { securityCode: { code: '123456' } });
  assert.equal(client.isAuthenticated(), true);
  assert.equal(saved.at(-1).trustToken, 'trust-token');
});

test('a code that is not 6 digits is refused before calling Apple', async () => {
  const { client, apple } = createClient({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    ...TRUSTED_DEVICE_ROUTES,
  });
  await client.login();

  await assert.rejects(() => client.submitSecurityCode('12'), AuthenticationError);
  assert.equal(apple.find('/securitycode').length, 0);
});

test('a saved trust token is replayed so Apple skips the code next time', async () => {
  const { client, apple } = createClient(
    {
      '/signin/init': SIGNIN_INIT,
      '/signin/complete': {
        status: 200,
        headers: { 'X-Apple-Session-Token': 'session-token' },
      },
      '/accountLogin': ACCOUNT_LOGIN_OK,
    },
    { trustToken: 'trust-token' },
  );

  await client.login();

  const [complete] = apple.find('/signin/complete');
  assert.deepEqual(complete.body.trustTokens, ['trust-token']);
});

test('a saved session signs in without touching the password endpoints', async () => {
  const { client, apple } = createClient(
    { '/accountLogin': ACCOUNT_LOGIN_OK },
    { sessionToken: 'session-token', accountCountryCode: 'FRA', trustToken: 'trust-token' },
  );

  assert.equal(await client.login(), LOGIN_STATUS.CONNECTED);
  assert.equal(apple.find('/signin').length, 0, 'no SRP exchange was needed');
});

test('a session Apple no longer accepts falls back to a full sign-in', async () => {
  // First accountLogin answers 450 (stale session), so the client must run the
  // SRP sign-in instead of giving up.
  let accountLoginCalls = 0;
  const apple = createFakeApple({
    '/signin/init': SIGNIN_INIT,
    '/signin/complete': { status: 409 },
    ...TRUSTED_DEVICE_ROUTES,
  });
  const client = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    session: { sessionToken: 'stale-token' },
    fetchImpl: async (url, options) => {
      if (url.includes('/accountLogin')) {
        accountLoginCalls += 1;
        return new Response(null, { status: 450 });
      }
      return apple.fetchImpl(url, options);
    },
  });

  assert.equal(await client.login(), LOGIN_STATUS.TWO_FACTOR_REQUIRED);
  assert.equal(accountLoginCalls, 1);
  assert.equal(apple.find('/signin/init').length, 1, 'a full sign-in was attempted');
});

test('cookies handed out by Apple are sent back on the next call', async () => {
  const { client, apple } = createClient(
    {
      '/accountLogin': {
        ...ACCOUNT_LOGIN_OK,
        headers: { 'Set-Cookie': 'X-APPLE-WEBAUTH-USER="abc"; Path=/; Secure' },
      },
      '/refreshClient': { status: 200, body: { content: [] } },
    },
    { sessionToken: 'session-token' },
  );

  await client.login();
  await client.fetchDevices();

  const [refresh] = apple.find('/refreshClient');
  assert.match(refresh.headers.Cookie, /X-APPLE-WEBAUTH-USER="abc"/);
});

test('fetchDevices returns the Find My content and honors the family flag', async () => {
  const { client, apple } = createClient(
    {
      '/accountLogin': ACCOUNT_LOGIN_OK,
      '/refreshClient': { status: 200, body: { content: [{ id: 'A' }, { id: 'B' }] } },
    },
    { sessionToken: 'session-token' },
  );

  await client.login();
  const devices = await client.fetchDevices({ includeFamily: false });

  assert.equal(devices.length, 2);
  const [refresh] = apple.find('/refreshClient');
  assert.equal(refresh.body.clientContext.fmly, false);
  assert.equal(refresh.body.clientContext.shouldLocate, true);
});

test('an expired session while reading Find My is reported as such', async () => {
  const { client } = createClient(
    {
      '/accountLogin': ACCOUNT_LOGIN_OK,
      '/refreshClient': { status: 450 },
    },
    { sessionToken: 'session-token' },
  );

  await client.login();
  await assert.rejects(() => client.fetchDevices(), SessionExpiredError);
});

test('an account without Find My gets an explicit message', async () => {
  const { client } = createClient(
    {
      '/accountLogin': {
        status: 200,
        body: { webservices: { findme: { url: '', status: 'inactive' } } },
      },
    },
    { sessionToken: 'session-token' },
  );

  await assert.rejects(() => client.login(), /enable Find My/);
});

test('playSound rings the Apple device id, not the Gladys external_id', async () => {
  const { client, apple } = createClient(
    {
      '/accountLogin': ACCOUNT_LOGIN_OK,
      '/playSound': { status: 200, body: {} },
    },
    { sessionToken: 'session-token' },
  );

  await client.login();
  await client.playSound('APPLE-DEVICE-ID');

  const [ring] = apple.find('/playSound');
  assert.equal(ring.body.device, 'APPLE-DEVICE-ID');
});

test('forgetSession clears the tokens and persists the empty session', async () => {
  const saved = [];
  const apple = createFakeApple({ '/accountLogin': ACCOUNT_LOGIN_OK });
  const client = new ICloudClient({
    appleId: 'john@example.com',
    password: 'hunter2',
    session: { sessionToken: 'session-token', trustToken: 'trust-token' },
    fetchImpl: apple.fetchImpl,
    onSessionChange: (session) => saved.push(session),
  });

  await client.login();
  await client.forgetSession();

  assert.equal(client.sessionToken, null);
  assert.equal(client.trustToken, null);
  assert.equal(client.isAuthenticated(), false);
  assert.equal(saved.at(-1).sessionToken, null);
});
