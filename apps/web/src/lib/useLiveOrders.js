import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Keeps a staff screen current without anyone pressing Refresh.
 *
 * It polls a tiny endpoint for a revision number and only calls `reload` when
 * that number has moved. The alternative — refetching the order list on a
 * timer — sends the whole list down the tunnel every few seconds to discover,
 * almost always, that nothing happened.
 *
 * Polling rather than a socket is deliberate. The API is reached through a
 * Cloudflare quick tunnel that is restarted by hand and changes address when
 * it is; a poll picks straight back up after that, and after a laptop sleeps
 * or the wifi drops, with no reconnect logic to get wrong.
 *
 * Nothing is polled while the tab is hidden — a kitchen screen left open
 * overnight should not spend the night talking to the API — and a hidden tab
 * is checked the moment it comes back, so returning to it never shows a stale
 * list.
 *
 * @param reload   called when something has changed (and once on becoming visible again)
 * @param enabled  false pauses polling entirely
 * @param everyMs  how often to ask
 * @returns {{live: boolean, checkedAt: Date|null}} for a status indicator
 */
export function useLiveOrders(reload, { enabled = true, everyMs = 5000 } = {}) {
  const [live, setLive] = useState(true);
  const [checkedAt, setCheckedAt] = useState(null);

  // Held in refs so changing them never restarts the interval: reload is a new
  // function on most renders, and an interval that resets on every render is
  // an interval that never fires.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const seenRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;

    async function check() {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const { rev } = await api.get('/orders/pulse');
        if (stopped) return;
        setLive(true);
        setCheckedAt(new Date());
        // First look just records where we are; only a change reloads. A
        // restarted API sends rev back to zero, so this compares for
        // difference rather than for growth.
        if (seenRef.current !== null && rev !== seenRef.current) await reloadRef.current();
        seenRef.current = rev;
      } catch {
        // A dropped tunnel or a sleeping laptop; the next tick tries again.
        if (!stopped) setLive(false);
      }
    }

    check();
    const timer = setInterval(check, everyMs);
    // Coming back to the tab should not mean waiting out the interval.
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, everyMs]);

  return { live, checkedAt };
}
