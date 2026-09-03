// -----------------------------------------------------------------------------
// SRP-6a client, the way Apple's identity service (idmsa.apple.com) expects it.
//
// Since 2023 the iCloud web sign-in no longer accepts a plain
// "accountName + password" POST: it runs a SRP-6a exchange, so the password
// itself never leaves the client. The flow is:
//
//   1. the client sends A = g^a mod N          -> POST /signin/init
//   2. Apple answers with the salt, the PBKDF2 iteration count and B
//   3. the client derives the shared secret and proves it with M1
//                                              -> POST /signin/complete
//   4. Apple proves it back with M2 (verified here, so a fake server that
//      does not know the password cannot be trusted)
//
// Group: RFC 5054, 2048-bit, hash SHA-256. Two Apple specifics, both matched
// by the reference clients (pyicloud & co):
//   - the "password" fed to SRP is not the password but a PBKDF2 derivation of
//     its SHA-256 digest (see derivePasswordKey);
//   - x is computed WITHOUT the user name: x = H(salt | H(":" | passwordKey)).
// -----------------------------------------------------------------------------

import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

// RFC 5054, appendix A, 2048-bit group.
export const N_HEX = [
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050',
  'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50',
  'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8',
  '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B',
  'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748',
  '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6',
  'AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6',
  '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',
].join('');

const N = BigInt(`0x${N_HEX}`);
const G = 2n;
// Width used to zero-pad the values that Apple hashes padded (k and u).
const N_WIDTH = N_HEX.length / 2;

function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

/** Big-endian bytes of a positive BigInt, minimal length (OpenSSL BN_bn2bin). */
export function bigIntToBytes(value) {
  if (value === 0n) {
    return Buffer.alloc(0);
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, 'hex');
}

/** Positive BigInt from big-endian bytes. */
export function bytesToBigInt(buffer) {
  if (buffer.length === 0) {
    return 0n;
  }
  return BigInt(`0x${Buffer.from(buffer).toString('hex')}`);
}

function padLeft(buffer, width) {
  if (buffer.length >= width) {
    return Buffer.from(buffer);
  }
  return Buffer.concat([Buffer.alloc(width - buffer.length), buffer]);
}

/** Modular exponentiation: base^exponent mod modulus, on BigInt. */
export function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

// k = H(N | PAD(g)), both padded to the width of N.
const K_MULTIPLIER = bytesToBigInt(sha256(bigIntToBytes(N), padLeft(bigIntToBytes(G), N_WIDTH)));

/**
 * Turn the user password into the byte string Apple actually runs SRP on.
 *
 * @param {string} password the Apple ID password, as typed
 * @param {Buffer} salt salt returned by /signin/init
 * @param {number} iterations PBKDF2 iteration count returned by /signin/init
 * @param {string} protocol 's2k' (digest bytes) or 's2k_fo' (digest as hex text)
 */
export function derivePasswordKey(password, salt, iterations, protocol) {
  let digest = sha256(Buffer.from(password, 'utf8'));
  if (protocol === 's2k_fo') {
    // Same digest, but fed to PBKDF2 as its lowercase hex TEXT.
    digest = Buffer.from(digest.toString('hex'), 'utf8');
  }
  return pbkdf2Sync(digest, salt, iterations, 32, 'sha256');
}

// H(N) XOR H(PAD(g)): the first block hashed into M1.
function hashNXorG() {
  const hashN = sha256(bigIntToBytes(N));
  const hashG = sha256(padLeft(bigIntToBytes(G), N_WIDTH));
  return Buffer.from(hashN.map((byte, index) => byte ^ hashG[index]));
}

/**
 * Create the client side of the exchange.
 *
 * @param {object} options
 * @param {string} options.accountName the Apple ID, hashed into M1
 * @param {Buffer} [options.ephemeralSecret] the private `a` (tests inject it)
 */
export function createSrpClient({ accountName, ephemeralSecret = randomBytes(32) }) {
  const a = bytesToBigInt(ephemeralSecret) % N;
  const A = modPow(G, a, N);
  const aBytes = bigIntToBytes(A);

  return {
    /** Public ephemeral A, zero-padded to the group width, for /signin/init. */
    publicKey: padLeft(aBytes, N_WIDTH),

    /**
     * Derive the session from the server answer.
     *
     * @param {object} params
     * @param {Buffer} params.serverPublicKey B, as returned by /signin/init
     * @param {Buffer} params.salt salt, as returned by /signin/init
     * @param {Buffer} params.passwordKey output of derivePasswordKey()
     * @returns {{ proof: Buffer, expectedServerProof: Buffer, sessionKey: Buffer }}
     */
    computeSession({ serverPublicKey, salt, passwordKey }) {
      const B = bytesToBigInt(serverPublicKey);
      if (B % N === 0n) {
        throw new Error('SRP: the server sent an invalid public key');
      }
      const bBytes = bigIntToBytes(B);

      // u = H(PAD(A) | PAD(B))
      const u = bytesToBigInt(sha256(padLeft(aBytes, N_WIDTH), padLeft(bBytes, N_WIDTH)));
      if (u === 0n) {
        throw new Error('SRP: the server sent an invalid public key');
      }

      // x = H(salt | H(":" | passwordKey)) — Apple hashes no user name in x.
      const inner = sha256(Buffer.concat([Buffer.from(':', 'utf8'), passwordKey]));
      const x = bytesToBigInt(sha256(salt, bigIntToBytes(bytesToBigInt(inner))));

      // S = (B - k * g^x) ^ (a + u * x) mod N
      const base = (((B - K_MULTIPLIER * modPow(G, x, N)) % N) + N) % N;
      const S = modPow(base, a + u * x, N);
      const sessionKey = sha256(bigIntToBytes(S));

      // M1 = H( H(N) XOR H(g) | H(accountName) | salt | A | B | K )
      const proof = sha256(
        hashNXorG(),
        sha256(Buffer.from(accountName, 'utf8')),
        salt,
        aBytes,
        bBytes,
        sessionKey,
      );

      // M2 = H(A | M1 | K): what the server must answer to prove it knows the
      // verifier — checked before we trust anything it says.
      const expectedServerProof = sha256(aBytes, proof, sessionKey);

      return { proof, expectedServerProof, sessionKey };
    },
  };
}
