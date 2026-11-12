import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Subscription settings come from apps/desktop/.env (git-ignored) or the environment at build time:
//   SUBSCRIPTION_SMTP_URL   smtps://user%40gmail.com:app-password@smtp.gmail.com:465
//   SUBSCRIPTION_OTP_EMAIL  where activation OTPs are emailed
//   SUBSCRIPTION_SECRET     long random string — keep it the same for every build, or activations reset
function loadEnvFile(): Record<string, string> {
  const f = resolve(__dirname, '.env')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const fileEnv = loadEnvFile()
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? ''

const define = {
  __SUBSCRIPTION_SMTP_URL__: JSON.stringify(env('SUBSCRIPTION_SMTP_URL')),
  __SUBSCRIPTION_OTP_EMAIL__: JSON.stringify(env('SUBSCRIPTION_OTP_EMAIL')),
  __SUBSCRIPTION_SECRET__: JSON.stringify(env('SUBSCRIPTION_SECRET')),
  __LICENSE_ENFORCED__: JSON.stringify(env('LICENSE_ENFORCED') !== '0')
}

export default defineConfig({
  main: {
    define,
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        external: ['baileys', 'node:sqlite'],
        output: { dynamicImportInCjs: true }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') }
    },
    plugins: [react()]
  }
})
