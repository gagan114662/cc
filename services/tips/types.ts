import type { FileStateCache } from '../../utils/fileStateCache.js'

export type TipContext = {
  bashTools?: Set<string>
  readFileState?: FileStateCache
  [key: string]: unknown
}

export type Tip = {
  id: string
  content: (ctx?: { theme?: unknown }) => Promise<string>
  cooldownSessions: number
  isRelevant: (ctx?: TipContext) => Promise<boolean>
}
