import { ipcMain, dialog, shell, BrowserWindow, app, nativeTheme } from 'electron'
import { db } from './db'
import { logger } from './core/logger'
import { getSettings, updateSettings } from './core/settings'
import { listJobs, getJob, jobLogs, pauseJob, resumeJob, cancelJob } from './core/jobs'
import { secrets } from './security/secrets'
import { logActivity } from './core/activity'
import * as leads from './services/leads'
import * as discovery from './services/discovery'
import * as verification from './services/verification'
import * as io from './services/importExport'
import * as providers from './services/ai/providers'
import * as agent from './services/ai/agent'
import * as convs from './services/conversations'
import * as wa from './services/whatsapp'
import * as email from './services/email'
import * as campaigns from './services/campaigns'
import * as analytics from './services/analytics'
import * as license from './services/license'
import { testPlacesKey, MAJOR_CITIES } from './services/sources/googleMaps'
import { testCse } from './services/sources/linkedin'
import { testApollo } from './services/sources/apollo'
import { searchSpotify, searchListenNotes } from './services/sources/podcasts'
import { SECRET_KEYS, type SecretName } from '@shared/settings'

const log = logger('ipc')
type Handler = (...args: any[]) => unknown

/** Channels that require an active license when licensing is enforced. */
const LICENSED = new Set([
  'discovery:start', 'verification:single', 'verification:bulk', 'verification:file', 'verification:leads', 'verification:reverify',
  'ai:research', 'ai:outreach', 'campaigns:start', 'campaigns:resume', 'conversations:send', 'agent:approve'
])

