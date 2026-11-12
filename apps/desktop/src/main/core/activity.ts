import { db } from '../db'

export function logActivity(actor: 'user' | 'ai' | 'system', action: string, entity?: string, entityId?: string | number, detail?: unknown): void {
  db().run(
    'INSERT INTO activity_logs (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    actor,
    action,
    entity ?? null,
    entityId !== undefined ? String(entityId) : null,
    detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail)
  )
}
