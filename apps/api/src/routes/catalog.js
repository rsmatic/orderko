import express from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db.js';
import { requireRole, isStaff } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../middleware/errors.js';
import { getSettings, publicSettings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 150);

/**
 * The whole menu in one call: categories, products, and the option groups each
 * product offers. Staff see inactive rows too, so the manager console can edit
 * them without a separate endpoint.
 */
router.get(
  '/menu',
  asyncHandler(async (req, res) => {
    const staff = isStaff(req.user);
    const activeOnly = staff ? '' : 'WHERE is_active = 1';

    const categories = await query(
      `SELECT id, name, slug, sort_order, is_active FROM categories ${activeOnly} ORDER BY sort_order, name`,
    );
    const products = await query(
      `SELECT id, category_id, name, slug, description, base_price, image_url,
              is_active, track_stock, stock_qty, sort_order
         FROM products ${activeOnly} ORDER BY sort_order, name`,
    );
    const groups = await query(
      `SELECT id, name, slug, description, input_type, min_select, max_select,
              is_required, sort_order, is_active
         FROM option_groups ${activeOnly} ORDER BY sort_order, name`,
    );
    const options = await query(
      `SELECT o.id, o.group_id, o.name, o.description, o.price_delta, o.image_url,
              o.is_available, o.track_stock, o.stock_qty, o.sort_order
         FROM options o
         JOIN option_groups g ON g.id = o.group_id
        ${staff ? '' : 'WHERE o.is_available = 1 AND g.is_active = 1'}
        ORDER BY o.sort_order, o.name`,
    );
    const links = await query(
      'SELECT product_id, group_id, sort_order FROM product_option_groups ORDER BY sort_order',
    );

    const optionsByGroup = new Map();
    for (const o of options) {
      if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
      optionsByGroup.get(o.group_id).push(o);
    }
    const groupById = new Map(
      groups.map((g) => [g.id, { ...g, options: optionsByGroup.get(g.id) ?? [] }]),
    );
    const groupsByProduct = new Map();
    for (const l of links) {
      const g = groupById.get(l.group_id);
      if (!g) continue;
      if (!groupsByProduct.has(l.product_id)) groupsByProduct.set(l.product_id, []);
      groupsByProduct.get(l.product_id).push(g);
    }

    res.json({
      settings: publicSettings(await getSettings()),
      categories,
      option_groups: [...groupById.values()],
      products: products.map((p) => ({
        ...p,
        option_groups: groupsByProduct.get(p.id) ?? [],
      })),
    });
  }),
);

// ------------------------------------------------------------------ products

const productBody = z.object({
  category_id: z.coerce.number().int().positive(),
  name: z.string().min(2).max(160),
  slug: z.string().max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
  base_price: z.coerce.number().min(0).max(9999),
  image_url: z.string().url().max(500).nullable().optional().or(z.literal('')),
  is_active: z.coerce.boolean().optional(),
  track_stock: z.coerce.boolean().optional(),
  stock_qty: z.coerce.number().int().min(0).optional(),
  sort_order: z.coerce.number().int().optional(),
  option_group_ids: z.array(z.coerce.number().int().positive()).optional(),
});

router.post(
  '/products',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const b = productBody.parse(req.body);
    const result = await execute(
      `INSERT INTO products (category_id, name, slug, description, base_price, image_url,
                             is_active, track_stock, stock_qty, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.category_id, b.name, b.slug || slugify(b.name), b.description ?? null,
        b.base_price, b.image_url || null, b.is_active ?? true, b.track_stock ?? false,
        b.stock_qty ?? 0, b.sort_order ?? 0,
      ],
    );
    if (b.option_group_ids?.length) {
      await setProductGroups(result.insertId, b.option_group_ids);
    }
    await audit(req.user, 'product.create', 'product', result.insertId, { name: b.name });
    res.status(201).json(await queryOne('SELECT * FROM products WHERE id = ?', [result.insertId]));
  }),
);

router.patch(
  '/products/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await queryOne('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) throw notFound('Product not found');

    const b = productBody.partial().parse(req.body);
    const fields = {
      category_id: b.category_id, name: b.name, slug: b.slug,
      description: b.description, base_price: b.base_price,
      image_url: b.image_url === '' ? null : b.image_url,
      is_active: b.is_active, track_stock: b.track_stock,
      stock_qty: b.stock_qty, sort_order: b.sort_order,
    };
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (sets.length) {
      params.push(id);
      await execute(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    if (b.option_group_ids) await setProductGroups(id, b.option_group_ids);

    await audit(req.user, 'product.update', 'product', id, b);
    res.json(await queryOne('SELECT * FROM products WHERE id = ?', [id]));
  }),
);

router.delete(
  '/products/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const used = await queryOne(
      'SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?', [id],
    );
    if (used.n > 0) {
      // Keep the history intact; hide it from the menu instead.
      await execute('UPDATE products SET is_active = 0 WHERE id = ?', [id]);
      await audit(req.user, 'product.deactivate', 'product', id, { reason: 'has orders' });
      return res.json({ deactivated: true, deleted: false });
    }
    await execute('DELETE FROM products WHERE id = ?', [id]);
    await audit(req.user, 'product.delete', 'product', id);
    res.json({ deactivated: false, deleted: true });
  }),
);

async function setProductGroups(productId, groupIds) {
  await execute('DELETE FROM product_option_groups WHERE product_id = ?', [productId]);
  let i = 0;
  for (const gid of groupIds) {
    await execute(
      'INSERT INTO product_option_groups (product_id, group_id, sort_order) VALUES (?, ?, ?)',
      [productId, gid, i++],
    );
  }
}

// ------------------------------------------------------------- option groups

const groupBody = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().max(120).optional(),
  description: z.string().max(255).nullable().optional(),
  input_type: z.enum(['single', 'multi']),
  min_select: z.coerce.number().int().min(0).max(20).optional(),
  max_select: z.coerce.number().int().min(0).max(20).optional(),
  is_required: z.coerce.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
  is_active: z.coerce.boolean().optional(),
});

router.post(
  '/option-groups',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const b = groupBody.parse(req.body);
    if (b.max_select && b.min_select && b.max_select < b.min_select) {
      throw badRequest('max_select cannot be lower than min_select');
    }
    const result = await execute(
      `INSERT INTO option_groups (name, slug, description, input_type, min_select,
                                  max_select, is_required, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name, b.slug || slugify(b.name), b.description ?? null, b.input_type,
        b.min_select ?? 0, b.max_select ?? 0, b.is_required ?? false,
        b.sort_order ?? 0, b.is_active ?? true,
      ],
    );
    await audit(req.user, 'option_group.create', 'option_group', result.insertId, { name: b.name });
    res.status(201).json(await queryOne('SELECT * FROM option_groups WHERE id = ?', [result.insertId]));
  }),
);

