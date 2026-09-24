import { useEffect } from 'react';
import { money, DEFAULT_CURRENCY } from '../lib/api';

export function Spinner({ label }) {
  return (
    <span className="row" style={{ gap: '.5rem' }}>
      <span className="spinner" />
      {label ? <span className="small muted">{label}</span> : null}
    </span>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="empty">
      <Spinner />
      <div className="small muted" style={{ marginTop: '.5rem' }}>{label}</div>
    </div>
  );
}

export function Empty({ icon = '🥣', title, children }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      {title ? <div className="strong" style={{ color: 'var(--ink-soft)' }}>{title}</div> : null}
      {children ? <div className="small" style={{ marginTop: '.3rem' }}>{children}</div> : null}
    </div>
  );
}

export function Alert({ kind = 'info', children, onDismiss }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="spread">
        <span>{children}</span>
        {onDismiss ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>✕</button>
        ) : null}
      </div>
    </div>
  );
}

const ORDER_BADGE = {
  pending:    ['badge-honey',   'Pending'],
  confirmed:  ['badge-sky',     'Confirmed'],
  preparing:  ['badge-sky',     'Preparing'],
  ready:      ['badge-leaf',    'Ready'],
  dispatched: ['badge-sky',     'On the way'],
  delivered:  ['badge-leaf',    'Delivered'],
  completed:  ['badge-neutral', 'Completed'],
  cancelled:  ['badge-berry',   'Cancelled'],
};

export function StatusBadge({ status }) {
  const [cls, label] = ORDER_BADGE[status] ?? ['badge-neutral', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

const DELIVERY_BADGE = {
  quoted:      ['badge-neutral', 'Quoted'],
  allocating:  ['badge-honey',   'Finding driver'],
  picking_up:  ['badge-sky',     'Driver to shop'],
  in_delivery: ['badge-sky',     'On the way'],
  completed:   ['badge-leaf',    'Delivered'],
  cancelled:   ['badge-berry',   'Cancelled'],
  failed:      ['badge-berry',   'Failed'],
  returned:    ['badge-berry',   'Returned'],
};

export function DeliveryBadge({ status }) {
  if (!status) return null;
  const [cls, label] = DELIVERY_BADGE[status] ?? ['badge-neutral', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function PaymentBadge({ status }) {
  const map = {
    paid:     ['badge-leaf',  'Paid'],
    unpaid:   ['badge-honey', 'Unpaid'],
    refunded: ['badge-berry', 'Refunded'],
  };
  const [cls, label] = map[status] ?? ['badge-neutral', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Qty({ value, onChange, min = 1, max = 50, disabled }) {
  return (
    <div className="qty">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= min}
        aria-label="Decrease quantity"
      >−</button>
      <span aria-live="polite">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= max}
        aria-label="Increase quantity"
      >+</button>
    </div>
  );
}

export function Money({ amount, currency = DEFAULT_CURRENCY }) {
  return <span className="mono">{money(amount, currency)}</span>;
}

export function Modal({ title, subtitle, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        style={width ? { width: `min(${width}, 100%)` } : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head spread">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="small muted">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      {label ? <span className="label">{label}</span> : null}
      {children}
      {error ? <span className="hint" style={{ color: 'var(--berry)' }}>{error}</span> : null}
      {!error && hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Stat({ label, value, note, tone, onClick, hint }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </>
  );

  // A tile you can open is a button, not a div with a click handler: it has
  // to be reachable by keyboard and announce itself as something that acts.
  if (!onClick) return <div className="card stat">{body}</div>;
  return (
    <button type="button" className="card stat stat-action" onClick={onClick} title={hint}>
      {body}
      <span className="stat-more" aria-hidden="true">View →</span>
    </button>
  );
}
