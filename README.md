# Lead Getter Enterprise

AI-powered lead generation and automated sales platform — a **new, independent desktop application** (Windows, macOS, Linux). It shares no code, database, configuration, activation system or backend with the original Lead Getter.

| Area | What it does |
|---|---|
| Discovery | Google Maps (Places API), LinkedIn (public pages via Google Programmable Search), Apollo (official API), website email extraction (robots.txt-aware crawler), podcasts (Listen Notes, Spotify, Apple Podcasts + RSS, Player FM, Pandora, Deezer) |
| CRM | One central, deduplicated lead database: categories (auto + custom), tags, saved filters, bulk actions, duplicate merge, history, CSV/Excel import & export |
| Verification | Reacher (self-hosted or hosted): syntax, MX, SMTP, catch-all, role, disposable → Safe / Risky / Invalid / Unknown; bulk, file, automatic, history, re-verification |
| AI Sales Agent | OpenAI, Anthropic Claude, Google Gemini, Groq. Website research, personalised outreach, contextual conversations with memory, **Suggestion Mode** for pricing (price ranges computed from *your* rules, always human-approved), human takeover |
| WhatsApp | Baileys multi-device: multiple accounts via QR, encrypted isolated sessions, auto-reconnect, delivery/read receipts, campaigns with 15+ message variations, pacing (default 30 min), windows, daily limits, opt-out |
| Email | Multiple SMTP accounts, IMAP reply & bounce tracking, sequences (initial + 3 follow-ups that stop on reply/unsubscribe/not-interested), suppression list |
| Inbox | Unified WhatsApp + email conversations, three-panel workspace, approvals inline |
| Analytics | Live dashboard and reports from real records, date ranges, CSV report export, audit log |
| Licensing | New subscription backend (`apps/license-server`): Ed25519-signed device-bound activations, 3 configurable plans (PKR 4,500 / 15,000 / 50,000), admin console, SMTP notifications |

## Repository layout

```
apps/desktop/          Electron + React + TypeScript desktop app
  src/main/            Main process: database, job queue, services, IPC
  src/preload/         Minimal, sandboxed IPC bridge
  src/renderer/        React UI (design system in styles/global.css)
  src/shared/          Types and settings shared by both processes
  tests/               Unit/integration tests (vitest) + opt-in live tests
apps/license-server/   Independent licensing backend (Node 22 + Express + SQLite)
infra/reacher/         Docker Compose for the Reacher verification backend
design/                Sidebar reference image
docs/                  Architecture, configuration, deployment and testing docs
```

## Quick start (development)

Requirements: Node.js ≥ 22.13, npm.

```bash
# 1. License server (own terminal)
cd apps/license-server && npm install && cp .env.example .env   # fill SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start                                                        # http://localhost:8787/admin

# 2. Desktop app
cd apps/desktop && npm install
LICENSE_PUBLIC_KEY="$(cd ../license-server && npm run -s print-public-key)" npm run dev
```

> `npm run dev` / `npm start` clear `ELECTRON_RUN_AS_NODE` automatically (VS Code terminals set it, which otherwise makes Electron start as plain Node).

Then: issue a license in the admin console → activate it in **License & Subscription** → configure integrations in **Settings** and an AI provider in **AI Sales Agent → AI providers**.

## Documentation

- [Architecture & database](docs/ARCHITECTURE.md)
- [Integrations: Google, Apollo, podcasts](docs/INTEGRATIONS.md)
- [Reacher deployment](docs/REACHER.md)
- [WhatsApp / Baileys](docs/WHATSAPP.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [SMTP & email campaigns](docs/SMTP.md)
- [Licensing server & API](docs/LICENSING.md)
- [Desktop IPC API](docs/API.md)
- [Build & installers](docs/BUILD.md)
- [Testing report](docs/TESTING.md)

## Responsible use

Outreach must have a lawful basis (e.g. B2B legitimate interest), honour opt-outs, and follow WhatsApp's, email providers' and data-source terms. The app enforces suppression, opt-out keywords, pacing and daily limits, but **you** remain responsible for compliance. Baileys is an unofficial WhatsApp client; numbers that send unsolicited bulk messages can be banned.
