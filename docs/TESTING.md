# Testing report — 12 Nov 2026

> The license server was removed; subscription is now local with emailed OTP.
> Updated after removing Analytics, Podcasts, Website Emails and the License page, and adding the free trial + top-bar subscription popup.

## How to run

```bash
cd apps/desktop && npm run typecheck && npm test        # 41 unit + integration tests
cd apps/desktop && npm run test:live                     # 5 live tests against real public services
```

## Results

| Suite | Result |
|---|---|
| Desktop typecheck (main + renderer, TypeScript 7) | ✅ clean |
| Desktop unit/integration (`vitest`) | ✅ 41 / 41 |
| Desktop live (`test:live`) | ✅ 3 / 3 |
| Production build (`electron-vite build`) | ✅ |
| Linux installers (AppImage, .deb) | ✅ built; packaged binary launched, created its own database and ran migrations |
| Visual QA | ✅ real Electron window, 12 pages × light/dark captured and reviewed |

## Coverage of the required workflows

Legend: ✅ verified · 🧪 verified with a local stand-in for the external service · ⚠️ needs your credentials/infrastructure to verify end-to-end

| # | Workflow | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Google Maps discovery | 🧪 ⚠️ | Query building (keywords × locations, nationwide), Places response mapping tested. Needs a Google Places API key for a live run. |
| 2 | LinkedIn | 🧪 ⚠️ | Query building and result parsing tested. Needs Google Programmable Search key + cx. |
| 3 | Apollo | 🧪 ⚠️ | Person/company mapping, placeholder-email filtering tested. Needs an Apollo API key. |
| 4 | Website email extraction | ✅ | Local test site (mailto, Cloudflare-encoded, obfuscated emails, tel:, robots.txt disallow, socials) + live crawl of a public website. |
| 5 | Podcasts | — | Removed from the product (12 Nov 2026). |
| 6 | Duplicate detection | ✅ | Cross-source merge by domain/phone, social-media URLs not merged, edited fields preserved, manual merge. |
| 7 | Categorisation | ✅ | Keyword rules + custom categories. |
| 8 | Advanced filters | ✅ | Country, city, category, source, verification, website/phone/email presence, tags, campaign status, date range, search — all against SQLite. |
| 9 | CSV import/export | ✅ | Column auto-mapping, dedupe on import, formula-injection guard, round-trip. |
| 10 | Excel import/export | ✅ | `.xlsx` round-trip. |
| 11 | Reacher verification | 🧪 ⚠️ | Full job (concurrency, results, suppression, re-verification policy, failures) against a local server implementing Reacher's `/v0/check_email` contract; result mapping (catch-all → risky) tested. **A real Reacher was not deployed**: Docker isn't accessible to this user account and outbound port 25 is blocked on this network (verified). See REACHER.md. |
| 12 | AI provider configuration | ⚠️ | Official SDKs integrated; settings, model listing, test, usage logging and fallback implemented and typechecked. No API keys were available to make live calls. |
| 13 | AI personalisation | 🧪 | Outreach/research prompt flow exercised with a mocked provider. |
| 14 | AI conversation handling | 🧪 | Auto-send vs approval, memory/requirements persistence, interest detection, debounce, stale-draft discard. |
| 15 | Budget Suggestion Mode | 🧪 | Pricing intent (EN/Urdu), no-pricing-config path produces no figures, deterministic range from rules, edited approval sent, further messages held while pending. |
| 16 | Human takeover | ✅ | AI blocked when paused/taken over, human replies allowed, concurrent-send lock. |
| 17 | WhatsApp QR connection | ✅ (live) | Baileys connected to WhatsApp and produced a pairing QR; full pairing needs a phone. |
| 18 | Multiple WhatsApp accounts | ⚠️ | Per-account isolated encrypted sessions and round-robin implemented; needs real numbers to verify. |
| 19 | WhatsApp campaigns | 🧪 ⚠️ | Shared campaign engine fully tested on the email channel; WhatsApp sending needs a paired number. |
| 20–21 | SMTP connection / multiple accounts | ⚠️ | Implemented (verify, test send, IMAP); needs mailbox credentials. |
| 22 | Email campaigns | 🧪 | Recipients, skip reasons, sending, pause/resume/stop, cross-campaign dedupe, suppression, daily limits. |
| 23 | Email follow-ups | 🧪 | Scheduled follow-ups, `Re:` threading, stop on reply, completion. |
| 24 | Conversation history | ✅ | Inbound/outbound recording, duplicate delivery ignored, opt-out handling. |
| 25 | Subscription activation | ✅ | Local trial (2 days, survives reinstall), OTP emailed to owner, wrong-code limit (5), single use, activation, renewal extends, lifetime, tamper detection, email failure. Real OTP email sent through Gmail SMTP on 12 Nov 2026. |
| 26 | Subscription expiration | ✅ | Trial end and plan expiry lock licensed features. |
| 27–28 | Light / dark mode | ✅ | Screenshots of every major page in both themes. |
| 29 | Database persistence | ✅ | Migrations, WAL, job checkpoint recovery after simulated crash, packaged app DB creation. |
| 30 | Installer startup | ✅ Linux · ⚠️ Windows · ⚠️ macOS | Linux AppImage/.deb built and launched. Windows: app packaged (`win-unpacked`), but the NSIS installer step needs wine, which isn't installed here — build on Windows/CI. macOS requires a Mac. |

## Issues found and fixed during testing

* "Pizza" businesses weren't categorised as restaurants (regex gap).
* Deezer podcast API change surfaced by the live test — now reported clearly.
* Large RSS feeds were downloaded in full — now limited to the 512 KB channel header.
* `electron-updater` dynamic import interop bug found by launching the packaged app.
* Light/dark capture showed the saved theme correctly overriding local preference; reduced-motion support added.

## Not verified here (requires your accounts or infrastructure)

Google Places, Programmable Search, Apollo, Listen Notes, Spotify and AI provider keys; a deployed Reacher with port 25; SMTP/IMAP mailboxes; WhatsApp numbers to pair; a macOS machine for the `.dmg`; code-signing certificates.
