export type TipContext = {
  bashTools?: Set<string>
  readFileState?: Map<string, unknown>
  [key: string]: unknown
}

export type Tip = {
  id: string
  content: () => Promise<string>
  cooldownSessions: number
  isRelevant: (ctx?: TipContext) => Promise<boolean>
}
