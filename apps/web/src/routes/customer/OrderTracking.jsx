import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, money, dateTime } from '../../lib/api';
import { Loading, Alert, StatusBadge, DeliveryBadge, Empty } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import GcashPanel from '../../components/GcashPanel';

// 'ewallet' and 'card' say nothing to a customer on their own; what they want
// to know is when the money changes hands.
const PAYMENT_LABEL = {
  cash: 'Cash',
  card: 'Card',
  ewallet: 'E-wallet',
  gcash: 'GCash',
};

const STEPS = [
  { key: 'pending',    label: 'Order received',   note: 'We have your order' },
  { key: 'confirmed',  label: 'Confirmed',        note: 'The kitchen has it' },
  { key: 'preparing',  label: 'Building your jar', note: 'Layering it up' },
  { key: 'ready',      label: 'Ready',            note: 'Packed and chilled' },
  { key: 'dispatched', label: 'On the way',       note: 'With a Grab driver' },
  { key: 'delivered',  label: 'Delivered',        note: 'Enjoy' },
];

const ORDER = ['pending', 'confirmed', 'preparing', 'ready', 'dispatched', 'delivered', 'completed'];

export default function OrderTracking() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const justPlaced = location.state?.justPlaced;

  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  /**
   * Signed-in customers read the order straight off its id. A guest has no
   * account for the server to match against, so we fall back to the public
   * order-number + phone lookup kept from checkout.
   */
  const load = useCallback(
    async (signal) => {
      try {
        setOrder(await api.get(`/orders/${id}`, { signal }));
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (err.status !== 401 && err.status !== 403) { setError(err.message); return; }
      }

      let guest = null;
      try { guest = JSON.parse(sessionStorage.getItem(`oats.guest.${id}`) ?? 'null'); } catch { /* ignore */ }
      if (!guest) {
        setError('Sign in to view this order, or look it up with your order number and phone.');
        return;
      }

      try {
        const params = new URLSearchParams({ phone: guest.phone });
        setOrder(await api.get(`/orders/track/${guest.order_number}?${params}`, { signal }));
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Poll while the order is still moving; stop once it settles.
  useEffect(() => {
    if (!order) return undefined;
    if (order.status === 'completed' || order.status === 'cancelled') return undefined;
    const t = setInterval(() => load(), 12_000);
    return () => clearInterval(t);
  }, [order, load]);

  if (error) {
    return (
      <div className="container" style={{ padding: '2.5rem 0' }}>
        <Alert kind="error">{error}</Alert>
        <Link to="/" className="btn" style={{ marginTop: '1rem' }}>Back to the menu</Link>
      </div>
    );
  }
  if (!order) return <Loading label="Finding your order…" />;

  const cancelled = order.status === 'cancelled';
  const currentIndex = ORDER.indexOf(order.status);
  const steps = order.fulfillment_type === 'delivery'
    ? STEPS
    : STEPS.filter((s) => s.key !== 'dispatched' && s.key !== 'delivered');
  const driver = order.delivery;

  async function cancel() {
    if (!window.confirm('Cancel this order?')) return;
    try {
      setOrder(await api.post(`/orders/${order.id}/cancel`, { reason: 'Changed my mind' }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="container" style={{ padding: '1.75rem 0 4rem', maxWidth: 760 }}>
      {justPlaced ? (
        <Alert kind="ok">Order placed — we've sent the details to the kitchen.</Alert>
      ) : null}

      <div className="spread" style={{ margin: '1rem 0 1.25rem' }}>
        <div>
          <h1>{order.order_number}</h1>
          <div className="small muted">
            Placed {dateTime(order.created_at)} · {order.fulfillment_type === 'delivery' ? 'Grab delivery' : 'Pickup'}
          </div>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {cancelled ? (
        <Alert kind="error">
          This order was cancelled{order.cancelled_reason ? ` — ${order.cancelled_reason}` : ''}.
        </Alert>
      ) : (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head"><h3>Progress</h3></div>
          <div className="panel-body">
            <div className="track-steps">
              {steps.map((step, i) => {
                const stepIndex = ORDER.indexOf(step.key);
                const done = currentIndex > stepIndex || order.status === 'completed';
                const current = order.status === step.key;
                return (
                  <div
                    key={step.key}
                    className={`track-step ${done ? 'done' : ''} ${current ? 'current' : ''}`}
                  >
                    <div className="track-rail">
                      <span className="track-dot">{done ? '✓' : current ? '●' : ''}</span>
                      {i < steps.length - 1 ? <span className="track-bar" /> : null}
                    </div>
                    <div className="track-text">
                      <div className="strong small">{step.label}</div>
                      <div className="tiny muted">{step.note}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {driver ? (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head">
            <h3>Your driver</h3>
            <DeliveryBadge status={driver.status} />
          </div>
          <div className="panel-body stack">
            {driver.driver_name ? (
              <div className="driver-card">
                <div className="driver-avatar" aria-hidden="true">
                  {driver.driver_name.slice(0, 1)}
                </div>
                <div className="grow">
                  <div className="strong">{driver.driver_name}</div>
                  <div className="small muted">
                    {driver.driver_plate ? `${driver.driver_plate} · ` : ''}
                    {driver.driver_phone}
                  </div>
                </div>
                {driver.driver_phone ? (
                  <a className="btn btn-sm" href={`tel:${driver.driver_phone}`}>Call</a>
                ) : null}
              </div>
            ) : (
              <div className="small muted">Grab is finding a driver for your order…</div>
            )}

            {driver.dropoff_eta ? (
              <div className="small">Estimated arrival {dateTime(driver.dropoff_eta)}</div>
            ) : null}

            {driver.events?.length ? (
              <div className="stack-s">
                {driver.events.slice().reverse().map((e, i) => (
                  <div key={i} className="spread small">
                    <span className="muted">{e.description ?? e.status}</span>
                    <span className="tiny faint">{dateTime(e.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {cancelled ? null : (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head">
            <h3>Payment</h3>
            <span className={`badge ${order.payment_status === 'paid' ? 'badge-leaf' : 'badge-neutral'}`}>
              {order.payment_status === 'paid' ? 'Paid' : 'Not yet paid'}
            </span>
          </div>
          <div className="panel-body stack">
            <div className="spread">
              <span className="muted">{PAYMENT_LABEL[order.payment_method] ?? order.payment_method}</span>
              <span className="mono strong">{money(order.total, order.currency)}</span>
            </div>

            {order.payment_method === 'gcash' && order.payment_status !== 'paid' ? (
              <GcashPanel amount={order.total} currency={order.currency}>
                <div className="tiny muted">
                  Send it from your GCash app. We'll mark this order paid once it
                  arrives — you don't need to do anything else here.
                </div>
              </GcashPanel>
            ) : null}

            {order.payment_status !== 'paid' && order.payment_method !== 'gcash' ? (
              <div className="small muted">
                {order.fulfillment_type === 'delivery'
                  ? 'Pay the rider when your order arrives.'
                  : 'Pay when you collect your order.'}
              </div>
            ) : null}
          </div>
        </section>
      )}

      <section className="panel" style={{ marginBottom: '1rem' }}>
        <div className="panel-head"><h3>What you ordered</h3></div>
        <div className="panel-body stack">
          {order.items.map((item) => (
            <div key={item.id} className="stack-s" style={{ paddingBottom: '.7rem', borderBottom: '1px solid var(--oat-deep)' }}>
              <div className="spread">
                <span className="strong">{item.quantity}× {item.product_name}</span>
                <span className="mono">{money(item.line_total, order.currency)}</span>
              </div>
              {item.options?.length ? (
                <div className="small muted">
                  {item.options.map((o) => `${o.option_name}`).join(' · ')}
                </div>
              ) : null}
              {item.notes ? (
                <div className="tiny faint" style={{ fontStyle: 'italic' }}>“{item.notes}”</div>
              ) : null}
            </div>
          ))}

          <div className="totals">
            <div className="totals-row">
              <span className="muted">Subtotal</span>
              <span className="mono">{money(order.subtotal, order.currency)}</span>
            </div>
            {Number(order.delivery_fee) > 0 ? (
              <div className="totals-row">
                <span className="muted">Delivery</span>
                <span className="mono">{money(order.delivery_fee, order.currency)}</span>
              </div>
            ) : null}
            {/* Keyed off what this order was actually charged, not the shop's
                current rate, so an old receipt still reads correctly. */}
            {Number(order.tax) > 0 ? (
              <div className="totals-row">
                <span className="muted">Tax</span>
                <span className="mono">{money(order.tax, order.currency)}</span>
              </div>
            ) : null}
            <div className="totals-total">
              <span>Total</span>
              <span className="mono">{money(order.total, order.currency)}</span>
            </div>
          </div>
        </div>
      </section>

      {order.delivery_address ? (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head"><h3>Delivering to</h3></div>
          <div className="panel-body">
            <div className="small">{order.delivery_address}</div>
            {order.delivery_notes ? (
              <div className="tiny muted" style={{ marginTop: '.3rem' }}>{order.delivery_notes}</div>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="row-wrap">
        <Link to="/" className="btn">Order again</Link>
        {order.status === 'pending' && user ? (
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel order</button>
        ) : null}
      </div>
    </div>
  );
}

export function OrderHistory() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/orders?limit=50', { signal: controller.signal })
      .then((res) => setOrders(res.orders))
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, []);

  if (error) return <div className="container" style={{ padding: '2rem 0' }}><Alert kind="error">{error}</Alert></div>;
  if (!orders) return <Loading />;

  return (
    <div className="container" style={{ padding: '1.75rem 0 4rem', maxWidth: 760 }}>
      <h1 style={{ marginBottom: '1.25rem' }}>Your orders</h1>
      {orders.length === 0 ? (
        <Empty title="No orders yet" icon="🥣">
          <Link to="/" className="btn btn-primary" style={{ marginTop: '.8rem' }}>Browse the menu</Link>
        </Empty>
      ) : (
        <div className="stack">
          {orders.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className="card card-pad spread" style={{ textDecoration: 'none' }}>
              <div>
                <div className="strong">{o.order_number}</div>
                <div className="small muted">
                  {dateTime(o.created_at)} · {o.item_count} item{o.item_count === 1 ? '' : 's'} ·{' '}
                  {o.fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup'}
                </div>
              </div>
              <div className="row">
                <span className="mono strong">{money(o.total, o.currency)}</span>
                <StatusBadge status={o.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
