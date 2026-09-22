import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  repoRoot: path.resolve(here, '../../..'),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'overnight_oats',
    connectionLimit: num(process.env.DB_POOL, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },

  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  },

  grab: {
    // 'mock' simulates a driver locally; 'live' talks to Grab's partner API.
    mode: process.env.GRAB_MODE || 'mock',
    baseUrl: process.env.GRAB_BASE_URL || 'https://partner-api.stg-myteksi.com/grabexpress',
    authUrl: process.env.GRAB_AUTH_URL || 'https://api.stg-myteksi.com/grabid/v1/oauth2/token',
    clientId: process.env.GRAB_CLIENT_ID || '',
    clientSecret: process.env.GRAB_CLIENT_SECRET || '',
    webhookSecret: process.env.GRAB_WEBHOOK_SECRET || '',
    serviceType: process.env.GRAB_SERVICE_TYPE || 'INSTANT',
    // How fast the mock driver advances through its states, in seconds.
    mockTickSeconds: num(process.env.GRAB_MOCK_TICK_SECONDS, 20),
  },

  seedPassword: process.env.SEED_PASSWORD || 'Password123!',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${num(process.env.PORT, 4000)}`,
};

if (config.env === 'production' && config.jwt.secret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
