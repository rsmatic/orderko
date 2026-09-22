import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, money } from '../../lib/api';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { Alert, Field, Spinner, Empty } from '../../components/ui';
import AddressPicker from '../../components/AddressPicker';
import { useShop } from '../../context/ShopContext';

export default function Checkout() {
  const cart = useCart();
  const { user } = useAuth();
  const { shop } = useShop();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fulfillment_type: 'pickup',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    delivery_address: '',
    delivery_notes: '',
    delivery_lat: null,
    delivery_lng: null,
    payment_method: 'cash',
    notes: '',
  });
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    setForm((f) => ({
      ...f,
      contact_name: f.contact_name || user.name || '',
      contact_phone: f.contact_phone || user.phone || '',
      contact_email: f.contact_email || user.email || '',
    }));
  }, [user]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const hasCoords = form.delivery_lat != null && form.delivery_lng != null;
  const wantsDelivery = form.fulfillment_type === 'delivery';

  // Re-quote whenever the basket, mode, or destination changes. The delivery
  // fee comes from Grab (or the mock provider), never from the browser.
  const quoteKey = useMemo(
    () => JSON.stringify({
      items: cart.payload,
      mode: form.fulfillment_type,
      lat: form.delivery_lat,
      lng: form.delivery_lng,
    }),
    [cart.payload, form.fulfillment_type, form.delivery_lat, form.delivery_lng],
  );

  useEffect(() => {
    if (!cart.lines.length) return undefined;
    if (wantsDelivery && !hasCoords) { setQuote(null); return undefined; }

    const controller = new AbortController();
    setQuoting(true);
    api
      .post(
        '/orders/quote',
        {
          items: cart.payload,
          fulfillment_type: form.fulfillment_type,
          delivery_address: form.delivery_address || null,
          delivery_lat: form.delivery_lat,
          delivery_lng: form.delivery_lng,
        },
        { signal: controller.signal },
      )
      .then((res) => { setQuote(res); setError(''); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => setQuoting(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  function chooseDestination(place) {
    set({
      delivery_address: place.address,
      delivery_lat: place.lat,
      delivery_lng: place.lng,
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const order = await api.post('/orders', {
        items: cart.payload,
        fulfillment_type: form.fulfillment_type,
        contact_name: form.contact_name.trim(),
        contact_phone: form.contact_phone.trim(),
        contact_email: form.contact_email.trim() || null,
        delivery_address: wantsDelivery ? form.delivery_address : null,
        delivery_notes: wantsDelivery ? form.delivery_notes || null : null,
        delivery_lat: wantsDelivery ? form.delivery_lat : null,
        delivery_lng: wantsDelivery ? form.delivery_lng : null,
        payment_method: form.payment_method,
        notes: form.notes || null,
      });
      cart.clear();
      // A guest has no account to look the order up against later, so keep the
      // number and phone around — OrderTracking falls back to those.
      if (!user) {
        try {
          sessionStorage.setItem(
            `oats.guest.${order.id}`,
            JSON.stringify({ order_number: order.order_number, phone: order.contact_phone }),
          );
        } catch { /* private mode */ }
      }
      navigate(`/orders/${order.id}`, { state: { justPlaced: true } });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  if (!cart.lines.length) {
    return (
      <div className="container" style={{ padding: '3rem 0' }}>
        <Empty title="Your basket is empty" icon="🫙">
          <Link to="/" className="btn btn-primary" style={{ marginTop: '.8rem' }}>Back to the menu</Link>
        </Empty>
      </div>
    );
  }

  const canSubmit =
    !submitting &&
    !quoting &&
    quote?.meets_minimum &&
    form.contact_name.trim().length >= 2 &&
    form.contact_phone.trim().length >= 6 &&
    (!wantsDelivery || hasCoords);

  return (
    <div className="container" style={{ padding: '1.75rem 0 4rem' }}>
      <Link to="/" className="small muted">← Back to the menu</Link>
      <h1 style={{ margin: '.6rem 0 1.25rem' }}>Checkout</h1>

      <form onSubmit={submit} className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 1fr)', alignItems: 'start', gap: '1.5rem' }}>
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h3>How do you want it?</h3></div>
            <div className="panel-body stack">
              <div className="row-wrap">
                {['pickup', 'delivery'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`btn ${form.fulfillment_type === mode ? 'btn-primary' : ''}`}
                    onClick={() => set({ fulfillment_type: mode })}
                  >
                    {mode === 'pickup' ? '🏪 Pick up' : '🚴 Grab delivery'}
                  </button>
                ))}
              </div>

              {wantsDelivery ? (
                <>
                  <Field label="Deliver to">
                    <AddressPicker
                      value={hasCoords
                        ? { address: form.delivery_address, lat: form.delivery_lat, lng: form.delivery_lng }
                        : null}
                      onChange={chooseDestination}
                      center={{
                        lat: shop.pickup_lat ?? 14.5611,
                        lng: shop.pickup_lng ?? 121.0296,
                      }}
                      maxKm={shop.max_delivery_km || 0}
                    />
                  </Field>

                  {hasCoords ? (
                    <div className="alert alert-ok small">
                      📍 {form.delivery_address}
                    </div>
                  ) : null}

                  <Field label="Notes for the driver">
                    <input
                      className="input"
                      placeholder="e.g. leave with the guard house"
                      maxLength={200}
                      value={form.delivery_notes}
                      onChange={(e) => set({ delivery_notes: e.target.value })}
                    />
                  </Field>
                </>
              ) : (
                <div className="alert alert-info small">
                  Collect from <strong>{quote?.pickup_address ?? 'the shop'}</strong>. We'll text you when it's ready.
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h3>Who's it for?</h3></div>
            <div className="panel-body grid grid-2">
              <Field label="Name">
                <input
                  className="input" required minLength={2} maxLength={120}
                  value={form.contact_name}
                  onChange={(e) => set({ contact_name: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="input" required minLength={6} maxLength={32} type="tel"
                  placeholder="+63 917 123 4567"
                  value={form.contact_phone}
                  onChange={(e) => set({ contact_phone: e.target.value })}
                />
              </Field>
              <Field label="Email" hint="For the receipt. Optional.">
                <input
                  className="input" type="email" maxLength={190}
                  value={form.contact_email}
                  onChange={(e) => set({ contact_email: e.target.value })}
                />
              </Field>
              <Field label="Payment">
                <select
                  className="select"
                  value={form.payment_method}
                  onChange={(e) => set({ payment_method: e.target.value })}
                >
                  <option value="cash">Cash on {wantsDelivery ? 'delivery' : 'pickup'}</option>
                  <option value="card">Card</option>
                  <option value="ewallet">E-wallet</option>
                </select>
              </Field>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h3>Anything for the kitchen?</h3></div>
            <div className="panel-body">
              <textarea
                className="textarea"
                placeholder="Allergies, packing requests, anything else"
                maxLength={500}
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
              />
            </div>
          </section>

          {!user ? (
            <Alert kind="info">
              Ordering as a guest. <Link to="/login" className="strong">Sign in</Link> to keep your order history.
            </Alert>
          ) : null}
        </div>

        <aside className="panel" style={{ position: 'sticky', top: '5rem' }}>
          <div className="panel-head"><h3>Order summary</h3></div>
          <div className="panel-body stack">
            {(quote?.items ?? []).map((item, i) => (
              <div key={i} className="stack-s" style={{ paddingBottom: '.6rem', borderBottom: '1px solid var(--oat-deep)' }}>
                <div className="spread">
                  <span className="small strong">{item.quantity}× {item.product_name}</span>
                  <span className="mono small">{money(item.line_total)}</span>
                </div>
                {item.options?.length ? (
                  <div className="tiny muted">{item.options.map((o) => o.option_name).join(' · ')}</div>
                ) : null}
              </div>
            ))}

            <div className="totals">
              <div className="totals-row">
                <span className="muted">Subtotal</span>
                <span className="mono">{money(quote?.subtotal ?? 0)}</span>
              </div>
              {wantsDelivery ? (
                <div className="totals-row">
                  <span className="muted">
                    Grab delivery
                    {quote?.delivery_quote?.distance_km
                      ? ` · ${quote.delivery_quote.distance_km} km`
                      : ''}
                  </span>
                  <span className="mono">
                    {!hasCoords ? '—' : quoting ? <Spinner /> : money(quote?.delivery_fee ?? 0)}
                  </span>
                </div>
              ) : null}
              {/* A shop below the VAT threshold charges none — showing a
                  zero line just invites the question. */}
              {Number(quote?.tax) > 0 ? (
                <div className="totals-row">
                  <span className="muted">Tax</span>
                  <span className="mono">{money(quote.tax)}</span>
                </div>
              ) : null}
              <div className="totals-total">
                <span>Total</span>
                <span className="mono">{money(quote?.total ?? 0)}</span>
              </div>
            </div>

            {wantsDelivery && quote?.delivery_quote?.eta_minutes ? (
              <div className="small muted">
                Driver ETA about {quote.delivery_quote.eta_minutes} minutes after we hand it over.
              </div>
            ) : null}

            {wantsDelivery && !hasCoords ? (
              <Alert kind="warn">Choose a destination to see the delivery fee.</Alert>
            ) : null}

            {quote && !quote.meets_minimum ? (
              <Alert kind="warn">Minimum order is {money(quote.min_order_total)}.</Alert>
            ) : null}

            {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!canSubmit}>
              {submitting ? <Spinner /> : `Place order · ${money(quote?.total ?? 0)}`}
            </button>
          </div>
        </aside>
      </form>
    </div>
  );
}
