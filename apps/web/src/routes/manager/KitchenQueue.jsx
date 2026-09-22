import { useCallback, useEffect, useState } from 'react';
import { api, money, relativeMinutes } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Empty, DeliveryBadge, Spinner } from '../../components/ui';
import OrderDetail from '../../components/OrderDetail';

const COLUMNS = [
  { status: 'pending',    title: 'New',        next: 'confirmed',  action: 'Confirm' },
  { status: 'confirmed',  title: 'Confirmed',  next: 'preparing',  action: 'Start' },
  { status: 'preparing',  title: 'Building',   next: 'ready',      action: 'Ready' },
  { status: 'ready',      title: 'Ready',      next: null,         action: null },
  { status: 'dispatched', title: 'Out',        next: 'delivered',  action: 'Delivered' },
];

/** An order sitting in one column longer than this gets flagged. */
const STALE_MINUTES = { pending: 5, confirmed: 10, preparing: 25, ready: 15, dispatched: 60 };

export default function KitchenQueue() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [auto, setAuto] = useState(true);

  const load = useCallback(
    () =>
      api
        .get('/orders/queue')
        .then((res) => { setOrders(res.orders); setError(''); })
        .catch((err) => setError(err.message)),
    [],
  );

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [auto, load]);

  async function advance(order, next) {
    setBusyId(order.id);
    try {
      await api.patch(`/orders/${order.id}/status`, { status: next });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function bookDriver(order) {
    setBusyId(order.id);
    try {
      await api.post(`/delivery/orders/${order.id}/book`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <DashHeader
        title="Kitchen queue"
        subtitle={orders ? `${orders.length} order${orders.length === 1 ? '' : 's'} in flight` : 'Loading…'}
      >
        <label className="switch">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh
        </label>
        <button type="button" className="btn btn-sm" onClick={load}>Refresh now</button>
      </DashHeader>

      <div className="dash-body stack">
        {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

        {!orders ? (
          <Loading />
        ) : orders.length === 0 ? (
          <Empty title="Nothing in the queue" icon="✨">Every order is done. Enjoy the quiet.</Empty>
        ) : (
          <div className="kanban">
            {COLUMNS.map((col) => {
              const inColumn = orders.filter((o) => o.status === col.status);
              return (
                <section key={col.status} className="kanban-col">
                  <div className="kanban-head">
                    <span className="kanban-title">{col.title}</span>
                    <span className="badge badge-neutral">{inColumn.length}</span>
                  </div>

                  {inColumn.length === 0 ? (
                    <div className="tiny faint center" style={{ padding: '1rem 0' }}>—</div>
                  ) : (
                    inColumn.map((order) => {
                      const stale = order.age_minutes > (STALE_MINUTES[col.status] ?? 30);
                      const needsDriver =
                        order.fulfillment_type === 'delivery' &&
                        order.status === 'ready' &&
                        !order.delivery_status;

                      return (
                        <article
                          key={order.id}
                          className={`ticket ${stale ? 'urgent' : ''}`}
                          onClick={() => setOpenId(order.id)}
                        >
                          <div className="spread">
                            <span className="strong small">{order.order_number}</span>
                            <span className={`tiny ${stale ? 'strong' : 'faint'}`} style={stale ? { color: 'var(--berry)' } : undefined}>
                              {order.age_minutes}m
                            </span>
                          </div>

                          <div className="tiny muted" style={{ marginBottom: '.3rem' }}>
                            {order.contact_name} ·{' '}
                            {order.fulfillment_type === 'delivery' ? '🚴 delivery' : '🏪 pickup'}
                          </div>

                          {order.items.map((item) => (
                            <div key={item.id} className="ticket-item">
                              <div className="strong">{item.quantity}× {item.product_name}</div>
                              {item.option_summary ? (
                                <div className="ticket-opts">{item.option_summary}</div>
                              ) : null}
                              {item.notes ? (
                                <div className="tiny" style={{ color: 'var(--berry)', fontStyle: 'italic' }}>
                                  “{item.notes}”
                                </div>
                              ) : null}
                            </div>
                          ))}

                          <div className="spread" style={{ marginTop: '.55rem' }}>
                            <span className="tiny mono faint">{money(order.total, order.currency)}</span>
                            {order.delivery_status ? <DeliveryBadge status={order.delivery_status} /> : null}
                          </div>

                          <div
                            className="row-wrap"
                            style={{ marginTop: '.5rem', gap: '.35rem' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {needsDriver ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-leaf"
                                disabled={busyId === order.id}
                                onClick={() => bookDriver(order)}
                              >
                                {busyId === order.id ? <Spinner /> : '🚴 Book driver'}
                              </button>
                            ) : null}

                            {col.next ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={busyId === order.id}
                                onClick={() => advance(order, col.next)}
                              >
                                {busyId === order.id ? <Spinner /> : col.action}
                              </button>
                            ) : null}

                            {col.status === 'ready' && order.fulfillment_type === 'pickup' ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={busyId === order.id}
                                onClick={() => advance(order, 'completed')}
                              >
                                Handed over
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {openId ? (
        <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      ) : null}
    </>
  );
}
