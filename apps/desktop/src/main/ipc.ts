import { ipcMain, dialog, shell, BrowserWindow, app, nativeTheme } from 'electron'
import { db } from './db'
import { logger } from './core/logger'
import { getSettings, updateSettings } from './core/settings'
import { listJobs, getJob, jobLogs, pauseJob, resumeJob, cancelJob, deleteJobs, clearFinishedJobs } from './core/jobs'
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
import { addEmailAccount } from './services/emailAutoConfig'
import * as campaigns from './services/campaigns'
import * as templates from './services/templates'
import * as assistant from './services/ai/assistant'
import * as knowledge from './services/knowledge'
import * as autoAgent from './services/ai/autoAgent'
import * as remote from './services/remoteAdmin'
import * as vlist from './services/verifyList'
import { writeFile } from 'node:fs/promises'
import * as analytics from './services/analytics'
import * as mapsManage from './services/maps/manage'
import * as gmaps from './services/maps'
import * as license from './services/subscription'
import { testPlacesKey, MAJOR_CITIES } from './services/sources/googleMaps'
import { testCse } from './services/sources/linkedin'
import { testApollo } from './services/sources/apollo'
import { SECRET_KEYS, type SecretName } from '@shared/settings'

const log = logger('ipc')
type Handler = (...args: any[]) => unknown

/** Channels that require an active license when licensing is enforced. */
const WEBSITE_STATUS: Record<string, string> = { has_website: 'Has website', possible_website: 'Website found online', no_website: 'No website', social_only: 'Social media only' }
const MAPS_EXPORT_COLUMNS: [string, string][] = [
  ['n', '#'], ['business_name', 'Business Name'], ['category', 'Category'], ['phone', 'Phone'], ['emails', 'Email'], ['website', 'Website'],
  ['address', 'Address'], ['rating', 'Rating'], ['reviews', 'Reviews'], ['status', 'Status'], ['maps_url', 'Google Maps URL']
]

