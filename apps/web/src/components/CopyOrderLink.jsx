import { useState } from 'react';
import { api } from '../lib/api';

/**
 * Builds the tracking link for one order and puts it on the clipboard, ready
 * to paste into whatever the shop talks to its customers on.
 *
 * The token is fetched when the button is pressed rather than shipped with
 * every order in the list: most orders are never shared, and an order sitting
 * on a screen all day is not a reason to have its secret sitting there too.
 */
export function orderTrackUrl(token) {
  // BASE_URL is '/orderko/' on Pages and '/' everywhere else; the router is
  // mounted on the same prefix, so the link has to carry it.
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${window.location.origin}${base}/track/${token}`;
}

export default function CopyOrderLink({ orderId, className = 'btn btn-sm', label = 'Copy link' }) {
  const [state, setState] = useState('idle');
  const [url, setUrl] = useState('');

  async function copy() {
    setState('working');
    try {
      const { share_token: token } = await api.post(`/orders/${orderId}/share`);
      const link = orderTrackUrl(token);
      setUrl(link);
      try {
        await navigator.clipboard.writeText(link);
        setState('copied');
        setTimeout(() => setState('idle'), 2500);
      } catch {
        // No clipboard on http:// or in older Safari — show it to copy by hand
        // rather than leaving the button looking broken.
        setState('manual');
      }
    } catch {
      setState('failed');
      setTimeout(() => setState('idle'), 2500);
    }
  }

  const text = {
    idle: label,
    working: 'Getting link…',
    copied: 'Copied ✓',
    manual: label,
    failed: 'Failed — retry',
  }[state];

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={copy}
        disabled={state === 'working'}
        title="Copy a tracking link to send to the customer"
      >
        {text}
      </button>

      {state === 'manual' ? (
        <input
          className="input mono tiny"
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          style={{ marginTop: '.4rem' }}
        />
      ) : null}
    </>
  );
}
