import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { createApp } from './app.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Minimal .env loader (no dependency); real environment variables take precedence.
const envFile = join(root, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const dataDir = process.env.DATA_DIR ?? join(root, 'data')
const { app, publicKeyPem, runReminders } = createApp({
  dbFile: join(dataDir, 'licenses.db'),
  keyFile: join(dataDir, 'keys', 'license_ed25519.pem'),
  sessionSecret: process.env.SESSION_SECRET,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  smtpUrl: process.env.SMTP_URL,
  mailFrom: process.env.MAIL_FROM ?? 'Lead Getter Enterprise <licenses@example.com>',
  trustProxy: process.env.TRUST_PROXY === '1',
  trialDays: Number(process.env.TRIAL_DAYS ?? 2),
  adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL,
  otpValidHours: Number(process.env.OTP_VALID_HOURS ?? 72)
})

const port = Number(process.env.PORT ?? 8787)
app.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`License server listening on :${port}`)
  console.log('Public key for desktop builds (LICENSE_PUBLIC_KEY):\n' + publicKeyPem)
})

setInterval(() => void runReminders().catch((e) => console.error('Reminder job failed', e)), 6 * 3600_000)
setTimeout(() => void runReminders().catch(() => {}), 10_000)
