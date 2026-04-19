// Pins the durable audit log: append creates file, multiple entries
// stack, day boundary rotates to a new file, reader returns the tail in
// chronological order, and a missing dir returns [] without throwing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  auditFilePath,
  readAuditTail,
  writeAuditEntry,
} from 'src/services/audit/durableAuditLog.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cc-audit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('durableAuditLog', () => {
  test('writeAuditEntry creates the day file and appends JSONL', () => {
    const now = () => new Date('2026-04-19T10:00:00Z')
    writeAuditEntry({ ts: '2026-04-19T10:00:00Z', kind: 'error', message: 'boom' }, { dir, now })

    const file = auditFilePath({ dir, now })
    expect(file).toBe(path.join(dir, '2026-04-19.jsonl'))

    const contents = readFileSync(file, 'utf8')
    expect(contents).toBe(
      JSON.stringify({ ts: '2026-04-19T10:00:00Z', kind: 'error', message: 'boom' }) + '\n',
    )
  })

  test('multiple entries stack on the same day', () => {
    const now = () => new Date('2026-04-19T10:00:00Z')
    writeAuditEntry({ ts: 't1', kind: 'error', message: 'a' }, { dir, now })
    writeAuditEntry({ ts: 't2', kind: 'error', message: 'b' }, { dir, now })
    writeAuditEntry({ ts: 't3', kind: 'duty.start', dutyId: 'd1' }, { dir, now })

    const lines = readFileSync(auditFilePath({ dir, now }), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2]!).kind).toBe('duty.start')
  })

  test('rotates across UTC day boundary to a new file', () => {
    let fake = new Date('2026-04-19T23:59:00Z')
    const now = () => fake

    writeAuditEntry({ ts: 'before', kind: 'error' }, { dir, now })
    fake = new Date('2026-04-20T00:01:00Z')
    writeAuditEntry({ ts: 'after', kind: 'error' }, { dir, now })

    const files = readdirSync(dir).sort()
    expect(files).toEqual(['2026-04-19.jsonl', '2026-04-20.jsonl'])
  })

  test('readAuditTail returns entries oldest→newest across files', () => {
    let fake = new Date('2026-04-18T12:00:00Z')
    const now = () => fake

    writeAuditEntry({ ts: 'day1-a', kind: 'error' }, { dir, now })
    writeAuditEntry({ ts: 'day1-b', kind: 'error' }, { dir, now })

    fake = new Date('2026-04-19T12:00:00Z')
    writeAuditEntry({ ts: 'day2-a', kind: 'error' }, { dir, now })
    writeAuditEntry({ ts: 'day2-b', kind: 'error' }, { dir, now })

    const tail = readAuditTail(3, { dir, now })
    expect(tail.map(e => e.ts)).toEqual(['day1-b', 'day2-a', 'day2-b'])
  })

  test('readAuditTail returns [] when the dir does not exist', () => {
    const nonExistent = path.join(dir, 'no-such-subdir')
    expect(readAuditTail(10, { dir: nonExistent })).toEqual([])
  })

  test('readAuditTail tolerates malformed lines without throwing', () => {
    const now = () => new Date('2026-04-19T10:00:00Z')
    writeAuditEntry({ ts: 'ok1', kind: 'error' }, { dir, now })
    // Hand-append a broken line.
    const file = auditFilePath({ dir, now })
    require('node:fs').appendFileSync(file, 'this is not json\n', 'utf8')
    writeAuditEntry({ ts: 'ok2', kind: 'error' }, { dir, now })

    const tail = readAuditTail(10, { dir, now })
    expect(tail.map(e => e.ts)).toEqual(['ok1', 'ok2'])
  })
})
