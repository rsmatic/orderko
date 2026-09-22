import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

const ShopContext = createContext(null);

/**
 * The shop's public settings — name, branding, currency. Fetched once and
 * shared, because the header needs it on every page and it changes rarely.
 */
export function ShopProvider({ children }) {
  const [settings, setSettings] = useState(null);

  const load = useCallback(
    (signal) =>
      api
        .get('/catalog/settings', { signal })
        .then(setSettings)
        // A failure here should never blank the storefront; the fallbacks in
        // `shop()` cover it.
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const value = useMemo(() => ({ settings, reload: () => load() }), [settings, load]);
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

const FALLBACK = {
  shop_name: 'Orderko',
  logo_url: '',
  hero_image_url: '',
  currency: 'PHP',
};

/** Always returns something renderable, even before the fetch lands. */
export function useShop() {
  const ctx = useContext(ShopContext);
  return {
    shop: { ...FALLBACK, ...(ctx?.settings ?? {}) },
    reload: ctx?.reload ?? (() => {}),
  };
}
