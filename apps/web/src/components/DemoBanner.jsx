import { useState } from 'react';
import { DEMO } from '../lib/api';

/**
 * Makes it unmistakable that the data is local and disposable. Without this a
 * visitor could reasonably think they had placed a real order.
 */
export default function DemoBanner() {
  const [open, setOpen] = useState(false);
  if (!DEMO) return null;

  async function reset() {
    if (!window.confirm('Reset the demo? Any orders or menu edits you made here will be discarded.')) return;
    const { resetDemo } = await import('../demo/backend');
    resetDemo();
    try {
      localStorage.removeItem('oats.cart');
      localStorage.removeItem('oats.token');
    } catch { /* private mode */ }
    window.location.reload();
  }

  return (
    <div className="demo-banner">
      <div className="container demo-banner-inner">
        <span className="demo-chip">Demo</span>
        <span className="grow small">
          Runs entirely in your browser — no server, no database. Orders you place are
          saved locally and visible only to you.
        </span>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide logins' : 'Show logins'}
        </button>
        <button type="button" className="btn btn-sm" onClick={reset}>Reset</button>
      </div>

      {open ? (
        <div className="container demo-logins">
          {[
            ['Admin', 'admin@orderko.test', 'everything'],
            ['Manager', 'manager@orderko.test', 'kitchen, menu, prices'],
            ['Customer', 'cust@orderko.test', 'ordering and history'],
          ].map(([role, email, can]) => (
            <div key={email} className="demo-login">
              <strong>{role}</strong>
              <code>{email}</code>
              <span className="tiny faint">{can}</span>
            </div>
          ))}
          <div className="tiny faint" style={{ width: '100%' }}>
            Password for all three: <code>Password123!</code> — or order as a guest without signing in.
          </div>
        </div>
      ) : null}
    </div>
  );
}
