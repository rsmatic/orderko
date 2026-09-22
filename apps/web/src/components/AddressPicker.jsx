import { useEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

/**
 * Picks a delivery address on a map.
 *
 * Uses OpenStreetMap through Leaflet, and Nominatim for search and reverse
 * geocoding, because neither needs an API key or a billing account. Google
 * Maps would do the same job but requires both — see the note in Checkout.
 *
 * Nominatim asks callers to stay under one request a second, so searches are
 * debounced and the pin only reverse-geocodes when it settles.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export default function AddressPicker({
  value,           // { address, lat, lng } | null
  onChange,
  center,          // the shop, so the map opens somewhere useful
  maxKm,
  shortcuts = [],
}) {
  const holder = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const debounce = useRef(null);

  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState('');

  // Leaflet is a chunk of JavaScript that only checkout needs, and only when
  // the customer chooses delivery, so it loads on demand.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      if (cancelled || !holder.current || map.current) return;

      const start = value?.lat != null ? [value.lat, value.lng] : [center.lat, center.lng];

      map.current = L.map(holder.current, { zoomControl: true, attributionControl: true })
        .setView(start, value?.lat != null ? 16 : 14);

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map.current);

      // The shop, so the customer can see how far they are from it.
      L.circleMarker([center.lat, center.lng], {
        radius: 6, color: '#3f7d5a', fillColor: '#3f7d5a', fillOpacity: 1, weight: 2,
      }).addTo(map.current).bindTooltip('Shop', { direction: 'top' });

      if (maxKm) {
        L.circle([center.lat, center.lng], {
          radius: maxKm * 1000,
          color: '#b8455f', weight: 1, fillColor: '#b8455f', fillOpacity: 0.05, dashArray: '4 4',
        }).addTo(map.current).bindTooltip(`Delivery limit — ${maxKm} km`, { direction: 'top' });
      }

      marker.current = L.marker(start, { draggable: true }).addTo(map.current);
      marker.current.on('dragend', () => {
        const p = marker.current.getLatLng();
        settle(p.lat, p.lng);
      });
      map.current.on('click', (e) => {
        marker.current.setLatLng(e.latlng);
        settle(e.latlng.lat, e.latlng.lng);
      });

      setReady(true);
      // The container is measured before the layout settles, so nudge it.
      setTimeout(() => map.current?.invalidateSize(), 50);
    })();

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Turns a dropped pin into an address, then reports it upward. */
  async function settle(lat, lng) {
    onChange({ address: value?.address ?? '', lat, lng, pending: true });
    setNote('');
    try {
      const res = await fetch(
        `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`,
        { headers: { accept: 'application/json' } },
      );
      const body = await res.json();
      onChange({ address: tidy(body) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng });
    } catch {
      // A failed lookup must not block the order — the coordinates are what
      // the driver actually needs.
      onChange({ address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng });
      setNote('Could not look up the street name, but the pin is set.');
    }
  }

  function search(text) {
    setQuery(text);
    clearTimeout(debounce.current);
    if (text.trim().length < 3) { setResults(null); return; }

    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `${NOMINATIM}/search?format=jsonv2&limit=6&countrycodes=ph&q=${encodeURIComponent(text)}`,
          { headers: { accept: 'application/json' } },
        );
        setResults(await res.json());
      } catch {
        setResults([]);
        setNote('Address search is unavailable — drop the pin on the map instead.');
      } finally {
        setSearching(false);
      }
    }, 600);
  }

  function choose(lat, lng, address) {
    map.current?.setView([lat, lng], 17);
    marker.current?.setLatLng([lat, lng]);
    onChange({ address, lat, lng });
    setResults(null);
    setQuery('');
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setNote('This browser cannot share your location.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude } = pos.coords;
        map.current?.setView([latitude, longitude], 17);
        marker.current?.setLatLng([latitude, longitude]);
        settle(latitude, longitude);
      },
      () => {
        setLocating(false);
        setNote('Location was not shared. Search or drop the pin instead.');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <div className="stack-s">
      <div className="row-wrap">
        <input
          className="input grow"
          style={{ minWidth: 200 }}
          placeholder="Search a street, building or barangay"
          value={query}
          onChange={(e) => search(e.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={useMyLocation} disabled={locating}>
          {locating ? <Spinner /> : '📍 Use my location'}
        </button>
      </div>

      {searching ? <div className="tiny muted">Searching…</div> : null}

      {results?.length ? (
        <ul className="addr-results">
          {results.map((r) => (
            <li key={r.place_id}>
              <button
                type="button"
                onClick={() => choose(Number(r.lat), Number(r.lon), r.display_name)}
              >
                {r.display_name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {results?.length === 0 && !searching ? (
        <div className="tiny muted">Nothing found. Try fewer words, or drop the pin yourself.</div>
      ) : null}

      <div className="addr-map" ref={holder}>
        {!ready ? <div className="addr-map-loading"><Spinner label="Loading map…" /></div> : null}
      </div>

      {shortcuts.length ? (
        <div className="row-wrap">
          <span className="tiny faint">Nearby:</span>
          {shortcuts.map((s) => (
            <button
              key={s.label}
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => choose(s.lat, s.lng, s.address)}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="tiny muted">
        Drag the pin or tap the map to set the exact spot.
      </div>

      {note ? <div className="tiny" style={{ color: 'var(--berry)' }}>{note}</div> : null}
    </div>
  );
}

/** Nominatim returns a long comma-chain; keep the parts a driver would use. */
function tidy(place) {
  const a = place?.address;
  if (!a) return place?.display_name ?? '';
  const parts = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.neighbourhood || a.suburb || a.village,
    a.city || a.town || a.municipality,
    a.postcode,
  ].filter(Boolean);
  return [...new Set(parts)].join(', ');
}
