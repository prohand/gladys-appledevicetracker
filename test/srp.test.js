// -----------------------------------------------------------------------------
// SRP is the one place where a silent, one-character mistake produces a client
// that simply never signs in — and Apple's answer would only say "unauthorized".
// So the exchange is checked here against a SRP-6a server implemented from the
// protocol itself: if the client agrees with it on the session key AND on both
// proofs, the maths (k, u, x, S, K, M1, M2) is right.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import {
  N_HEX,
  bigIntToBytes,
  bytesToBigInt,
  createSrpClient,
  derivePasswordKey,
  modPow,
} from '../src/icloud/srp.js';

const N = BigInt(`0x${N_HEX}`);
const G = 2n;
const WIDTH = N_HEX.length / 2;

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
};
const pad = (buffer) => Buffer.concat([Buffer.alloc(WIDTH - buffer.length), buffer]);

/** The server side of RFC 5054 SRP-6a, with Apple's "no user name in x" rule. */
function createSrpServer({ accountName, passwordKey, salt, ephemeralSecret }) {
  const inner = sha256(Buffer.concat([Buffer.from(':', 'utf8'), passwordKey]));
  const x = bytesToBigInt(sha256(salt, bigIntToBytes(bytesToBigInt(inner))));
  const v = modPow(G, x, N);

  const k = bytesToBigInt(sha256(bigIntToBytes(N), pad(bigIntToBytes(G))));
  const b = bytesToBigInt(ephemeralSecret) % N;
  const B = (k * v + modPow(G, b, N)) % N;

  return {
    publicKey: bigIntToBytes(B),
    session(clientPublicKey) {
      const A = bytesToBigInt(clientPublicKey);
      const u = bytesToBigInt(sha256(pad(bigIntToBytes(A)), pad(bigIntToBytes(B))));
      const S = modPow(A * modPow(v, u, N), b, N);
      const sessionKey = sha256(bigIntToBytes(S));

      const hashN = sha256(bigIntToBytes(N));
      const hashG = sha256(pad(bigIntToBytes(G)));
      const xored = Buffer.from(hashN.map((byte, index) => byte ^ hashG[index]));

      const proof = sha256(
        xored,
        sha256(Buffer.from(accountName, 'utf8')),
        salt,
        bigIntToBytes(A),
        bigIntToBytes(B),
        sessionKey,
      );
      return { sessionKey, proof, serverProof: sha256(bigIntToBytes(A), proof, sessionKey) };
    },
  };
}

test('the client and a reference SRP server agree on the session and both proofs', () => {
  const accountName = 'john@example.com';
  const salt = randomBytes(16);
  const passwordKey = derivePasswordKey('hunter2', salt, 20, 's2k');

  const client = createSrpClient({ accountName, ephemeralSecret: randomBytes(32) });
  const server = createSrpServer({
    accountName,
    passwordKey,
    salt,
    ephemeralSecret: randomBytes(32),
  });

  const clientSession = client.computeSession({
    serverPublicKey: server.publicKey,
    salt,
    passwordKey,
  });
  const serverSession = server.session(client.publicKey);

  assert.deepEqual(clientSession.sessionKey, serverSession.sessionKey, 'same shared secret');
  assert.deepEqual(clientSession.proof, serverSession.proof, 'M1 matches');
  assert.deepEqual(
    clientSession.expectedServerProof,
    serverSession.serverProof,
    'M2 matches, so a fake server can be detected',
  );
});

test('a wrong password never reaches the same session key', () => {
  const accountName = 'john@example.com';
  const salt = randomBytes(16);
  const goodKey = derivePasswordKey('hunter2', salt, 20, 's2k');
  const badKey = derivePasswordKey('hunter3', salt, 20, 's2k');

  const client = createSrpClient({ accountName, ephemeralSecret: randomBytes(32) });
  const server = createSrpServer({
    accountName,
    passwordKey: goodKey,
    salt,
    ephemeralSecret: randomBytes(32),
  });

  const clientSession = client.computeSession({
    serverPublicKey: server.publicKey,
    salt,
    passwordKey: badKey,
  });
  const serverSession = server.session(client.publicKey);

  assert.notDeepEqual(clientSession.proof, serverSession.proof);
});

test('the public key is sent zero-padded to the 2048-bit group width', () => {
  const client = createSrpClient({ accountName: 'a@b.c', ephemeralSecret: randomBytes(32) });
  assert.equal(client.publicKey.length, 256);
});

test('derivePasswordKey applies PBKDF2-SHA256 over the SHA-256 of the password', () => {
  const salt = Buffer.from('some-salt');
  const expected = pbkdf2Sync(sha256(Buffer.from('hunter2')), salt, 1000, 32, 'sha256');
  assert.deepEqual(derivePasswordKey('hunter2', salt, 1000, 's2k'), expected);
});

test('the s2k_fo protocol hashes the digest as hex text, not as bytes', () => {
  const salt = Buffer.from('some-salt');
  const bytes = derivePasswordKey('hunter2', salt, 100, 's2k');
  const hexText = derivePasswordKey('hunter2', salt, 100, 's2k_fo');
  assert.notDeepEqual(bytes, hexText);

  const expected = pbkdf2Sync(
    Buffer.from(sha256(Buffer.from('hunter2')).toString('hex'), 'utf8'),
    salt,
    100,
    32,
    'sha256',
  );
  assert.deepEqual(hexText, expected);
});

test('a server public key that is a multiple of N is refused', () => {
  const client = createSrpClient({ accountName: 'a@b.c', ephemeralSecret: randomBytes(32) });
  assert.throws(
    () =>
      client.computeSession({
        serverPublicKey: bigIntToBytes(N),
        salt: Buffer.alloc(16),
        passwordKey: Buffer.alloc(32),
      }),
    /invalid public key/,
  );
});
