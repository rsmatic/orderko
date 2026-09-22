import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert, Field, Spinner } from '../components/ui';

const DEMO = [
  { role: 'Admin',    email: 'admin@orderko.test' },
  { role: 'Manager',  email: 'manager@orderko.test' },
  { role: 'Customer', email: 'cust@orderko.test' },
];

const landingFor = (role) =>
  role === 'admin' ? '/admin' : role === 'manager' ? '/manager' : '/';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(email.trim(), password);
      navigate(location.state?.from ?? landingFor(user.role), { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <Link to="/" className="brand" style={{ justifyContent: 'center', textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden="true">🥣</span> Orderko
        </Link>

        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h3>Sign in</h3></div>
          <div className="panel-body stack">
            {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

            <Field label="Email">
              <input
                className="input" type="email" required autoFocus autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                className="input" type="password" required minLength={8} autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? <Spinner /> : 'Sign in'}
            </button>

            <div className="small center muted">
              No account? <Link to="/register" className="strong">Create one</Link>
            </div>
          </div>
        </form>

        <div className="card card-pad stack-s">
          <div className="tiny strong muted">Seeded accounts · password Password123!</div>
          {DEMO.map((d) => (
            <button
              key={d.email}
              type="button"
              className="btn btn-sm"
              onClick={() => { setEmail(d.email); setPassword('Password123!'); }}
            >
              {d.role} — {d.email}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        password: form.password,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <Link to="/" className="brand" style={{ justifyContent: 'center', textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden="true">🥣</span> Orderko
        </Link>

        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h3>Create an account</h3></div>
          <div className="panel-body stack">
            {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

            <Field label="Name">
              <input
                className="input" required minLength={2} autoFocus
                value={form.name} onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                className="input" type="email" required autoComplete="email"
                value={form.email} onChange={(e) => set({ email: e.target.value })}
              />
            </Field>
            <Field label="Phone" hint="So we can reach you about the order.">
              <input
                className="input" type="tel" placeholder="+60 12 345 6789"
                value={form.phone} onChange={(e) => set({ phone: e.target.value })}
              />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <input
                className="input" type="password" required minLength={8} autoComplete="new-password"
                value={form.password} onChange={(e) => set({ password: e.target.value })}
              />
            </Field>

            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? <Spinner /> : 'Create account'}
            </button>

            <div className="small center muted">
              Already have one? <Link to="/login" className="strong">Sign in</Link>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
