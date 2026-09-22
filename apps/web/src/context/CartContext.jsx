import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const CartContext = createContext(null);
const STORAGE_KEY = 'oats.cart';

const load = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Two lines merge only if the same product carries the same options and note. */
const signature = (line) =>
  [line.product_id, [...line.option_ids].sort((a, b) => a - b).join('.'), line.notes ?? '']
    .join('|');

export function CartProvider({ children }) {
  const [lines, setLines] = useState(load);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch { /* ignore */ }
  }, [lines]);

  const add = useCallback((line) => {
    setLines((prev) => {
      const sig = signature(line);
      const existing = prev.findIndex((l) => signature(l) === sig);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = {
          ...next[existing],
          quantity: Math.min(50, next[existing].quantity + line.quantity),
        };
        return next;
      }
      return [...prev, { ...line, key: `${sig}-${Date.now()}` }];
    });
  }, []);

  const setQuantity = useCallback((key, quantity) => {
    setLines((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, quantity) } : l)),
    );
  }, []);

  const remove = useCallback((key) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo(
    () => ({
      lines,
      add,
      setQuantity,
      remove,
      clear,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      // Shape the API expects. Display prices are always recomputed server side.
      payload: lines.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        option_ids: l.option_ids,
        notes: l.notes || null,
      })),
    }),
    [lines, add, setQuantity, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
