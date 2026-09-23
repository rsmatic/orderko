import { useState } from 'react';
import { formatPhone } from '@overnight-oats/core';
import { money } from '../lib/api';
import { useShop } from '../context/ShopContext';

/**
 * Where to send a GCash payment.
 *
 * Nothing is charged automatically — the customer pays in their own app and
 * the shop marks the order paid once the money lands. So the one job here is
 * to make the number impossible to get wrong: grouped for reading, and
 * copyable in a single tap on the phone the customer is holding.
 *
 * Renders nothing when no number is configured, which is also what stops
 * GCash being offered at checkout in the first place.
 */
export default function GcashPanel({ amount, currency, children }) {
  const { shop } = useShop();
  const [copied, setCopied] = useState(false);

  const number = String(shop?.gcash_number ?? '').trim();
  if (!number) return null;

  const accountName = String(shop?.gcash_name ?? '').trim() || shop?.shop_name;
  const qr = String(shop?.gcash_qr_url ?? '').trim();

  async function copy() {
    try {
      // Digits only — pasting spaces into GCash is what makes it reject the
      // number, and the clipboard API is missing on http:// and in old Safari.
      await navigator.clipboard.writeText(number.replace(/\D/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* no clipboard; the number is on screen to type */ }
  }

  return (
    <div className="gcash">
      <div className="gcash-head">
        <span className="gcash-mark" aria-hidden="true">G</span>
        <div>
          <div className="strong">Send your payment to GCash</div>
          <div className="tiny muted">{accountName}</div>
        </div>
      </div>

      {qr ? (
        <figure className="gcash-qr">
          <img src={qr} alt={`GCash QR code for ${accountName}`} />
          <figcaption className="tiny muted">
            Scan this in your GCash app, or send to the number below.
          </figcaption>
        </figure>
      ) : null}

      <button type="button" className="gcash-number" onClick={copy} title="Tap to copy">
        <span className="mono">{formatPhone(number)}</span>
        <span className="tiny">{copied ? 'Copied ✓' : 'Tap to copy'}</span>
      </button>

      {amount != null ? (
        <div className="gcash-amount spread">
          <span className="muted">Amount to send</span>
          <span className="mono strong">{money(amount, currency)}</span>
        </div>
      ) : null}

      {children ?? (
        <div className="tiny muted">
          Pay after you place the order. We'll confirm it once the payment
          arrives, and the order stays marked unpaid until then.
        </div>
      )}
    </div>
  );
}
