import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  repoRoot: path.resolve(here, '../../..'),

  // The whole database. Point it at a persistent volume in production —
  // an ephemeral container filesystem loses every order on redeploy.
  dataFile: path.resolve(
    here,
    '../',
    process.env.DATA_FILE || 'data/store.json',
  ),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },

  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  },

  grab: {
    // 'sim' simulates a driver; 'live' talks to Grab's partner API.
    mode: process.env.GRAB_MODE === 'live' ? 'live' : 'sim',
    baseUrl: process.env.GRAB_BASE_URL || 'https://partner-api.stg-myteksi.com/grabexpress',
    authUrl: process.env.GRAB_AUTH_URL || 'https://api.stg-myteksi.com/grabid/v1/oauth2/token',
    clientId: process.env.GRAB_CLIENT_ID || '',
    clientSecret: process.env.GRAB_CLIENT_SECRET || '',
    webhookSecret: process.env.GRAB_WEBHOOK_SECRET || '',
    serviceType: process.env.GRAB_SERVICE_TYPE || 'INSTANT',
    // Seconds between automatic driver-state changes in sim mode; 0 disables
    // it, leaving the Advance button as the only way to move a delivery.
    autoAdvanceSeconds: num(process.env.GRAB_AUTO_ADVANCE_SECONDS, 25),
  },

  seedPassword: process.env.SEED_PASSWORD || 'Password123!',

  // Two weeks of sample orders make the dashboards legible on a first look.
  // Set false for a real shop, so the first order in the book is a real one.
  seedSampleOrders: process.env.SEED_SAMPLE_ORDERS !== 'false',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 4000)}`,
};

if (config.env === 'production') {
  if (config.jwt.secret === 'dev-only-change-me') {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (config.seedPassword === 'Password123!') {
    throw new Error(
      'SEED_PASSWORD is still the documented default, which is public. ' +
        'Set SEED_PASSWORD before running in production.',
    );
  }
}
