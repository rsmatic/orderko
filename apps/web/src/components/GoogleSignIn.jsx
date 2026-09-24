import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useShop } from '../context/ShopContext';
import { useAuth } from '../context/AuthContext';
import { Alert } from './ui';

/**
 * "Continue with Google".
 *
 * Google hands the browser a signed token; we post it to the API, which checks
 * the signature before trusting a word of it. Nothing here decides who the
 * customer is — it only carries Google's answer to the server.
 *
 * Renders nothing until the shop has a client id, so an unconfigured shop
 * shows no dead button.
 */
export default function GoogleSignIn({ onSignedIn, text = 'continue_with' }) {
  const { shop } = useShop();
  const { adoptSession } = useAuth();
  const holder = useRef(null);
  const [error, setError] = useState('');
  const clientId = shop.google_client_id;

  // Every caller passes an inline arrow, so onSignedIn is a different function
  // on every render. Listed as a dependency it re-ran this effect on each
  // keystroke of the form beside it, clearing the holder and asking Google to
  // draw the button again — which is the flicker you see while typing. Held in
  // a ref instead, the effect runs once and still calls the current callback.
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const adoptRef = useRef(adoptSession);
  adoptRef.current = adoptSession;

  useEffect(() => {
    if (!clientId || !holder.current) return undefined;
    let cancelled = false;

    (async () => {
      await loadScript();
      if (cancelled || !window.google?.accounts?.id || !holder.current) return;

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          setError('');
          try {
            const res = await api.post('/auth/google', { credential });
            adoptRef.current(res.token, res.user);
            onSignedInRef.current?.(res.user);
          } catch (err) {
            setError(err.message);
          }
        },
      });

      holder.current.innerHTML = '';
      window.google.accounts.id.renderButton(holder.current, {
        theme: 'outline',
        size: 'large',
        text,
        shape: 'pill',
        width: 280,
      });
    })().catch(() => setError('Could not load Google sign-in.'));

    return () => { cancelled = true; };
  }, [clientId, text]);

  if (!clientId) return null;

  return (
    <div className="stack-s">
      <div className="google-btn" ref={holder} />
      {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}
    </div>
  );
}

let scriptPromise = null;

/** Loads Google's script once, however many buttons ask for it. */
function loadScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://accounts.google.com/gsi/client';
    el.async = true;
    el.defer = true;
    el.onload = resolve;
    el.onerror = () => {
      scriptPromise = null;
      reject(new Error('Google sign-in script failed to load'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}
