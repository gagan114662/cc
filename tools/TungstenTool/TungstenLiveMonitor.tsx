import React from 'react'
import { Box, Text } from '../../ink.js'
import { getTungstenSessions, isTungstenInitialized } from './TungstenTool.js'

export function TungstenLiveMonitor(): React.ReactNode {
  if (!isTungstenInitialized()) {
    return null
  }

  const sessions = getTungstenSessions().slice(0, 3)
  if (sessions.length === 0) {
    return (
      <Box>
        <Text dimColor>Tungsten: initialized, no active shared sessions</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>Tungsten sessions</Text>
      {sessions.map(session => (
        <Text key={session.id} dimColor>
          {session.id}: {session.task || session.command || 'shared shell work'}
        </Text>
      ))}
    </Box>
  )
}
