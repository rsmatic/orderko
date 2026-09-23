import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createSimulatedDelivery, AppError } from '@overnight-oats/core';
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

/**
 * Picks the delivery provider per call from the shop's current setting, so
 * the mode can be switched from the admin screen instead of by editing a file
 * and restarting.
 *
 * The credentials stay in the environment. A client secret is not something a
 * settings object should hold: that object is written to disk in the clear and
 * parts of it are served to every visitor.
 */
export function createDeliveryRouter(getMode) {
  const sim = createSimulatedDelivery({ publicBaseUrl: config.publicBaseUrl });
  let live = null;

  const hasCredentials = () => Boolean(config.grab.clientId && config.grab.clientSecret);

  function current() {
    if (getMode() !== 'live') return sim;
    // Built on first use, and kept, so its token cache survives.
    if (!live) live = createLiveProvider();
    return live;
  }

  return {
    get name() { return getMode() === 'live' ? 'live' : 'sim'; },

    /**
     * Why the shop cannot switch to `mode`, or null. Checked before the
     * setting is saved — turning on live delivery without credentials would
     * look like it worked and fail at the next checkout.
     */
    whyUnavailable(mode) {
      if (mode !== 'live') return null;
      if (hasCredentials()) return null;
      return 'Live Grab delivery needs GRAB_CLIENT_ID and GRAB_CLIENT_SECRET in '
        + "the API's environment. Add them and restart the API, then switch this on.";
    },

    quote: (...args) => current().quote(...args),
    book: (...args) => current().book(...args),
    track: (...args) => current().track(...args),
    cancel: (...args) => current().cancel(...args),

    advance(...args) {
      const provider = current();
      if (!provider.advance) {
        throw new AppError(400, 'Advancing a driver by hand only works in simulated mode');
      }
      return provider.advance(...args);
    },
  };
}
