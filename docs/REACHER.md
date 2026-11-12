# Reacher deployment

The app uses Reacher's HTTP backend (`POST /v0/check_email`) — it does not re-implement verification.

## 1. Pick a host with outbound port 25

SMTP checks need outbound TCP 25. Most residential ISPs and many clouds block it (it **is blocked** on the development network this project was built on). Good options: a VPS from a provider that unblocks port 25 on request (e.g. Hetzner, OVH, Contabo, Vultr after a ticket). Check with:

```bash
infra/reacher/check-port25.sh
```

Also set a PTR (reverse DNS) record for the server IP matching `REACHER_HELLO_NAME`; mail servers distrust hosts without one.

## 2. Run the backend

```bash
cd infra/reacher
cp .env.example .env      # set REACHER_SECRET, REACHER_FROM_EMAIL, REACHER_HELLO_NAME
docker compose up -d
curl -s -X POST localhost:8080/v0/check_email \
  -H 'content-type: application/json' -H "x-reacher-secret: $REACHER_SECRET" \
  -d '{"to_email":"someone@gmail.com"}'
```

Pin `reacherhq/backend` to a specific tag in production. Environment variable names follow Reacher's `RCH__` convention; if your Reacher version differs, check its README (`backend/README.md` in reacherhq/check-if-email-exists).

Expose it to the desktop app through HTTPS (Caddy/nginx reverse proxy) and keep the secret header enabled — never expose an unauthenticated Reacher publicly.

**Alternative:** Reacher's hosted API — set the URL to `https://api.reacher.email` and paste your API key as the secret (sent as both `x-reacher-secret` and `Authorization`).

## 3. Connect the app

Settings → Integrations → Reacher: URL + secret → **Test connection**. Email Verification → Diagnostics also has **Test Reacher** and a local port-25 check.

## How results are classified

| Reacher | App status | Notes |
|---|---|---|
| `safe` | **Safe** | Mailbox accepted at SMTP level. Inbox placement is never guaranteed. |
| `safe` + catch-all / disposable / full inbox | **Risky** | Catch-all domains accept every address, so they are never "verified". |
| `risky` | **Risky** | |
| `invalid` | **Invalid** | Added to the suppression list automatically. |
| `unknown` | **Unknown** | Often greylisting or timeouts — retry later. |
| HTTP/network error | **Failed** | Retried on the next run. |

Settings → Verification & crawling controls auto-verification, concurrency (default 3), re-verification age (default 30 days) and per-email timeout.
