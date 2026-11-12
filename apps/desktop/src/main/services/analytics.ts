import { db } from '../db'
import { getSettings } from '../core/settings'
import { secrets } from '../security/secrets'
import { keyName } from './ai/providers'

/** All figures are computed from live database records for the requested range (inclusive dates, UTC). */
export function dashboard(range: { from?: string; to?: string } = {}) {
  const from = range.from ?? new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10)
  const to = range.to ?? new Date().toISOString().slice(0, 10)
  const inRange = (col: string) => `${col} >= ? AND ${col} < date(?, '+1 day')`
  const one = (sql: string, ...p: any[]) => (db().get<{ n: number }>(sql, ...p)?.n ?? 0) as number

  const ver = Object.fromEntries(db().all<{ s: string; n: number }>('SELECT verification_status s, COUNT(*) n FROM email_addresses GROUP BY s').map((r) => [r.s, r.n]))
  const s = getSettings()
  const provider = s.ai.defaultProvider
  const providerRow = provider ? db().get<{ status: string; default_model: string }>('SELECT status, default_model FROM ai_providers WHERE id = ?', provider) : null

  const stats = {
    totalLeads: one('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL'),
    newLeads: one(`SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND ${inRange('discovered_at')}`, from, to),
    verifiedEmails: ver.safe ?? 0,
    riskyEmails: ver.risky ?? 0,
    invalidEmails: ver.invalid ?? 0,
    unverifiedEmails: (ver.unverified ?? 0) + (ver.queued ?? 0),
    interested: one("SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND outreach_status IN ('interested','converted')"),
    activeWhatsApp: one("SELECT COUNT(*) n FROM whatsapp_accounts WHERE status = 'connected' AND enabled = 1"),
    totalWhatsApp: one('SELECT COUNT(*) n FROM whatsapp_accounts'),
    activeSmtp: one("SELECT COUNT(*) n FROM smtp_accounts WHERE enabled = 1 AND status = 'ok'"),
    totalSmtp: one('SELECT COUNT(*) n FROM smtp_accounts'),
    activeWaCampaigns: one("SELECT COUNT(*) n FROM campaigns WHERE channel = 'whatsapp' AND status IN ('running','scheduled')"),
    activeEmailCampaigns: one("SELECT COUNT(*) n FROM campaigns WHERE channel = 'email' AND status IN ('running','scheduled')"),
    whatsappSent: one(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel = 'whatsapp' AND m.direction = 'out' AND m.status != 'failed' AND ${inRange('m.created_at')}`, from, to),
    emailsSent: one(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel = 'email' AND m.direction = 'out' AND m.status != 'failed' AND ${inRange('m.created_at')}`, from, to),
    emailsFailed: one(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel = 'email' AND m.direction = 'out' AND m.status = 'failed' AND ${inRange('m.created_at')}`, from, to),
    emailBounces: one(`SELECT COUNT(*) n FROM campaign_executions WHERE event = 'bounced' AND ${inRange('created_at')}`, from, to),
    repliesReceived: one(`SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND ${inRange('created_at')}`, from, to),
    pendingApprovals: one("SELECT COUNT(*) n FROM approvals WHERE status IN ('pending','needs_pricing_config')"),
    aiProvider: provider ? { id: provider, status: providerRow?.status ?? 'unconfigured', model: providerRow?.default_model ?? null, hasKey: secrets.has(keyName(provider)) } : null
  }

  const leadsOverTime = db().all(
    `SELECT date(discovered_at) day, COUNT(*) leads FROM leads WHERE deleted_at IS NULL AND ${inRange('discovered_at')} GROUP BY day ORDER BY day`,
    from, to
  )
  const activity = db().all(
    `SELECT date(m.created_at) day,
       SUM(m.direction = 'out' AND c.channel = 'whatsapp') whatsapp_out, SUM(m.direction = 'out' AND c.channel = 'email') email_out,
       SUM(m.direction = 'in') replies
     FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.status != 'failed' AND ${inRange('m.created_at')} GROUP BY day ORDER BY day`,
    from, to
  )
  const sources = db().all(
    `SELECT s.label name, COUNT(l.id) value FROM lead_sources s LEFT JOIN leads l ON l.source = s.id AND l.deleted_at IS NULL AND ${inRange('l.discovered_at')}
     GROUP BY s.id HAVING value > 0 ORDER BY value DESC`,
    from, to
  )
  const industries = db().all(
    `SELECT COALESCE(c.name, 'Uncategorised') name, COUNT(*) value FROM leads l LEFT JOIN lead_categories c ON c.id = l.category_id
     WHERE l.deleted_at IS NULL GROUP BY c.id ORDER BY value DESC LIMIT 10`
  )
  const verification = ['safe', 'risky', 'invalid', 'unknown', 'failed', 'unverified'].map((k) => ({ name: k, value: (ver[k] ?? 0) + (k === 'unverified' ? ver.queued ?? 0 : 0) }))
  const campaigns = db().all(
    `SELECT c.id, c.name, c.channel, c.status,
       (SELECT COUNT(*) FROM campaign_executions e WHERE e.campaign_id = c.id AND e.event = 'sent') sent,
       (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'replied') replied,
       (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') failed,
       (SELECT COUNT(*) FROM campaign_recipients r JOIN leads l ON l.id = r.lead_id WHERE r.campaign_id = c.id AND l.outreach_status IN ('interested','converted')) interested
     FROM campaigns c ORDER BY c.id DESC LIMIT 12`
  )
  const funnel = (() => {
    const r = db().get<any>(
      `SELECT COUNT(*) total, SUM(outreach_status != 'new') contacted, SUM(outreach_status IN ('replied','interested','not_interested','converted')) replied,
        SUM(outreach_status IN ('interested','converted')) interested, SUM(outreach_status = 'converted') converted
       FROM leads WHERE deleted_at IS NULL`
    )
    return [
      { stage: 'Leads', value: r.total ?? 0 },
      { stage: 'Contacted', value: r.contacted ?? 0 },
      { stage: 'Replied', value: r.replied ?? 0 },
      { stage: 'Interested', value: r.interested ?? 0 },
      { stage: 'Converted', value: r.converted ?? 0 }
    ]
  })()
  const interestedOverTime = db().all(
    `SELECT date(created_at) day, COUNT(*) n FROM lead_history WHERE event = 'updated' AND detail LIKE '%outreach_status%' AND ${inRange('created_at')} GROUP BY day`,
    from, to
  )
  const recent = db().all('SELECT actor, action, entity, entity_id, created_at FROM activity_logs ORDER BY id DESC LIMIT 12')
  return { range: { from, to }, stats, leadsOverTime, activity, sources, industries, verification, campaigns, funnel, interestedOverTime, recent }
}

export function sidebarCounts() {
  return {
    pendingApprovals: (db().get<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE status IN ('pending','needs_pricing_config')")?.n ?? 0) as number,
    unread: (db().get<{ n: number }>('SELECT COUNT(*) n FROM conversations WHERE unread > 0')?.n ?? 0) as number,
    runningJobs: (db().get<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')")?.n ?? 0) as number
  }
}
