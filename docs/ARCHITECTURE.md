# Architecture & database

## Process model

```
┌────────────────────── Electron main process (Node 22) ──────────────────────┐
│  ipc.ts ── single entry point; validates, license-gates, wraps errors        │
│  core/   db (node:sqlite, WAL) · jobs (persistent queue) · events · logger   │
│          settings · http (timeouts/retries) · activity (audit log)           │
│  security/secrets ── OS keychain (safeStorage) or AES-256-GCM key file       │
│  services/                                                                   │
│    leads · discovery · sources/{googleMaps,linkedin,apollo,website,podcasts} │
│    verification (Reacher) · ai/{providers,agent} · conversations             │
│    whatsapp (Baileys) · email (SMTP/IMAP) · campaigns · analytics · subscr.  │
└──────────────▲───────────────────────────────────────────────▲──────────────┘
               │ contextBridge (invoke + events only)          │ HTTPS
┌──────────────┴──────────────┐                     ┌──────────┴─────────────┐
│ Renderer (React, sandboxed) │                     │ Gmail SMTP, Reacher,     │
│ no Node, strict CSP          │                     │ Google, Apollo, AI APIs  │
└─────────────────────────────┘                     └────────────────────────┘
```

* **Renderer** is sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`), loads only local files, has a strict Content-Security-Policy, and can only call whitelisted IPC channels. Secrets never reach it — only masked previews.
* **Database**: SQLite via Node's built-in `node:sqlite` (no native modules → identical builds for Windows/macOS/Linux). WAL mode, foreign keys, busy timeout. Versioned migrations in `src/main/db/migrations.ts` run inside transactions at startup.
* **Background jobs** (`core/jobs.ts`): persistent `jobs` table, per-type concurrency, checkpoints (`state`) so jobs resume after pause *or a crash/restart*, cancellation, retries, de-duplication (`dedupe_key` unique while active), logs (`job_logs`). Used for discovery, crawling, verification and AI research.
* **Schedulers**: campaign engine (20 s tick, one send in flight per campaign), IMAP polling (3 min), WhatsApp auto-reconnect with exponential back-off.
* **Clean shutdown**: on quit the campaign engine and pollers stop, running jobs are re-queued with their checkpoint, WhatsApp sockets close, WAL is checkpointed and the DB closed.
* **Data location**: `<appData>/lead-getter-enterprise/` (Windows `%APPDATA%`, macOS `~/Library/Application Support`, Linux `~/.config`). Logs in the OS log directory, rotated at 10 MB, with API keys/passwords redacted.

## Key flows

**Discovery → CRM → verification.** Every source maps results to `LeadInput` and calls `upsertLead`, which computes a dedupe key (business domain → phone → LinkedIn URL → email → source id → name+city), merges into an existing lead if any identifier matches (filling gaps only, never overwriting edits), auto-categorises, attaches emails and records history. New email ids are batched into a `verify_emails` job when auto-verification is enabled; the re-verification policy skips recently verified addresses.

**Conversation turn.** Inbound WhatsApp/IMAP message → `recordIncoming` (dedupe by external id, stop follow-ups, opt-out keyword check) → agent debounced by the configured reply delay → one model call returns intent, updated memory (`summary`, `requirements` JSON) and a reply. Pricing intent (keyword regex **or** model) → **Suggestion Mode**: the model scopes the work and chooses service keys; the range is computed deterministically from the price list × complexity multiplier and inserted into the draft; an `approvals` row waits for a human. Non-commercial replies are auto-sent only if enabled, otherwise queued for approval. AI sends are refused when the conversation is paused/taken over, when a human or the client wrote after the AI started drafting, or while another send is in flight.

**Campaign send.** Pick next due recipient → skip if lead opted out / not interested / suppressed / already contacted by another campaign / email fails the verification policy → pick an account (round-robin over connected accounts under their daily limit) → render template (variables + spintax) or AI-personalise → send through the conversation layer (so the message appears in the inbox) → log to `outreach_log`, `campaign_executions`, schedule the next follow-up. Window, delay (randomised ±25 %) and daily limits are enforced per campaign.

## Database schema (desktop)

| Table | Purpose |
|---|---|
| `settings` | JSON settings by key (see `src/shared/settings.ts`) |
| `secrets` | Encrypted credentials (API keys, SMTP passwords) |
| `users` | Operators (single owner by default; used for assignment) |
| `lead_categories`, `lead_sources` | Category list (10 defaults + custom) and source labels |
| `leads` | Central lead record; `dedupe_key` unique among non-deleted; `opted_out`, `consent_status`, soft delete |
| `lead_tags`, `lead_history`, `lead_research` | Tags, audit trail per lead, AI website research |
| `email_addresses`, `lead_emails` | Unique emails with verification status/flags; many-to-many with leads (`is_primary`, `source_url`) |
| `verification_records` | Every Reacher result (raw JSON kept), per batch |
| `search_history`, `saved_filters` | Discovery history; saved CRM filters |
| `whatsapp_accounts`, `whatsapp_sessions` | Accounts and encrypted Baileys auth keys (one row per key) |
| `smtp_accounts` | SMTP/IMAP config (password in `secrets`) |
| `ai_providers`, `ai_usage` | Provider status/default model; token usage, latency and errors per call |
| `campaigns`, `campaign_steps`, `campaign_recipients`, `campaign_executions` | Campaign config, message variants / sequence steps, per-lead state, event log |
| `outreach_log`, `suppression_list` | Cross-campaign dedupe; never-contact list |
| `conversations`, `messages`, `approvals` | Unified inbox, AI memory, Suggestion Mode / reply approvals |
| `jobs`, `job_logs` | Persistent background jobs |
| `activity_logs` | Audit log (user / ai / system actions) |
| `subscription`, `subscription_otp` | Signed trial/plan state; hashed OTP requests (attempts, expiry, status) |

Indexes cover every filter in Leads Management (category, source, country/city, status, discovery date, phone, domain, tags, verification status) and the hot paths of the inbox and campaign engine.

