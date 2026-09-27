import { useState } from 'react';
import { api, money } from '../lib/api';
import { Modal, Alert, Spinner } from './ui';

/**
 * Removes an order from the books for good.
 *
 * Not the same as cancelling. Cancelling records that an order was called off
 * and leaves it in the history; this says it should never have been counted —
 * a test order, a duplicate — and takes its money out of the reports with it.
 *
 * Admin only, and worth a sentence of explanation before the button, because
 * there is nothing to undo it with.
 */
export default function DeleteOrder({ order, onClose, onDeleted, onError }) {
  const [busy, setBusy] = useState(false);
  const settled = ['completed', 'cancelled'].includes(order.status);

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/orders/${order.id}`);
      onDeleted(`${order.order_number} was deleted`);
    } catch (err) {
      onError(err.message);
      onClose();
    }
  }

  return (
    <Modal
      title={`Delete ${order.order_number}?`}
      subtitle={`${money(order.total, order.currency)} · ${order.contact_name}`}
      onClose={onClose}
      width="440px"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-berry" onClick={remove} disabled={busy}>
            {busy ? <Spinner /> : 'Delete for good'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        This removes the order, its items and its history. It cannot be undone,
        and the only trace left is a line in the activity log.
      </p>

      {order.payment_status === 'paid' ? (
        <Alert kind="warn">
          This order is marked <strong>paid</strong>. Deleting it takes
          {' '}{money(order.total, order.currency)} out of your reports.
        </Alert>
      ) : null}

      <Alert kind="info">
        Anything it was holding in stock is put back, since a deleted order is
        no longer there to explain where it went.
      </Alert>

      {!settled ? (
        <div className="small muted">
          This order is still in progress. If it simply is not going ahead,
          close this and <strong>cancel</strong> it instead — that keeps it in
          the books with a reason, which is usually what you want.
        </div>
      ) : null}
    </Modal>
  );
}
