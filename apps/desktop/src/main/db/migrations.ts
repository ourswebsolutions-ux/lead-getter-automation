// Versioned schema migrations. Each entry runs once inside a transaction.
// Never edit a shipped migration — append a new one instead.

export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Encrypted credential vault (API keys, SMTP passwords, tokens). Values are encrypted with
-- the OS keychain (Electron safeStorage) before they are written here.
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('owner','admin','operator')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lead_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lead_sources (
  id TEXT PRIMARY KEY,          -- google_maps, linkedin, apollo, website, podcast, import, manual
  label TEXT NOT NULL
);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  job_title TEXT,
  business_category TEXT,
  industry TEXT,
  category_id INTEGER REFERENCES lead_categories(id) ON DELETE SET NULL,
  phone TEXT,
  phone_normalized TEXT,
  website TEXT,
  domain TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  postal_code TEXT,
  source TEXT NOT NULL REFERENCES lead_sources(id),
  source_ref TEXT,               -- e.g. Google place_id, Apollo id, podcast id
  source_url TEXT,               -- e.g. Google Maps URL, LinkedIn URL
  linkedin_url TEXT,
  rating REAL,
  review_count INTEGER,
  apollo_data TEXT,              -- JSON
  extra TEXT,                    -- JSON custom fields
  outreach_status TEXT NOT NULL DEFAULT 'new'
    CHECK (outreach_status IN ('new','contacted','replied','interested','not_interested','converted','do_not_contact')),
  notes TEXT,
  opted_out INTEGER NOT NULL DEFAULT 0,
  consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','legitimate_interest','granted','withdrawn')),
  dedupe_key TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX ux_leads_dedupe ON leads(dedupe_key) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_category ON leads(category_id);
CREATE INDEX ix_leads_source ON leads(source);
CREATE INDEX ix_leads_country_city ON leads(country, city);
CREATE INDEX ix_leads_status ON leads(outreach_status);
CREATE INDEX ix_leads_discovered ON leads(discovered_at);
CREATE INDEX ix_leads_phone ON leads(phone_normalized);
CREATE INDEX ix_leads_domain ON leads(domain);

CREATE TABLE lead_tags (
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (lead_id, tag)
);
CREATE INDEX ix_lead_tags_tag ON lead_tags(tag);

