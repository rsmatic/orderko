import { Link, NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loading } from '../components/ui';
import DemoBanner from '../components/DemoBanner';

const MANAGER_NAV = [
  { to: '/manager',          end: true, icon: '🔥', label: 'Kitchen queue' },
  { to: '/manager/orders',   icon: '🧾', label: 'All orders' },
  { to: '/manager/menu',     icon: '🥣', label: 'Menu & prices' },
  { to: '/manager/reports',  icon: '📈', label: 'Reports' },
];

const ADMIN_NAV = [
  { to: '/admin',            end: true, icon: '📊', label: 'Overview' },
  { to: '/admin/orders',     icon: '🧾', label: 'Orders' },
  { to: '/admin/queue',      icon: '🔥', label: 'Kitchen queue' },
  { to: '/admin/menu',       icon: '🥣', label: 'Menu & prices' },
  { to: '/admin/users',      icon: '👥', label: 'People' },
  { to: '/admin/settings',   icon: '⚙️', label: 'Shop settings' },
  { to: '/admin/audit',      icon: '🗒️', label: 'Activity log' },
];

/**
 * Shared chrome for both dashboards. `area` decides the nav and which roles
 * may enter: the manager area admits managers and admins, the admin area
 * admits admins only.
 */
export default function DashboardLayout({ area }) {
  const { user, loading, logout } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const allowed =
    area === 'admin' ? user.role === 'admin' : user.role === 'admin' || user.role === 'manager';

  if (!allowed) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card card-pad stack center">
          <h2>Not your door</h2>
          <p className="muted small">
            You're signed in as <strong>{user.name}</strong> ({user.role}), which doesn't have
            access to the {area} dashboard.
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link to="/" className="btn">Back to the shop</Link>
            {user.role === 'manager' ? (
              <Link to="/manager" className="btn btn-primary">Manager dashboard</Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const nav = area === 'admin' ? ADMIN_NAV : MANAGER_NAV;

  return (
    <div className="dash">
      <aside className="sidebar">
        <Link to="/" className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">🥣</span>
          Orderko
        </Link>

        <div className="sidebar-section">
          {area === 'admin' ? 'Administration' : 'Shop floor'}
        </div>
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}

        {area === 'manager' && user.role === 'admin' ? (
          <>
            <div className="sidebar-section">Also</div>
            <NavLink to="/admin" className="sidebar-link">
              <span aria-hidden="true">📊</span> Admin dashboard
            </NavLink>
          </>
        ) : null}

        <div className="sidebar-foot">
          <div className="sidebar-link" style={{ cursor: 'default' }}>
            <span aria-hidden="true">👤</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.name}
              </span>
              <span className="tiny" style={{ opacity: .65 }}>{user.role}</span>
            </span>
          </div>
          <button
            type="button"
            className="sidebar-link"
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
            onClick={logout}
          >
            <span aria-hidden="true">↩</span> Sign out
          </button>
        </div>
      </aside>

      <div className="dash-main">
        <DemoBanner />
        <Outlet />
      </div>
    </div>
  );
}

export function DashHeader({ title, subtitle, children }) {
  return (
    <header className="dash-head">
      <div>
        <h1 style={{ fontSize: '1.4rem' }}>{title}</h1>
        {subtitle ? <div className="small muted">{subtitle}</div> : null}
      </div>
      {children ? <div className="row-wrap">{children}</div> : null}
    </header>
  );
}
