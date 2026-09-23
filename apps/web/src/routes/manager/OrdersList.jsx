import { useCallback, useEffect, useState } from 'react';
import { api, money, dateTime } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Empty, StatusBadge, PaymentBadge, DeliveryBadge } from '../../components/ui';
import OrderDetail from '../../components/OrderDetail';
import { useLiveOrders } from '../../lib/useLiveOrders';
import LiveDot from '../../components/LiveDot';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending,confirmed,preparing,ready,dispatched', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'ready', label: 'Ready' },
  { value: 'dispatched', label: 'On the way' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PAGE = 25;

export default function OrdersList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(
    (signal) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (status) params.set('status', status);
      if (fulfillment) params.set('fulfillment_type', fulfillment);
      if (search.trim()) params.set('search', search.trim());

      return api
        .get(`/orders?${params}`, { signal })
        .then((res) => { setData(res); setError(''); })
        .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    },
    [status, fulfillment, search, offset],
  );

  // Debounce so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => load(controller.signal), search ? 300 : 0);
    return () => { clearTimeout(t); controller.abort(); };
  }, [load, search]);

  useEffect(() => { setOffset(0); }, [status, fulfillment, search]);

  // New orders arrive on their own; nobody should have to press Refresh to
  // find out the shop has work waiting.
  const { live, checkedAt } = useLiveOrders(() => load());

  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <DashHeader title="Orders" subtitle={data ? `${total} order${total === 1 ? '' : 's'}` : 'Loading…'}>
        <LiveDot live={live} checkedAt={checkedAt} />
        <input
          className="input"
          style={{ width: 230 }}
          placeholder="Order no, name or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select" style={{ width: 150 }} value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
          <option value="">Pickup & delivery</option>
          <option value="pickup">Pickup only</option>
          <option value="delivery">Delivery only</option>
        </select>
      </DashHeader>

      <div className="dash-body stack">
        {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

        <div className="row-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              className="cat-chip"
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="panel">
          {!data ? (
            <Loading />
          ) : orders.length === 0 ? (
            <Empty title="No orders match" icon="🔍">Try a different filter.</Empty>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Delivery</th>
                    <th>Payment</th>
                    <th className="right">Total</th>
                    <th>Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="clickable" onClick={() => setOpenId(o.id)}>
                      <td className="strong mono">{o.order_number}</td>
                      <td>
                        <div>{o.contact_name}</div>
                        <div className="tiny faint">{o.contact_phone}</div>
                      </td>
                      <td className="small">{o.fulfillment_type === 'delivery' ? '🚴 Delivery' : '🏪 Pickup'}</td>
                      <td><StatusBadge status={o.status} /></td>
                      <td>
                        {o.delivery_status ? (
                          <>
                            <DeliveryBadge status={o.delivery_status} />
                            {o.driver_name ? <div className="tiny faint">{o.driver_name}</div> : null}
                          </>
                        ) : (
                          <span className="tiny faint">—</span>
                        )}
                      </td>
                      <td><PaymentBadge status={o.payment_status} /></td>
                      <td className="right mono strong">{money(o.total, o.currency)}</td>
                      <td className="small muted">{dateTime(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {total > PAGE ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            >
              ← Previous
            </button>
            <span className="small muted">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset((o) => o + PAGE)}
            >
              Next →
            </button>
          </div>
        ) : null}
      </div>

      {openId ? (
        <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={() => load()} />
      ) : null}
    </>
  );
}
