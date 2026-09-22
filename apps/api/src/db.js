import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  queueLimit: 0,
  namedPlaceholders: true,
  // DECIMAL comes back as a string by default, which is right for money but
  // awkward everywhere else. We convert explicitly at the edges instead.
  decimalNumbers: true,
  dateStrings: false,
});

/** Run a query, return rows. */
export async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Run a query, return the first row or null. */
export async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/** Run a write, return the OkPacket (insertId, affectedRows). */
export async function execute(sql, params) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * throw. `fn` receives the dedicated connection.
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}
