import { useEffect, useMemo, useState } from 'react';
import {
  optionLimit, minPicks, isPickBlocked, applyPick, selectionProblems, initialPicks,
} from '@overnight-oats/core';
import { money } from '../../lib/api';
import { Qty, Alert } from '../../components/ui';

/**
 * Builds one jar: pick a size, a milk, mix up to N fruits, pile on toppings.
 *
 * Group rules come straight from the database (input_type, min_select,
 * max_select, is_required) so a manager can add a new group without touching
 * this file. The price shown here is a preview — the server re-prices on
 * checkout and its number is the one that counts.
 */
export default function Customizer({ product, onClose, onAdd }) {
  const groups = useMemo(
    () => [...(product.option_groups ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    [product],
  );

  // Opens in a valid state, so the sheet never greets you with an error.
  const [selected, setSelected] = useState(() => initialPicks(groups));

  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  function toggle(group, option) {
    setSelected((prev) => ({
      ...prev,
      [group.id]: applyPick(group, prev[group.id] ?? [], option),
    }));
  }

  const problems = useMemo(
    () => selectionProblems(groups, selected),
    [groups, selected],
  );

  const chosenOptions = useMemo(() => {
    const byId = new Map();
    for (const g of groups) for (const o of g.options ?? []) byId.set(o.id, { ...o, group: g });
    return Object.values(selected).flat().map((id) => byId.get(id)).filter(Boolean);
  }, [groups, selected]);

  const optionsTotal = chosenOptions.reduce((sum, o) => sum + Number(o.price_delta), 0);
  const unitPrice = Number(product.base_price) + optionsTotal;
  const lineTotal = unitPrice * quantity;

  function submit() {
    setTouched(true);
    if (problems.length) return;
    onAdd({
      product_id: product.id,
      product_name: product.name,
      quantity,
      option_ids: Object.values(selected).flat(),
      option_labels: chosenOptions.map((o) => ({
        group: o.group.name,
        name: o.name,
        price_delta: Number(o.price_delta),
      })),
      notes: notes.trim() || null,
      unit_preview: unitPrice,
    });
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Customise ${product.name}`}
      >
        <div className="sheet-head">
          <div>
            <h2>{product.name}</h2>
            <div className="small muted" style={{ marginTop: '.2rem' }}>
              {product.description}
            </div>
            <div className="small strong" style={{ marginTop: '.35rem' }}>
              Base {money(product.base_price)}
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet-body">
          {groups.length === 0 ? (
            <div className="small muted">This one comes just as it is — no choices needed.</div>
          ) : null}

          {groups.map((group) => {
            const current = selected[group.id] ?? [];
            const max = optionLimit(group);
            const min = minPicks(group);
            const options = (group.options ?? [])
              .slice()
              .sort((a, b) => a.sort_order - b.sort_order);

            return (
              <section key={group.id} className="opt-group">
                <div className="opt-group-head">
                  <div>
                    <h3>{group.name}</h3>
                    {group.description ? (
                      <div className="tiny muted">{group.description}</div>
                    ) : null}
                  </div>
                  <span className="pill tiny">
                    {min > 0 ? `Choose ${min}` : 'Optional'}
                    {max !== Infinity && max !== min ? `–${max}` : ''}
                    {max !== Infinity ? ` · ${current.length}/${max}` : ''}
                  </span>
                </div>

                <div className="opt-grid">
                  {options.map((option) => {
                    const isOn = current.includes(option.id);
                    const blocked = isPickBlocked(group, current, option);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className="opt"
                        aria-pressed={isOn}
                        disabled={blocked}
                        onClick={() => toggle(group, option)}
                        title={
                          !option.is_available
                            ? 'Sold out'
                            : blocked
                              ? `You can pick ${max} from ${group.name}`
                              : option.description ?? undefined
                        }
                      >
                        <span
                          className={`opt-check ${group.input_type === 'single' ? 'radio' : 'box'}`}
                          aria-hidden="true"
                        >
                          {isOn ? '✓' : ''}
                        </span>
                        <span className="grow">
                          <span className="opt-name">{option.name}</span>
                          <span className="opt-price" style={{ display: 'block' }}>
                            {!option.is_available
                              ? 'Sold out'
                              : Number(option.price_delta) === 0
                                ? 'Included'
                                : `+${money(option.price_delta)}`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <label className="field">
            <span className="label">Anything else?</span>
            <textarea
              className="textarea"
              placeholder="e.g. light on the honey, separate the granola"
              maxLength={255}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          {touched && problems.length ? (
            <Alert kind="error">{problems.join(' · ')}</Alert>
          ) : null}
        </div>

        <div className="sheet-foot">
          <Qty value={quantity} onChange={setQuantity} />
          <div className="grow">
            <div className="tiny muted">
              {money(unitPrice)} each
              {optionsTotal > 0 ? ` · ${money(optionsTotal)} of add-ons` : ''}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={submit}
            disabled={touched && problems.length > 0}
          >
            Add · {money(lineTotal)}
          </button>
        </div>
      </div>
    </div>
  );
}
