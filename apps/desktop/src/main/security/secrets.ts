import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { db } from '../db'

/**
 * Credential vault. The concrete cipher is injected at startup:
 *  - Electron safeStorage (OS keychain / DPAPI / libsecret) when available,
 *  - otherwise AES-256-GCM with a per-install key file (0600) as a fallback.
 * Plaintext secrets never leave the main process.
 */
export interface Cipher {
  name: string
  encrypt(plain: string): Uint8Array
  decrypt(data: Uint8Array): string
}

export function aesCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error('AES key must be 32 bytes')
  return {
    name: 'aes-256-gcm',
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), enc])
    },
    decrypt(data) {
      const b = Buffer.from(data)
      if (b[0] !== 1) throw new Error('Unknown secret format')
      const iv = b.subarray(1, 13)
      const tag = b.subarray(13, 29)
      const d = createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8')
    }
  }
}

let cipher: Cipher | null = null
export function setCipher(c: Cipher): void {
  cipher = c
}
export function getCipher(): Cipher {
  if (!cipher) throw new Error('Secret cipher not initialised')
  return cipher
}

export const secrets = {
  set(key: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') {
      db().run('DELETE FROM secrets WHERE key = ?', key)
      return
    }
    db().run(
      `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      getCipher().encrypt(value)
    )
  },
  get(key: string): string | null {
    const row = db().get<{ value: Uint8Array }>('SELECT value FROM secrets WHERE key = ?', key)
    if (!row) return null
    try {
      return getCipher().decrypt(row.value)
    } catch {
      return null
    }
  },
  has(key: string): boolean {
    return !!db().get('SELECT 1 FROM secrets WHERE key = ?', key)
  },
  delete(key: string): void {
    db().run('DELETE FROM secrets WHERE key = ?', key)
  },
  deletePrefix(prefix: string): void {
    db().run('DELETE FROM secrets WHERE key LIKE ?', prefix + '%')
  },
  /** Masked preview for UI — never the full value. */
  mask(key: string): string | null {
    const v = this.get(key)
    if (!v) return null
    return v.length <= 8 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-4)}`
  }
}
