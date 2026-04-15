export type AssistantSession = {
  id: string
  title?: string
  createdAt?: string
  cwd?: string
  updatedAt?: string
  status?: string
  repo?: string
}

export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  const { fetchCodeSessionsFromSessionsAPI } = await import(
    '../utils/teleport/api.js'
  )

  const sessions = await fetchCodeSessionsFromSessionsAPI()

  return sessions
    .map(session => ({
      id: session.id,
      title: session.title || session.repo?.name || 'Untitled session',
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: session.status,
      repo: session.repo
        ? `${session.repo.owner.login}/${session.repo.name}`
        : undefined,
    }))
    .sort((a, b) => {
      const left = new Date(a.updatedAt || a.createdAt || 0).getTime()
      const right = new Date(b.updatedAt || b.createdAt || 0).getTime()
      return right - left
    })
}
