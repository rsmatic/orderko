import { useRef, useState } from 'react';

/**
 * Picks an image and hands back a value the settings can hold: either an
 * https:// address, or the picture itself as a data URI.
 *
 * Uploads are resized in the browser before they are stored. The whole shop
 * lives in one JSON file that is rewritten on every order, so a full-size
 * phone photo pasted in here would slow down every save — this keeps it to
 * tens of kilobytes without the shopkeeper having to think about it.
 */
export default function ImagePicker({
  value,
  onChange,
  maxPixels = 640,
  hint,
  shape = 'wide',
}) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('upload');

  async function pick(file) {
    if (!file) return;
    setError('');

    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }

    setBusy(true);
    try {
      onChange(await downscale(file, maxPixels));
    } catch (err) {
      setError(err.message || 'Could not read that image.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const sizeKb = value?.startsWith('data:') ? Math.round((value.length * 0.75) / 1024) : null;

  return (
    <div className="stack-s">
      <div className={`img-pick ${shape === 'square' ? 'img-pick-square' : ''}`}>
        {value
          ? <img src={value} alt="" />
          : <span className="faint tiny">No image set</span>}
      </div>

      <div className="row-wrap">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? 'Resizing…' : value ? 'Replace' : 'Upload a picture'}
        </button>

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setMode((m) => (m === 'url' ? 'upload' : 'url'))}
        >
          {mode === 'url' ? 'Hide link' : 'Use a link instead'}
        </button>

        {value ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange('')}>
            Remove
          </button>
        ) : null}

        {sizeKb ? <span className="tiny faint">{sizeKb} KB stored</span> : null}
      </div>

      {mode === 'url' ? (
        <input
          className="input"
          type="url"
          placeholder="https://example.com/picture.jpg"
          value={value?.startsWith('data:') ? '' : (value ?? '')}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {error ? <span className="hint" style={{ color: 'var(--berry)' }}>{error}</span> : null}
      {!error && hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Reads a file, shrinks it to fit `maxPixels`, and returns a data URI. */
function downscale(file, maxPixels) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be decoded.'));
      img.onload = () => {
        const scale = Math.min(1, maxPixels / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // PNG keeps transparency, which logos usually rely on, but is heavy
        // for photographs. Keep whichever comes out smaller.
        const png = canvas.toDataURL('image/png');
        const jpeg = canvas.toDataURL('image/jpeg', 0.85);
        const best = jpeg.length < png.length * 0.7 ? jpeg : png;

        if (best.length > 400_000) {
          reject(new Error('Still too large after resizing — try a simpler picture.'));
          return;
        }
        resolve(best);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
