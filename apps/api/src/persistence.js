import fs from 'node:fs/promises';
import path from 'node:path';
import { freshState } from '@overnight-oats/core';

/**
 * A JSON file as the database.
 *
 * Every write rewrites the whole file, so this suits a shop doing hundreds of
 * orders a day, not thousands. Two properties make that safe enough:
 *
 *   - writes are atomic (temp file + rename), so a crash mid-write cannot
 *     leave a truncated store behind;
 *   - writes are serialised through a single promise chain, so concurrent
 *     requests cannot interleave and lose each other's changes.
 *
 * It assumes ONE process. Run a second instance against the same file and they
 * will overwrite each other — see the deployment notes.
 */
export function createJsonStore({ file, hashPassword, seedPassword, debounceMs = 150 }) {
  const dir = path.dirname(file);
  const tmp = `${file}.tmp`;

  let state = null;
  let writing = Promise.resolve();
  let pending = null;
  let timer = null;

  async function writeNow() {
    const snapshot = JSON.stringify(state, null, 2);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, file);
  }

  /** Coalesces bursts of writes into one, but never drops the last one. */
  function schedule() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        pending = null;
        timer = null;
        writing = writing.then(writeNow).then(resolve, reject);
      }, debounceMs);
      timer.unref?.();
    });
    return pending;
  }

  return {
    async load() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        state = JSON.parse(raw);
        if (!state?.seq || !Array.isArray(state?.products)) {
          throw new Error('store file is missing expected fields');
        }
        return { state, seeded: false };
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Refuse to silently discard a store we merely failed to parse.
          if (err instanceof SyntaxError || err.message.includes('missing expected')) {
            throw new Error(
              `${file} exists but is not a valid store (${err.message}). ` +
                'Move it aside and restart to seed a fresh one.',
            );
          }
          throw err;
        }
        state = await freshState({ hashPassword, seedPassword });
        await fs.mkdir(dir, { recursive: true });
        await writeNow();
        return { state, seeded: true };
      }
    },

    getState: () => state,

    /** Called by the backend after any handler that changed something. */
    persist: (next) => {
      state = next;
      return schedule();
    },

    /** Waits for any queued write, so shutdown does not lose the last change. */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        pending = null;
        writing = writing.then(writeNow);
      }
      await writing;
    },

    async reset() {
      state = await freshState({ hashPassword, seedPassword });
      await writeNow();
      return state;
    },
  };
}
