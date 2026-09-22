import { query } from '../db.js';
import { badRequest } from '../middleware/errors.js';

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Re-prices a cart from the database. The client's prices are never trusted —
 * only product ids, option ids and quantities are taken from the request.
 *
 * @param {Array<{product_id:number, quantity:number, option_ids:number[], notes?:string}>} cartItems
 * @returns {Promise<{items:Array, subtotal:number}>}
 */
export async function priceCart(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw badRequest('Cart is empty');
  }

  const productIds = [...new Set(cartItems.map((i) => i.product_id))];
  const optionIds = [...new Set(cartItems.flatMap((i) => i.option_ids ?? []))];

  const products = await query(
    `SELECT id, name, base_price, is_active, track_stock, stock_qty
       FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
    productIds,
  );
  const productById = new Map(products.map((p) => [p.id, p]));

  for (const id of productIds) {
    const p = productById.get(id);
    if (!p) throw badRequest(`Product ${id} does not exist`);
    if (!p.is_active) throw badRequest(`"${p.name}" is not available right now`);
  }

  // Option groups attached to each product, so we can enforce min/max rules.
  const groupLinks = await query(
    `SELECT pog.product_id, g.id AS group_id, g.name AS group_name, g.slug,
            g.input_type, g.min_select, g.max_select, g.is_required
       FROM product_option_groups pog
       JOIN option_groups g ON g.id = pog.group_id
      WHERE pog.product_id IN (${productIds.map(() => '?').join(',')})
        AND g.is_active = 1`,
    productIds,
  );
  const groupsByProduct = new Map();
  for (const g of groupLinks) {
    if (!groupsByProduct.has(g.product_id)) groupsByProduct.set(g.product_id, []);
    groupsByProduct.get(g.product_id).push(g);
  }

  let optionById = new Map();
  if (optionIds.length) {
    const options = await query(
      `SELECT o.id, o.group_id, o.name, o.price_delta, o.is_available,
              o.track_stock, o.stock_qty, g.name AS group_name, g.is_active AS group_active
         FROM options o
         JOIN option_groups g ON g.id = o.group_id
        WHERE o.id IN (${optionIds.map(() => '?').join(',')})`,
      optionIds,
    );
    optionById = new Map(options.map((o) => [o.id, o]));
  }

  const items = [];
  let subtotal = 0;

  for (const raw of cartItems) {
    const product = productById.get(raw.product_id);
    const quantity = Number.parseInt(raw.quantity, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw badRequest(`Quantity for "${product.name}" must be between 1 and 50`);
    }
    if (product.track_stock && product.stock_qty < quantity) {
      throw badRequest(`Only ${product.stock_qty} left of "${product.name}"`);
    }

    const allowedGroups = groupsByProduct.get(product.id) ?? [];
    const allowedGroupIds = new Set(allowedGroups.map((g) => g.group_id));
    const chosen = [];
    const countByGroup = new Map();

    for (const optionId of raw.option_ids ?? []) {
      const opt = optionById.get(optionId);
      if (!opt) throw badRequest(`Option ${optionId} does not exist`);
      if (!opt.is_available || !opt.group_active) {
        throw badRequest(`"${opt.name}" is sold out`);
      }
      if (!allowedGroupIds.has(opt.group_id)) {
        throw badRequest(`"${opt.name}" cannot be added to "${product.name}"`);
      }
      if (opt.track_stock && opt.stock_qty < quantity) {
        throw badRequest(`Not enough "${opt.name}" left`);
      }
      countByGroup.set(opt.group_id, (countByGroup.get(opt.group_id) ?? 0) + 1);
      chosen.push({
        option_id: opt.id,
        group_name: opt.group_name,
        option_name: opt.name,
        price_delta: round2(opt.price_delta),
      });
    }

    for (const g of allowedGroups) {
      const picked = countByGroup.get(g.group_id) ?? 0;
      const min = g.is_required ? Math.max(1, g.min_select) : g.min_select;
      if (picked < min) {
        throw badRequest(
          `"${product.name}": pick at least ${min} from ${g.group_name}`,
        );
      }
      const max = g.input_type === 'single' ? 1 : g.max_select;
      if (max > 0 && picked > max) {
        throw badRequest(
          `"${product.name}": pick at most ${max} from ${g.group_name}`,
        );
      }
    }

    const unitBase = round2(product.base_price);
    const unitOptions = round2(chosen.reduce((sum, o) => sum + o.price_delta, 0));
    const lineTotal = round2((unitBase + unitOptions) * quantity);

    items.push({
      product_id: product.id,
      product_name: product.name,
      quantity,
      unit_base_price: unitBase,
      unit_options_price: unitOptions,
      line_total: lineTotal,
      notes: raw.notes?.slice(0, 255) || null,
      options: chosen,
    });
    subtotal = round2(subtotal + lineTotal);
  }

  return { items, subtotal };
}

/**
 * Applies tax and delivery fee on top of a priced subtotal.
 * Tax is charged on goods only, not on the delivery fee.
 */
export function totalsFor({ subtotal, deliveryFee = 0, taxRate = 0, discount = 0 }) {
  const sub = round2(subtotal);
  const disc = round2(Math.min(discount, sub));
  const fee = round2(deliveryFee);
  const tax = round2((sub - disc) * Number(taxRate));
  return {
    subtotal: sub,
    discount: disc,
    delivery_fee: fee,
    tax,
    total: round2(sub - disc + fee + tax),
  };
}
