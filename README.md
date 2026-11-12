# Lead Getter Enterprise

AI-powered lead generation and automated sales platform — a **new, independent desktop application** (Windows, macOS, Linux). It shares no code, database, configuration, activation system or backend with the original Lead Getter.

| Area | What it does |
|---|---|
| Discovery | Google Maps (Places API, optional email extraction from business websites), LinkedIn (public pages via Google Programmable Search), Apollo (official API) |
| CRM | One central, deduplicated lead database: categories (auto + custom), tags, saved filters, bulk actions, duplicate merge, history, CSV/Excel import & export |
| Verification | Reacher (self-hosted or hosted): syntax, MX, SMTP, catch-all, role, disposable → Safe / Risky / Invalid / Unknown; bulk, file, automatic, history, re-verification |
| AI Sales Agent | OpenAI, Anthropic Claude, Google Gemini, Groq. Website research, personalised outreach, contextual conversations with memory, **Suggestion Mode** for pricing (price ranges computed from *your* rules, always human-approved), human takeover |
| WhatsApp | Baileys multi-device: multiple accounts via QR, encrypted isolated sessions, auto-reconnect, delivery/read receipts, campaigns with 15+ message variations, pacing (default 30 min), windows, daily limits, opt-out |
| Email | Multiple SMTP accounts, IMAP reply & bounce tracking, sequences (initial + 3 follow-ups that stop on reply/unsubscribe/not-interested), suppression list |
| Inbox | Unified WhatsApp + email conversations, three-panel workspace, approvals inline |
| Dashboard | Live command center from real records with date ranges |
| Subscription | 2-day free trial on first launch. A top-bar button opens the plans popup → **Activate** emails a 4-digit OTP to the owner's Gmail → share it with the team member (e.g. WhatsApp) → they enter it and the plan activates. No license keys and no server; state is signed and bound to the computer. |

## Repository layout

```
apps/desktop/          Electron + React + TypeScript desktop app
  src/main/            Main process: database, job queue, services, IPC
  src/preload/         Minimal, sandboxed IPC bridge
  src/renderer/        React UI (design system in styles/global.css)
  src/shared/          Types and settings shared by both processes
  tests/               Unit/integration tests (vitest) + opt-in live tests
infra/reacher/         Docker Compose for the Reacher verification backend
design/                Sidebar reference image
docs/                  Architecture, configuration, deployment and testing docs
```

## Quick start

Requirements: Node.js ≥ 22.13, npm.

```bash
cd apps/desktop
npm install
cp .env.example .env     # Gmail App Password + OTP email + a long random secret
npm run dev
```

The app starts a 2-day free trial automatically (top-right button). To activate a plan: popup → **Activate** → the OTP arrives at `SUBSCRIPTION_OTP_EMAIL` → enter it in the popup. Then configure integrations in **Settings** and an AI provider in **AI Sales Agent → AI providers**.

## Documentation

- [Architecture & database](docs/ARCHITECTURE.md)
- [Integrations: Google, Apollo, podcasts](docs/INTEGRATIONS.md)
- [Reacher deployment](docs/REACHER.md)
- [WhatsApp / Baileys](docs/WHATSAPP.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [SMTP & email campaigns](docs/SMTP.md)
- [Subscription & OTP activation](docs/SUBSCRIPTION.md)
- [Desktop IPC API](docs/API.md)
- [Build & installers](docs/BUILD.md)
- [Testing report](docs/TESTING.md)

## Responsible use

Outreach must have a lawful basis (e.g. B2B legitimate interest), honour opt-outs, and follow WhatsApp's, email providers' and data-source terms. The app enforces suppression, opt-out keywords, pacing and daily limits, but **you** remain responsible for compliance. Baileys is an unofficial WhatsApp client; numbers that send unsolicited bulk messages can be banned.
