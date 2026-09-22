import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { execute, queryOne } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { asyncHandler, unauthorized, conflict } from '../middleware/errors.js';

const router = express.Router();

const credentials = z.object({
  email: z.string().email().max(190),
  password: z.string().min(8).max(200),
});

const registration = credentials.extend({
  name: z.string().min(2).max(120),
  phone: z.string().min(6).max(32).optional(),
});

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  phone: u.phone,
  role: u.role,
});

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registration.parse(req.body);

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [body.email]);
    if (existing) throw conflict('That email is already registered');

    const hash = await bcrypt.hash(body.password, 10);
    const result = await execute(
      'INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?)',
      [body.email, hash, body.name, body.phone ?? null, 'customer'],
    );

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = credentials.parse(req.body);

    const user = await queryOne('SELECT * FROM users WHERE email = ?', [body.email]);
    // Same message either way, so the endpoint does not confirm which emails exist.
    if (!user) throw unauthorized('Email or password is incorrect');
    if (!user.is_active) throw unauthorized('This account has been deactivated');

    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) throw unauthorized('Email or password is incorrect');

    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        phone: z.string().min(6).max(32).nullable().optional(),
        password: z.string().min(8).max(200).optional(),
      })
      .parse(req.body);

    const sets = [];
    const params = [];
    if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
    if (body.phone !== undefined) { sets.push('phone = ?'); params.push(body.phone); }
    if (body.password !== undefined) {
      sets.push('password_hash = ?');
      params.push(await bcrypt.hash(body.password, 10));
    }
    if (sets.length) {
      params.push(req.user.id);
      await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: publicUser(user) });
  }),
);

export default router;
