import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Database, setDatabase } from '../src/main/db'
import { setCipher, aesCipher } from '../src/main/security/secrets'

export function freshDb(): Database {
  process.env.NODE_ENV = 'test'
  setCipher(aesCipher(randomBytes(32)))
  const d = new Database(':memory:')
  d.migrate()
  setDatabase(d)
  return d
}

export async function serve(handler: (req: any, res: any) => void): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return { url: `http://127.0.0.1:${port}`, server, close: () => new Promise((r) => server.close(() => r())) }
}

export async function waitFor(fn: () => boolean, timeout = 8000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
