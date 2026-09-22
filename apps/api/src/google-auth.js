import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError } from '@overnight-oats/core';

/**
 * Verifies a Google ID token.
 *
 * The browser gets the token from Google and posts it here; this checks it is
 * genuinely Google's before anything is trusted. Skipping that would let
 * anyone hand us a hand-written token claiming any address they liked.
 *
 * Node can build a key straight from a JWK, so this needs no library beyond
 * the JWT verifier already in use.
 */

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let keyCache = { keys: new Map(), expiresAt: 0 };

async function fetchKeys() {
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new AppError(502, `Could not reach Google to verify sign-in (${res.status})`);

  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys ?? []) {
    keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }

  // Google's Cache-Control says how long these stay good; default to an hour.
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  keyCache = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

async function keyFor(kid) {
  if (Date.now() < keyCache.expiresAt && keyCache.keys.has(kid)) {
    return keyCache.keys.get(kid);
  }
  // A miss usually means Google rotated its keys, so refetch before giving up.
  const keys = await fetchKeys();
  const key = keys.get(kid);
  if (!key) throw new AppError(401, 'Google sign-in token was signed with an unknown key');
  return key;
}

export const googleAuth = {
  /**
   * @param {string} credential  the ID token from Google Identity Services
   * @param {string} clientId    this shop's OAuth client id
   * @returns {{sub, email, email_verified, name}}
   */
  async verify(credential, clientId) {
    if (!clientId) {
      throw new AppError(400, 'Google sign-in is not configured for this shop');
    }

    const decoded = jwt.decode(credential, { complete: true });
    if (!decoded?.header?.kid) throw new AppError(401, 'That is not a valid Google token');

    const key = await keyFor(decoded.header.kid);

    let claims;
    try {
      claims = jwt.verify(credential, key, {
        algorithms: ['RS256'],
        issuer: ISSUERS,
        // Rejects a token minted for somebody else's app, which is the whole
        // point of checking rather than just decoding.
        audience: clientId,
      });
    } catch (err) {
      throw new AppError(401, `Google sign-in could not be verified: ${err.message}`);
    }

    return {
      sub: claims.sub,
      email: claims.email,
      email_verified: claims.email_verified === true || claims.email_verified === 'true',
      name: claims.name,
    };
  },
};
