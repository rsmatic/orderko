import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createSimulatedDelivery } from '@overnight-oats/core';
import { config } from './config.js';
import { createLiveProvider } from './grab-live.js';

/**
 * Real credentials handling for the server: bcrypt at rest, signed JWTs in
 * flight. The browser demo swaps in a trivial pair, which is why the core
 * takes this as an adapter instead of importing bcrypt itself.
 */
export const auth = {
  hashPassword: (plain) => bcrypt.hash(plain, 10),

  verifyPassword: (plain, hash) =>
    // A stored hash should always be bcrypt; guard anyway so a hand-edited
    // store file cannot turn into an authentication bypass.
    typeof hash === 'string' && hash.startsWith('$2')
      ? bcrypt.compare(plain, hash)
      : Promise.resolve(false),

  signToken: async (user) =>
    jwt.sign(
      { sub: user.id, role: user.role, email: user.email, name: user.name },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn },
    ),

  verifyToken: async (token) => {
    try {
      return jwt.verify(token, config.jwt.secret);
    } catch {
      // Expired or tampered tokens read as "not signed in".
      return null;
    }
  },
};

export function createDelivery() {
  if (config.grab.mode === 'live') return createLiveProvider();
  return createSimulatedDelivery({ publicBaseUrl: config.publicBaseUrl });
}
