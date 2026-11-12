# Licensing & subscription backend

`apps/license-server` is a new, independent service (Node ≥ 22.13, Express 5, SQLite). It has no connection to the original Lead Getter's activation backend.

## Customer flow

1. **First launch** — the app asks the server for a free trial (`POST /api/v1/trial`). One trial per device (by device id), length `TRIAL_DAYS` (default **2 days**). Reinstalling does not reset it.
2. **Top-bar button** shows *Free trial · N days left*, then *Trial ended — Subscribe*. Clicking it (or the sidebar account card) opens the plans popup.
3. **Choose plan** → name, email, phone, message → `POST /api/v1/purchase-requests`. The server emails the request to `ADMIN_NOTIFY_EMAIL` (or `ADMIN_EMAIL`) and a confirmation to the customer, via SMTP.
4. After payment you open the admin console → **Subscription requests → Issue license & email key**. The key is emailed to the customer.
5. The customer pastes the key into the popup → **Activate**. The trial is replaced by the paid plan.

SMTP (`SMTP_URL`) must be configured for steps 3–4; without it requests are still stored and visible in the admin console, but no emails are sent.

## Design

* **Ed25519 signatures.** The server holds the private key (`data/keys/license_ed25519.pem`, created on first start, mode 600). The desktop app embeds only the **public** key at build time and verifies every token offline — no secret ever ships in the app.
* **Token** = `base64url(payload).base64url(signature)`; payload `{ lid, plan, planName, device, exp, iat }`. A token is bound to one device id (SHA-256 of the OS machine id) and is useless elsewhere; editing it breaks the signature.
* **Device activations** with unique `act_…` ids, per-license device limits, self-service deactivation and admin deactivation.
* **Validation** every 6 h; tokens are refreshed on each successful check. If the server is unreachable the app keeps working for **7 days** after the last successful validation, then asks to reconnect. Revoked/suspended/expired licenses take effect at the next validation.
* **Plans** (seeded, editable in the admin console/API — price, currency, months, label, device limit, features, limits JSON, active):

| Code | Name | Price | Duration |
|---|---|---|---|
| `basic_monthly` | Basic Monthly | PKR 4,500 | 1 month |
| `six_month` | Six-Month Plan | PKR 15,000 | 6 months |
| `lifetime` | Lifetime Plan | PKR 50,000 | Lifetime (2 devices) |

* **Renewals** extend from the later of now and the current expiry (early renewal never loses days) and can change plan.
* **Emails** (optional SMTP): license issued, renewed, expiring in ≤ 7 days, expired, revoked — de-duplicated in `notifications`.
* **Security**: admin passwords hashed with scrypt; HMAC-signed 12 h admin sessions; rate limits (public 60/min/IP, login 10/15 min/IP); input validated before any lookup; JSON body limit 64 KB; security headers. Run behind HTTPS.

## Deploy

```bash
cd apps/license-server
npm ci --omit=dev
cp .env.example .env    # SESSION_SECRET (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), SMTP_URL, MAIL_FROM
npm start               # prints the public key on start
```

Run it under systemd/pm2 behind Caddy or nginx with TLS and set `TRUST_PROXY=1`. **Back up `data/`** — losing the private key means every issued token becomes unverifiable and all customers must re-activate with a rebuilt app.

Build the desktop app against it:

```bash
cd apps/desktop
LICENSE_SERVER_URL=https://license.yourdomain.com \
LICENSE_PUBLIC_KEY="$(cd ../license-server && npm run -s print-public-key)" \
npm run dist:linux        # or dist:win / dist:mac
```

`LICENSE_ENFORCED=0` builds a developer build that does not gate features (never ship it).

## Public API (used by the desktop app)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/api/v1/plans` | – | `{plans:[…]}` | |
| GET | `/api/v1/public-key` | – | PEM | |
| POST | `/api/v1/licenses/activate` | `{licenseKey, deviceId, deviceName?, platform?, appVersion?}` | `{status, activationId, token, expiresAt}` | 400 malformed, 404 not found, 403 `suspended`/`revoked`, 410 `expired`, 409 `device_limit` |
| POST | `/api/v1/licenses/validate` | `{licenseKey, deviceId}` | same as activate | 403 `not_activated`/status, 410 `expired` |
| POST | `/api/v1/licenses/deactivate` | `{licenseKey, deviceId}` | `{ok:true}` | |
| POST | `/api/v1/trial` | `{deviceId, deviceName?}` | `{status:'trial', token, expiresAt}` | 410 `trial_used` |
| POST | `/api/v1/purchase-requests` | `{planCode, name, email, phone?, message?, deviceId?}` | `{ok, id, emailed}` | 400 invalid; limited to 5/hour/IP |

## Admin API (Bearer token from `/api/admin/login`)

`POST /login {email,password}` · `GET /stats` · `GET|POST /plans` · `PATCH /plans/:id` · `GET /licenses?search=` · `GET /licenses/:id` (activations, history, emails) · `POST /licenses {planCode, customerName?, customerEmail?, maxDevices?, notes?, sendEmail?}` · `PATCH /licenses/:id` · `POST /licenses/:id/renew {planCode?}` · `POST /licenses/:id/status {status: active|suspended|revoked}` · `DELETE /activations/:id` · `GET /requests` · `POST /requests/:id/status {status: new|fulfilled|dismissed}` (creating a license with `requestId` marks the request fulfilled)

The admin console is served at `/admin/`.

## Database (license server)

`plans`, `licenses` (key, plan, customer, status, max devices, starts/expires), `activations` (activation id, device id/name/platform/version, IP, active, timestamps), `license_events` (activation history and admin actions), `admins`, `notifications`, `trials` (one per device), `purchase_requests`.
