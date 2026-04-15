import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from '../components/CustomSelect/index.js'
import type { AssistantSession } from './sessionDiscovery.js'

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({
  sessions,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const formatTimestamp = (value?: string): string => {
    if (!value) return 'unknown time'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString()
  }

  return (
    <Box flexDirection="column">
      <Text bold>Select Assistant Session</Text>
      <Text dimColor>
        Pick a live remote assistant session to attach this REPL to.
      </Text>
      <Select
        options={[
          ...sessions.map(session => ({
            label: [
              session.title?.trim() || session.id,
              session.repo ? `· ${session.repo}` : null,
              session.status ? `· ${session.status}` : null,
              `· updated ${formatTimestamp(session.updatedAt || session.createdAt)}`,
            ]
              .filter(Boolean)
              .join(' '),
            value: session.id,
          })),
          { label: 'Cancel', value: '__cancel__' },
        ]}
        onChange={value => {
          if (value === '__cancel__') {
            onCancel()
            return
          }
          onSelect(value)
        }}
      />
    </Box>
  )
}
