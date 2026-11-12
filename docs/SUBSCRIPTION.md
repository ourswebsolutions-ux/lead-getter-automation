# Subscription & OTP activation

The app has no license server. Everything happens on the computer, and the only network call is the OTP email.

## Flow

1. **First launch** → a **2-day free trial** starts automatically.
2. A small button in the top bar shows *Free trial · N days left*, then *Trial ended — Subscribe*. Clicking it (or the sidebar account card) opens the plans popup.
3. Pick a plan → optional name and WhatsApp number → **Activate**. The app emails a **4-digit OTP** to `SUBSCRIPTION_OTP_EMAIL` (subject `OTP 1234 — <plan> activation request`, with the name, number and computer name).
4. Send that OTP to the team member (WhatsApp or by hand).
5. They type it into the popup → the plan is active on that computer. Activating again on the same computer extends the current plan.

| Plan | Price | Duration |
|---|---|---|
| Basic Monthly | PKR 4,500 | 1 month |
| Six-Month Plan | PKR 15,000 | 6 months |
| Lifetime Plan | PKR 50,000 | Lifetime |

Plans are defined in `apps/desktop/src/main/services/subscription.ts` (`PLANS`).

## OTP rules

Valid 72 hours · single use · only on the computer that requested it · 5 wrong attempts lock it (use *Request a new code*) · a new request replaces the previous code · 30 s between requests. Only a hash of the code is stored; the code itself is only in the email.

## State and reinstalling

Trial and plan state are stored in the app database **and** in a hidden file in the user's home folder (`~/.lead-getter-enterprise.sub`), both HMAC-signed with `SUBSCRIPTION_SECRET` and bound to the computer's device id. Reinstalling does not reset the trial or lose a paid plan; hand-editing either copy invalidates it; copying it to another computer doesn't work.

## Configuration (`apps/desktop/.env`, git-ignored)

```
SUBSCRIPTION_SMTP_URL=smtps://you%40gmail.com:app-password@smtp.gmail.com:465
SUBSCRIPTION_OTP_EMAIL=you@gmail.com
SUBSCRIPTION_SECRET=<long random string — never change it after activations start>
```

These values are baked into the app when it is built. **This is designed for internal team use:** someone who unpacks the installer could extract the Gmail App Password and bypass activation, so don't distribute builds outside the team, and use an App Password (revocable) rather than the account password.
