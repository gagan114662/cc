import React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../CustomSelect/index.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'

type Props = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (result: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function buildMergePrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return `Merge the latest ${scope} memory snapshot for the ${agentType} agent into the active conversation. Preserve current work, reconcile differences, and call out any conflicts before continuing.`
}

export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Update Agent Memory</Text>
      <Text dimColor>
        {agentType} has a newer {scope} snapshot from {snapshotTimestamp}.
      </Text>
      <Text dimColor>
        Merge keeps your current thread and folds in newer memory. Replace
        prefers the saved snapshot as the new source of truth.
      </Text>
      <Select
        options={[
          { label: 'Merge snapshot', value: 'merge' },
          { label: 'Keep current', value: 'keep' },
          { label: 'Replace current', value: 'replace' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={value => {
          if (value === 'cancel') {
            onCancel()
            return
          }
          onComplete(value as 'merge' | 'keep' | 'replace')
        }}
      />
    </Box>
  )
}
