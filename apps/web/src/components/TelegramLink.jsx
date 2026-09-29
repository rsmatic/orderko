import { useState } from 'react';
import { api } from '../lib/api';
import { Field, Alert, Spinner } from './ui';

/**
 * Connecting one person to the bot, so they hear about their orders.
 *
 * Telegram never tells a bot who its users are — it only reports people as
 * they write in, and only once. So the flow is: they press Start, and the
 * admin picks them off the list of who has just written. Nobody has to hunt
 * for a numeric id.
 */
export default function TelegramLink({ userId, userName, value, onChange, onError }) {
  const [chats, setChats] = useState(null);
  const [busy, setBusy] = useState('');

  async function look() {
    setBusy('look');
    try {
      const res = await api.get('/admin/telegram/chats');
      setChats(res.chats ?? []);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    try {
      const res = await api.post('/admin/telegram/test', { user_id: userId });
      onError(`Sent to ${res.to} — check their Telegram`);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack-s">
      <Field
        label="Telegram"
        hint="Where new orders are announced. Blank means they are not told."
      >
        <div className="row-wrap">
          <input
            className="input mono"
            style={{ maxWidth: 190 }}
            placeholder="not connected"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn btn-sm" onClick={look} disabled={busy === 'look'}>
            {busy === 'look' ? <Spinner /> : 'Find them'}
          </button>
          {value ? (
            <button type="button" className="btn btn-sm" onClick={test} disabled={busy === 'test'}>
              {busy === 'test' ? <Spinner /> : 'Send a test'}
            </button>
          ) : null}
        </div>
      </Field>

      {chats ? (
        chats.length === 0 ? (
          <Alert kind="warn">
            Nobody has written to the bot yet. Ask {userName} to open it in
            Telegram and press <strong>Start</strong>, then look again.
          </Alert>
        ) : (
          <div className="stack-s">
            <div className="tiny muted">
              Who has written to the bot lately — pick {userName}:
            </div>
            {chats.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn btn-sm"
                style={{ justifyContent: 'space-between' }}
                onClick={() => { onChange(c.id); setChats(null); }}
              >
                <span>{c.name}{c.username ? ` · @${c.username}` : ''}</span>
                <span className="tiny faint">
                  {c.linked && String(c.id) !== String(value) ? 'already linked' : c.id}
                </span>
              </button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