const handlers: Record<string, Handler> = {
  // ------------------------------------------------------------ app
  'app:info': () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData'), licensedFeaturesEnforced: license.ENFORCED }),
  'app:openExternal': (url: string) => {
    if (!/^https?:\/\//.test(url) && !/^mailto:/.test(url)) throw new Error('Only http(s) and mailto links can be opened')
    return shell.openExternal(url)
  },
  'app:openLogs': () => shell.openPath(app.getPath('logs')),
  'app:activity': (limit = 100) => db().all('SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?', limit),

  // ------------------------------------------------------------ settings & secrets
  'settings:get': () => getSettings(),
  'settings:update': (patch) => {
    const s = updateSettings(patch)
    if (patch.appearance) nativeTheme.themeSource = s.appearance.theme
    return s
  },
  'secrets:status': () => Object.fromEntries((Object.keys(SECRET_KEYS) as SecretName[]).map((k) => [k, secrets.mask(SECRET_KEYS[k])])),
  'secrets:set': (name: SecretName, value: string | null) => {
    if (!(name in SECRET_KEYS)) throw new Error('Unknown secret')
    secrets.set(SECRET_KEYS[name], value?.trim() || null)
    logActivity('user', 'secret_updated', 'secret', name)
  },
  'integrations:test': async (name: string) => {
    const need = (k: SecretName) => {
      const v = secrets.get(SECRET_KEYS[k])
      if (!v) throw new Error('Not configured')
      return v
    }
    switch (name) {
      case 'googlePlaces': return testPlacesKey(need('googlePlaces'))
      case 'googleCse': return testCse(need('googleCseKey'), need('googleCseCx'))
      case 'apollo': return testApollo(need('apollo'))
      case 'listenNotes': await searchListenNotes(need('listenNotes'), 'business', 0); return 'Connected to Listen Notes.'
      case 'spotify': await searchSpotify(need('spotifyId'), need('spotifySecret'), 'business', 0, 'US'); return 'Connected to Spotify.'
      case 'reacher': return verification.testReacher()
      default: throw new Error('Unknown integration')
    }
  },

  // ------------------------------------------------------------ jobs
  'jobs:list': (opts) => listJobs(opts),
  'jobs:get': (id: string) => getJob(id),
  'jobs:logs': (id: string) => jobLogs(id),
  'jobs:pause': (id: string) => pauseJob(id),
  'jobs:resume': (id: string) => resumeJob(id),
  'jobs:cancel': (id: string) => cancelJob(id),

  // ------------------------------------------------------------ leads
  'leads:list': (filter, opts) => leads.listLeads(filter, opts),
  'leads:get': (id: number) => leads.getLead(id),
  'leads:create': (input) => {
    const r = leads.upsertLead({ ...input, source: 'manual' })
    if (getSettings().verification.autoVerify && r.newEmailIds.length) verification.queueVerification(r.newEmailIds)
    return r
  },
  'leads:update': (id: number, patch) => leads.updateLead(id, patch),
  'leads:bulkUpdate': (ids: number[], patch) => leads.bulkUpdate(ids, patch),
  'leads:delete': (ids: number[], purge = false) => {
    logActivity('user', purge ? 'leads_purged' : 'leads_deleted', 'lead', ids.length)
    return leads.deleteLeads(ids, purge)
  },
  'leads:idsForFilter': (filter) => leads.leadIdsForFilter(filter),
  'leads:addEmail': (leadId: number, address: string) => {
    const r = leads.attachEmail(leadId, address, 'manual')
    if (!r) throw new Error('That email address is not valid')
    if (getSettings().verification.autoVerify) verification.queueVerification([r.id])
    return r
  },
  'leads:setPrimaryEmail': (leadId: number, emailId: number) => leads.setPrimaryEmail(leadId, emailId),
  'leads:removeEmail': (leadId: number, emailId: number) => leads.removeEmail(leadId, emailId),
  'leads:optOut': (id: number) => leads.optOutLead(id, 'Manual opt-out'),
  'leads:categories': () => leads.listCategories(),
  'leads:createCategory': (name: string, color?: string) => leads.createCategory(name, color),
  'leads:renameCategory': (id: number, name: string, color?: string) => leads.renameCategory(id, name, color),
  'leads:deleteCategory': (id: number) => leads.deleteCategory(id),
  'leads:filterOptions': () => leads.filterOptions(),
  'leads:savedFilters': () => leads.listSavedFilters(),
  'leads:saveFilter': (name: string, filter) => leads.saveFilter(name, filter),
  'leads:deleteSavedFilter': (id: number) => leads.deleteSavedFilter(id),
  'leads:duplicates': () => leads.findDuplicates(),
  'leads:merge': (keepId: number, others: number[]) => leads.mergeLeads(keepId, others),
  'leads:export': async (input: { leadIds?: number[]; filter?: any; format: 'csv' | 'xlsx' }, _e?: any, win?: BrowserWindow) => {
    const rows = io.exportRows(input)
    if (!rows.length) throw new Error('No leads to export')
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `leads-${new Date().toISOString().slice(0, 10)}.${input.format}`,
      filters: [input.format === 'xlsx' ? { name: 'Excel', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }]
    })
    if (r.canceled || !r.filePath) return null
    const n = await io.writeExport(r.filePath, rows)
    logActivity('user', 'leads_exported', 'lead', n)
    return { file: r.filePath, count: n }
  },
  'leads:importPick': async (_a?: any, _e?: any, win?: BrowserWindow) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['csv', 'xlsx'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const t = await io.readTable(r.filePaths[0])
    return { file: r.filePaths[0], headers: t.headers, preview: t.rows.slice(0, 5), count: t.rows.length, mapping: io.guessMapping(t.headers) }
  },
  'leads:importCommit': async (file: string, mapping: Record<string, string>, opts) => {
    const t = await io.readTable(file)
    return io.importLeads(t.rows, mapping, opts)
  },

  // ------------------------------------------------------------ discovery
  'discovery:start': (source: string, params) => discovery.startDiscovery(source, params),
  'discovery:history': (source?: string) => discovery.searchHistory(source),
  'discovery:countries': () => Object.keys(MAJOR_CITIES),

  // ------------------------------------------------------------ verification
  'verification:single': async (address: string) => {
    const id = verification.ensureEmailRow(address)
    if (!id) throw new Error('That is not a valid email address')
    const o = await verification.callReacher(address)
    verification.saveOutcome(id, o, null)
    return { status: o.status, reasons: o.reasons, isCatchAll: o.isCatchAll, isRole: o.isRole, isDisposable: o.isDisposable }
  },
  'verification:bulk': (emails: string[]) => verification.queueRawEmails(emails),
  'verification:file': async (_a?: any, _e?: any, win?: BrowserWindow) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['csv', 'xlsx', 'txt'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const t = await io.readTable(r.filePaths[0])
    const emails = new Set<string>()
    for (const row of t.rows) for (const v of Object.values(row)) for (const m of String(v).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) emails.add(m.toLowerCase())
    if (!emails.size) throw new Error('No email addresses found in that file')
    return { ...verification.queueRawEmails([...emails], { label: `Verify ${emails.size} emails from file` }), found: emails.size }
  },
  'verification:leads': (leadIds: number[] | null, statuses?: string[]) => {
    const ids = verification.emailIdsFromLeads(leadIds, statuses)
    if (!ids.length) throw new Error('No matching emails need verification')
    return verification.queueVerification(ids, { force: true, label: `Verify ${ids.length} lead emails` })
  },
  'verification:reverify': (emailIds: number[]) => verification.queueVerification(emailIds, { force: true, label: `Re-verify ${emailIds.length} emails` }),
  'verification:stats': () => verification.verificationStats(),
  'verification:history': (opts) => verification.verificationHistory(opts),
  'verification:batch': (batchId: string) => verification.summary(batchId),
  'verification:port25': () => verification.checkPort25(),
  'verification:export': async (opts: { status?: string }, _e?: any, win?: BrowserWindow) => {
    const rows = verification.verificationHistory({ ...opts, limit: 1_000_000 }).rows as any[]
    if (!rows.length) throw new Error('Nothing to export')
    const r = await dialog.showSaveDialog(win!, { defaultPath: `verification-${new Date().toISOString().slice(0, 10)}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return null
    return { file: r.filePath, count: await io.writeExport(r.filePath, rows, io.VERIFICATION_COLUMNS) }
  },

  // ------------------------------------------------------------ AI
  'ai:providers': () => providers.providerStatus(),
  'ai:saveProvider': (id, patch) => providers.saveProvider(id, patch),
  'ai:testProvider': (id) => providers.testProvider(id),
  'ai:listModels': (id) => providers.listModels(id),
  'ai:usage': (days?: number) => providers.usageSummary(days),
  'ai:research': (leadIds: number[]) => (leadIds.length === 1 ? agent.researchLead(leadIds[0]) : agent.queueResearch(leadIds)),
  'ai:outreach': (leadId: number, channel: 'whatsapp' | 'email', guidance?: string) => agent.generateOutreach(leadId, channel, { guidance }),

  // ------------------------------------------------------------ agent / approvals
  'agent:approvals': (status?: 'open' | 'all') => agent.listApprovals(status),
  'agent:approve': (id: number, text?: string) => agent.approve(id, text),
  'agent:reject': (id: number) => agent.reject(id),
  'agent:regenerate': (id: number) => agent.regenerate(id),
  'agent:draft': (convId: number) => agent.draftReply(convId),
  'agent:runTurn': (convId: number) => agent.runTurn(convId),
  'agent:pricingSuggestion': (convId: number) => agent.createPricingSuggestion(convId, null),

  // ------------------------------------------------------------ conversations
  'conversations:list': (opts) => convs.listConversations(opts),
  'conversations:counts': () => convs.folderCounts(),
  'conversations:get': (id: number) => convs.getConversation(id),
  'conversations:send': (id: number, body: string, subject?: string) => {
    if (!body?.trim()) throw new Error('Message is empty')
    return convs.sendInConversation(id, body.trim(), 'human', { subject })
  },
  'conversations:setAiMode': (id: number, mode) => convs.setAiMode(id, mode),
  'conversations:update': (id: number, patch) => convs.updateConversation(id, patch),
  'conversations:markRead': (id: number) => convs.markRead(id),
  'conversations:start': (leadId: number, channel: 'whatsapp' | 'email', accountId: number | null) => {
    const lead = leads.getLead(leadId)
    if (!lead) throw new Error('Lead not found')
    const address = channel === 'whatsapp' ? (lead as any).phone_normalized ?? lead.phone : lead.emails?.[0]?.email
    if (!address) throw new Error(channel === 'whatsapp' ? 'This lead has no phone number' : 'This lead has no email address')
    return convs.getOrCreateConversation({ channel, address, accountId, leadId }).id
  },

  // ------------------------------------------------------------ WhatsApp
  'whatsapp:list': () => wa.listAccounts(),
  'whatsapp:create': (label: string, dailyLimit?: number) => wa.createAccount(label, dailyLimit),
  'whatsapp:update': (id: number, patch) => wa.updateAccount(id, patch),
  'whatsapp:connect': (id: number) => wa.connect(id),
  'whatsapp:disconnect': (id: number) => wa.disconnect(id),
  'whatsapp:logout': (id: number) => wa.logout(id),
  'whatsapp:remove': (id: number) => wa.removeAccount(id),

  // ------------------------------------------------------------ SMTP
  'smtp:list': () => email.listSmtpAccounts(),
  'smtp:create': (a) => email.createSmtpAccount(a),
  'smtp:update': (id: number, a) => email.updateSmtpAccount(id, a),
  'smtp:delete': (id: number) => email.deleteSmtpAccount(id),
  'smtp:test': (id: number) => email.testSmtp(id),
  'smtp:sendTest': (id: number, to: string, subject: string, body: string, isHtml: boolean) => email.sendTestEmail(id, to, subject, body, isHtml),
  'smtp:poll': (id: number) => email.pollInbox(id),

  // ------------------------------------------------------------ campaigns
  'campaigns:list': (channel) => campaigns.listCampaigns(channel),
  'campaigns:get': (id: number) => campaigns.getCampaign(id),
  'campaigns:create': (channel, name, config, steps) => campaigns.createCampaign(channel, name, config, steps),
  'campaigns:update': (id: number, patch) => campaigns.updateCampaign(id, patch),
  'campaigns:delete': (id: number) => campaigns.deleteCampaign(id),
  'campaigns:addRecipients': (id: number, input) => campaigns.addRecipients(id, input),
  'campaigns:removeRecipients': (id: number, ids: number[]) => campaigns.removeRecipients(id, ids),
  'campaigns:recipients': (id: number, opts) => campaigns.listRecipients(id, opts),
  'campaigns:start': (id: number, scheduledAt?: string | null) => campaigns.startCampaign(id, scheduledAt),
  'campaigns:pause': (id: number) => campaigns.pauseCampaign(id),
  'campaigns:resume': (id: number) => campaigns.resumeCampaign(id),
  'campaigns:stop': (id: number) => campaigns.stopCampaign(id),
  'campaigns:preview': (id: number, leadId: number, step?: number) => campaigns.previewMessage(id, leadId, step),
  'campaigns:defaults': (channel: 'whatsapp' | 'email') => campaigns.DEFAULT_CONFIG[channel],
  'suppression:list': (channel?) => campaigns.suppressionList(channel),
  'suppression:add': (channel, address: string, reason?: string) => campaigns.addSuppression(channel, address, reason),
  'suppression:remove': (channel, address: string) => campaigns.removeSuppression(channel, address),

  // ------------------------------------------------------------ analytics
  'analytics:dashboard': (range) => analytics.dashboard(range),
  'analytics:sidebar': () => analytics.sidebarCounts(),

  // ------------------------------------------------------------ license
  'license:status': () => license.licenseStatus(),
  'license:activate': (key: string) => license.activate(key),
  'license:validate': () => license.validate(),
  'license:deactivate': () => license.deactivate(),
  'license:plans': () => license.plans(),

  // ------------------------------------------------------------ data control
  'data:wipe': (confirm: string) => {
    if (confirm !== 'DELETE ALL DATA') throw new Error('Confirmation text does not match')
    db().tx(() => {
      for (const t of ['messages', 'approvals', 'conversations', 'campaign_executions', 'campaign_recipients', 'campaign_steps', 'campaigns',
        'outreach_log', 'verification_records', 'lead_emails', 'email_addresses', 'lead_tags', 'lead_history', 'lead_research', 'leads',
        'search_history', 'job_logs', 'jobs', 'ai_usage'])
        db().run(`DELETE FROM ${t}`)
    })
    logActivity('user', 'data_wiped')
  }
}

export function registerIpc(): void {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (LICENSED.has(channel) && !license.isLicensed())
          throw new Error('This feature requires an active subscription. Open License & Subscription to activate.')
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        // Dialog-based handlers receive the window as an extra trailing arg.
        const needsWin = /export|importPick|verification:file/.test(channel)
        const data = await fn(...(needsWin ? [...padArgs(args, fn.length - 2), event, win] : args))
        return { ok: true, data: data === undefined ? null : data }
      } catch (e: any) {
        log.warn(`${channel} failed: ${e?.message ?? e}`)
        return { ok: false, error: e?.message ?? String(e) }
      }
    })
  }
}

function padArgs(args: unknown[], n: number): unknown[] {
  const out = args.slice(0, Math.max(n, 0))
  while (out.length < n) out.push(undefined)
  return out
}

export const IPC_CHANNELS = Object.keys(handlers)