router.patch(
  '/option-groups/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = groupBody.partial().parse(req.body);
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(b)) {
      if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (!sets.length) throw badRequest('Nothing to update');
    params.push(id);
    const r = await execute(`UPDATE option_groups SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) throw notFound('Option group not found');
    await audit(req.user, 'option_group.update', 'option_group', id, b);
    res.json(await queryOne('SELECT * FROM option_groups WHERE id = ?', [id]));
  }),
);

// ------------------------------------------------------------------- options

const optionBody = z.object({
  group_id: z.coerce.number().int().positive(),
  name: z.string().min(1).max(160),
  description: z.string().max(255).nullable().optional(),
  price_delta: z.coerce.number().min(-999).max(999),
  image_url: z.string().url().max(500).nullable().optional().or(z.literal('')),
  is_available: z.coerce.boolean().optional(),
  track_stock: z.coerce.boolean().optional(),
  stock_qty: z.coerce.number().int().min(0).optional(),
  sort_order: z.coerce.number().int().optional(),
});

router.post(
  '/options',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const b = optionBody.parse(req.body);
    const result = await execute(
      `INSERT INTO options (group_id, name, description, price_delta, image_url,
                            is_available, track_stock, stock_qty, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.group_id, b.name, b.description ?? null, b.price_delta, b.image_url || null,
        b.is_available ?? true, b.track_stock ?? false, b.stock_qty ?? 0, b.sort_order ?? 0,
      ],
    );
    await audit(req.user, 'option.create', 'option', result.insertId, { name: b.name });
    res.status(201).json(await queryOne('SELECT * FROM options WHERE id = ?', [result.insertId]));
  }),
);

router.patch(
  '/options/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = optionBody.partial().parse(req.body);
    const patch = { ...b, image_url: b.image_url === '' ? null : b.image_url };
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (!sets.length) throw badRequest('Nothing to update');
    params.push(id);
    const r = await execute(`UPDATE options SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) throw notFound('Option not found');
    await audit(req.user, 'option.update', 'option', id, b);
    res.json(await queryOne('SELECT * FROM options WHERE id = ?', [id]));
  }),
);

router.delete(
  '/options/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const used = await queryOne(
      'SELECT COUNT(*) AS n FROM order_item_options WHERE option_id = ?', [id],
    );
    if (used.n > 0) {
      await execute('UPDATE options SET is_available = 0 WHERE id = ?', [id]);
      await audit(req.user, 'option.deactivate', 'option', id, { reason: 'has orders' });
      return res.json({ deactivated: true, deleted: false });
    }
    await execute('DELETE FROM options WHERE id = ?', [id]);
    await audit(req.user, 'option.delete', 'option', id);
    res.json({ deactivated: false, deleted: true });
  }),
);

// ---------------------------------------------------------------- categories

router.post(
  '/categories',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(2).max(120),
        slug: z.string().max(120).optional(),
        sort_order: z.coerce.number().int().optional(),
        is_active: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    const result = await execute(
      'INSERT INTO categories (name, slug, sort_order, is_active) VALUES (?, ?, ?, ?)',
      [b.name, b.slug || slugify(b.name), b.sort_order ?? 0, b.is_active ?? true],
    );
    await audit(req.user, 'category.create', 'category', result.insertId, { name: b.name });
    res.status(201).json(await queryOne('SELECT * FROM categories WHERE id = ?', [result.insertId]));
  }),
);

router.patch(
  '/categories/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = z
      .object({
        name: z.string().min(2).max(120).optional(),
        sort_order: z.coerce.number().int().optional(),
        is_active: z.coerce.boolean().optional(),
      })
      .parse(req.body);
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(b)) {
      if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (!sets.length) throw badRequest('Nothing to update');
    params.push(id);
    const r = await execute(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) throw notFound('Category not found');
    res.json(await queryOne('SELECT * FROM categories WHERE id = ?', [id]));
  }),
);

export default router;
