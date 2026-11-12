# Desktop IPC API

The renderer talks to the main process only through `window.lge.invoke(channel, ...args)` (exposed by `src/preload/index.ts`) and receives push events through `window.lge.onEvent`. Every handler lives in `src/main/ipc.ts` and returns `{ ok: true, data } | { ok: false, error }`; the preload unwraps it into a resolved value or a thrown `Error`.

Channels marked 🔒 require an active license when licensing is enforced.

| Group | Channels |
|---|---|
| App | `app:info`, `app:openExternal(url)` (http/https/mailto only), `app:openLogs`, `app:activity(limit)` |
| Settings | `settings:get`, `settings:update(patch)`, `secrets:status` (masked), `secrets:set(name, value\|null)`, `integrations:test(name)` |
| Jobs | `jobs:list({types, limit, active})`, `jobs:get(id)`, `jobs:logs(id)`, `jobs:pause/resume/cancel(id)` |
| Leads | `leads:list(filter, {limit, offset, sort, dir})`, `leads:get(id)`, `leads:create(input)`, `leads:update(id, patch)`, `leads:bulkUpdate(ids, {category_id, outreach_status, addTags, removeTags})`, `leads:delete(ids, purge?)`, `leads:idsForFilter(filter)`, `leads:addEmail`, `leads:setPrimaryEmail`, `leads:removeEmail`, `leads:optOut`, `leads:categories`, `leads:createCategory`, `leads:renameCategory`, `leads:deleteCategory`, `leads:filterOptions`, `leads:savedFilters`, `leads:saveFilter`, `leads:deleteSavedFilter`, `leads:duplicates`, `leads:merge(keepId, others)`, `leads:export({leadIds\|filter, format})`, `leads:importPick`, `leads:importCommit(file, mapping, {tag, category})` |
| Discovery | 🔒`discovery:start(source, params)` (`google_maps`, `linkedin`, `apollo`, `website`), `discovery:history(source)`, `discovery:countries` |
| Verification | 🔒`verification:single(email)`, 🔒`verification:bulk(emails)`, 🔒`verification:file`, 🔒`verification:leads(leadIds\|null, statuses)`, 🔒`verification:reverify(emailIds)`, `verification:stats`, `verification:history(opts)`, `verification:batch(batchId)`, `verification:port25`, `verification:export(opts)` |
| AI | `ai:providers`, `ai:saveProvider(id, {apiKey, defaultModel, enabled})`, `ai:testProvider(id)`, `ai:listModels(id)`, `ai:usage(days)`, 🔒`ai:research(leadIds)`, 🔒`ai:outreach(leadId, channel, guidance?)` |
| Agent | `agent:approvals('open'\|'all')`, 🔒`agent:approve(id, text?)`, `agent:reject(id)`, `agent:regenerate(id)`, `agent:draft(convId)`, `agent:runTurn(convId)`, `agent:pricingSuggestion(convId)` |
| Conversations | `conversations:list({folder, search})`, `conversations:counts`, `conversations:get(id)`, 🔒`conversations:send(id, body, subject?)`, `conversations:setAiMode(id, 'auto'\|'paused'\|'human')`, `conversations:update(id, {status, interest, assigned_to, notes})`, `conversations:markRead(id)`, `conversations:start(leadId, channel, accountId)` |
| WhatsApp | `whatsapp:list`, `whatsapp:create(label, dailyLimit)`, `whatsapp:update`, `whatsapp:connect/disconnect/logout/remove(id)` |
| SMTP | `smtp:list`, `smtp:create(account)`, `smtp:update(id, account)`, `smtp:delete(id)`, `smtp:test(id)`, `smtp:sendTest(id, to, subject, body, isHtml)`, `smtp:poll(id)` |
| Campaigns | `campaigns:list(channel)`, `campaigns:get(id)`, `campaigns:create(channel, name, config, steps)`, `campaigns:update(id, patch)`, `campaigns:delete(id)`, `campaigns:addRecipients(id, {leadIds\|filter})`, `campaigns:removeRecipients`, `campaigns:recipients(id, opts)`, 🔒`campaigns:start(id, scheduledAt?)`, `campaigns:pause`, 🔒`campaigns:resume`, `campaigns:stop`, `campaigns:preview(id, leadId, step)`, `campaigns:defaults(channel)`, `suppression:list/add/remove` |
| Analytics | `analytics:dashboard({from, to})`, `analytics:sidebar` |
| Subscription | `license:status`, `license:plans`, `license:requestOtp({planCode, name?, phone?})`, `license:verifyOtp(code)` |
| Data | `data:wipe('DELETE ALL DATA')` |

## Events (main → renderer)

`job:update`, `job:finished`, `leads:changed`, `verification:progress`, `discovery:progress`, `extraction:page`, `extraction:result`, `conversation:message`, `conversation:updated`, `approval:created`, `approval:updated`, `campaign:updated`, `whatsapp:status`, `whatsapp:qr`, `license:changed`, `update:available`, `notify`, `navigate`.

