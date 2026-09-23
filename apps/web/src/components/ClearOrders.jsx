import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, Field, Alert, Spinner } from './ui';

/**
 * Removes every order, behind a password.
 *
 * The count is shown before the button is even pressed, and again in the
 * confirmation, because "remove all orders" means very different things when
 * it is 2 test orders and when it is a month of real ones.
 */
export default function ClearOrders() {
  const [total, setTotal] = useState(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const loadCount = () =>
    api
      .get('/orders?limit=1')
      .then((res) => setTotal(res.total))
      .catch(() => setTotal(null));

  useEffect(() => { loadCount(); }, []);

  async function clear() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/admin/orders/clear', { password });
      setOpen(false);
      setPassword('');
      setDone(`Removed ${res.removed} order${res.removed === 1 ? '' : 's'}.`);
      await loadCount();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setPassword('');
    setError('');
  }

  return (
    <section className="panel panel-danger">
      <div className="panel-head">
        <h3>Danger zone</h3>
        <span className="badge badge-berry">Admin only</span>
      </div>

      <div className="panel-body stack">
        {done ? <Alert kind="ok" onDismiss={() => setDone('')}>{done}</Alert> : null}

        <div className="spread" style={{ alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <div className="strong">Remove all orders</div>
            <div className="small muted" style={{ maxWidth: '46ch' }}>
              Deletes every order, its items, status history and Grab bookings, and
              starts the numbering again at OK-240001. Your menu, prices, accounts
              and settings are untouched. This cannot be undone.
            </div>
          </div>

          <button
            type="button"
            className="btn btn-berry"
            disabled={total === 0}
            onClick={() => setOpen(true)}
          >
            {total === 0 ? 'No orders' : 'Remove all orders'}
          </button>
        </div>

        {total != null ? (
          <div className="tiny faint">
            {total === 0
              ? 'The order book is already empty.'
              : `${total} order${total === 1 ? '' : 's'} in the book right now.`}
          </div>
        ) : null}
      </div>

      {open ? (
        <Modal
          title="Remove all orders?"
          subtitle="This cannot be undone"
          onClose={close}
          width="460px"
          footer={
            <>
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button
                type="button"
                className="btn btn-berry"
                disabled={busy || password.length === 0}
                onClick={clear}
              >
                {busy ? <Spinner /> : `Remove ${total ?? ''} order${total === 1 ? '' : 's'}`}
              </button>
            </>
          }
        >
          {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

          <Alert kind="warn">
            <strong>{total}</strong> order{total === 1 ? '' : 's'} will be deleted, along with
            their items, history and any Grab bookings. There is no undo — take a copy of
            <code> apps/api/data/store.json</code> first if you might want them back.
          </Alert>

          <Field label="Your password" hint="Asked again because this cannot be reversed.">
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password && !busy) clear();
              }}
            />
          </Field>
        </Modal>
      ) : null}
    </section>
  );
}
