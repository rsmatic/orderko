#!/usr/bin/env node
/**
 * Removes every order, leaving the menu, accounts and settings alone.
 *
 *   npm run orders:clear
 *
 * Use this to start testing from an empty book. `npm run data:reset` is the
 * bigger hammer — it rebuilds the whole store from seed, which also throws
 * away any menu or price changes you have made.
 *
 * Destructive, and there is no undo. Stop the API first: it holds the store in
 * memory and would write it back over this.
 */
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { createJsonStore } from '../src/persistence.js';

const force = process.argv.includes('--force');

// The API caches state in memory and flushes on write, so clearing the file
// underneath a running process just loses the change on its next request.
if (!force) {
  const reachable = await fetch(`http://localhost:${config.port}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (reachable) {
    console.error(
      `\nThe API is running on port ${config.port}.\n\n` +
        'It keeps the store in memory, so clearing the file now would be undone\n' +
        'the next time it writes. Stop it first, clear, then start it again.\n\n' +
        'Pass --force if you are certain nothing is holding the store.',
    );
    process.exit(1);
  }
}

const store = createJsonStore({
  file: config.dataFile,
  hashPassword: (plain) => bcrypt.hash(plain, 10),
  seedPassword: config.seedPassword,
  includeSampleOrders: config.seedSampleOrders,
});

const { seeded } = await store.load();
if (seeded) {
  console.log(`No store existed, so one was created at ${config.dataFile}`);
}

const before = store.getState();
const counts = {
  orders: before.orders.length,
  items: before.orderItems.length,
  deliveries: before.deliveries.length,
};

const removed = await store.clearOrders();
await store.flush();

const after = store.getState();

console.log(`\nCleared ${removed} order${removed === 1 ? '' : 's'} from ${config.dataFile}`);
console.log(`  order lines   ${counts.items} removed`);
console.log(`  deliveries    ${counts.deliveries} removed`);
console.log('  numbering     next order will be OK-240001');
console.log('\nKept:');
console.log(`  ${after.users.length} accounts, ${after.products.length} products, ` +
            `${after.options.length} options, and your shop settings`);
