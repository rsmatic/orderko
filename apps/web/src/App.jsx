import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import { Loading } from './components/ui';

import StoreLayout from './routes/customer/StoreLayout';
import Menu from './routes/customer/Menu';
import Checkout from './routes/customer/Checkout';
import OrderTracking, { OrderHistory } from './routes/customer/OrderTracking';
import Login, { Register } from './routes/Login';

import DashboardLayout from './routes/DashboardLayout';
import KitchenQueue from './routes/manager/KitchenQueue';
import OrdersList from './routes/manager/OrdersList';
import MenuManager from './routes/manager/MenuManager';
import Users from './routes/admin/Users';
import Settings from './routes/admin/Settings';
import AuditLog from './routes/admin/AuditLog';

// Reports pulls in the charting library, which nothing else needs. Splitting it
// out keeps it off the storefront bundle.
const Reports = lazy(() => import('./routes/manager/Reports'));

const LazyReports = () => (
  <Suspense fallback={<Loading label="Loading charts…" />}>
    <Reports />
  </Suspense>
);

/** Customer-only gate: pushes guests to sign in, keeping where they came from. */
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function NotFound() {
  return (
    <div className="container" style={{ padding: '4rem 0', textAlign: 'center' }}>
      <h1>Nothing here</h1>
      <p className="muted">That page doesn't exist.</p>
      <Link to="/" className="btn btn-primary" style={{ marginTop: '1rem' }}>Back to the menu</Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            {/* Customer storefront */}
            <Route element={<StoreLayout />}>
              <Route index element={<Menu />} />
              <Route path="checkout" element={<Checkout />} />
              <Route path="orders" element={<RequireAuth><OrderHistory /></RequireAuth>} />
              <Route path="orders/:id" element={<OrderTracking />} />
              <Route path="*" element={<NotFound />} />
            </Route>

            {/* Manager dashboard — managers and admins */}
            <Route path="/manager" element={<DashboardLayout area="manager" />}>
              <Route index element={<KitchenQueue />} />
              <Route path="orders" element={<OrdersList />} />
              <Route path="menu" element={<MenuManager />} />
              <Route path="reports" element={<LazyReports />} />
            </Route>

            {/* Admin dashboard — admins only */}
            <Route path="/admin" element={<DashboardLayout area="admin" />}>
              <Route index element={<LazyReports />} />
              <Route path="orders" element={<OrdersList />} />
              <Route path="queue" element={<KitchenQueue />} />
              <Route path="menu" element={<MenuManager />} />
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Settings />} />
              <Route path="audit" element={<AuditLog />} />
            </Route>
          </Routes>
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
