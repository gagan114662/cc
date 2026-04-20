import { createServer, type Server, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendInboxMessage } from './inboxStore.js'
import { writeAuditEntry } from '../audit/durableAuditLog.js'

export const SMTP_EMAIL_RECEIVED_AUDIT_KIND = 'email.smtp.received'

export type StartSmtpListenerOptions = {
  port: number
  host?: string
  projectRoot?: string
  auditDir?: string
  domain?: string
  now?: () => Date
  idFactory?: () => string
  encryptionKey?: string
}

export type SmtpListenerHandle = {
  server: Server
  port: number
  host: string
  domain: string
}

type SessionState = {
  mailFrom: string | null
  recipients: string[]
  dataMode: boolean
  dataLines: string[]
}

function resetSessionTransaction(state: SessionState): void {
  state.mailFrom = null
  state.recipients = []
  state.dataMode = false
  state.dataLines = []
}

function writeLine(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`)
}

function parsePathValue(line: string, prefix: string): string | null {
  const remainder = line.slice(prefix.length).trim()
  const match = remainder.match(/^:?\s*<([^>]+)>/i)
  if (match?.[1]) return match[1].trim()
  return null
}

function parseHeader(raw: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, 'im')
  const match = raw.match(pattern)
  return match?.[1]?.trim() ?? ''
}

function parseRecipient(
  address: string,
): { employee: string; tenantId: string; to: string } {
  const [localPartRaw, domainRaw] = address.toLowerCase().split('@')
  const localPart = localPartRaw?.trim() ?? 'inbox'
  const domain = domainRaw?.trim() ?? 'localhost'
  const [employeeRaw, tenantRaw] = localPart.split('+')
  return {
    employee: employeeRaw?.trim() || 'inbox',
    tenantId: tenantRaw?.trim() || 'default',
    to: `${localPart}@${domain}`,
  }
}

async function persistMessage(
  rawMessage: string,
  state: SessionState,
  opts: StartSmtpListenerOptions,
): Promise<void> {
  const receivedAt = (opts.now ?? (() => new Date()))().toISOString()
  const subject = parseHeader(rawMessage, 'subject')
  const headerFrom = parseHeader(rawMessage, 'from')
  for (const rcpt of state.recipients) {
    const parsed = parseRecipient(rcpt)
    const id = (opts.idFactory ?? randomUUID)()
    appendInboxMessage(
      {
        id,
        tenantId: parsed.tenantId,
        employee: parsed.employee,
        from: headerFrom || state.mailFrom || '',
        to: parsed.to,
        subject,
        receivedAt,
        message: rawMessage,
      },
      {
        projectRoot: opts.projectRoot,
        tenantId: parsed.tenantId,
        ...(opts.encryptionKey ? { encryptionKey: opts.encryptionKey } : {}),
      },
    )
    writeAuditEntry(
      {
        ts: receivedAt,
        kind: SMTP_EMAIL_RECEIVED_AUDIT_KIND,
        source: 'smtp.listener',
        emailId: id,
        employee: parsed.employee,
        subject,
        from: headerFrom || state.mailFrom || '',
        to: parsed.to,
      },
      {
        ...(opts.auditDir ? { dir: opts.auditDir } : {}),
        tenant: {
          id: parsed.tenantId,
          name: parsed.tenantId,
          role: parsed.tenantId === 'default' ? 'admin' : 'developer',
        },
      },
    )
  }
}

function wireSocket(socket: Socket, opts: StartSmtpListenerOptions): void {
  const session: SessionState = {
    mailFrom: null,
    recipients: [],
    dataMode: false,
    dataLines: [],
  }
  let buffer = ''

  const flushLines = async (): Promise<void> => {
    while (true) {
      if (session.dataMode) {
        const terminatorIndex = buffer.indexOf('\r\n.\r\n')
        if (terminatorIndex === -1) return
        const rawMessage = buffer.slice(0, terminatorIndex)
        buffer = buffer.slice(terminatorIndex + 5)
        await persistMessage(rawMessage, session, opts)
        resetSessionTransaction(session)
        writeLine(socket, '250 Ok queued')
        continue
      }

      const lineEnd = buffer.indexOf('\r\n')
      if (lineEnd === -1) return
      const line = buffer.slice(0, lineEnd)
      buffer = buffer.slice(lineEnd + 2)
      const upper = line.toUpperCase()

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        writeLine(socket, '250-localhost')
        writeLine(socket, '250 SIZE 1048576')
        continue
      }
      if (upper.startsWith('MAIL FROM')) {
        session.mailFrom = parsePathValue(line, 'MAIL FROM')
        session.recipients = []
        writeLine(socket, session.mailFrom ? '250 Ok' : '501 Syntax error')
        continue
      }
      if (upper.startsWith('RCPT TO')) {
        const recipient = parsePathValue(line, 'RCPT TO')
        if (!recipient) {
          writeLine(socket, '501 Syntax error')
          continue
        }
        session.recipients.push(recipient)
        writeLine(socket, '250 Ok')
        continue
      }
      if (upper === 'DATA') {
        if (!session.mailFrom || session.recipients.length === 0) {
          writeLine(socket, '503 Need MAIL FROM and RCPT TO first')
          continue
        }
        session.dataMode = true
        writeLine(socket, '354 End data with <CR><LF>.<CR><LF>')
        continue
      }
      if (upper === 'RSET') {
        resetSessionTransaction(session)
        writeLine(socket, '250 Ok')
        continue
      }
      if (upper === 'NOOP') {
        writeLine(socket, '250 Ok')
        continue
      }
      if (upper === 'QUIT') {
        writeLine(socket, '221 Bye')
        socket.end()
        return
      }
      writeLine(socket, '502 Command not implemented')
    }
  }

  writeLine(socket, `220 ${opts.domain ?? 'localhost'} ESMTP cc`)
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    void flushLines().catch(() => {
      writeLine(socket, '451 Requested action aborted')
      socket.end()
    })
  })
}

export async function startSmtpListener(
  opts: StartSmtpListenerOptions,
): Promise<SmtpListenerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const domain = opts.domain ?? 'localhost'
  const server = createServer(socket => wireSocket(socket, { ...opts, domain }))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(opts.port, host)
  })
  const address = server.address()
  const port =
    address && typeof address === 'object' ? address.port : opts.port
  return { server, port, host, domain }
}
