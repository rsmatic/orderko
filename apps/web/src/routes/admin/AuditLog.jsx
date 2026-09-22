import { useEffect, useState } from 'react';
import { api, dateTime } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Empty } from '../../components/ui';

const TONE = (action) => {
  if (action.includes('delete') || action.includes('cancel')) return 'badge-berry';
  if (action.includes('create')) return 'badge-leaf';
  if (action.includes('status') || action.includes('book')) return 'badge-sky';
  return 'badge-neutral';
};

export default function AuditLog() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/admin/audit?limit=150', { signal: controller.signal })
      .then((res) => setEntries(res.entries))
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, []);

  return (
    <>
      <DashHeader title="Activity log" subtitle="Every change staff made, newest first" />
      <div className="dash-body">
        {error ? <Alert kind="error">{error}</Alert> : null}

        <div className="panel">
          {!entries ? (
            <Loading />
          ) : entries.length === 0 ? (
            <Empty title="Nothing logged yet" icon="🗒️" />
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.created_at)}</td>
                      <td className="small">
                        {e.user_name ?? <span className="faint">system</span>}
                      </td>
                      <td><span className={`badge ${TONE(e.action)}`}>{e.action}</span></td>
                      <td className="small mono faint">
                        {e.entity ? `${e.entity}${e.entity_id ? ` #${e.entity_id}` : ''}` : '—'}
                      </td>
                      <td className="tiny faint" style={{ maxWidth: 360 }}>
                        {e.meta ? (
                          <code style={{ wordBreak: 'break-word' }}>
                            {typeof e.meta === 'string' ? e.meta : JSON.stringify(e.meta)}
                          </code>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
