import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import path from 'node:path'

export const AT_REST_ENCRYPTION_ENV = 'CC_AT_REST_KEY'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'

type EncryptedLineEnvelope = {
  __encrypted: true
  alg: typeof ENCRYPTION_ALGORITHM
  iv: string
  tag: string
  data: string
}

export type EncryptedJsonlOptions = {
  key?: string
}

function resolveKey(raw?: string): Buffer | null {
  const value = raw ?? process.env[AT_REST_ENCRYPTION_ENV]
  if (!value) return null
  return createHash('sha256').update(value).digest()
}

function encodeRecord(
  record: Record<string, unknown>,
  key: Buffer | null,
): string {
  if (!key) {
    return JSON.stringify(record)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(record), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope: EncryptedLineEnvelope = {
    __encrypted: true,
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  }
  return JSON.stringify(envelope)
}

function isEncryptedEnvelope(
  value: unknown,
): value is EncryptedLineEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __encrypted?: unknown }).__encrypted === true &&
    (value as { alg?: unknown }).alg === ENCRYPTION_ALGORITHM &&
    typeof (value as { iv?: unknown }).iv === 'string' &&
    typeof (value as { tag?: unknown }).tag === 'string' &&
    typeof (value as { data?: unknown }).data === 'string'
  )
}

function decodeRecord<T extends Record<string, unknown>>(
  value: unknown,
  key: Buffer | null,
): T | null {
  if (!isEncryptedEnvelope(value)) {
    return value && typeof value === 'object' ? (value as T) : null
  }
  if (!key) return null
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(value.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final(),
    ])
    return JSON.parse(decrypted.toString('utf8')) as T
  } catch {
    return null
  }
}

export function encryptionAtRestEnabled(
  opts: EncryptedJsonlOptions = {},
): boolean {
  return resolveKey(opts.key) !== null
}

export function appendEncryptedJsonlRecord(
  filePath: string,
  record: Record<string, unknown>,
  opts: EncryptedJsonlOptions = {},
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const line = encodeRecord(record, resolveKey(opts.key))
  appendFileSync(filePath, `${line}\n`, 'utf8')
}

export function readEncryptedJsonl<T extends Record<string, unknown>>(
  filePath: string,
  opts: EncryptedJsonlOptions = {},
): T[] {
  if (!existsSync(filePath)) return []
  const key = resolveKey(opts.key)
  const raw = readFileSync(filePath, 'utf8')
  const out: T[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const decoded = decodeRecord<T>(parsed, key)
      if (decoded) out.push(decoded)
    } catch {
      // Ignore malformed lines so one bad row does not brick the dashboard.
    }
  }
  return out
}

export function buildEncryptionArtifact(input: {
  coveredStores: string[]
  now?: () => Date
  enabled?: boolean
}): {
  generatedAt: string
  encryptionAtRest: {
    enabled: boolean
    env: typeof AT_REST_ENCRYPTION_ENV
    algorithm: typeof ENCRYPTION_ALGORITHM
    coveredStores: string[]
  }
} {
  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    encryptionAtRest: {
      enabled:
        input.enabled ?? encryptionAtRestEnabled(),
      env: AT_REST_ENCRYPTION_ENV,
      algorithm: ENCRYPTION_ALGORITHM,
      coveredStores: [...input.coveredStores].sort(),
    },
  }
}
