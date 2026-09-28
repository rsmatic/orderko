import { useState } from 'react';
import { api } from '../lib/api';
import { Alert, Field, Spinner } from './ui';

/**
 * Renaming and adding the groups the menu is sorted into.
 *
 * The API could always do this; there was simply no way to ask it from here,
 * so a category named for what it used to hold stayed that way for good.
 *
 * Deleting is deliberately absent: a category with items in it would orphan
 * them, and the cure for one nobody uses is to hide it.
 */
export default function CategoryManager({ categories, products, onChanged, onError }) {
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState('');

  const countIn = (id) => products.filter((p) => p.category_id === id).length;

  async function rename(cat, name) {
    const next = name.trim();
    if (!next || next === cat.name) return;
    setBusy(cat.id);
    try {
      await api.patch(`/catalog/categories/${cat.id}`, { name: next });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function setActive(cat, is_active) {
    setBusy(cat.id);
    try {
      await api.patch(`/catalog/categories/${cat.id}`, { is_active });
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const name = adding.trim();
    if (!name) return;
    setBusy('new');
    try {
      await api.post('/catalog/categories', { name, sort_order: categories.length + 1 });
      setAdding('');
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <Alert kind="info">
        Categories are the tabs a customer sees above the menu. Renaming one
        never moves an item — change the name here, and the category each item
        belongs to on the item itself.
      </Alert>

      {categories.map((c) => (
        <div key={c.id} className="edit-line">
          <div className="grow">
            <input
              className="input"
              defaultValue={c.name}
              disabled={busy === c.id}
              onBlur={(e) => rename(c, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            />
            <div className="tiny faint" style={{ marginTop: '.25rem' }}>
              {countIn(c.id) === 0
                ? 'No items — customers see an empty tab'
                : `${countIn(c.id)} item${countIn(c.id) === 1 ? '' : 's'}`}
            </div>
          </div>
          <label className="switch" style={{ flex: 'none' }}>
            <input
              type="checkbox"
              checked={Boolean(c.is_active)}
              disabled={busy === c.id}
              onChange={(e) => setActive(c, e.target.checked)}
            />
            Shown
          </label>
          {busy === c.id ? <Spinner /> : null}
        </div>
      ))}

      <Field label="Add a category" hint="It appears as a new tab once something is in it.">
        <div className="row-wrap">
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="e.g. Merienda"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={add}
            disabled={!adding.trim() || busy === 'new'}
          >
            {busy === 'new' ? <Spinner /> : 'Add'}
          </button>
        </div>
      </Field>
    </div>
  );
}
