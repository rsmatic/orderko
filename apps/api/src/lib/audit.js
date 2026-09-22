import { execute } from '../db.js';

/** Fire-and-forget audit trail. Never blocks or fails the request it records. */
export function audit(user, action, entity = null, entityId = null, meta = null) {
  return execute(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, meta) VALUES (?, ?, ?, ?, ?)',
    [user?.id ?? null, action, entity, entityId == null ? null : String(entityId),
     meta ? JSON.stringify(meta) : null],
  ).catch((err) => console.error('[audit]', action, err.message));
}
