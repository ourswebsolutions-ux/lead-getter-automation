import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Build-time configuration for the licensing backend. The public key is NOT a secret:
// it only verifies signatures produced by the license server's private key.
const define = {
  __LICENSE_SERVER_URL__: JSON.stringify(process.env.LICENSE_SERVER_URL ?? 'http://localhost:8787'),
  __LICENSE_PUBLIC_KEY__: JSON.stringify(process.env.LICENSE_PUBLIC_KEY ?? ''),
  __LICENSE_ENFORCED__: JSON.stringify(process.env.LICENSE_ENFORCED !== '0')
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
