/**
 * Everything the assistant can do in the app, by area. Each entry is a real IPC handler
 * (the same code the screens call). Entries marked `confirm` delete data, send messages or
 * disconnect something: the assistant shows a summary and runs them only after the user approves.
 * The main prompt lists only the area names; the model reads an area's entries with
 * `capabilities` when it needs them, which keeps every request small.
 */

export interface CatalogEntry {
  args: string
  desc: string
  confirm?: boolean
}

export const CATALOG: Record<string, { about: string; calls: Record<string, CatalogEntry> }> = {
  categories: {
    about: 'Lead categories: list, create, rename, delete (leads of a deleted category move to "Other").',
    calls: {
      'leads:categories': { args: '[]', desc: 'All categories with lead_count.' },
      'leads:createCategory': { args: '[name]', desc: 'Create a category.' },
      'leads:renameCategory': { args: '[categoryId, newName]', desc: 'Rename.' },
      'leads:deleteCategory': { args: '[categoryId]', desc: 'Delete one category (its leads move to Other).', confirm: true }
    }
  },
  leads: {
    about: 'Saved businesses (leads): search, view, add, edit, tag, move, merge duplicates, delete, opt out.',
    calls: {
      'leads:list': { args: '[filter, {limit, offset}]', desc: 'filter: {search, categoryIds, countries, cities, hasEmail, hasWebsite, hasPhone, verification:["safe","risky","invalid","unverified"], outreach:["new","contacted","interested","not_interested"], tags}. Returns {rows,total}.' },
      'leads:get': { args: '[leadId]', desc: 'One lead with emails and history.' },
      'leads:create': { args: '[{business_name, contact_name?, phone?, website?, city?, country?, category?, emails?: [{email}]}]', desc: 'Add a lead by hand.' },
      'leads:update': { args: '[leadId, {business_name?, contact_name?, phone?, website?, city?, country?, category_id?, outreach_status?, notes?}]', desc: 'Edit a lead.' },
      'leads:bulkUpdate': { args: '[leadIds, {category_id?, outreach_status?, addTags?, removeTags?}]', desc: 'Change many leads.' },
      'leads:idsForFilter': { args: '[filter]', desc: 'Lead ids matching a filter (use before bulk actions).' },
      'leads:addEmail': { args: '[leadId, email]', desc: 'Attach an email the user gave.' },
      'leads:removeEmail': { args: '[leadId, emailId]', desc: 'Remove an email from a lead.', confirm: true },
      'leads:duplicates': { args: '[]', desc: 'Groups of probable duplicate leads.' },
      'leads:merge': { args: '[keepId, otherIds]', desc: 'Merge duplicates into one lead.', confirm: true },
      'leads:optOut': { args: '[leadId]', desc: 'Mark do-not-contact.', confirm: true },
      'leads:delete': { args: '[leadIds, purge?]', desc: 'Delete leads (purge=true removes permanently).', confirm: true }
    }
  },
  maps: {
    about: 'Google Maps search history/results, background email finder and verification switches.',
    calls: {
      'maps:searches': { args: '[]', desc: 'Recent searches with counts.' },
      'maps:results': { args: '[{searchId?, search?, emailStatus?}, {limit, offset}]', desc: 'Search results table.' },
      'maps:bgStatus': { args: '[]', desc: 'Email finder / verifier status.' },
      'maps:setOptions': { args: '[{autoFindEmails?: boolean, verifyEmails?: boolean}]', desc: 'Turn the background email finder / verification on or off.' },
      'maps:stop': { args: '[]', desc: 'Stop the running search.' },
      'maps:delete': { args: '[resultIds]', desc: 'Delete search results (and their leads).', confirm: true }
    }
  },
  verification: {
    about: 'Email verification: check one address, verify leads, stats.',
    calls: {
      'verification:single': { args: '[email]', desc: 'Check one email now.' },
      'verification:leads': { args: '[leadIds | null, statuses?]', desc: 'Queue verification for leads (null = all unverified).' },
      'verification:stats': { args: '[]', desc: 'Counts by status.' },
      'verification:history': { args: '[{limit}]', desc: 'Recent checks.' }
    }
  },
  email_accounts: {
    about: 'Sending email accounts (add = user types email + app password in chat or uses the form), test, categories, sent emails.',
    calls: {
      'smtp:list': { args: '[]', desc: 'Accounts (id, from_email, status, daily_limit, sent_today).' },
      'smtp:test': { args: '[accountId]', desc: 'Test the login.' },
      'smtp:sendTest': { args: '[accountId, to, subject, body, false]', desc: 'Send a test email to an address the user gave.', confirm: true },
      'smtp:accountCategories': { args: '[]', desc: 'Which categories each account sends to.' },
      'smtp:setCategories': { args: '[accountId, categoryIds]', desc: 'Replace an account’s categories.' },
      'smtp:delete': { args: '[accountId]', desc: 'Remove an account.', confirm: true },
      'email:stats': { args: '[]', desc: 'Sent / replied / failed / sending counts.' },
      'email:activity': { args: '[{status?: "sent"|"replied"|"failed", search?, limit?}]', desc: 'Sent emails with status.' },
      'settings:update': { args: '[{email: {rotateAccounts: boolean}}]', desc: 'Rotate between accounts of a category on/off.' }
    }
  },
  templates: {
    about: 'Email templates: list, create/edit, copy, delete.',
    calls: {
      'templates:list': { args: '[]', desc: 'All templates.' },
      'templates:save': { args: '[{id?, name, subject, body}]', desc: 'Create or edit (variables {business_name} {contact_name} {city}).' },
      'templates:duplicate': { args: '[templateId]', desc: 'Copy.' },
      'templates:delete': { args: '[templateId]', desc: 'Delete.', confirm: true }
    }
  },
  campaigns: {
    about: 'Email and WhatsApp campaigns: list, details, recipients, pause/resume/stop, rename, delete.',
    calls: {
      'campaigns:list': { args: '["email"|"whatsapp"]', desc: 'Campaigns with progress.' },
      'campaigns:get': { args: '[campaignId]', desc: 'Details, steps, stats.' },
      'campaigns:recipients': { args: '[campaignId, {status?, limit?}]', desc: 'Who is in it and their status.' },
      'campaigns:pause': { args: '[campaignId]', desc: 'Pause.' },
      'campaigns:resume': { args: '[campaignId]', desc: 'Resume.' },
      'campaigns:update': { args: '[campaignId, {name?, config?: {dailyLimit?, delayMinutes?, sendWindow?: {start,end,days}}}]', desc: 'Rename or change pacing.' },
      'campaigns:stop': { args: '[campaignId]', desc: 'Stop for good.', confirm: true },
      'campaigns:delete': { args: '[campaignId]', desc: 'Delete (must be stopped).', confirm: true }
    }
  },
  whatsapp: {
    about: 'WhatsApp accounts: list, add (then the user scans a QR code on the top bar), connect, limits, log out, remove.',
    calls: {
      'whatsapp:list': { args: '[]', desc: 'Accounts and status.' },
      'whatsapp:create': { args: '[label, dailyLimit?]', desc: 'Add an account (user must scan the QR from the WhatsApp menu on the top bar).' },
      'whatsapp:connect': { args: '[accountId]', desc: 'Connect / reconnect.' },
      'whatsapp:disconnect': { args: '[accountId]', desc: 'Disconnect (keeps the session).' },
      'whatsapp:update': { args: '[accountId, {label?, daily_limit?, enabled?}]', desc: 'Rename / limit / enable.' },
      'whatsapp:logout': { args: '[accountId]', desc: 'Log out (needs a new QR scan).', confirm: true },
      'whatsapp:remove': { args: '[accountId]', desc: 'Remove the account.', confirm: true }
    }
  },
  conversations: {
    about: 'Email/WhatsApp conversations with leads: list, read, reply, AI mode, mark interested.',
    calls: {
      'conversations:list': { args: '[{folder?: "all"|"email"|"whatsapp"|"interested"|"not_interested"|"pending_replies"|"pending_approvals"|"human", search?, limit?}]', desc: 'Conversations.' },
      'conversations:get': { args: '[conversationId]', desc: 'Messages of one conversation.' },
      'conversations:markRead': { args: '[conversationId]', desc: 'Mark read.' },
      'conversations:setAiMode': { args: '[conversationId, "auto"|"paused"|"human"]', desc: 'Let AI answer, pause AI, or hand to a human.' },
      'conversations:update': { args: '[conversationId, {status?: "open"|"resolved", interest?: "interested"|"not_interested"|"unknown", notes?}]', desc: 'Update status / interest.' },
      'agent:draft': { args: '[conversationId]', desc: 'AI drafts a reply (not sent).' },
      'conversations:send': { args: '[conversationId, body, subject?]', desc: 'Send a message to the lead.', confirm: true }
    }
  },
  ai_agent: {
    about: 'AI reply agent: approvals waiting, approve/reject drafts, agent settings.',
    calls: {
      'agent:approvals': { args: '["open"|"all"]', desc: 'Drafts / pricing waiting for approval.' },
      'agent:approve': { args: '[approvalId, editedText?]', desc: 'Send the approved reply.', confirm: true },
      'agent:reject': { args: '[approvalId]', desc: 'Discard a draft.' },
      'settings:update': { args: '[{agent: {enabled?, autoSendReplies?, tone?: "professional"|"friendly"|"consultative"|"formal", language?, replyDelaySeconds?, outreachStrategy?}}]', desc: 'AI agent behaviour.' }
    }
  },
  settings: {
    about: 'App settings: company info and signature, pricing, compliance, verification, crawler, notifications, theme.',
    calls: {
      'settings:get': { args: '[]', desc: 'All settings.' },
      'settings:update': {
        args: '[patch]',
        desc: 'patch keys: company {name, website, description, services, signature, senderName}; pricing {currency, notes}; compliance {emailFooter, optOutKeywords, whatsappOptOutNotice}; verification {autoVerify, reverifyAfterDays}; notifications {desktop}; appearance {theme: "light"|"dark"|"system"}; maps {autoFindEmails, verifyEmails}; email {rotateAccounts}.'
      },
      'ai:providers': { args: '[]', desc: 'AI providers and models (keys are set in the AI settings screen, never in chat).' },
      'ai:usage': { args: '[days?]', desc: 'AI usage.' },
      'license:status': { args: '[]', desc: 'Subscription status.' }
    }
  },
  suppression: {
    about: 'Do-not-contact list (emails / numbers that must never be contacted).',
    calls: {
      'suppression:list': { args: '["email"|"whatsapp"?]', desc: 'The list.' },
      'suppression:add': { args: '["email"|"whatsapp", address, reason?]', desc: 'Block an address.', confirm: true },
      'suppression:remove': { args: '["email"|"whatsapp", address]', desc: 'Unblock.', confirm: true }
    }
  },
  data: {
    about: 'Danger zone.',
    calls: {
      'data:wipe': { args: '["DELETE ALL DATA"]', desc: 'Delete ALL leads, campaigns, conversations (settings and accounts stay).', confirm: true }
    }
  }
}

export const CATALOG_CHANNELS: Record<string, CatalogEntry> = Object.fromEntries(Object.values(CATALOG).flatMap((a) => Object.entries(a.calls)))
