import React from 'react'
import { Box, Text } from '../../ink.js'
import { getBuiltInAgents } from '../../tools/AgentTool/builtInAgents.js'

export async function call(
  onDone: (result?: string) => void,
  context: {
    options?: {
      agentDefinitions?: {
        customAgents?: unknown[]
      }
    }
  },
): Promise<React.ReactNode> {
  const builtIn = getBuiltInAgents().length
  const custom = context.options?.agentDefinitions?.customAgents?.length || 0

  queueMicrotask(() =>
    onDone(
      `Agents platform ready. Detected ${builtIn} built-in agent${builtIn === 1 ? '' : 's'} and ${custom} custom agent${custom === 1 ? '' : 's'}.`,
    ),
  )

  return (
    <Box flexDirection="column">
      <Text bold>Agents Platform</Text>
      <Text dimColor>Built-in agents: {builtIn}</Text>
      <Text dimColor>Custom agents loaded: {custom}</Text>
      <Text dimColor>
        Agent discovery is active through the current registry and project
        agent definitions.
      </Text>
    </Box>
  )
}
