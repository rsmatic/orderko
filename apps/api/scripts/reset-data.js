#!/usr/bin/env node
/**
 * Throws away the JSON store and seeds a fresh one.
 *
 *   npm run data:reset
 *
 * Destructive: every order placed against this store is lost.
 */
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { createJsonStore } from '../src/persistence.js';

const store = createJsonStore({
  file: config.dataFile,
  hashPassword: (plain) => bcrypt.hash(plain, 10),
  seedPassword: config.seedPassword,
});

const state = await store.reset();
await store.flush();

console.log(`Reset ${config.dataFile}`);
console.log(`  ${state.users.length} users, ${state.products.length} products, ` +
            `${state.options.length} options, ${state.orders.length} orders`);
console.log(`\nSign in with ${config.seedPassword === 'Password123!' ? 'Password123!' : 'your SEED_PASSWORD'}:`);
console.log('  admin@orderko.test / manager@orderko.test / cust@orderko.test');
