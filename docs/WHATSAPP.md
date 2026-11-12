# WhatsApp (Baileys)

WhatsApp connectivity uses [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys@7.0.0-rc14`), an unofficial WhatsApp Web multi-device client. WhatsApp Cloud API is not used.

## Connecting accounts

WhatsApp Accounts → **Add account** → scan the QR code from the phone (WhatsApp → Settings → Linked devices → Link a device). Each account:

* has its **own auth state**, stored in the `whatsapp_sessions` table, one row per key, **encrypted** with the OS keychain (no plaintext session files);
* reconnects automatically on start-up and after drops (exponential back-off up to 5 min, 8 attempts; immediate restart on WhatsApp's "restart required");
* clears its session and shows **Logged out** if unlinked from the phone; shows a clear error if the session was opened elsewhere;
* has a **daily limit** (default 40) enforced by the campaign engine; *Sent today* and *Last activity* are shown per account.

Verified live (12 Nov 2026): the app connects to WhatsApp's servers and renders a pairing QR code.

## Sending behaviour

* Every send first checks the number is on WhatsApp (`onWhatsApp`), shows "typing…" for a length-proportional moment, then sends.
* Incoming messages from individual chats are recorded (groups, broadcasts, status and newsletters are ignored). LID-addressed messages are mapped to phone numbers via `remoteJidAlt`.
* Delivery and read receipts update message status.
* Replies containing an opt-out keyword (Settings → Compliance) suppress the number, pause AI and stop all campaigns to it.

## Campaigns

WhatsApp Campaigns → New campaign: 15 message slots (plus **Add message**), variables `{business_name} {contact_name} {city} {category} {website} {custom_field}`, spintax `{Hi|Hello}`, preview, one or more accounts (round-robin), default **30-minute delay** (minimum 5) randomised ±25 %, campaign daily limit, sending window, optional AI personalisation, schedule/start/pause/resume/stop. Leads already contacted by another campaign are skipped by default.

## Safety guidance

* Use numbers that have been in normal use for weeks; start with 20–40 messages/day and grow slowly.
* Message businesses with a genuine, specific reason; keep the opt-out line.
* Delivery is not guaranteed, and WhatsApp may ban numbers that are reported or that send unsolicited bulk messages. Baileys can break when WhatsApp changes its protocol — update the `baileys` dependency when that happens.
