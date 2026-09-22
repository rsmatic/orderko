import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { forbidden, unauthorized } from './errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

function readToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Populates req.user when a valid token is present. Never rejects — use
 * `requireAuth` / `requireRole` to actually gate a route.
 */
export async function attachUser(req, res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await queryOne(
      'SELECT id, email, name, phone, role, is_active FROM users WHERE id = ?',
      [payload.sub],
    );
    if (user && user.is_active) req.user = user;
  } catch {
    // An expired or malformed token is treated as "not signed in".
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** requireRole('admin') or requireRole('admin', 'manager') */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

/** Admins and managers can both see every order; customers only see their own. */
export const isStaff = (user) => user?.role === 'admin' || user?.role === 'manager';
