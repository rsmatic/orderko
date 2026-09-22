import express from 'express';
import { z } from 'zod';
import { execute, query, queryOne, transaction } from '../db.js';
import { requireAuth, requireRole, isStaff } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../middleware/errors.js';
import { getSettings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { priceCart, totalsFor, round2 } from '../services/pricing.js';
import { quoteDelivery, getDeliveryForOrder } from '../services/grab/index.js';

const router = express.Router();

/** Which statuses a staff member may move an order into, from each state. */
const TRANSITIONS = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['preparing', 'cancelled'],
  preparing:  ['ready', 'cancelled'],
  ready:      ['dispatched', 'completed', 'cancelled'],
  dispatched: ['delivered', 'cancelled'],
  delivered:  ['completed'],
  completed:  [],
  cancelled:  [],
};

const cartItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(50),
  option_ids: z.array(z.coerce.number().int().positive()).max(30).default([]),
  notes: z.string().max(255).nullable().optional(),
});

const checkoutSchema = z
  .object({
    items: z.array(cartItemSchema).min(1).max(30),
    fulfillment_type: z.enum(['pickup', 'delivery']),
    contact_name: z.string().min(2).max(120),
    contact_phone: z.string().min(6).max(32),
    contact_email: z.string().email().max(190).nullable().optional(),
    delivery_address: z.string().max(500).nullable().optional(),
    delivery_notes: z.string().max(500).nullable().optional(),
    delivery_lat: z.coerce.number().min(-90).max(90).nullable().optional(),
    delivery_lng: z.coerce.number().min(-180).max(180).nullable().optional(),
    payment_method: z.enum(['cash', 'card', 'ewallet']).default('cash'),
    notes: z.string().max(500).nullable().optional(),
    scheduled_for: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      v.fulfillment_type !== 'delivery' ||
      (v.delivery_address && v.delivery_lat != null && v.delivery_lng != null),
    { message: 'Delivery orders need an address with coordinates', path: ['delivery_address'] },
  );

async function nextOrderNumber() {
  const row = await queryOne(
    `SELECT order_number FROM orders WHERE order_number LIKE 'OK-%' ORDER BY id DESC LIMIT 1`,
  );
  const last = row ? Number.parseInt(row.order_number.slice(3), 10) : 240000;
  return `OK-${String((Number.isFinite(last) ? last : 240000) + 1).padStart(6, '0')}`;
}

/** Loads an order with its items, options, history and delivery. */
async function loadOrder(orderId) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;

  const items = await query(
    `SELECT id, product_id, product_name, quantity, unit_base_price,
            unit_options_price, line_total, notes
       FROM order_items WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  const itemIds = items.map((i) => i.id);
  let options = [];
  if (itemIds.length) {
    options = await query(
      `SELECT order_item_id, option_id, group_name, option_name, price_delta
         FROM order_item_options
        WHERE order_item_id IN (${itemIds.map(() => '?').join(',')})
        ORDER BY id`,
      itemIds,
    );
  }
  const optionsByItem = new Map();
  for (const o of options) {
    if (!optionsByItem.has(o.order_item_id)) optionsByItem.set(o.order_item_id, []);
    optionsByItem.get(o.order_item_id).push(o);
  }

  const history = await query(
    `SELECT h.from_status, h.to_status, h.note, h.created_at, u.name AS changed_by_name
       FROM order_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.order_id = ? ORDER BY h.id`,
    [orderId],
  );

  return {
    ...order,
    items: items.map((i) => ({ ...i, options: optionsByItem.get(i.id) ?? [] })),
    history,
    delivery: await getDeliveryForOrder(orderId),
  };
}

function assertCanSee(order, user) {
  if (isStaff(user)) return;
  if (!user || order.customer_id !== user.id) throw forbidden('That is not your order');
}

// ------------------------------------------------------- quote (no side effects)

/** Prices a cart without saving it. Used by the cart drawer and checkout. */
router.post(
  '/quote',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        items: z.array(cartItemSchema).min(1).max(30),
        fulfillment_type: z.enum(['pickup', 'delivery']).default('pickup'),
        delivery_address: z.string().max(500).nullable().optional(),
        delivery_lat: z.coerce.number().nullable().optional(),
        delivery_lng: z.coerce.number().nullable().optional(),
      })
      .parse(req.body);

    const settings = await getSettings();
    const { items, subtotal } = await priceCart(body.items);

    let deliveryQuote = null;
    if (body.fulfillment_type === 'delivery' && body.delivery_lat != null) {
      deliveryQuote = await quoteDelivery({
        address: body.delivery_address,
        lat: body.delivery_lat,
        lng: body.delivery_lng,
      });
    }

    const totals = totalsFor({
      subtotal,
      deliveryFee: deliveryQuote?.fee ?? 0,
      taxRate: settings.tax_rate,
    });

    res.json({
      items,
      ...totals,
      currency: settings.currency,
      delivery_quote: deliveryQuote,
      pickup_address: settings.pickup_address,
      order_lead_mins: Number(settings.order_lead_mins),
      min_order_total: Number(settings.min_order_total),
      meets_minimum: subtotal >= Number(settings.min_order_total),
    });
  }),
);

// ----------------------------------------------------------------- checkout

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = checkoutSchema.parse(req.body);
    const settings = await getSettings();

    if (body.fulfillment_type === 'delivery' && !settings.delivery_enabled) {
      throw badRequest('Delivery is switched off right now');
    }

    const { items, subtotal } = await priceCart(body.items);
    if (subtotal < Number(settings.min_order_total)) {
      throw badRequest(
        `Minimum order is ${settings.currency} ${Number(settings.min_order_total).toFixed(2)}`,
      );
    }

    // The delivery fee is re-quoted server side; the client's number is ignored.
    let deliveryFee = 0;
    if (body.fulfillment_type === 'delivery') {
      const q = await quoteDelivery({
        address: body.delivery_address,
        lat: body.delivery_lat,
        lng: body.delivery_lng,
      });
      deliveryFee = q.fee;
    }

    const totals = totalsFor({ subtotal, deliveryFee, taxRate: settings.tax_rate });
    const orderNumber = await nextOrderNumber();

    const orderId = await transaction(async (conn) => {
      const [orderResult] = await conn.execute(
        `INSERT INTO orders
           (order_number, customer_id, status, fulfillment_type, contact_name, contact_phone,
            contact_email, delivery_address, delivery_notes, delivery_lat, delivery_lng,
            subtotal, delivery_fee, tax, discount, total, currency, payment_method, notes, scheduled_for)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber,
          req.user?.id ?? null,
          body.fulfillment_type,
          body.contact_name,
          body.contact_phone,
          body.contact_email ?? req.user?.email ?? null,
          body.delivery_address ?? null,
          body.delivery_notes ?? null,
          body.delivery_lat ?? null,
          body.delivery_lng ?? null,
          totals.subtotal,
          totals.delivery_fee,
          totals.tax,
          totals.discount,
          totals.total,
          settings.currency,
          body.payment_method,
          body.notes ?? null,
          body.scheduled_for ? new Date(body.scheduled_for) : null,
        ],
      );
      const newId = orderResult.insertId;

      for (const item of items) {
        const [itemResult] = await conn.execute(
          `INSERT INTO order_items
             (order_id, product_id, product_name, quantity, unit_base_price,
              unit_options_price, line_total, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId, item.product_id, item.product_name, item.quantity,
            item.unit_base_price, item.unit_options_price, item.line_total, item.notes,
          ],
        );
        for (const opt of item.options) {
          await conn.execute(
            `INSERT INTO order_item_options
               (order_item_id, option_id, group_name, option_name, price_delta)
             VALUES (?, ?, ?, ?, ?)`,
            [itemResult.insertId, opt.option_id, opt.group_name, opt.option_name, opt.price_delta],
          );
        }

        // Decrement tracked stock inside the same transaction.
        await conn.execute(
          'UPDATE products SET stock_qty = GREATEST(0, stock_qty - ?) WHERE id = ? AND track_stock = 1',
          [item.quantity, item.product_id],
        );
        for (const opt of item.options) {
          if (opt.option_id) {
            await conn.execute(
              'UPDATE options SET stock_qty = GREATEST(0, stock_qty - ?) WHERE id = ? AND track_stock = 1',
              [item.quantity, opt.option_id],
            );
          }
        }
      }

      await conn.execute(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES (?, NULL, 'pending', ?, 'Order placed')`,
        [newId, req.user?.id ?? null],
      );

      return newId;
    });

    await audit(req.user, 'order.create', 'order', orderId, { order_number: orderNumber });
    res.status(201).json(await loadOrder(orderId));
  }),
);

