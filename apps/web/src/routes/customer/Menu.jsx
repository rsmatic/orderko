import { useEffect, useMemo, useState } from 'react';
import { api, money } from '../../lib/api';
import { useCart } from '../../context/CartContext';
import { Loading, Empty, Alert } from '../../components/ui';
import Customizer from './Customizer';

export default function Menu() {
  const [menu, setMenu] = useState(null);
  const [error, setError] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState('');
  const cart = useCart();

  useEffect(() => {
    let cancelled = false;
    api
      .get('/catalog/menu')
      .then((data) => { if (!cancelled) setMenu(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    if (!menu) return [];
    return activeCategory === 'all'
      ? menu.products
      : menu.products.filter((p) => p.category_id === activeCategory);
  }, [menu, activeCategory]);

  if (error) return <div className="container" style={{ padding: '2rem 0' }}><Alert kind="error">{error}</Alert></div>;
  if (!menu) return <Loading label="Bringing out the jars…" />;

  const heroProduct = menu.products.find((p) => p.option_groups?.length) ?? menu.products[0];

  function handleAdd(line) {
    cart.add(line);
    setEditing(null);
    setToast(`${line.quantity}× ${line.product_name} added`);
  }

  return (
    <>
      <div className="container">
        <section className="hero">
          <div>
            <h1 className="hero-title">Oats that wait for you.</h1>
            <p className="hero-sub">
              Soaked overnight, packed in a jar, and built exactly how you like it —
              mix up to three fruits, choose your milk, and pile on the walnuts,
              Skippy peanut butter or chia seeds. Ready for pickup, or on a Grab
              bike to your door.
            </p>
            <div className="row-wrap" style={{ marginTop: '1.15rem' }}>
              {heroProduct ? (
                <button type="button" className="btn btn-primary btn-lg" onClick={() => setEditing(heroProduct)}>
                  Build your jar
                </button>
              ) : null}
              <span className="pill">
                🚴 {menu.settings.delivery_enabled ? 'Grab delivery available' : 'Pickup only today'}
              </span>
              <span className="pill">
                ⏱ Ready in ~{menu.settings.order_lead_mins} min
              </span>
            </div>
          </div>
          <div className="hero-art">
            <img
              src="https://images.unsplash.com/photo-1517093157656-b9eccef91cb1?w=900&q=75"
              alt="A jar of overnight oats topped with fresh fruit"
              loading="eager"
            />
          </div>
        </section>

        <nav className="cat-nav" aria-label="Menu categories">
          <button
            type="button"
            className="cat-chip"
            aria-pressed={activeCategory === 'all'}
            onClick={() => setActiveCategory('all')}
          >
            Everything
          </button>
          {menu.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className="cat-chip"
              aria-pressed={activeCategory === c.id}
              onClick={() => setActiveCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </nav>

        {visible.length === 0 ? (
          <Empty title="Nothing here yet" icon="🥣">Try another category.</Empty>
        ) : (
          <div className="grid grid-3" style={{ paddingBottom: '5rem' }}>
            {visible.map((product) => (
              <button
                key={product.id}
                type="button"
                className="product-card"
                onClick={() => setEditing(product)}
              >
                <div className="product-img">
                  {product.image_url ? (
                    <img src={product.image_url} alt="" loading="lazy" />
                  ) : null}
                </div>
                <div className="product-body">
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <h3>{product.name}</h3>
                    <span className="strong mono">{money(product.base_price)}</span>
                  </div>
                  <p className="product-desc">{product.description}</p>
                  <div className="row-wrap tiny faint">
                    {product.option_groups?.length ? (
                      <span className="pill tiny">
                        {product.option_groups.length} choices to make
                      </span>
                    ) : (
                      <span className="pill tiny">Ready as is</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <Customizer
          product={editing}
          onClose={() => setEditing(null)}
          onAdd={handleAdd}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          style={{
            position: 'fixed', bottom: '5.5rem', left: '50%', transform: 'translateX(-50%)',
            background: 'var(--ink)', color: 'var(--oat)', padding: '.6rem 1.1rem',
            borderRadius: 999, boxShadow: 'var(--shadow-lg)', fontSize: '.88rem',
            fontWeight: 600, zIndex: 50,
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
