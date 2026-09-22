#!/usr/bin/env node
/**
 * Creates the database, applies db/schema.sql and db/seed.sql, then re-hashes
 * the seeded passwords with the value of SEED_PASSWORD.
 *
 *   npm run db:setup           # skips if tables already exist
 *   npm run db:reset           # drops and rebuilds everything
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';

const force = process.argv.includes('--force');
const dbDir = path.join(config.repoRoot, 'db');

async function main() {
  const { database, ...serverOnly } = config.db;

  console.log(`> connecting to mysql://${serverOnly.user}@${serverOnly.host}:${serverOnly.port}`);
  const root = await mysql.createConnection({ ...serverOnly, multipleStatements: true });

  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  console.log(`> database \`${database}\` ready`);
  await root.end();

  const conn = await mysql.createConnection({
    ...config.db,
    multipleStatements: true,
  });

  const [tables] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
    [database],
  );
  if (tables[0].n > 0 && !force) {
    console.log(`> ${tables[0].n} tables already exist — pass --force to rebuild. Nothing to do.`);
    await conn.end();
    return;
  }

  const schema = await fs.readFile(path.join(dbDir, 'schema.sql'), 'utf8');
  await conn.query(schema);
  console.log('> schema applied');

  const seed = await fs.readFile(path.join(dbDir, 'seed.sql'), 'utf8');
  await conn.query(seed);
  console.log('> seed data loaded');

  // The seed file carries a placeholder hash; set the real one here so the
  // documented password always works regardless of how the file was edited.
  const hash = await bcrypt.hash(config.seedPassword, 10);
  const [r] = await conn.query('UPDATE users SET password_hash = ? WHERE email LIKE ?', [
    hash,
    '%@orderko.test',
  ]);
  console.log(`> password set for ${r.affectedRows} seeded accounts`);

  const [counts] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM users)    AS users,
       (SELECT COUNT(*) FROM products) AS products,
       (SELECT COUNT(*) FROM options)  AS options,
       (SELECT COUNT(*) FROM orders)   AS orders`,
  );
  console.log('> row counts:', counts[0]);

  await conn.end();

  console.log('\nDone. Sign in with:');
  console.log(`  admin@orderko.test   / ${config.seedPassword}`);
  console.log(`  manager@orderko.test / ${config.seedPassword}`);
  console.log(`  cust@orderko.test    / ${config.seedPassword}`);
}

main().catch((err) => {
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error(
      `\nMySQL rejected ${config.db.user}@${config.db.host}.\n` +
        'Set DB_USER / DB_PASSWORD in apps/api/.env and try again.',
    );
  } else if (err.code === 'ECONNREFUSED') {
    console.error(
      `\nNothing listening on ${config.db.host}:${config.db.port}. Is MySQL running?`,
    );
  } else {
    console.error('\n', err);
  }
  process.exit(1);
});
