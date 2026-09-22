/**
 * Demo mode: the same backend, running in the browser.
 *
 * The rules, routes and seed data all come from @overnight-oats/core — the
 * identical code the server runs. Only the adapters differ: localStorage
 * instead of a file, and throwaway credentials instead of bcrypt and JWT.
 *
 * That last substitution is why this is demo-only. Passwords are compared in
 * plaintext and tokens are not signed, which is acceptable for disposable
 * per-visitor data and would not be anywhere else.
 */

import {
  createBackend, freshState, createSimulatedDelivery, SEED_PASSWORD,
} from '@overnight-oats/core';

const STORAGE_KEY = 'oats.demo.state.v2';

let backend = null;
let state = null;

/** Plaintext, deliberately: see the note above. */
const demoAuth = {
  hashPassword: async (plain) => `demo:${plain}`,
  verifyPassword: async (plain, stored) => stored === `demo:${plain}`,
  signToken: async (user) => `demo.${user.id}.${Math.random().toString(36).slice(2)}`,
  verifyToken: async (token) => {
    const id = Number(String(token).split('.')[1]);
    return Number.isInteger(id) ? { sub: id } : null;
  },
};

function persist(next) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode — the demo still works for this page view.
  }
}

async function ensure() {
  if (backend) return backend;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // A seed change invalidates stored state rather than half-migrating it.
    state = parsed?.seq && Array.isArray(parsed.products) ? parsed : null;
  } catch {
    state = null;
  }

  if (!state) {
    state = await freshState({ hashPassword: demoAuth.hashPassword, seedPassword: SEED_PASSWORD });
    persist(state);
  }

  backend = createBackend({
    state,
    persist,
    auth: demoAuth,
    delivery: createSimulatedDelivery({ publicBaseUrl: '' }),
  });
  return backend;
}

/** Wipes demo data back to the seeded catalog and order history. */
export async function resetDemo() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode */ }
  backend = null;
  state = null;
}

/**
 * Mirrors fetch's contract closely enough that the app cannot tell the
 * difference, with a little latency so loading states still get exercised.
 */
export async function demoRequest(method, path, body, token) {
  const api = await ensure();
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
  // The HTTP layer cares about the status; in the browser only the body matters.
  const { body: result } = await api.handle(method, path, body, token);
  return result;
}

export { SEED_PASSWORD };
