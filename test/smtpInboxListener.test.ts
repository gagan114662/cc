import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Socket } from 'node:net'
import { readAuditTail } from 'src/services/audit/durableAuditLog.js'
import { loadEmployeeInbox } from 'src/services/email/inboxStore.js'
import {
  SMTP_EMAIL_RECEIVED_AUDIT_KIND,
  startSmtpListener,
} from 'src/services/email/smtpListener.js'

let projectRoot: string
let auditDir: string

async function sendSmtpMessage(port: number, commands: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    socket.connect(port, '127.0.0.1', () => {
      socket.write(commands)
    })
    socket.on('error', reject)
    socket.on('close', () => resolve())
  })
}

beforeEach(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  projectRoot = path.join(tmpdir(), `cc-smtp-inbox-${suffix}`)
  auditDir = path.join(tmpdir(), `cc-smtp-audit-${suffix}`)
  await mkdir(projectRoot, { recursive: true })
  await mkdir(auditDir, { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(auditDir, { recursive: true, force: true })
})

describe('SMTP inbox listener', () => {
  test('captures inbound mail into the tenant-scoped inbox and audit log', async () => {
    const listener = await startSmtpListener({
      port: 0,
      domain: 'mail.test',
      projectRoot,
      auditDir,
    })

    try {
      await sendSmtpMessage(
        listener.port,
        [
          'EHLO localhost',
          'MAIL FROM:<sender@example.com>',
          'RCPT TO:<alice+acme@example.com>',
          'DATA',
          'Subject: Welcome',
          'From: sender@example.com',
          '',
          'Hello from SMTP',
          '.',
          'QUIT',
          '',
        ].join('\r\n'),
      )

      const inbox = loadEmployeeInbox('alice', {
        projectRoot,
        tenantId: 'acme',
      })
      expect(inbox).toHaveLength(1)
      expect(inbox[0].subject).toBe('Welcome')
      expect(inbox[0].from).toBe('sender@example.com')
      expect(inbox[0].message).toContain('Hello from SMTP')

      const audit = readAuditTail(10, { dir: auditDir })
      expect(audit.at(-1)?.kind).toBe(SMTP_EMAIL_RECEIVED_AUDIT_KIND)
      expect(audit.at(-1)?.employee).toBe('alice')
      expect(audit.at(-1)?.tenant).toEqual({
        id: 'acme',
        name: 'acme',
        role: 'developer',
      })
    } finally {
      await new Promise<void>(resolve => listener.server.close(() => resolve()))
    }
  })
})
