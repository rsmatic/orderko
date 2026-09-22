const TOKEN_KEY = 'oats.token';

/**
 * Where the API lives.
 *
 * In dev this stays '/api' and Vite proxies it to localhost:4000. A deployed
 * build bakes in VITE_API_BASE_URL (e.g. https://oats-api.onrender.com/api),
 * because the static host serving this bundle has no API of its own.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

/**
 * Demo mode swaps the network for an in-browser backend, so the app works on
 * a static host with no API behind it. A real API address always wins.
 */
export const DEMO = import.meta.env.VITE_DEMO === '1' && !import.meta.env.VITE_API_BASE_URL;

/**
 * A relative base only resolves when something is serving the API alongside
 * this bundle. On a static host it never will, so say so plainly instead of
 * letting every request fail as an unexplained 404.
 */
const MISCONFIGURED =
  !DEMO &&
  !import.meta.env.DEV &&
  API_BASE.startsWith('/') &&
  !['localhost', '127.0.0.1'].includes(window.location.hostname);

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
  if (DEMO) {
    // Loaded on demand so the demo backend stays out of a real deployment's bundle.
    const { demoRequest } = await import('../demo/backend');
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    try {
      return await demoRequest(method, path, body, tokenStore.get());
    } catch (err) {
      throw new ApiError(err.status ?? 500, err.message, err.details);
    }
  }

  if (MISCONFIGURED) {
    throw new ApiError(
      0,
      'This build has no API address. Set the VITE_API_BASE_URL repository variable ' +
        'to your deployed API (for example https://your-api.onrender.com/api) and re-run the deploy.',
    );
  }

  const token = tokenStore.get();

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // A free-tier API that has spun down looks exactly like a CORS failure
    // from here, so name both possibilities.
    throw new ApiError(
      0,
      'Could not reach the API. It may still be waking up — try again in a moment. ' +
        "If this persists, check the API is running and that its CORS_ORIGIN allows this site.",
    );
  }

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