CREATE TABLE lead_history (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_lead_history_lead ON lead_history(lead_id);

CREATE TABLE email_addresses (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','queued','safe','risky','invalid','unknown','failed')),
  is_role INTEGER,
  is_disposable INTEGER,
  is_catch_all INTEGER,
  last_verified_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0,
  suppression_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_email_status ON email_addresses(verification_status);

CREATE TABLE lead_emails (
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email_id INTEGER NOT NULL REFERENCES email_addresses(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  PRIMARY KEY (lead_id, email_id)
);
CREATE INDEX ix_lead_emails_email ON lead_emails(email_id);

CREATE TABLE verification_records (
  id INTEGER PRIMARY KEY,
  email_id INTEGER NOT NULL REFERENCES email_addresses(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT,
  raw TEXT,                       -- full Reacher JSON
  batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_verif_email ON verification_records(email_id);
CREATE INDEX ix_verif_batch ON verification_records(batch_id);

CREATE TABLE lead_research (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  summary TEXT,
  data TEXT,                      -- JSON research output
  pages TEXT,                     -- JSON list of crawled URLs
  provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE search_history (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  params TEXT NOT NULL,
  job_id TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE saved_filters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  filter TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE whatsapp_accounts (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  phone TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected','connecting','qr','connected','logged_out','error')),
  last_error TEXT,
  last_activity_at TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 40,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Baileys auth state, one row per key, encrypted at rest.
CREATE TABLE whatsapp_sessions (
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE smtp_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  secure TEXT NOT NULL DEFAULT 'starttls' CHECK (secure IN ('none','starttls','ssl')),
  username TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  imap_host TEXT,
  imap_port INTEGER,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_last_uid INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ok','error')),
  last_error TEXT,
  last_tested_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY CHECK (id IN ('openai','anthropic','gemini','groq')),
  enabled INTEGER NOT NULL DEFAULT 0,
  default_model TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('unconfigured','ok','error')),
  last_error TEXT,
  last_tested_at TEXT
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_ai_usage_created ON ai_usage(created_at);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','running','paused','stopped','completed')),
  config TEXT NOT NULL,           -- JSON: delays, limits, window, accounts, ai personalization...
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_campaigns_channel_status ON campaigns(channel, status);

-- Message variants (WhatsApp) or sequence steps (email).
CREATE TABLE campaign_steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('variant','initial','followup')),
  subject TEXT,
  body TEXT NOT NULL,
  is_html INTEGER NOT NULL DEFAULT 0,
  delay_days INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_campaign_steps ON campaign_steps(campaign_id, position);

CREATE TABLE campaign_recipients (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  address TEXT NOT NULL,          -- phone or email
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','replied','failed','skipped','completed','stopped')),
  step_index INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT,
  last_sent_at TEXT,
  account_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX ix_recipients_status ON campaign_recipients(campaign_id, status, next_send_at);

CREATE TABLE campaign_executions (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE SET NULL,
  event TEXT NOT NULL,            -- started, paused, resumed, sent, failed, skipped, stopped, completed, bounced
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_exec_campaign ON campaign_executions(campaign_id, created_at);

-- One record per (channel,address) that has received outreach, used for cross-campaign dedupe.
CREATE TABLE outreach_log (
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  lead_id INTEGER,
  campaign_id INTEGER,
  first_sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, address)
);

CREATE TABLE suppression_list (
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  address TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, address)
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  address TEXT NOT NULL,          -- phone (digits) or email
  account_id INTEGER,             -- whatsapp_accounts.id or smtp_accounts.id
  campaign_id INTEGER,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  interest TEXT NOT NULL DEFAULT 'unknown' CHECK (interest IN ('unknown','interested','not_interested')),
  ai_mode TEXT NOT NULL DEFAULT 'auto' CHECK (ai_mode IN ('auto','paused','human')),
  assigned_to INTEGER REFERENCES users(id),
  unread INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  requirements TEXT,              -- JSON memory: requirements, objections, preferences
  last_message_at TEXT,
  last_message_preview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, address, account_id)
);
CREATE INDEX ix_conv_last ON conversations(last_message_at DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  author TEXT NOT NULL CHECK (author IN ('contact','ai','human','campaign','system')),
  body TEXT NOT NULL,
  subject TEXT,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','delivered','read','failed','received')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_messages_conv ON messages(conversation_id, id);
CREATE UNIQUE INDEX ux_messages_external ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pricing','reply')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','superseded','needs_pricing_config')),
  title TEXT,
  requirements_summary TEXT,
  scope TEXT,                     -- JSON array
  complexity TEXT,
  price_min REAL,
  price_max REAL,
  currency TEXT,
  assumptions TEXT,               -- JSON array
  suggested_response TEXT NOT NULL,
  final_response TEXT,
  trigger_message_id INTEGER,
  decided_by INTEGER,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_approvals_status ON approvals(status);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  params TEXT NOT NULL,
  state TEXT,                     -- JSON checkpoint for resume after restart
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_jobs_status ON jobs(status, created_at);
CREATE UNIQUE INDEX ux_jobs_active_dedupe ON jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued','running','paused');

CREATE TABLE job_logs (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_job_logs ON job_logs(job_id, id);

CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,            -- 'user', 'ai', 'system'
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_activity_created ON activity_logs(created_at);

CREATE TABLE license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license_key TEXT,
  token TEXT,                     -- signed token returned by the license server
  plan TEXT,
  status TEXT,
  expires_at TEXT,
  last_validated_at TEXT,
  last_error TEXT
);
INSERT INTO license_state (id) VALUES (1);

INSERT INTO lead_sources (id, label) VALUES
  ('google_maps','Google Maps'), ('linkedin','LinkedIn'), ('apollo','Apollo'),
  ('website','Website'), ('podcast','Podcast'), ('import','Import'), ('manual','Manual');

INSERT INTO lead_categories (name, color, is_system) VALUES
  ('Restaurants','#E5484D',1), ('Food Businesses','#F76B15',1), ('Automotive','#0090FF',1),
  ('Car Dealerships','#3E63DD',1), ('Real Estate','#30A46C',1), ('Healthcare','#12A594',1),
  ('Skincare Clinics','#D6409F',1), ('Retail','#FFB224',1), ('Professional Services','#8E4EC6',1),
  ('Other','#8B8D98',1);

INSERT INTO ai_providers (id) VALUES ('openai'), ('anthropic'), ('gemini'), ('groq');
INSERT INTO users (id, name, role) VALUES (1, 'Owner', 'owner');
`
  },
  {
    version: 2,
    name: 'local subscription with emailed OTP (no license server)',
    sql: `
CREATE TABLE subscription (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  trial_ends_at TEXT,          -- ISO
  plan TEXT,                   -- plan code once activated
  expires_at TEXT,             -- ISO; NULL with a plan = lifetime
  activated_at TEXT,
  signature TEXT               -- HMAC over the fields above + device id
);
INSERT INTO subscription (id) VALUES (1);

CREATE TABLE subscription_otp (
  id INTEGER PRIMARY KEY,
  plan TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','replaced','locked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP TABLE IF EXISTS license_state;
`
  },
  {
    version: 3,
    name: 'google maps search (browser) results',
    sql: `
CREATE TABLE maps_searches (
  id INTEGER PRIMARY KEY,
  keyword TEXT NOT NULL,
  location TEXT,
  category TEXT,
  business_type TEXT NOT NULL DEFAULT 'all' CHECK (business_type IN ('all','with','without')),
  find_emails INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','completed','stopped','error')),
  message TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE maps_results (
  id INTEGER PRIMARY KEY,
  search_id INTEGER REFERENCES maps_searches(id) ON DELETE SET NULL,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  place_key TEXT NOT NULL UNIQUE,     -- Maps listing id: the same business is never stored twice
  maps_url TEXT,
  category TEXT,
  rating REAL,
  reviews INTEGER,
  website_status TEXT NOT NULL,       -- has_website | possible_website | no_website | social_only
  social_links TEXT,                  -- JSON array
  email_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_maps_results_search ON maps_results(search_id);
CREATE INDEX ix_maps_results_lead ON maps_results(lead_id);
`
  },
  {
    version: 4,
    name: 'background email finder attempts',
    sql: `ALTER TABLE maps_results ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0;`
  },
  {
    version: 5,
    name: 'email accounts per category',
    sql: `
CREATE TABLE smtp_account_categories (
  account_id INTEGER NOT NULL REFERENCES smtp_accounts(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES lead_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, category_id)
);
CREATE INDEX ix_smtp_cat_category ON smtp_account_categories(category_id);
`
  },
  {
    version: 6,
    name: 'email templates',
    sql: `
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
  },
  {
    version: 7,
    name: 'assistant chat',
    sql: `
CREATE TABLE assistant_messages (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  data TEXT,                      -- JSON: tool name/args/result, buttons, pending action
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE assistant_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    version: 8,
    name: 'autonomous agent: knowledge, reply queue, per-account switches',
    sql: `
CREATE TABLE org_knowledge (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,              -- company | services | pricing | policies | contact | hours | faq | style | other
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0, -- internal only: never shown to customers
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE agent_queue (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','followup')),
  trigger_message_id INTEGER,       -- newest inbound message this reply answers
  due_at TEXT NOT NULL,             -- UTC 'YYYY-MM-DD HH:MM:SS'
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','working','sent','approval','skipped','failed','cancelled')),
  reply TEXT,
  decision TEXT,                    -- JSON: intent, interest, reasons (AI decision history)
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_agent_queue_trigger ON agent_queue(conversation_id, trigger_message_id) WHERE kind = 'reply';
CREATE INDEX ix_agent_queue_due ON agent_queue(status, due_at);
ALTER TABLE smtp_accounts ADD COLUMN agent_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE whatsapp_accounts ADD COLUMN agent_enabled INTEGER NOT NULL DEFAULT 1;
`
  }
]
