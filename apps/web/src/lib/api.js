const TOKEN_KEY = 'oats.token';

export const tokenStore = {
  get: () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode */ }
  },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body, { signal } = {}) {
  const token = tokenStore.get();
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }

  if (!res.ok) {
    const detail = payload?.details?.length
      ? ` (${payload.details.map((d) => d.message ?? d).join('; ')})`
      : '';
    throw new ApiError(res.status, (payload?.error ?? res.statusText) + detail, payload?.details);
  }
  return payload;
}

export const api = {
  get:   (path, opts)       => request('GET', path, undefined, opts),
  post:  (path, body, opts) => request('POST', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
  put:   (path, body, opts) => request('PUT', path, body ?? {}, opts),
  del:   (path, opts)       => request('DELETE', path, undefined, opts),
};

export const money = (amount, currency = 'MYR') =>
  new Intl.NumberFormat('en-MY', { style: 'currency', currency }).format(Number(amount) || 0);

export const shortTime = (value) =>
  value ? new Intl.DateTimeFormat('en-MY', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';

export const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat('en-MY', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      }).format(new Date(value))
    : '';

export const relativeMinutes = (value) => {
  if (!value) return '';
  const mins = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