// -------------------------------------------------------------------- listing

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.string().optional(),
        fulfillment_type: z.enum(['pickup', 'delivery']).optional(),
        search: z.string().max(120).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where = [];
    const params = [];

    if (!isStaff(req.user)) {
      where.push('o.customer_id = ?');
      params.push(req.user.id);
    }
    if (q.status) {
      const list = q.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) {
        where.push(`o.status IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }
    if (q.fulfillment_type) { where.push('o.fulfillment_type = ?'); params.push(q.fulfillment_type); }
    if (q.from) { where.push('o.created_at >= ?'); params.push(new Date(q.from)); }
    if (q.to)   { where.push('o.created_at <= ?'); params.push(new Date(q.to)); }
    if (q.search) {
      where.push('(o.order_number LIKE ? OR o.contact_name LIKE ? OR o.contact_phone LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await query(
      `SELECT o.*, u.name AS customer_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              d.status AS delivery_status, d.driver_name, d.tracking_url
         FROM orders o
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN deliveries d ON d.id = (
              SELECT id FROM deliveries dd WHERE dd.order_id = o.id ORDER BY dd.id DESC LIMIT 1)
         ${whereSql}
        ORDER BY o.created_at DESC
        LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const { total } = await queryOne(
      `SELECT COUNT(*) AS total FROM orders o ${whereSql}`,
      params,
    );

    res.json({ orders: rows, total, limit: q.limit, offset: q.offset });
  }),
);

