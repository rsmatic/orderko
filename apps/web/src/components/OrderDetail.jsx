import { useEffect, useState } from 'react';
import { api, money, dateTime, relativeMinutes } from '../lib/api';
import { Modal, Alert, StatusBadge, DeliveryBadge, PaymentBadge, Spinner, Loading } from './ui';

const NEXT_LABEL = {
  confirmed:  'Confirm order',
  preparing:  'Start preparing',
  ready:      'Mark ready',
  dispatched: 'Hand to driver',
  delivered:  'Mark delivered',
  completed:  'Complete',
  cancelled:  'Cancel order',
};

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

/**
 * Staff view of one order: line items with every chosen option, status
 * controls, payment, and the Grab booking.
 */
export default function OrderDetail({ orderId, onClose, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = () =>
    api.get(`/orders/${orderId}`).then(setOrder).catch((e) => setError(e.message));

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [orderId]);

  // Keep the Grab panel live while a driver is en route.
  useEffect(() => {
    const active = order?.delivery &&
      !['completed', 'cancelled', 'failed', 'returned'].includes(order.delivery.status);
    if (!active) return undefined;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.delivery?.status]);

  async function run(label, fn) {
    setBusy(label);
    setError('');
    try {
      const updated = await fn();
      if (updated) setOrder(updated);
      else await refresh();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const setStatus = (status) => {
    const reason =
      status === 'cancelled'
        ? window.prompt('Why is this being cancelled?') ?? undefined
        : undefined;
    if (status === 'cancelled' && reason === undefined) return;
    run(status, () => api.patch(`/orders/${orderId}/status`, { status, reason }));
  };

  const bookDriver = () =>
    run('book', async () => {
      await api.post(`/delivery/orders/${orderId}/book`);
      return null;
    });

  const cancelDriver = () =>
    run('cancel-driver', async () => {
      const reason = window.prompt('Why cancel the driver?') ?? 'Cancelled by staff';
      await api.post(`/delivery/orders/${orderId}/cancel`, { reason });
      return null;
    });

  const advanceDriver = () =>
    run('advance', async () => {
      await api.post(`/delivery/simulate/${orderId}/advance`);
      return null;
    });

  const setPayment = (payment_status) =>
    run('payment', () => api.patch(`/orders/${orderId}/payment`, { payment_status }));

  if (!order) {
    return (
      <Modal title="Order" onClose={onClose}>
        {error ? <Alert kind="error">{error}</Alert> : <Loading />}
      </Modal>
    );
  }

  const nextStatuses = TRANSITIONS[order.status] ?? [];
  const isDelivery = order.fulfillment_type === 'delivery';
  const d = order.delivery;
  const driverActive = d && !['completed', 'cancelled', 'failed', 'returned'].includes(d.status);

  return (
    <Modal
      title={order.order_number}
      subtitle={`${dateTime(order.created_at)} · ${relativeMinutes(order.created_at)} · ${isDelivery ? 'Grab delivery' : 'Pickup'}`}
      onClose={onClose}
      width="780px"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {nextStatuses
            .filter((s) => s !== 'cancelled')
            .map((s) => (
              <button
                key={s}
                type="button"
                className="btn btn-primary"
                disabled={Boolean(busy)}
                onClick={() => setStatus(s)}
              >
                {busy === s ? <Spinner /> : NEXT_LABEL[s] ?? s}
              </button>
            ))}
          {nextStatuses.includes('cancelled') ? (
            <button
              type="button"
              className="btn btn-berry"
              disabled={Boolean(busy)}
              onClick={() => setStatus('cancelled')}
            >
              Cancel
            </button>
          ) : null}
        </>
      }
    >
      {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

      <div className="row-wrap">
        <StatusBadge status={order.status} />
        <PaymentBadge status={order.payment_status} />
        <span className="pill tiny">{order.payment_method}</span>
        {d ? <DeliveryBadge status={d.status} /> : null}
      </div>

      <section className="card card-pad stack-s">
        <div className="spread">
          <div>
            <div className="strong">{order.contact_name}</div>
            <div className="small muted">{order.contact_phone}</div>
            {order.contact_email ? <div className="tiny faint">{order.contact_email}</div> : null}
          </div>
          <div className="right">
            <div className="tiny faint">Total</div>
            <div className="strong mono" style={{ fontSize: '1.15rem' }}>
              {money(order.total, order.currency)}
            </div>
          </div>
        </div>

        {order.delivery_address ? (
          <div className="small" style={{ paddingTop: '.5rem', borderTop: '1px solid var(--oat-deep)' }}>
            📍 {order.delivery_address}
            {order.delivery_notes ? (
              <div className="tiny muted" style={{ marginTop: '.2rem' }}>{order.delivery_notes}</div>
            ) : null}
          </div>
        ) : null}

        {order.notes ? (
          <div className="alert alert-warn small">Kitchen note: {order.notes}</div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Items</h3></div>
        <div className="panel-body stack">
          {order.items.map((item) => (
            <div key={item.id} className="stack-s" style={{ paddingBottom: '.7rem', borderBottom: '1px solid var(--oat-deep)' }}>
              <div className="spread">
                <span className="strong">{item.quantity}× {item.product_name}</span>
                <span className="mono">{money(item.line_total, order.currency)}</span>
              </div>
              {item.options?.length ? (
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '.2rem' }}>
                  {item.options.map((o, i) => (
                    <div key={i} className="tiny">
                      <span className="faint">{o.group_name}:</span>{' '}
                      <span className="strong">{o.option_name}</span>
                      {Number(o.price_delta) > 0 ? (
                        <span className="faint"> +{money(o.price_delta, order.currency)}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {item.notes ? (
                <div className="tiny" style={{ color: 'var(--berry)', fontStyle: 'italic' }}>
                  “{item.notes}”
                </div>
              ) : null}
            </div>
          ))}

          <div className="totals">
            <div className="totals-row"><span className="muted">Subtotal</span><span className="mono">{money(order.subtotal, order.currency)}</span></div>
            {Number(order.delivery_fee) > 0 ? (
              <div className="totals-row"><span className="muted">Delivery</span><span className="mono">{money(order.delivery_fee, order.currency)}</span></div>
            ) : null}
            <div className="totals-row"><span className="muted">Tax</span><span className="mono">{money(order.tax, order.currency)}</span></div>
            <div className="totals-total"><span>Total</span><span className="mono">{money(order.total, order.currency)}</span></div>
          </div>
        </div>
      </section>

      {isDelivery ? (
        <section className="panel">
          <div className="panel-head">
            <h3>Grab delivery</h3>
            {d ? <DeliveryBadge status={d.status} /> : null}
          </div>
          <div className="panel-body stack">
            {!d ? (
              <>
                <div className="small muted">No driver booked yet.</div>
                <button
                  type="button"
                  className="btn btn-leaf"
                  disabled={Boolean(busy) || order.status === 'cancelled'}
                  onClick={bookDriver}
                >
                  {busy === 'book' ? <Spinner /> : '🚴 Book a Grab driver'}
                </button>
              </>
            ) : (
              <>
                <div className="grid grid-2" style={{ gap: '.6rem' }}>
                  <div>
                    <div className="tiny faint">Booking</div>
                    <div className="small mono">{d.provider_delivery_id}</div>
                  </div>
                  <div>
                    <div className="tiny faint">Fee · distance</div>
                    <div className="small mono">
                      {money(d.fee, d.currency)}{d.distance_km ? ` · ${d.distance_km} km` : ''}
                    </div>
                  </div>
                </div>

                {d.driver_name ? (
                  <div className="driver-card">
                    <div className="driver-avatar" aria-hidden="true">{d.driver_name.slice(0, 1)}</div>
                    <div className="grow">
                      <div className="strong">{d.driver_name}</div>
                      <div className="small muted">{d.driver_plate} · {d.driver_phone}</div>
                    </div>
                    <a className="btn btn-sm" href={`tel:${d.driver_phone}`}>Call</a>
                  </div>
                ) : (
                  <div className="small muted">Waiting for Grab to assign a driver…</div>
                )}

                {d.events?.length ? (
                  <div className="stack-s" style={{ paddingTop: '.5rem', borderTop: '1px solid var(--oat-deep)' }}>
                    {d.events.slice().reverse().map((e, i) => (
                      <div key={i} className="spread tiny">
                        <span className="muted">{e.description ?? e.status}</span>
                        <span className="faint">{dateTime(e.created_at)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {driverActive ? (
                  <div className="row-wrap">
                    <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={refresh}>
                      Refresh
                    </button>
                    <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={advanceDriver}>
                      {busy === 'advance' ? <Spinner /> : '⏩ Advance (mock)'}
                    </button>
                    <button type="button" className="btn btn-sm btn-berry" disabled={Boolean(busy)} onClick={cancelDriver}>
                      Cancel driver
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h3>Payment</h3>
          <PaymentBadge status={order.payment_status} />
        </div>
        <div className="panel-body row-wrap">
          {['unpaid', 'paid', 'refunded']
            .filter((s) => s !== order.payment_status)
            .map((s) => (
              <button
                key={s}
                type="button"
                className="btn btn-sm"
                disabled={Boolean(busy)}
                onClick={() => setPayment(s)}
              >
                Mark {s}
              </button>
            ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h3>History</h3></div>
        <div className="panel-body stack-s">
          {order.history.map((h, i) => (
            <div key={i} className="spread tiny">
              <span>
                <span className="faint">{h.from_status ?? 'new'} → </span>
                <span className="strong">{h.to_status}</span>
                {h.note ? <span className="muted"> · {h.note}</span> : null}
              </span>
              <span className="faint">
                {h.changed_by_name ? `${h.changed_by_name} · ` : ''}{dateTime(h.created_at)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Modal>
  );
}
