import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound, conflict } from '../middleware/errors.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

// -------------------------------------------------------------------- users

router.get(
  '/users',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        role: z.enum(['admin', 'manager', 'customer']).optional(),
        search: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where = [];
    const params = [];
    if (q.role) { where.push('u.role = ?'); params.push(q.role); }
    if (q.search) {
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const users = await query(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.is_active, u.created_at,
              COUNT(o.id) AS order_count,
              COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total ELSE 0 END), 0) AS lifetime_value
         FROM users u
         LEFT JOIN orders o ON o.customer_id = u.id
         ${whereSql}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const { total } = await queryOne(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    res.json({ users, total, limit: q.limit, offset: q.offset });
  }),
);

router.post(
  '/users',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = z
      .object({
        email: z.string().email().max(190),
        password: z.string().min(8).max(200),
        name: z.string().min(2).max(120),
        phone: z.string().min(6).max(32).nullable().optional(),
        role: z.enum(['admin', 'manager', 'customer']),
      })
      .parse(req.body);

    if (await queryOne('SELECT id FROM users WHERE email = ?', [b.email])) {
      throw conflict('That email is already registered');
    }
    const hash = await bcrypt.hash(b.password, 10);
    const r = await execute(
      'INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?)',
      [b.email, hash, b.name, b.phone ?? null, b.role],
    );
    await audit(req.user, 'user.create', 'user', r.insertId, { email: b.email, role: b.role });
    res.status(201).json(
      await queryOne('SELECT id, email, name, phone, role, is_active FROM users WHERE id = ?', [r.insertId]),
    );
  }),
);

router.patch(
  '/users/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = z
      .object({
        name: z.string().min(2).max(120).optional(),
        phone: z.string().min(6).max(32).nullable().optional(),
        role: z.enum(['admin', 'manager', 'customer']).optional(),
        is_active: z.coerce.boolean().optional(),
        password: z.string().min(8).max(200).optional(),
      })
      .parse(req.body);

    const target = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw notFound('User not found');

    // Keep at least one active admin so nobody locks themselves out.
    const losingAdmin =
      target.role === 'admin' && (b.role && b.role !== 'admin' || b.is_active === false);
    if (losingAdmin) {
      const { n } = await queryOne(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?`, [id],
      );
      if (n === 0) throw badRequest('This is the last active admin');
    }

    const sets = [];
    const params = [];
    for (const key of ['name', 'phone', 'role', 'is_active']) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); params.push(b[key]); }
    }
    if (b.password) {
      sets.push('password_hash = ?');
      params.push(await bcrypt.hash(b.password, 10));
    }
    if (!sets.length) throw badRequest('Nothing to update');
    params.push(id);
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    await audit(req.user, 'user.update', 'user', id, { ...b, password: undefined });
    res.json(await queryOne('SELECT id, email, name, phone, role, is_active FROM users WHERE id = ?', [id]));
  }),
);

// ----------------------------------------------------------------- settings

router.get(
  '/settings',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    res.json({
      settings: await getSettings({ fresh: true }),
      grab_mode: config.grab.mode,
    });
  }),
);

router.put(
  '/settings',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = z
      .object({
        shop_name: z.string().min(2).max(120).optional(),
        currency: z.string().length(3).optional(),
        tax_rate: z.coerce.number().min(0).max(1).optional(),
        pickup_address: z.string().min(4).max(500).optional(),
        pickup_lat: z.coerce.number().min(-90).max(90).optional(),
        pickup_lng: z.coerce.number().min(-180).max(180).optional(),
        pickup_phone: z.string().min(6).max(32).optional(),
        min_order_total: z.coerce.number().min(0).max(9999).optional(),
        delivery_enabled: z.coerce.boolean().optional(),
        order_lead_mins: z.coerce.number().int().min(0).max(480).optional(),
      })
      .parse(req.body);

    const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const settings = await setSettings(patch);
    await audit(req.user, 'settings.update', 'settings', null, patch);
    res.json({ settings });
  }),
);

// ------------------------------------------------------------------ reports

/** Headline numbers for the dashboard cards. */
router.get(
  '/stats',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse(req.query.days ?? 30);

    const today = await queryOne(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total ELSE 0 END), 0) AS revenue
         FROM orders WHERE DATE(created_at) = CURDATE()`,
    );
    const period = await queryOne(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total ELSE 0 END), 0) AS revenue,
              COALESCE(AVG(CASE WHEN status <> 'cancelled' THEN total END), 0) AS avg_order_value
         FROM orders WHERE created_at >= NOW() - INTERVAL ? DAY`,
      [days],
    );
    const open = await queryOne(
      `SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('completed','cancelled')`,
    );
    const byStatus = await query(
      `SELECT status, COUNT(*) AS n FROM orders
        WHERE created_at >= NOW() - INTERVAL ? DAY GROUP BY status`,
      [days],
    );
    const daily = await query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total ELSE 0 END), 0) AS revenue
         FROM orders WHERE created_at >= NOW() - INTERVAL ? DAY
        GROUP BY DATE(created_at) ORDER BY day`,
      [days],
    );
    const topProducts = await query(
      `SELECT oi.product_name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= NOW() - INTERVAL ? DAY AND o.status <> 'cancelled'
        GROUP BY oi.product_name ORDER BY qty DESC LIMIT 10`,
      [days],
    );
    const topOptions = await query(
      `SELECT oio.group_name, oio.option_name, COUNT(*) AS picks
         FROM order_item_options oio
         JOIN order_items oi ON oi.id = oio.order_item_id
         JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= NOW() - INTERVAL ? DAY AND o.status <> 'cancelled'
        GROUP BY oio.group_name, oio.option_name
        ORDER BY picks DESC LIMIT 15`,
      [days],
    );
    const fulfillment = await query(
      `SELECT fulfillment_type, COUNT(*) AS n,
              COALESCE(SUM(delivery_fee), 0) AS delivery_fees
         FROM orders WHERE created_at >= NOW() - INTERVAL ? DAY
        GROUP BY fulfillment_type`,
      [days],
    );

    res.json({
      days,
      today,
      period,
      open_orders: open.n,
      by_status: byStatus,
      daily,
      top_products: topProducts,
      top_options: topOptions,
      fulfillment,
    });
  }),
);

router.get(
  '/audit',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit ?? 100);
    const rows = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.created_at,
              u.name AS user_name, u.email AS user_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ${limit}`,
    );
    res.json({ entries: rows });
  }),
);

export default router;
