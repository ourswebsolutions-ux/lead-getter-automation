# SMTP accounts & email campaigns

## Accounts

Email Accounts → **Add account**. Presets fill host/port/encryption for Gmail/Google Workspace, Microsoft 365, Zoho and Hostinger.

| Provider | SMTP | IMAP | Notes |
|---|---|---|---|
| Gmail / Workspace | smtp.gmail.com:587 STARTTLS | imap.gmail.com:993 | Requires an **App Password** (2-Step Verification on) |
| Microsoft 365 | smtp.office365.com:587 STARTTLS | outlook.office365.com:993 | Admin must allow *Authenticated SMTP* for the mailbox |
| Zoho | smtp.zoho.com:465 SSL | imap.zoho.com:993 | App-specific password if 2FA |

Passwords are encrypted with the OS keychain. **Save & test** runs SMTP `verify()` and, if IMAP is set, an IMAP login. **Send test** delivers a real test email.

**IMAP (recommended)** lets the app detect replies (they appear in Conversations and stop follow-ups), `unsubscribe` replies, and bounces (hard bounces suppress the address and mark the recipient failed). Polling runs every 3 minutes, newest 200 messages per run, only for senders that match a lead or existing conversation.

## Campaigns

Email Campaigns → **New campaign**: audience (categories, countries, cities, tags, verification status, only never-contacted), sending account, initial email (subject + body, optional HTML) and up to three follow-ups with "send after N days without reply", variables `{business_name} {contact_name} {website} {industry} {city} {custom_field}`, spintax, preview, pacing, daily limit, sending window, verification policy (*safe only* / *safe + risky* / *any except invalid*), optional AI personalisation, schedule.

Follow-ups stop automatically when the prospect replies, unsubscribes, is marked not interested / do-not-contact, or bounces. Follow-ups thread as `Re: <subject>` with `In-Reply-To` where the reply id is known.

Every email carries the compliance footer and a `List-Unsubscribe: <mailto:…?subject=unsubscribe>` header.

## Deliverability

* Publish SPF, DKIM and DMARC for the sending domain; use a dedicated outreach domain; warm it up.
* Keep volume modest (30–100/mailbox/day) and send only to verified addresses.
* **Open tracking is intentionally not offered:** SMTP alone can't report opens reliably and tracking pixels hurt deliverability.
