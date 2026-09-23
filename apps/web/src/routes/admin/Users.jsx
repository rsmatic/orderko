import { useCallback, useEffect, useState } from 'react';
import { api, money, dateTime } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Empty, Modal, Field, Spinner } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

const ROLE_BADGE = {
  admin:    'badge-berry',
  manager:  'badge-sky',
  customer: 'badge-neutral',
};

export default function Users() {
  const { user: me } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(
    (signal) => {
      const params = new URLSearchParams({ limit: '100' });
      if (role) params.set('role', role);
      if (search.trim()) params.set('search', search.trim());
      return api
        .get(`/admin/users?${params}`, { signal })
        .then((res) => { setData(res); setError(''); })
        .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    },
    [role, search],
  );

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => load(controller.signal), search ? 300 : 0);
    return () => { clearTimeout(t); controller.abort(); };
  }, [load, search]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const users = data?.users ?? [];

  return (
    <>
      <DashHeader title="People" subtitle={data ? `${data.total} account${data.total === 1 ? '' : 's'}` : 'Loading…'}>
        <input
          className="input" style={{ width: 210 }}
          placeholder="Name, email or phone"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select" style={{ width: 140 }} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          <option value="admin">Admins</option>
          <option value="manager">Managers</option>
          <option value="customer">Customers</option>
        </select>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setEditing({ role: 'manager', name: '', email: '', phone: '', password: '' })}
        >
          + New account
        </button>
      </DashHeader>

      <div className="dash-body stack">
        {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}
        {notice ? <Alert kind="ok">{notice}</Alert> : null}

        <div className="panel">
          {!data ? (
            <Loading />
          ) : users.length === 0 ? (
            <Empty title="Nobody matches" icon="🔍" />
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Role</th>
                    <th className="right">Orders</th>
                    <th className="right">Lifetime</th>
                    <th>Status</th>
                    <th>Joined</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="strong">{u.name}</div>
                        {u.id === me.id ? <span className="tiny faint">that's you</span> : null}
                      </td>
                      <td>
                        <div className="small">{u.email}</div>
                        {u.phone ? <div className="tiny faint">{u.phone}</div> : null}
                      </td>
                      <td><span className={`badge ${ROLE_BADGE[u.role]}`}>{u.role}</span></td>
                      <td className="right mono">{u.order_count}</td>
                      <td className="right mono">{money(u.lifetime_value)}</td>
                      <td>
                        <span className={`badge ${u.is_active ? 'badge-leaf' : 'badge-neutral'}`}>
                          {u.is_active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="small muted">{dateTime(u.created_at)}</td>
                      <td className="right">
                        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>
                            Edit
                          </button>
                          {u.id === me.id ? null : (
                            <button
                              type="button"
                              className="btn btn-sm btn-berry"
                              onClick={() => setDeleting(u)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {deleting ? (
        <DeleteUser
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async (msg) => { setDeleting(null); await load(); setNotice(msg); }}
          onError={setError}
        />
      ) : null}

      {editing ? (
        <UserEditor
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); await load(); setNotice(msg); }}
          onError={setError}
        />
      ) : null}
    </>
  );
}

/**
 * Deleting an account is not the same as disabling one, and the difference
 * matters most to whoever is about to press the button — so the dialog says
 * what happens to the orders, and offers the smaller action instead.
 */
function DeleteUser({ user, onClose, onDeleted, onError }) {
  const [busy, setBusy] = useState(false);
  const orders = Number(user.order_count) || 0;

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/admin/users/${user.id}`);
      onDeleted(`${user.name} was deleted`);
    } catch (err) {
      onError(err.message);
      onClose();
    }
  }

  return (
    <Modal
      title={`Delete ${user.name}?`}
      subtitle={user.email}
      onClose={onClose}
      width="430px"
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
        This removes the account for good. They will not be able to sign in, and
        the name, email address and mobile number go with it.
      </p>

      {orders > 0 ? (
        <Alert kind="warn">
          Their {orders === 1 ? 'order stays' : `${orders} orders stay`} in the
          books, under the name and number given at checkout — deleting someone
          should not quietly change what you sold.
        </Alert>
      ) : null}

      <div className="small muted">
        If you only want to stop them signing in, close this and use
        <strong> Edit</strong> to set the account to disabled instead. That keeps
        it in this list and can be undone.
      </div>
    </Modal>
  );
}

function UserEditor({ user, isSelf, onClose, onSaved, onError }) {
  const isNew = !user.id;
  const [form, setForm] = useState({
    name: user.name ?? '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    role: user.role ?? 'customer',
    is_active: Boolean(user.is_active ?? true),
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setBusy(true);
    try {
      if (isNew) {
        await api.post('/admin/users', {
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          role: form.role,
          password: form.password,
        });
        onSaved('Account created');
      } else {
        const body = {
          name: form.name.trim(),
          phone: form.phone.trim() || null,
          role: form.role,
          is_active: form.is_active,
        };
        const email = form.email.trim().toLowerCase();
        if (email && email !== (user.email ?? '').toLowerCase()) body.email = email;
        if (form.password) body.password = form.password;
        await api.patch(`/admin/users/${user.id}`, body);
        onSaved('Account updated');
      }
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  const valid =
    form.name.trim().length >= 2 &&
    form.email.includes('@') &&
    (!isNew || form.password.length >= 8);

  return (
    <Modal
      title={isNew ? 'New account' : form.name}
      subtitle={isNew ? 'Give someone access' : user.email}
      onClose={onClose}
      width="520px"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={save}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <Field
        label="Email"
        hint={isNew ? undefined : 'This is their sign-in name — changing it changes how they log in.'}
      >
        <input
          className="input" type="email" required
          value={form.email} onChange={(e) => set({ email: e.target.value })}
        />
      </Field>

      <Field label="Phone">
        <input className="input" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
      </Field>

      <Field
        label="Role"
        hint="Managers run the shop floor and the menu. Admins can also manage people and settings."
      >
        <select
          className="select" value={form.role}
          disabled={isSelf}
          onChange={(e) => set({ role: e.target.value })}
        >
          <option value="customer">Customer</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
      </Field>

      <Field
        label={isNew ? 'Password' : 'New password'}
        hint={isNew ? 'At least 8 characters.' : 'Leave blank to keep the current one.'}
      >
        <input
          className="input" type="password" minLength={8} autoComplete="new-password"
          value={form.password} onChange={(e) => set({ password: e.target.value })}
        />
      </Field>

      {!isNew ? (
        <label className="switch">
          <input
            type="checkbox" checked={form.is_active} disabled={isSelf}
            onChange={(e) => set({ is_active: e.target.checked })}
          />
          Account active
          {isSelf ? <span className="tiny faint">(you can't disable yourself)</span> : null}
        </label>
      ) : null}
    </Modal>
  );
}
