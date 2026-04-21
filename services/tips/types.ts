import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

export type TipContext = {
  bashTools?: Set<string>
  readFileState?: FileStateCache
  theme: ThemeName
  [key: string]: unknown
}

export type Tip = {
  id: string
  content: (ctx: TipContext) => Promise<string>
  cooldownSessions: number
  isRelevant: (ctx?: TipContext) => Promise<boolean>
}
