import { db } from '../db'
import { bus } from '../core/events'

/** Saved email templates (subject + body with {variables} and {spin|text}), used by email campaigns. */
export interface EmailTemplate {
  id: number
  name: string
  subject: string
  body: string
  created_at: string
  updated_at: string
  used: number
}

export function listTemplates(): EmailTemplate[] {
  return db().all<EmailTemplate>(
    `SELECT t.*, (SELECT COUNT(*) FROM campaign_steps s JOIN campaigns c ON c.id = s.campaign_id
       WHERE c.channel = 'email' AND s.kind = 'initial' AND s.subject = t.subject AND s.body = t.body) used
     FROM email_templates t ORDER BY t.updated_at DESC, t.id DESC`
  )
}

export function saveTemplate(t: { id?: number; name: string; subject: string; body: string }): number {
  const name = t.name?.trim()
  const subject = t.subject?.trim()
  const body = t.body?.trim()
  if (!name) throw new Error('Give the template a name.')
  if (!subject) throw new Error('Write a subject line.')
  if (!body) throw new Error('Write the email.')
  let id = t.id
  if (id) db().run("UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = datetime('now') WHERE id = ?", name, subject, body, id)
  else id = Number(db().run('INSERT INTO email_templates (name, subject, body) VALUES (?, ?, ?)', name, subject, body).lastInsertRowid)
  bus.publish('templates:updated', { id })
  return id
}

export function duplicateTemplate(id: number): number {
  const t = db().get<EmailTemplate>('SELECT * FROM email_templates WHERE id = ?', id)
  if (!t) throw new Error('Template not found')
  return saveTemplate({ name: `${t.name} (copy)`, subject: t.subject, body: t.body })
}

export function deleteTemplate(id: number): void {
  db().run('DELETE FROM email_templates WHERE id = ?', id)
  bus.publish('templates:updated', { id })
}
