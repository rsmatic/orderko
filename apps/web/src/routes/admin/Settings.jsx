import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Field, Spinner } from '../../components/ui';
import ImagePicker from '../../components/ImagePicker';
import ClearOrders from '../../components/ClearOrders';
import { useShop } from '../../context/ShopContext';

export default function Settings() {
  const { reload: reloadShop } = useShop();
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
          logo_url: s.logo_url ?? '',
          hero_image_url: s.hero_image_url ?? '',
          show_included_label: s.show_included_label !== false,
          google_client_id: s.google_client_id ?? '',
          currency: s.currency ?? 'PHP',
          tax_rate: String(Number(s.tax_rate ?? 0) * 100),
          pickup_address: s.pickup_address ?? '',
          pickup_lat: String(s.pickup_lat ?? ''),
          pickup_lng: String(s.pickup_lng ?? ''),
          pickup_phone: s.pickup_phone ?? '',
          min_order_total: String(s.min_order_total ?? 0),
          delivery_enabled: Boolean(s.delivery_enabled),
          max_delivery_km: String(s.max_delivery_km ?? 0),
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
        logo_url: form.logo_url,
        hero_image_url: form.hero_image_url,
        show_included_label: form.show_included_label,
        google_client_id: form.google_client_id.trim(),
        currency: form.currency.toUpperCase(),
        tax_rate: Number(form.tax_rate) / 100,
        pickup_address: form.pickup_address,
        pickup_lat: Number(form.pickup_lat),
        pickup_lng: Number(form.pickup_lng),
        pickup_phone: form.pickup_phone,
        min_order_total: Number(form.min_order_total),
        delivery_enabled: form.delivery_enabled,
        max_delivery_km: Number(form.max_delivery_km),
        order_lead_mins: Number(form.order_lead_mins),
      });
      setNotice('Settings saved');
      // The storefront header reads these, so refresh its copy.
      reloadShop();
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
          <div className="panel-head">
            <h3>Branding</h3>
            <span className="tiny faint">what customers see</span>
          </div>
          <div className="panel-body stack">
            <label className="switch">
              <input
                type="checkbox"
                checked={form.show_included_label}
                onChange={(e) => set({ show_included_label: e.target.checked })}
              />
              Label free choices as “Included”
            </label>
            <span className="hint" style={{ marginTop: '-.35rem' }}>
              Useful when most choices cost extra. Turn it off when a whole group
              is free and the word just repeats down the list.
            </span>

            <div className="grid grid-2">
            <Field label="Logo">
              <ImagePicker
                value={form.logo_url}
                shape="square"
                maxPixels={192}
                onChange={(v) => set({ logo_url: v })}
                hint="Shown beside the shop name in the header. A square picture works best."
              />
            </Field>
            <Field label="Front page picture">
              <ImagePicker
                value={form.hero_image_url}
                maxPixels={720}
                onChange={(v) => set({ hero_image_url: v })}
                hint="The large image on the storefront. Leave empty for the stock photo."
              />
            </Field>
            </div>
          </div>
        </section>

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
          <div className="panel-head">
            <h3>Customer sign-in</h3>
            <span className={`badge ${form.google_client_id ? 'badge-leaf' : 'badge-neutral'}`}>
              {form.google_client_id ? 'Google on' : 'Off'}
            </span>
          </div>
          <div className="panel-body stack">
            <Field
              label="Google OAuth client ID"
              hint="Leave empty to hide the Google button. This value is public by design — every visitor's browser receives it — so it is not a secret."
            >
              <input
                className="input"
                placeholder="1234567890-abcdefg.apps.googleusercontent.com"
                value={form.google_client_id}
                onChange={(e) => set({ google_client_id: e.target.value })}
              />
            </Field>

            <details className="small muted">
              <summary style={{ cursor: 'pointer' }}>Where do I get this?</summary>
              <ol style={{ margin: '.5rem 0 0', paddingLeft: '1.2rem', lineHeight: 1.6 }}>
                <li>Open <strong>console.cloud.google.com</strong> and create a project. Free, no card.</li>
                <li>APIs &amp; Services → <strong>OAuth consent screen</strong>: choose External, fill in the app name and your email, save.</li>
                <li>Credentials → <strong>Create credentials → OAuth client ID</strong> → Web application.</li>
                <li>Under <strong>Authorised JavaScript origins</strong> add exactly <code>https://rsmatic.github.io</code>, plus <code>http://localhost:5173</code> for local work.</li>
                <li>Paste the client ID above and save.</li>
              </ol>
              <p style={{ marginBottom: 0 }}>
                No redirect URI is needed: sign-in happens in the page, so a changing
                API address does not matter.
              </p>
            </details>
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

            <Field
              label="Delivery radius (km)"
              hint="Straight-line from the pickup point. Customers pin their own address on a map, so this is what stops an order from the next province. 0 removes the limit."
            >
              <input
                className="input" type="number" min="0" max="500" step="1"
                style={{ maxWidth: 140 }}
                value={form.max_delivery_km}
                onChange={(e) => set({ max_delivery_km: e.target.value })}
              />
            </Field>

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

        <ClearOrders />
      </form>
    </>
  );
}