const LICENSED = new Set([
  'maps:start',
  'discovery:start', 'verification:single', 'verification:bulk', 'verification:file', 'verification:leads', 'verification:reverify',
  'ai:research', 'ai:outreach', 'campaigns:start', 'campaigns:launchEmail', 'verifylist:add', 'verifylist:resume', 'campaigns:resume', 'conversations:send', 'agent:approve'
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
  'jobs:delete': (ids: string[]) => deleteJobs(ids),
  'jobs:clearFinished': (types?: string[]) => clearFinishedJobs(types),

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

  // ------------------------------------------------------------ Google Maps (browser) search
  'maps:start': (input) => gmaps.startSearch(input),
  'maps:stop': () => gmaps.stopSearch(),
  'maps:active': () => gmaps.activeSearch(),
  'maps:searches': () => gmaps.recentSearches(),
  'maps:results': (filter, opts) => gmaps.listResults(filter ?? {}, opts),
  'maps:categories': () => gmaps.resultCategories(),
  'maps:delete': (ids: number[]) => mapsManage.deleteBusinesses(ids),
  'maps:add': (input) => {
    const r = mapsManage.addBusiness(input)
    if (getSettings().verification.autoVerify && r.newEmailIds.length) verification.queueVerification(r.newEmailIds)
    return r
  },
  'maps:get': (id: number) => mapsManage.getBusiness(id),
  'maps:update': (id: number, patch) => mapsManage.updateBusiness(id, patch),
  'maps:moveToCategory': (ids: number[], categoryId: number) => mapsManage.moveToCategory(ids, categoryId),
  'maps:deleteSearches': (ids: number[]) => mapsManage.deleteSearches(ids),
  'maps:bgStatus': () => gmaps.backgroundStatus(),
  'maps:setOptions': (patch) => gmaps.setMapsOptions(patch),
  'maps:export': async (input: { filter?: any; ids?: number[]; format: 'csv' | 'xlsx' }, _e?: any, win?: BrowserWindow) => {
    const rows = gmaps.resultRowsForExport(input.filter ?? {}, input.ids).map((r: any, i: number) => ({ ...r, n: i + 1, status: WEBSITE_STATUS[r.website_status] ?? r.website_status }))
    if (!rows.length) throw new Error('No results to export')
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `google-maps-leads-${new Date().toISOString().slice(0, 10)}.${input.format}`,
      filters: [input.format === 'xlsx' ? { name: 'Excel', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }]
    })
    if (r.canceled || !r.filePath) return null
    const n = await io.writeExport(r.filePath, rows, MAPS_EXPORT_COLUMNS)
    logActivity('user', 'maps_exported', 'maps', n)
    return { file: r.filePath, count: n }
  },

  // ------------------------------------------------------------ discovery
  'discovery:start': (source: string, params) => discovery.startDiscovery(source, params),
  'discovery:history': (source?: string) => discovery.searchHistory(source),
  'discovery:deleteHistory': (ids: number[]) => discovery.deleteSearchHistory(ids),
  'discovery:clearHistory': (source?: string) => discovery.clearSearchHistory(source),
  'discovery:countries': () => Object.keys(MAJOR_CITIES),

  // ------------------------------------------------------------ email verification list (paste → verify → table)
  'verifylist:parse': (text: string) => {
    const r = vlist.parseEmails(text)
    return { count: r.emails.length, duplicates: r.duplicates, badFormat: r.badFormat.slice(0, 50), badCount: r.badFormat.length }
  },
  'verifylist:add': (text: string, opts?: { recheck?: boolean }) => vlist.addAndVerify(text, opts),
  'verifylist:list': (f) => vlist.listResults(f ?? {}),
  'verifylist:counts': () => vlist.counts(),
  'verifylist:ids': (f) => vlist.idsFor(f ?? {}),
  'verifylist:recheck': (ids: number[]) => vlist.recheck(ids),
  'verifylist:delete': (ids: number[]) => vlist.deleteIds(ids),
  'verifylist:deleteStatus': (status: 'invalid' | 'unknown' | 'risky' | 'verified') => vlist.deleteByStatus(status),
  'verifylist:clear': () => vlist.clearAll(),
  'verifylist:stop': () => vlist.stop(),
  'verifylist:resume': () => void vlist.start(),
  'verifylist:export': async (scope: { kind: 'verified' | 'selected' | 'all' | 'filtered'; ids?: number[]; status?: string; search?: string; format: 'csv' | 'txt' }, _e?: any, win?: BrowserWindow) => {
    const rows = vlist.exportRows(scope)
    const name = { verified: 'verified-emails', selected: 'selected-emails', all: 'all-emails', filtered: 'emails' }[scope.kind]
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `${name}-${new Date().toISOString().slice(0, 10)}.${scope.format}`,
      filters: [scope.format === 'txt' ? { name: 'Text (one email per line)', extensions: ['txt'] } : { name: 'CSV (Excel)', extensions: ['csv'] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, scope.format === 'txt' ? vlist.toTxt(rows) : '\ufeff' + vlist.toCsv(rows), 'utf8')
    logActivity('user', 'verifylist_exported', 'verification', rows.length)
    return { file: r.filePath, count: rows.length }
  },

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
  'conversations:delete': (ids: number[]) => convs.deleteConversations(ids),
  'conversations:deleteMessages': (id: number, messageIds: number[]) => convs.deleteMessages(id, messageIds),
  'conversations:clear': (id: number) => convs.clearConversation(id),
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
  'smtp:add': async (input: { email: string; password: string; host?: string; port?: number; id?: number }) => {
    const r = await addEmailAccount(input)
    email.forgetTransport(r.id)
    logActivity('user', 'smtp_account_added', 'smtp', r.id)
    return r
  },
  'smtp:update': (id: number, a) => email.updateSmtpAccount(id, a),
  'smtp:patch': (id: number, p) => email.patchSmtpAccount(id, p),
  'smtp:delete': (id: number) => email.deleteSmtpAccount(id),
  'smtp:test': (id: number) => email.testSmtp(id),
  'smtp:sendTest': (id: number, to: string, subject: string, body: string, isHtml: boolean) => email.sendTestEmail(id, to, subject, body, isHtml),
  'smtp:poll': (id: number) => email.pollInbox(id),
  'smtp:accountCategories': () => email.accountCategories(),
  'smtp:setCategories': (id: number, categoryIds: number[]) => email.setAccountCategories(id, categoryIds),
  'email:activity': (opts) => email.emailActivity(opts),
  'email:stats': () => email.emailStats(),

  // ------------------------------------------------------------ campaigns
  'campaigns:list': (channel) => campaigns.listCampaigns(channel),
  'campaigns:get': (id: number) => campaigns.getCampaign(id),
  'campaigns:create': (channel, name, config, steps) => campaigns.createCampaign(channel, name, config, steps),
  'campaigns:update': (id: number, patch) => campaigns.updateCampaign(id, patch),
  'campaigns:delete': (id: number) => campaigns.deleteCampaign(id),
  'campaigns:addRecipients': (id: number, input) => campaigns.addRecipients(id, input),
  'campaigns:removeRecipients': (id: number, ids: number[]) => campaigns.removeRecipients(id, ids),
  'campaigns:rename': (id: number, name: string) => campaigns.renameCampaign(id, name),
  'campaigns:recipients': (id: number, opts) => campaigns.listRecipients(id, opts),
  'campaigns:start': (id: number, scheduledAt?: string | null) => campaigns.startCampaign(id, scheduledAt),
  'campaigns:pause': (id: number) => campaigns.pauseCampaign(id),
  'campaigns:resume': (id: number) => campaigns.resumeCampaign(id),
  'campaigns:stop': (id: number) => campaigns.stopCampaign(id),
  'campaigns:preview': (id: number, leadId: number, step?: number) => campaigns.previewMessage(id, leadId, step),
  'remote:status': () => remote.remoteStatus(),
  'remote:sendCode': () => remote.sendVerificationCode(),
  'remote:clearHistory': () => remote.clearRemoteHistory(),
  'remote:test': async () => {
    if (!getSettings().remoteAdmin.verified) throw new Error('Verify the admin number first.')
    if (!(await remote.sendToAdmin('👋 Test from Lead Generation — remote control is connected.'))) throw new Error('Could not send. Is the WhatsApp account connected?')
    return true
  },
  'knowledge:list': () => knowledge.listKnowledge(),
  'knowledge:save': (item) => knowledge.saveKnowledge(item),
  'knowledge:fill': async (text?: string) => (await import('./services/ai/businessInfo')).fillFromText(text ?? getSettings().agent.businessPrompt),
  'knowledge:delete': (id: number) => knowledge.deleteKnowledge(id),
  'agent:overview': () => autoAgent.agentOverview(),
  'agent:activity': (opts) => autoAgent.agentActivity(opts ?? {}),
  'agent:pendingFor': (convId: number) => db().get("SELECT id, kind, due_at FROM agent_queue WHERE conversation_id = ? AND status IN ('waiting','working') ORDER BY due_at LIMIT 1", convId) ?? null,
  'agent:sendNow': (queueId: number) => autoAgent.sendNow(queueId),
  'agent:cancelItem': (queueId: number) => autoAgent.cancelItem(queueId),
  'agent:accounts': () => ({
    email: db().all('SELECT id, from_email label, agent_enabled, status FROM smtp_accounts ORDER BY id'),
    whatsapp: db().all('SELECT id, label, phone, agent_enabled, status FROM whatsapp_accounts ORDER BY id')
  }),
  'agent:setAccountEnabled': (channel: 'email' | 'whatsapp', id: number, on: boolean) => {
    db().run(`UPDATE ${channel === 'email' ? 'smtp_accounts' : 'whatsapp_accounts'} SET agent_enabled = ? WHERE id = ?`, on ? 1 : 0, id)
  },
  'agent:timezones': () => (Intl as any).supportedValuesOf?.('timeZone') ?? [],
  'assistant:messages': () => assistant.listMessages(),
  'assistant:ask': (text: string) => {
    if (assistant.isBusy()) throw new Error('Still working on your last message — wait a moment or press Stop.')
    void assistant.ask(text)
  },
  'assistant:stop': () => assistant.stop(),
  'assistant:confirm': () => assistant.confirmPending(),
  'assistant:cancel': () => assistant.cancelPending(),
  'assistant:clear': () => assistant.clearChat(),
  'assistant:live': () => assistant.liveStatus(),
  'templates:writeAI': async (category: string, offer?: string) => (await import('./services/ai/writer')).writeTemplate(category, offer),
  'templates:list': () => templates.listTemplates(),
  'templates:save': (t) => templates.saveTemplate(t),
  'templates:duplicate': (id: number) => templates.duplicateTemplate(id),
  'templates:delete': (id: number) => templates.deleteTemplate(id),
  'campaigns:launchEmail': (input) => campaigns.launchEmailCampaignAuto(input),
  'campaigns:emailAudience': (categoryIds: number[]) => campaigns.emailAudienceCount(categoryIds ?? []),
  'campaigns:defaults': (channel: 'whatsapp' | 'email') => campaigns.DEFAULT_CONFIG[channel],
  'suppression:list': (channel?) => campaigns.suppressionList(channel),
  'suppression:add': (channel, address: string, reason?: string) => campaigns.addSuppression(channel, address, reason),
  'suppression:remove': (channel, address: string) => campaigns.removeSuppression(channel, address),

  // ------------------------------------------------------------ analytics
  'analytics:dashboard': (range) => analytics.dashboard(range),
  'analytics:sidebar': () => analytics.sidebarCounts(),

  // ------------------------------------------------------------ license
  'license:status': () => license.subscriptionStatus(),
  'license:plans': () => license.plans(),
  'license:requestOtp': (input) => license.requestOtp(input),
  'license:verifyOtp': (code: string) => license.verifyOtp(code),

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
  // The AI assistant runs actions through the same handlers (and the same subscription checks) as the screens.
  assistant.setAppInvoker(async (channel, args) => {
    const fn = handlers[channel]
    if (!fn) throw new Error(`Unknown action ${channel}`)
    if (LICENSED.has(channel) && !license.isLicensed()) throw new Error('This feature requires an active subscription.')
    return fn(...args)
  })
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
