import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert, Field, Spinner } from '../components/ui';
import DemoBanner from '../components/DemoBanner';
import GoogleSignIn from '../components/GoogleSignIn';

const landingFor = (role) =>
  role === 'admin' ? '/admin' : role === 'manager' ? '/manager' : '/';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(identifier.trim(), password);
      navigate(location.state?.from ?? landingFor(user.role), { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <><DemoBanner />
    <div className="auth-wrap">
      <div className="auth-card stack">
        <Link to="/" className="brand" style={{ justifyContent: 'center', textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden="true">🥣</span> Orderko
        </Link>

        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h3>Sign in</h3></div>
          <div className="panel-body stack">
            {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}

            <Field label="Email or mobile number">
              <input
                className="input" required autoFocus autoComplete="username"
                placeholder="you@example.com or 0915 386 8303"
                value={identifier} onChange={(e) => setIdentifier(e.target.value)}
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

            <GoogleSignIn text="signin_with" onSignedIn={(u) => navigate(landingFor(u.role), { replace: true })} />

            <div className="small center muted">
              No account? <Link to="/register" className="strong">Create one</Link>
            </div>
          </div>
        </form>
      </div>
    </div>
    </>
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
    <><DemoBanner />
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
            <Field label="Mobile number" hint="We use it to reach you about the order — and you can sign in with it.">
              <input
                className="input" type="tel" placeholder="+63 917 123 4567"
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

            <GoogleSignIn text="signup_with" onSignedIn={() => navigate('/', { replace: true })} />

            <div className="small center muted">
              Already have one? <Link to="/login" className="strong">Sign in</Link>
            </div>
          </div>
        </form>
      </div>
    </div>
    </>
  );
}
