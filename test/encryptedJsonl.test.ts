import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AT_REST_ENCRYPTION_ENV,
  appendEncryptedJsonlRecord,
  encryptionAtRestEnabled,
  readEncryptedJsonl,
} from 'src/services/security/encryptedJsonl.js'

const tempDirs: string[] = []
const originalKey = process.env[AT_REST_ENCRYPTION_ENV]

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-encrypted-jsonl-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
  if (originalKey === undefined) delete process.env[AT_REST_ENCRYPTION_ENV]
  else process.env[AT_REST_ENCRYPTION_ENV] = originalKey
})

describe('encryptedJsonl', () => {
  test('writes plaintext JSONL when no encryption key is configured', async () => {
    delete process.env[AT_REST_ENCRYPTION_ENV]
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'records.jsonl')

    appendEncryptedJsonlRecord(filePath, {
      id: 'plain-1',
      kind: 'plain',
    })

    const raw = await readFile(filePath, 'utf8')
    expect(raw).toContain('"id":"plain-1"')
    expect(encryptionAtRestEnabled()).toBe(false)
    expect(readEncryptedJsonl<{ id: string; kind: string }>(filePath)).toEqual([
      { id: 'plain-1', kind: 'plain' },
    ])
  })

  test('writes encrypted envelopes and decrypts them when a key is configured', async () => {
    process.env[AT_REST_ENCRYPTION_ENV] = 'phase3-secret'
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'records.jsonl')

    appendEncryptedJsonlRecord(filePath, {
      id: 'enc-1',
      secret: 'top-secret',
    })

    const raw = await readFile(filePath, 'utf8')
    expect(raw).toContain('"__encrypted":true')
    expect(raw).not.toContain('top-secret')
    expect(encryptionAtRestEnabled()).toBe(true)
    expect(
      readEncryptedJsonl<{ id: string; secret: string }>(filePath),
    ).toEqual([{ id: 'enc-1', secret: 'top-secret' }])
  })
})
