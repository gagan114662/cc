import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

export function createStableId(...parts: Array<string | number>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

export function createJobInstanceId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return variables[key] ?? ''
  })
}

export function resolveRepoPath(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

export function truncateText(value: string, maxLength: number = 1200): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}…`
}
