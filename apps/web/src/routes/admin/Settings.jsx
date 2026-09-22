import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Field, Spinner } from '../../components/ui';

export default function Settings() {
  const [form, setForm] = useState(null);
  const [grabMode, setGrabMode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/admin/settings', { signal: controller.signal })
      .then((res) => {
        const s = res.settings;
        setGrabMode(res.grab_mode);
        setForm({
          shop_name: s.shop_name ?? '',
          currency: s.currency ?? 'MYR',
          tax_rate: String(Number(s.tax_rate ?? 0) * 100),
          pickup_address: s.pickup_address ?? '',
          pickup_lat: String(s.pickup_lat ?? ''),
          pickup_lng: String(s.pickup_lng ?? ''),
          pickup_phone: s.pickup_phone ?? '',
          min_order_total: String(s.min_order_total ?? 0),
          delivery_enabled: Boolean(s.delivery_enabled),
          order_lead_mins: String(s.order_lead_mins ?? 20),
        });
      })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put('/admin/settings', {
        shop_name: form.shop_name,
        currency: form.currency.toUpperCase(),
        tax_rate: Number(form.tax_rate) / 100,
        pickup_address: form.pickup_address,
        pickup_lat: Number(form.pickup_lat),
        pickup_lng: Number(form.pickup_lng),
        pickup_phone: form.pickup_phone,
        min_order_total: Number(form.min_order_total),
        delivery_enabled: form.delivery_enabled,
        order_lead_mins: Number(form.order_lead_mins),
      });
      setNotice('Settings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!form) {
    return <><DashHeader title="Shop settings" /><div className="dash-body">{error ? <Alert kind="error">{error}</Alert> : <Loading />}</div></>;
  }

  return (
    <>
      <DashHeader title="Shop settings" subtitle="Applies to every new order" />

      <form className="dash-body stack" style={{ maxWidth: 780 }} onSubmit={save}>
        {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}
        {notice ? <Alert kind="ok">{notice}</Alert> : null}

        <section className="panel">
          <div className="panel-head"><h3>Shop</h3></div>
          <div className="panel-body grid grid-2">
            <Field label="Shop name">
              <input className="input" value={form.shop_name} onChange={(e) => set({ shop_name: e.target.value })} />
            </Field>
            <Field label="Currency" hint="Three-letter ISO code.">
              <input
                className="input" maxLength={3} style={{ textTransform: 'uppercase' }}
                value={form.currency} onChange={(e) => set({ currency: e.target.value })}
              />
            </Field>
            <Field label="Service tax (%)" hint="Charged on goods, not on the delivery fee.">
              <input
                className="input" type="number" step="0.1" min="0" max="100"
                value={form.tax_rate} onChange={(e) => set({ tax_rate: e.target.value })}
              />
            </Field>
            <Field label="Minimum order" hint="Checkout is blocked below this subtotal.">
              <input
                className="input" type="number" step="1" min="0"
                value={form.min_order_total} onChange={(e) => set({ min_order_total: e.target.value })}
              />
            </Field>
            <Field label="Prep time (minutes)" hint="Shown to customers as 'ready in ~N min'.">
              <input
                className="input" type="number" min="0" max="480"
                value={form.order_lead_mins} onChange={(e) => set({ order_lead_mins: e.target.value })}
              />
            </Field>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Pickup point</h3>
            <span className="tiny faint">where Grab collects</span>
          </div>
          <div className="panel-body stack">
            <Field label="Address">
              <input className="input" value={form.pickup_address} onChange={(e) => set({ pickup_address: e.target.value })} />
            </Field>
            <div className="grid grid-3">
              <Field label="Latitude">
                <input
                  className="input" type="number" step="0.0000001"
                  value={form.pickup_lat} onChange={(e) => set({ pickup_lat: e.target.value })}
                />
              </Field>
              <Field label="Longitude">
                <input
                  className="input" type="number" step="0.0000001"
                  value={form.pickup_lng} onChange={(e) => set({ pickup_lng: e.target.value })}
                />
              </Field>
              <Field label="Phone for the driver">
                <input className="input" type="tel" value={form.pickup_phone} onChange={(e) => set({ pickup_phone: e.target.value })} />
              </Field>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Delivery</h3></div>
          <div className="panel-body stack">
            <label className="switch">
              <input
                type="checkbox" checked={form.delivery_enabled}
                onChange={(e) => set({ delivery_enabled: e.target.checked })}
              />
              Offer Grab delivery at checkout
            </label>

            <div className={`alert ${grabMode === 'live' ? 'alert-ok' : 'alert-info'} small`}>
              {grabMode === 'live' ? (
                <>
                  <strong>Live mode.</strong> Bookings go to the GrabExpress partner API using the
                  credentials in the API's environment.
                </>
              ) : (
                <>
                  <strong>Mock mode.</strong> Bookings are simulated locally — a fake driver walks
                  through allocating → picking up → in delivery → completed on a timer. Set
                  <code> GRAB_MODE=live</code> with your client id and secret in
                  <code> apps/api/.env</code> to use the real API.
                </>
              )}
            </div>
          </div>
        </section>

        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : 'Save settings'}
          </button>
        </div>
      </form>
    </>
  );
}
