import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../../lib/api';
import { useCart } from '../../context/CartContext';
import { Qty, Empty, Alert, Spinner } from '../../components/ui';

export default function CartDrawer({ onClose }) {
  const cart = useCart();
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [pricing, setPricing] = useState(false);

  // Re-price through the API whenever the basket changes, so the drawer
  // shows the same numbers checkout will charge.
  useEffect(() => {
    if (!cart.lines.length) { setQuote(null); setError(''); return undefined; }
    const controller = new AbortController();
    setPricing(true);
    api
      .post('/orders/quote', { items: cart.payload, fulfillment_type: 'pickup' }, { signal: controller.signal })
      .then((res) => { setQuote(res); setError(''); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => setPricing(false));
    return () => controller.abort();
  }, [cart.payload, cart.lines.length]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const belowMinimum = quote && !quote.meets_minimum;

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Your basket"
      >
        <div className="drawer-head spread">
          <div>
            <h2>Your basket</h2>
            <div className="small muted">
              {cart.count === 0 ? 'Nothing in it yet' : `${cart.count} jar${cart.count === 1 ? '' : 's'}`}
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="drawer-body">
          {cart.lines.length === 0 ? (
            <Empty title="Empty basket" icon="🫙">Pick a jar from the menu to get started.</Empty>
          ) : (
            cart.lines.map((line) => (
              <div key={line.key} className="cart-line">
                <div className="grow">
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <span className="strong">{line.product_name}</span>
                    <span className="mono small">
                      {money((line.unit_preview ?? 0) * line.quantity)}
                    </span>
                  </div>

                  {line.option_labels?.length ? (
                    <div className="cart-line-opts">
                      {line.option_labels.map((o, i) => (
                        <span key={`${o.name}-${i}`}>
                          {i > 0 ? ' · ' : ''}
                          {o.name}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {line.notes ? (
                    <div className="tiny faint" style={{ marginTop: '.25rem', fontStyle: 'italic' }}>
                      “{line.notes}”
                    </div>
                  ) : null}

                  <div className="row" style={{ marginTop: '.5rem' }}>
                    <Qty
                      value={line.quantity}
                      min={0}
                      onChange={(q) => cart.setQuantity(line.key, q)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => cart.remove(line.key)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}

          {error ? <Alert kind="error">{error}</Alert> : null}
        </div>

        {cart.lines.length > 0 ? (
          <div className="drawer-foot stack">
            <div className="totals">
              <div className="totals-row">
                <span className="muted">Subtotal</span>
                <span className="mono">
                  {pricing && !quote ? <Spinner /> : money(quote?.subtotal ?? 0)}
                </span>
              </div>
              {Number(quote?.tax) > 0 ? (
                <div className="totals-row">
                  <span className="muted">Tax</span>
                  <span className="mono">{money(quote.tax)}</span>
                </div>
              ) : null}
              <div className="totals-row tiny faint">
                <span>Delivery is added at checkout</span>
              </div>
              <div className="totals-total">
                <span>Total</span>
                <span className="mono">{money(quote?.total ?? 0)}</span>
              </div>
            </div>

            {belowMinimum ? (
              <Alert kind="warn">
                Minimum order is {money(quote.min_order_total)} — add {money(quote.min_order_total - quote.subtotal)} more.
              </Alert>
            ) : null}

            <div className="row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={cart.clear}>
                Clear
              </button>
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={pricing || Boolean(error) || belowMinimum}
                onClick={() => { onClose(); navigate('/checkout'); }}
              >
                Checkout
              </button>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
