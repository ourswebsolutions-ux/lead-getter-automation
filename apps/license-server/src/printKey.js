import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSigningKey } from './crypto.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.DATA_DIR ?? join(root, 'data')
const { publicKeyPem } = loadSigningKey(join(dataDir, 'keys', 'license_ed25519.pem'))
process.stdout.write(publicKeyPem)
