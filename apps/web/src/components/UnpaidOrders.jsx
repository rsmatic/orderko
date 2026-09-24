import { useEffect, useState } from 'react';
import { api, money, dateTime } from '../lib/api';
import { Modal, Alert, Loading, Empty, StatusBadge } from './ui';

/**
 * Who owes money, and how long they have owed it.
 *
 * The tile answers "how much"; this answers "from whom", which is the only
 * version of the question anyone can act on. Picking a row hands the order
 * straight to the sheet that can mark it paid.
 */
export default function UnpaidOrders({ onClose, onPick }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/orders?payment_status=unpaid&limit=200', { signal: controller.signal })
      .then((res) => { setRows(res.orders); setError(''); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, []);

  const total = (rows ?? []).reduce((sum, o) => sum + Number(o.total), 0);

  return (
    <Modal
      title="Not yet paid"
      subtitle={rows ? `${rows.length} order${rows.length === 1 ? '' : 's'} · ${money(total)} outstanding` : 'Loading…'}
      onClose={onClose}
      width="720px"
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      {error ? <Alert kind="error">{error}</Alert> : null}

      {!rows ? <Loading label="Checking the books…" /> : rows.length === 0 ? (
        <Empty title="Everyone has paid" icon="🎉">
          <span className="small muted">Nothing outstanding.</span>
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Who</th>
                <th>Status</th>
                <th>Placed</th>
                <th className="right">Owed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.id}
                  className="clickable"
                  onClick={() => onPick(o.id)}
                  title="Open this order"
                >
                  <td className="mono small">{o.order_number}</td>
                  <td>
                    <div className="strong">{o.contact_name}</div>
                    <div className="tiny faint">{o.contact_phone}</div>
                  </td>
                  <td><StatusBadge status={o.status} /></td>
                  <td className="small muted">{dateTime(o.created_at)}</td>
                  <td className="right mono">{money(o.total, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
