import { useState } from 'react';
import { api, money } from '../lib/api';
import { Alert, Field, Spinner } from './ui';
import Customizer from '../routes/customer/Customizer';

/**
 * Lets the shop change what an order contains after it has been placed.
 *
 * The customer rings up and wants another jar, or no walnuts after all. What
 * is sent is only what was chosen — products, options, quantities. Every price
 * comes back from the server, priced off the menu exactly as checkout does, so
 * the totals shown here are a preview and never the source of the charge.
 *
 * Adding a line reuses the customiser the customer used, so an option a
 * product does not allow is as impossible here as it is at the counter.
 */
export default function EditOrderItems({ order, menu, onSaved, onCancel, onError }) {
  // Seeded from the order as placed. option_ids is what the server needs; the
  // labels are carried alongside only so the list stays readable while editing.
  const [lines, setLines] = useState(() => order.items.map((i) => ({
    key: `had-${i.id}`,
    product_id: i.product_id,
    product_name: i.product_name,
    quantity: i.quantity,
    option_ids: (i.options ?? []).map((o) => o.option_id),
    option_labels: (i.options ?? []).map((o) => ({
      group: o.group_name, name: o.option_name, price_delta: Number(o.price_delta),
    })),
    notes: i.notes ?? null,
    // A per-jar price, so changing the quantity moves the preview sensibly.
    // The server re-prices everything on save regardless.
    unit_preview: Number(i.line_total) / Math.max(1, Number(i.quantity)),
  })));
  const [adding, setAdding] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const setQty = (key, next) => setLines((ls) => ls.map((l) => (
    l.key === key ? { ...l, quantity: Math.max(1, Math.min(50, next)) } : l
  )));
  const drop = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  // A preview only. A line added here has no server price yet, so it counts at
  // the customiser's estimate until the save comes back with the real one.
  const preview = lines.reduce((sum, l) => sum + (l.unit_preview ?? 0) * l.quantity, 0);

  async function save() {
    if (!lines.length) { onError('An order needs at least one item. Cancel it instead.'); return; }
    setBusy(true);
    try {
      const updated = await api.put(`/orders/${order.id}/items`, {
        items: lines.map((l) => ({
          product_id: l.product_id,
          quantity: l.quantity,
          option_ids: l.option_ids,
          notes: l.notes,
        })),
        reason: reason.trim() || undefined,
      });
      onSaved(updated);
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Alert kind="info">
        Prices are worked out by the server when you save, so this total is a
        preview. The delivery fee stays as quoted — the distance has not changed.
      </Alert>

      {lines.map((l) => (
        <div key={l.key} className="edit-line">
          <div className="grow">
            <div className="strong">{l.product_name}</div>
            {l.option_labels?.length ? (
              <div className="tiny faint">
                {l.option_labels.map((o) => o.name).join(' · ')}
              </div>
            ) : null}
            {l.notes ? (
              <div className="tiny" style={{ color: 'var(--berry)', fontStyle: 'italic' }}>
                “{l.notes}”
              </div>
            ) : null}
          </div>

          <div className="qty">
            <button type="button" className="btn btn-sm" onClick={() => setQty(l.key, l.quantity - 1)}>−</button>
            <span className="mono strong">{l.quantity}</span>
            <button type="button" className="btn btn-sm" onClick={() => setQty(l.key, l.quantity + 1)}>+</button>
          </div>

          <button type="button" className="btn btn-sm btn-berry" onClick={() => drop(l.key)}>
            Remove
          </button>
        </div>
      ))}

      <div className="row-wrap">
        <select
          className="select"
          style={{ maxWidth: 260 }}
          value=""
          onChange={(e) => {
            const p = menu?.products?.find((x) => String(x.id) === e.target.value);
            if (p) setAdding(p);
          }}
        >
          <option value="">+ Add an item…</option>
          {(menu?.products ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <Field label="Why? (optional)" hint="Kept on the order so the change can be explained later.">
        <input
          className="input"
          maxLength={120}
          placeholder="e.g. customer rang to add an item"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>

      <div className="totals">
        <div className="totals-row">
          <span className="muted">Items (preview)</span>
          <span className="mono">{money(preview, order.currency)}</span>
        </div>
        {Number(order.delivery_fee) > 0 ? (
          <div className="totals-row">
            <span className="muted">Delivery (unchanged)</span>
            <span className="mono">{money(order.delivery_fee, order.currency)}</span>
          </div>
        ) : null}
      </div>

      {order.payment_status === 'paid' ? (
        <Alert kind="warn">
          This order is marked paid. If the new total is higher it goes back to
          unpaid, so the difference is not lost.
        </Alert>
      ) : null}

      <div className="row-wrap">
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : 'Save changes'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>

      {adding ? (
        <Customizer
          product={adding}
          onClose={() => setAdding(null)}
          onAdd={(item) => {
            setLines((ls) => [...ls, { ...item, key: `new-${Date.now()}` }]);
            setAdding(null);
          }}
        />
      ) : null}
    </div>
  );
}
