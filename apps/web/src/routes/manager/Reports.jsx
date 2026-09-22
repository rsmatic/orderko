import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, LabelList, Cell,
} from 'recharts';
import { api, money } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Stat, Empty } from '../../components/ui';

/**
 * Chart roles, not raw hex, so the palette swaps in one place.
 * Values come from the validated default categorical palette
 * (blue slot 1, orange slot 2) checked against a #ffffff surface.
 */
const VIZ = {
  series1: '#2a78d6',
  series2: '#eb6834',
  grid: '#e3d9c9',
  axis: '#8b8073',
  ink: '#241d15',
};

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const shortDay = (value) =>
  new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short' }).format(new Date(value));

function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: 'var(--cream)', border: '1px solid var(--line)',
        borderRadius: 'var(--radius-sm)', padding: '.5rem .7rem',
        boxShadow: 'var(--shadow)', fontSize: '.82rem',
      }}
    >
      <div className="tiny faint" style={{ marginBottom: '.15rem' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="row" style={{ gap: '.4rem' }}>
          <span
            aria-hidden="true"
            style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flex: 'none' }}
          />
          <span className="strong mono">{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Reports() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setStats(null);
    api
      .get(`/admin/stats?days=${days}`, { signal: controller.signal })
      .then((res) => { setStats(res); setError(''); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [days]);

  if (error) {
    return (
      <>
        <DashHeader title="Reports" />
        <div className="dash-body"><Alert kind="error">{error}</Alert></div>
      </>
    );
  }
  if (!stats) {
    return <><DashHeader title="Reports" /><div className="dash-body"><Loading /></div></>;
  }

  const daily = stats.daily.map((d) => ({
    ...d,
    day: shortDay(d.day),
    revenue: Number(d.revenue),
    orders: Number(d.orders),
  }));
  const topProducts = stats.top_products.map((p) => ({
    ...p, qty: Number(p.qty), revenue: Number(p.revenue),
  }));
  const topOptions = stats.top_options.slice(0, 10).map((o) => ({
    ...o, picks: Number(o.picks), label: o.option_name,
  }));
  const delivery = stats.fulfillment.find((f) => f.fulfillment_type === 'delivery');
  const pickup = stats.fulfillment.find((f) => f.fulfillment_type === 'pickup');

  return (
    <>
      <DashHeader title="Reports" subtitle={`Last ${days} days`}>
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            className="cat-chip"
            aria-pressed={days === r.days}
            onClick={() => setDays(r.days)}
          >
            {r.label}
          </button>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Show charts' : 'Show table'}
        </button>
      </DashHeader>

      <div className="dash-body stack">
        <div className="grid grid-4">
          <Stat
            label="Today"
            value={money(stats.today.revenue)}
            note={`${stats.today.orders} order${stats.today.orders === 1 ? '' : 's'}`}
          />
          <Stat
            label={`Revenue · ${days}d`}
            value={money(stats.period.revenue)}
            note={`${stats.period.orders} orders`}
          />
          <Stat
            label="Average order"
            value={money(stats.period.avg_order_value)}
            note="Excludes cancelled"
          />
          <Stat
            label="Open right now"
            value={stats.open_orders}
            note="Not yet completed"
            tone={stats.open_orders > 0 ? 'berry' : undefined}
          />
        </div>

        {showTable ? (
          <section className="panel">
            <div className="panel-head"><h3>Daily figures</h3></div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Day</th><th className="right">Orders</th><th className="right">Revenue</th></tr>
                </thead>
                <tbody>
                  {daily.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="right mono">{d.orders}</td>
                      <td className="right mono">{money(d.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="grid grid-2">
            <section className="panel">
              <div className="panel-head"><h3>Revenue per day</h3></div>
              <div className="panel-body">
                {daily.length === 0 ? (
                  <Empty icon="📈" title="No orders in this window" />
                ) : (
                  <ResponsiveContainer width="100%" height={230}>
                    <AreaChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                      <defs>
                        <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={VIZ.series1} stopOpacity={0.22} />
                          <stop offset="100%" stopColor={VIZ.series1} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={VIZ.grid} strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="day" tickLine={false} axisLine={false}
                        tick={{ fill: VIZ.axis, fontSize: 11 }} minTickGap={18}
                      />
                      <YAxis
                        tickLine={false} axisLine={false} width={54}
                        tick={{ fill: VIZ.axis, fontSize: 11 }}
                        tickFormatter={(v) => `RM${v}`}
                      />
                      <Tooltip
                        content={<ChartTooltip formatter={(v) => money(v)} />}
                        cursor={{ stroke: VIZ.axis, strokeWidth: 1, strokeDasharray: '3 3' }}
                      />
                      <Area
                        type="monotone" dataKey="revenue"
                        stroke={VIZ.series1} strokeWidth={2}
                        fill="url(#revenueFill)"
                        activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head"><h3>Orders per day</h3></div>
              <div className="panel-body">
                {daily.length === 0 ? (
                  <Empty icon="🧾" title="No orders in this window" />
                ) : (
                  <ResponsiveContainer width="100%" height={230}>
                    <BarChart data={daily} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke={VIZ.grid} strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="day" tickLine={false} axisLine={false}
                        tick={{ fill: VIZ.axis, fontSize: 11 }} minTickGap={18}
                      />
                      <YAxis
                        tickLine={false} axisLine={false} width={40} allowDecimals={false}
                        tick={{ fill: VIZ.axis, fontSize: 11 }}
                      />
                      <Tooltip
                        content={<ChartTooltip formatter={(v) => `${v} orders`} />}
                        cursor={{ fill: 'rgba(36,29,21,.05)' }}
                      />
                      <Bar dataKey="orders" fill={VIZ.series2} radius={[4, 4, 0, 0]} maxBarSize={26} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>
          </div>
        )}

        <div className="grid grid-2">
          <section className="panel">
            <div className="panel-head">
              <h3>Best sellers</h3>
              <span className="tiny faint">jars sold</span>
            </div>
            <div className="panel-body">
              {topProducts.length === 0 ? (
                <Empty icon="🥣" title="Nothing sold yet" />
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(160, topProducts.length * 38)}>
                  <BarChart
                    data={topProducts}
                    layout="vertical"
                    margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke={VIZ.grid} strokeDasharray="2 4" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      type="category" dataKey="product_name" width={155}
                      tickLine={false} axisLine={false}
                      tick={{ fill: VIZ.ink, fontSize: 12 }}
                    />
                    <Tooltip
                      content={<ChartTooltip formatter={(v) => `${v} sold`} />}
                      cursor={{ fill: 'rgba(36,29,21,.05)' }}
                    />
                    <Bar dataKey="qty" fill={VIZ.series1} radius={[0, 4, 4, 0]} maxBarSize={18}>
                      <LabelList
                        dataKey="qty" position="right"
                        style={{ fill: VIZ.axis, fontSize: 11, fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Most-picked add-ons</h3>
              <span className="tiny faint">times chosen</span>
            </div>
            <div className="panel-body">
              {topOptions.length === 0 ? (
                <Empty icon="🍓" title="No options chosen yet" />
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(160, topOptions.length * 32)}>
                  <BarChart
                    data={topOptions}
                    layout="vertical"
                    margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke={VIZ.grid} strokeDasharray="2 4" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      type="category" dataKey="label" width={135}
                      tickLine={false} axisLine={false}
                      tick={{ fill: VIZ.ink, fontSize: 12 }}
                    />
                    <Tooltip
                      content={<ChartTooltip formatter={(v) => `${v} times`} />}
                      cursor={{ fill: 'rgba(36,29,21,.05)' }}
                    />
                    <Bar dataKey="picks" radius={[0, 4, 4, 0]} maxBarSize={16}>
                      {topOptions.map((o) => (
                        <Cell key={o.option_name} fill={VIZ.series1} />
                      ))}
                      <LabelList
                        dataKey="picks" position="right"
                        style={{ fill: VIZ.axis, fontSize: 11, fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>

        <div className="grid grid-2">
          <section className="panel">
            <div className="panel-head"><h3>Pickup vs delivery</h3></div>
            <div className="panel-body grid grid-2">
              <Stat
                label="🏪 Pickup"
                value={pickup?.n ?? 0}
                note="orders collected"
              />
              <Stat
                label="🚴 Grab delivery"
                value={delivery?.n ?? 0}
                note={`${money(delivery?.delivery_fees ?? 0)} in delivery fees`}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h3>Where orders ended up</h3></div>
            <div className="panel-body">
              <table className="table">
                <tbody>
                  {stats.by_status.map((s) => (
                    <tr key={s.status}>
                      <td className="small" style={{ textTransform: 'capitalize' }}>{s.status}</td>
                      <td className="right mono strong">{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
