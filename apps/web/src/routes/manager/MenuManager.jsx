import { useCallback, useEffect, useState } from 'react';
import { groupRuleProblem } from '@overnight-oats/core';
import { api, money } from '../../lib/api';
import { DashHeader } from '../DashboardLayout';
import { Loading, Alert, Modal, Field, Spinner, Empty } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

const emptyProduct = (categories) => ({
  category_id: categories[0]?.id ?? 1,
  name: '',
  description: '',
  base_price: '150',
  image_url: '',
  is_active: true,
  track_stock: false,
  stock_qty: 0,
  sort_order: 0,
  option_group_ids: [],
});

const emptyOption = (groupId) => ({
  group_id: groupId,
  name: '',
  description: '',
  price_delta: '0',
  is_available: true,
  track_stock: false,
  stock_qty: 0,
  sort_order: 0,
});

export default function MenuManager() {
  const { isAdmin } = useAuth();
  const [menu, setMenu] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('products');
  const [editingProduct, setEditingProduct] = useState(null);
  const [editingOption, setEditingOption] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(
    () =>
      api
        .get('/catalog/menu')
        .then((data) => { setMenu(data); setError(''); })
        .catch((err) => setError(err.message)),
    [],
  );

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  async function patch(path, body, label) {
    setBusyId(label);
    try {
      await api.patch(path, body);
      await load();
      setNotice('Saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!menu) return <><DashHeader title="Menu & prices" /><div className="dash-body"><Loading /></div></>;

  return (
    <>
      <DashHeader title="Menu & prices" subtitle="Items, options and what each one costs">
        {tab === 'products' ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setEditingProduct(emptyProduct(menu.categories))}
          >
            + New item
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setEditingOption(emptyOption(menu.option_groups[0]?.id))}
          >
            + New option
          </button>
        )}
      </DashHeader>

      <div className="dash-body stack">
        {error ? <Alert kind="error" onDismiss={() => setError('')}>{error}</Alert> : null}
        {notice ? <Alert kind="ok">{notice}</Alert> : null}

        <div className="row-wrap">
          <button type="button" className="cat-chip" aria-pressed={tab === 'products'} onClick={() => setTab('products')}>
            Items ({menu.products.length})
          </button>
          <button type="button" className="cat-chip" aria-pressed={tab === 'options'} onClick={() => setTab('options')}>
            Add-ons & choices ({menu.option_groups.reduce((n, g) => n + g.options.length, 0)})
          </button>
        </div>

        {tab === 'products' ? (
          <div className="panel">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="right">Base price</th>
                    <th>Choices offered</th>
                    <th>Stock</th>
                    <th>On the menu</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {menu.products.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="strong">{p.name}</div>
                        <div className="tiny faint" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.description}
                        </div>
                      </td>
                      <td className="small muted">
                        {menu.categories.find((c) => c.id === p.category_id)?.name ?? '—'}
                      </td>
                      <td className="right mono strong">{money(p.base_price)}</td>
                      <td className="tiny muted">
                        {p.option_groups?.length
                          ? p.option_groups.map((g) => g.name).join(', ')
                          : '—'}
                      </td>
                      <td className="small">
                        {p.track_stock ? (
                          <span className={p.stock_qty > 0 ? '' : 'strong'} style={p.stock_qty > 0 ? undefined : { color: 'var(--berry)' }}>
                            {p.stock_qty}
                          </span>
                        ) : (
                          <span className="faint">untracked</span>
                        )}
                      </td>
                      <td>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={Boolean(p.is_active)}
                            disabled={busyId === `p${p.id}`}
                            onChange={(e) => patch(`/catalog/products/${p.id}`, { is_active: e.target.checked }, `p${p.id}`)}
                          />
                          {busyId === `p${p.id}` ? <Spinner /> : p.is_active ? 'Live' : 'Hidden'}
                        </label>
                      </td>
                      <td className="right">
                        <button type="button" className="btn btn-sm" onClick={() => setEditingProduct(p)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="stack">
            {menu.option_groups.map((group) => (
              <section key={group.id} className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{group.name}</h3>
                    <div className="tiny muted">
                      {group.input_type === 'single' ? 'Pick one' : 'Pick several'}
                      {group.is_required ? ' · required' : ' · optional'}
                      {group.max_select ? ` · max ${group.max_select}` : ''}
                      {group.description ? ` · ${group.description}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    <button type="button" className="btn btn-sm" onClick={() => setEditingGroup(group)}>
                      Group rules
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => setEditingOption(emptyOption(group.id))}
                    >
                      + Option
                    </button>
                  </div>
                </div>

                {group.options.length === 0 ? (
                  <Empty icon="🍓" title="No options yet" />
                ) : (
                  <div className="table-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Option</th>
                          <th className="right">Price</th>
                          <th>Stock</th>
                          <th>Available</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {group.options.map((o) => (
                          <tr key={o.id}>
                            <td>
                              <div className="strong small">{o.name}</div>
                              {o.description ? <div className="tiny faint">{o.description}</div> : null}
                            </td>
                            <td className="right mono">
                              {Number(o.price_delta) === 0 ? (
                                <span className="faint">included</span>
                              ) : (
                                `+${money(o.price_delta)}`
                              )}
                            </td>
                            <td className="small">
                              {o.track_stock ? o.stock_qty : <span className="faint">—</span>}
                            </td>
                            <td>
                              <label className="switch">
                                <input
                                  type="checkbox"
                                  checked={Boolean(o.is_available)}
                                  disabled={busyId === `o${o.id}`}
                                  onChange={(e) => patch(`/catalog/options/${o.id}`, { is_available: e.target.checked }, `o${o.id}`)}
                                />
                                {busyId === `o${o.id}` ? <Spinner /> : o.is_available ? 'On' : 'Sold out'}
                              </label>
                            </td>
                            <td className="right">
                              <button type="button" className="btn btn-sm" onClick={() => setEditingOption(o)}>
                                Edit
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {editingProduct ? (
        <ProductEditor
          product={editingProduct}
          menu={menu}
          canDelete={isAdmin && Boolean(editingProduct.id)}
          onClose={() => setEditingProduct(null)}
          onSaved={async (msg) => { setEditingProduct(null); await load(); setNotice(msg); }}
          onError={setError}
        />
      ) : null}

      {editingOption ? (
        <OptionEditor
          option={editingOption}
          groups={menu.option_groups}
          onClose={() => setEditingOption(null)}
          onSaved={async (msg) => { setEditingOption(null); await load(); setNotice(msg); }}
          onError={setError}
        />
      ) : null}

      {editingGroup ? (
        <GroupEditor
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={async (msg) => { setEditingGroup(null); await load(); setNotice(msg); }}
          onError={setError}
        />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ editors

function ProductEditor({ product, menu, canDelete, onClose, onSaved, onError }) {
  const isNew = !product.id;
  const [form, setForm] = useState({
    category_id: product.category_id,
    name: product.name ?? '',
    description: product.description ?? '',
    base_price: String(product.base_price ?? '0'),
    image_url: product.image_url ?? '',
    is_active: Boolean(product.is_active ?? true),
    track_stock: Boolean(product.track_stock),
    stock_qty: product.stock_qty ?? 0,
    sort_order: product.sort_order ?? 0,
    option_group_ids: (product.option_groups ?? []).map((g) => g.id),
  });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function toggleGroup(id) {
    set({
      option_group_ids: form.option_group_ids.includes(id)
        ? form.option_group_ids.filter((g) => g !== id)
        : [...form.option_group_ids, id],
    });
  }

  async function save() {
    setBusy(true);
    try {
      const body = {
        ...form,
        base_price: Number(form.base_price),
        stock_qty: Number(form.stock_qty),
        sort_order: Number(form.sort_order),
        description: form.description || null,
        image_url: form.image_url || '',
      };
      if (isNew) await api.post('/catalog/products', body);
      else await api.patch(`/catalog/products/${product.id}`, body);
      onSaved(isNew ? 'Item created' : 'Item saved');
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${form.name}"? If it appears in past orders it will be hidden instead.`)) return;
    setBusy(true);
    try {
      const res = await api.del(`/catalog/products/${product.id}`);
      onSaved(res.deleted ? 'Item deleted' : 'Item hidden (it has order history)');
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? 'New item' : form.name}
      subtitle={isNew ? 'Add something to the menu' : 'Edit item and price'}
      onClose={onClose}
      footer={
        <>
          {canDelete ? (
            <button type="button" className="btn btn-berry" disabled={busy} onClick={remove} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className="select" value={form.category_id} onChange={(e) => set({ category_id: Number(e.target.value) })}>
            {menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Base price (PHP)" hint="Options add on top of this.">
          <input
            className="input" type="number" step="5" min="0"
            value={form.base_price} onChange={(e) => set({ base_price: e.target.value })}
          />
        </Field>
        <Field label="Sort order" hint="Lower numbers show first.">
          <input
            className="input" type="number"
            value={form.sort_order} onChange={(e) => set({ sort_order: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea className="textarea" value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <Field label="Image URL" hint="Leave blank for a plain tile.">
        <input className="input" value={form.image_url} onChange={(e) => set({ image_url: e.target.value })} />
      </Field>

      <Field label="Choices this item offers" hint="Which option groups the customer sees.">
        <div className="opt-grid">
          {menu.option_groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="opt"
              aria-pressed={form.option_group_ids.includes(g.id)}
              onClick={() => toggleGroup(g.id)}
            >
              <span className="opt-check box" aria-hidden="true">
                {form.option_group_ids.includes(g.id) ? '✓' : ''}
              </span>
              <span className="grow">
                <span className="opt-name">{g.name}</span>
                <span className="opt-price" style={{ display: 'block' }}>
                  {g.options.length} option{g.options.length === 1 ? '' : 's'}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Field>

      <div className="row-wrap">
        <label className="switch">
          <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          Show on the menu
        </label>
        <label className="switch">
          <input type="checkbox" checked={form.track_stock} onChange={(e) => set({ track_stock: e.target.checked })} />
          Track stock
        </label>
        {form.track_stock ? (
          <input
            className="input" type="number" min="0" style={{ width: 110 }}
            value={form.stock_qty} onChange={(e) => set({ stock_qty: e.target.value })}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function OptionEditor({ option, groups, onClose, onSaved, onError }) {
  const isNew = !option.id;
  const [form, setForm] = useState({
    group_id: option.group_id,
    name: option.name ?? '',
    description: option.description ?? '',
    price_delta: String(option.price_delta ?? '0'),
    is_available: Boolean(option.is_available ?? true),
    track_stock: Boolean(option.track_stock),
    stock_qty: option.stock_qty ?? 0,
    sort_order: option.sort_order ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const body = {
        ...form,
        group_id: Number(form.group_id),
        price_delta: Number(form.price_delta),
        stock_qty: Number(form.stock_qty),
        sort_order: Number(form.sort_order),
        description: form.description || null,
      };
      if (isNew) await api.post('/catalog/options', body);
      else await api.patch(`/catalog/options/${option.id}`, body);
      onSaved(isNew ? 'Option added' : 'Option saved');
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${form.name}"? If customers have ordered it, it will be marked sold out instead.`)) return;
    setBusy(true);
    try {
      const res = await api.del(`/catalog/options/${option.id}`);
      onSaved(res.deleted ? 'Option removed' : 'Option marked sold out (it has order history)');
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isNew ? 'New option' : form.name}
      subtitle="A fruit, topping, milk or extra"
      onClose={onClose}
      width="520px"
      footer={
        <>
          {!isNew ? (
            <button type="button" className="btn btn-berry" disabled={busy} onClick={remove} style={{ marginRight: 'auto' }}>
              Remove
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Group">
        <select className="select" value={form.group_id} onChange={(e) => set({ group_id: e.target.value })}>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Name">
        <input className="input" placeholder="e.g. Dragon Fruit" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="Extra charge (PHP)" hint="0 means included.">
          <input
            className="input" type="number" step="5"
            value={form.price_delta} onChange={(e) => set({ price_delta: e.target.value })}
          />
        </Field>
        <Field label="Sort order">
          <input className="input" type="number" value={form.sort_order} onChange={(e) => set({ sort_order: e.target.value })} />
        </Field>
      </div>
      <div className="row-wrap">
        <label className="switch">
          <input type="checkbox" checked={form.is_available} onChange={(e) => set({ is_available: e.target.checked })} />
          Available
        </label>
        <label className="switch">
          <input type="checkbox" checked={form.track_stock} onChange={(e) => set({ track_stock: e.target.checked })} />
          Track stock
        </label>
        {form.track_stock ? (
          <input
            className="input" type="number" min="0" style={{ width: 110 }}
            value={form.stock_qty} onChange={(e) => set({ stock_qty: e.target.value })}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function GroupEditor({ group, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: group.name,
    description: group.description ?? '',
    input_type: group.input_type,
    min_select: group.min_select,
    max_select: group.max_select,
    is_required: Boolean(group.is_required),
    is_active: Boolean(group.is_active),
    sort_order: group.sort_order,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // The same check the server runs, so the contradiction is caught while it
  // is still being typed rather than on save.
  const ruleProblem = groupRuleProblem({
    input_type: form.input_type,
    min_select: Number(form.min_select),
    max_select: Number(form.max_select),
  });

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/catalog/option-groups/${group.id}`, {
        ...form,
        min_select: Number(form.min_select),
        max_select: Number(form.max_select),
        sort_order: Number(form.sort_order),
        description: form.description || null,
      });
      onSaved('Group rules saved');
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${group.name} — rules`}
      subtitle="How many the customer must or may pick"
      onClose={onClose}
      width="520px"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn-primary"
            disabled={busy || Boolean(ruleProblem)}
            onClick={save}
          >
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      {ruleProblem ? <Alert kind="error">{ruleProblem}</Alert> : null}

      <Field label="Name">
        <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Helper text" hint="Shown under the group heading on the ordering page.">
        <input className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Selection style">
        <select
          className="select"
          value={form.input_type}
          onChange={(e) => {
            const input_type = e.target.value;
            set(input_type === 'single'
              ? {
                input_type,
                min_select: Math.min(Number(form.min_select) || 0, 1),
                max_select: Math.min(Number(form.max_select) || 0, 1),
              }
              : { input_type });
          }}
        >
          <option value="single">Pick one (radio)</option>
          <option value="multi">Pick several (checkbox)</option>
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Minimum picks">
          <input
            className="input" type="number" min="0"
            max={form.input_type === 'single' ? 1 : undefined}
            value={form.min_select} onChange={(e) => set({ min_select: e.target.value })}
          />
        </Field>
        <Field label="Maximum picks" hint="0 means no limit.">
          <input
            className="input" type="number" min="0"
            max={form.input_type === 'single' ? 1 : undefined}
            disabled={form.input_type === 'single'}
            value={form.input_type === 'single' ? 1 : form.max_select}
            onChange={(e) => set({ max_select: e.target.value })}
          />
        </Field>
      </div>
      <div className="row-wrap">
        <label className="switch">
          <input type="checkbox" checked={form.is_required} onChange={(e) => set({ is_required: e.target.checked })} />
          Required
        </label>
        <label className="switch">
          <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          Active
        </label>
      </div>
    </Modal>
  );
}
