import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import CartDrawer from './CartDrawer';
import DemoBanner from '../../components/DemoBanner';

export default function StoreLayout() {
  const { user, logout, isStaff } = useAuth();
  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);

  return (
    <div className="shell">
      <DemoBanner />
      <header className="store-header">
        <div className="container store-header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">🥣</span>
            Orderko
          </Link>

          <nav className="row grow" style={{ justifyContent: 'flex-end' }}>
            <NavLink to="/" end className="btn btn-ghost btn-sm">Menu</NavLink>
            {user ? (
              <NavLink to="/orders" className="btn btn-ghost btn-sm">My orders</NavLink>
            ) : null}
            {isStaff ? (
              <NavLink
                to={user.role === 'admin' ? '/admin' : '/manager'}
                className="btn btn-sm"
              >
                {user.role === 'admin' ? 'Admin' : 'Manager'} dashboard
              </NavLink>
            ) : null}
            {user ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                Sign out
              </button>
            ) : (
              <Link to="/login" className="btn btn-sm">Sign in</Link>
            )}
          </nav>
        </div>
      </header>

      <main style={{ flex: 1 }}>
        <Outlet />
      </main>

      <footer className="container" style={{ padding: '2rem 0', borderTop: '1px solid var(--line)', marginTop: '2rem' }}>
        <div className="spread small muted">
          <span>Orderko Overnight Oats</span>
          <span className="tiny faint">Delivery by Grab</span>
        </div>
      </footer>

      {cart.count > 0 ? (
        <button type="button" className="cart-fab" onClick={() => setCartOpen(true)}>
          🫙 Basket
          <span className="cart-count">{cart.count}</span>
        </button>
      ) : null}

      {cartOpen ? <CartDrawer onClose={() => setCartOpen(false)} /> : null}
    </div>
  );
}