/** Kitchen view: everything not finished, oldest first. */
router.get(
  '/queue',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT o.*, u.name AS customer_name,
              d.status AS delivery_status, d.driver_name, d.driver_phone, d.tracking_url,
              TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) AS age_minutes
         FROM orders o
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN deliveries d ON d.id = (
              SELECT id FROM deliveries dd WHERE dd.order_id = o.id ORDER BY dd.id DESC LIMIT 1)
        WHERE o.status NOT IN ('completed','cancelled')
        ORDER BY o.created_at ASC`,
    );

    const ids = rows.map((r) => r.id);
    let items = [];
    if (ids.length) {
      items = await query(
        `SELECT oi.order_id, oi.id, oi.product_name, oi.quantity, oi.notes,
                GROUP_CONCAT(CONCAT(oio.group_name, ': ', oio.option_name)
                             ORDER BY oio.id SEPARATOR ' | ') AS option_summary
           FROM order_items oi
           LEFT JOIN order_item_options oio ON oio.order_item_id = oi.id
          WHERE oi.order_id IN (${ids.map(() => '?').join(',')})
          GROUP BY oi.id
          ORDER BY oi.id`,
        ids,
      );
    }
    const byOrder = new Map();
    for (const it of items) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }

    res.json({ orders: rows.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] })) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await loadOrder(Number(req.params.id));
    if (!order) throw notFound('Order not found');
    assertCanSee(order, req.user);
    res.json(order);
  }),
);

/** Public order lookup by number + phone, for guests with no account. */
router.get(
  '/track/:orderNumber',
  asyncHandler(async (req, res) => {
    const phone = z.string().min(4).parse(req.query.phone);
    const row = await queryOne(
      'SELECT id FROM orders WHERE order_number = ? AND contact_phone = ?',
      [req.params.orderNumber, phone],
    );
    if (!row) throw notFound('No order matches that number and phone');
    const order = await loadOrder(row.id);
    res.json(order);
  }),
);

// ------------------------------------------------------------ status changes

router.patch(
  '/:id/status',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        status: z.enum([
          'pending', 'confirmed', 'preparing', 'ready',
          'dispatched', 'delivered', 'completed', 'cancelled',
        ]),
        note: z.string().max(255).nullable().optional(),
        reason: z.string().max(255).nullable().optional(),
      })
      .parse(req.body);

    const order = await queryOne('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) throw notFound('Order not found');

    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw badRequest(
        `Cannot move an order from "${order.status}" to "${body.status}"`,
        { allowed },
      );
    }

    await execute(
      'UPDATE orders SET status = ?, cancelled_reason = ? WHERE id = ?',
      [body.status, body.status === 'cancelled' ? body.reason ?? null : null, id],
    );
    await execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES (?, ?, ?, ?, ?)`,
      [id, order.status, body.status, req.user.id, body.note ?? body.reason ?? null],
    );

    await audit(req.user, 'order.status', 'order', id, { from: order.status, to: body.status });
    res.json(await loadOrder(id));
  }),
);

router.patch(
  '/:id/payment',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        payment_status: z.enum(['unpaid', 'paid', 'refunded']),
        payment_method: z.enum(['cash', 'card', 'ewallet']).optional(),
      })
      .parse(req.body);

    const sets = ['payment_status = ?'];
    const params = [body.payment_status];
    if (body.payment_method) { sets.push('payment_method = ?'); params.push(body.payment_method); }
    params.push(id);

    const r = await execute(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!r.affectedRows) throw notFound('Order not found');

    await audit(req.user, 'order.payment', 'order', id, body);
    res.json(await loadOrder(id));
  }),
);

/** A customer may cancel their own order while it is still pending. */
router.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const order = await queryOne('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) throw notFound('Order not found');
    assertCanSee(order, req.user);

    if (!isStaff(req.user) && order.status !== 'pending') {
      throw badRequest('This order is already being prepared — call the shop to cancel');
    }
    if (order.status === 'cancelled') throw badRequest('Already cancelled');

    const reason = z.string().max(255).optional().parse(req.body?.reason);
    await execute(
      `UPDATE orders SET status = 'cancelled', cancelled_reason = ? WHERE id = ?`,
      [reason ?? 'Cancelled by customer', id],
    );
    await execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES (?, ?, 'cancelled', ?, ?)`,
      [id, order.status, req.user.id, reason ?? 'Cancelled by customer'],
    );

    await audit(req.user, 'order.cancel', 'order', id, { reason });
    res.json(await loadOrder(id));
  }),
);

export { loadOrder, round2 };
export default router;
