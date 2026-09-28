import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Field, Alert, Spinner, Loading } from './ui';
import ImagePicker from './ImagePicker';

/**
 * Where a seller is collected from, and who gets paid for their work.
 *
 * Lives with the person rather than in shop settings, because that is what it
 * is: this seller's counter and this seller's GCash, not the shop's.
 *
 * Every field may be left blank, and blank means "use the shop's". So the
 * placeholder shows what they would inherit, and only what they type is saved
 * — writing the shop's values into the row would freeze them, and changing the
 * shop later would stop reaching this seller.
 */
export default function SellerProfile({ userId, onSaved, onError }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get(`/sellers/${userId}/profile`, { signal: controller.signal })
      .then((res) => {
        setProfile(res);
        setForm({ ...res.own });
      })
      .catch((err) => { if (err.name !== 'AbortError') onError(err.message); });
    return () => controller.abort();
  }, [userId, onError]);

  if (!form) return <Loading label="Reading their details…" />;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const inherited = (k) => String(profile.shop?.[k] ?? '');
  const isInherited = (k) => String(form[k] ?? '') === '';

  async function save() {
    setBusy(true);
    try {
      const saved = await api.put(`/sellers/${userId}/profile`, form);
      setProfile(saved);
      setForm({ ...saved.own });
      onSaved('Seller details saved');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Alert kind="info">
        Anything left blank uses the shop's own setting, shown greyed out in the
        box. Fill in only what is different for this seller.
      </Alert>

      <Field label="Trading name" hint="What customers see next to their items. Defaults to their account name.">
        <input
          className="input" maxLength={120}
          placeholder={profile.display_name}
          value={form.display_name}
          onChange={(e) => set({ display_name: e.target.value })}
        />
      </Field>

      <section className="panel">
        <div className="panel-head">
          <h3>Pickup point</h3>
          <span className="tiny faint">
            {isInherited('pickup_address') ? "the shop's" : 'their own'}
          </span>
        </div>
        <div className="panel-body stack">
          <Field label="Address" hint="Where the customer collects, and where a rider is sent.">
            <input
              className="input"
              placeholder={inherited('pickup_address')}
              value={form.pickup_address}
              onChange={(e) => set({ pickup_address: e.target.value })}
            />
          </Field>
          <div className="grid grid-2">
            <Field label="Latitude" hint="The delivery radius is measured from here.">
              <input
                className="input" type="number" step="0.000001"
                placeholder={inherited('pickup_lat')}
                value={form.pickup_lat}
                onChange={(e) => set({ pickup_lat: e.target.value })}
              />
            </Field>
            <Field label="Longitude">
              <input
                className="input" type="number" step="0.000001"
                placeholder={inherited('pickup_lng')}
                value={form.pickup_lng}
                onChange={(e) => set({ pickup_lng: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Phone for the driver">
            <input
              className="input" type="tel"
              placeholder={inherited('pickup_phone')}
              value={form.pickup_phone}
              onChange={(e) => set({ pickup_phone: e.target.value })}
            />
          </Field>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>GCash</h3>
          <span className={`badge ${profile.gcash_number ? 'badge-leaf' : 'badge-neutral'}`}>
            {profile.gcash_number ? 'Can be paid' : 'No number'}
          </span>
        </div>
        <div className="panel-body stack">
          <Field
            label="GCash mobile number"
            hint="Their money, not the shop's — a customer paying for their items sends it here."
          >
            <input
              className="input" type="tel" inputMode="tel"
              placeholder={inherited('gcash_number') || '0915 386 8303'}
              value={form.gcash_number}
              onChange={(e) => set({ gcash_number: e.target.value })}
            />
          </Field>
          <Field label="Account name" hint="The name the customer should see in GCash.">
            <input
              className="input"
              placeholder={profile.display_name}
              value={form.gcash_name}
              onChange={(e) => set({ gcash_name: e.target.value })}
            />
          </Field>
          <Field label="Their GCash QR code" hint="Optional. Taken from their own GCash app.">
            <ImagePicker
              value={form.gcash_qr_url}
              onChange={(v) => set({ gcash_qr_url: v ?? '' })}
              shape="qr"
            />
          </Field>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Their delivery charge</h3></div>
        <div className="panel-body grid grid-2">
          <Field label="Delivery fee" hint="Only when the shop delivers its own orders. Blank uses the shop's.">
            <input
              className="input" type="number" min="0" step="0.01"
              placeholder={inherited('own_delivery_fee')}
              value={form.own_delivery_fee}
              onChange={(e) => set({ own_delivery_fee: e.target.value })}
            />
          </Field>
          <Field label="Extra per km">
            <input
              className="input" type="number" min="0" step="0.01"
              placeholder={inherited('own_delivery_fee_per_km')}
              value={form.own_delivery_fee_per_km}
              onChange={(e) => set({ own_delivery_fee_per_km: e.target.value })}
            />
          </Field>
        </div>
      </section>

      <div className="row-wrap">
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : 'Save seller details'}
        </button>
      </div>
    </div>
  );
}
