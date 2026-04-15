import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

type WizardProps = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export async function computeDefaultInstallDir(): Promise<string> {
  return join(homedir(), '.claude-assistant')
}

export function NewInstallWizard({
  defaultDir,
  onInstalled,
  onCancel,
  onError,
}: WizardProps): React.ReactNode {
  function handleInstall(): void {
    try {
      mkdirSync(defaultDir, { recursive: true })
      const { error } = updateSettingsForSource('localSettings', {
        assistant: true,
        defaultView: 'chat',
      })
      if (error) {
        throw error
      }
      onInstalled(defaultDir)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold>Assistant Install</Text>
      <Text dimColor>Default install directory: {defaultDir}</Text>
      <Text dimColor>
        This enables assistant mode in local settings and prefers chat view for
        the current project.
      </Text>
      <Select
        options={[
          { label: 'Enable assistant mode', value: 'install' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={value => {
          if (value === 'cancel') {
            onCancel()
            return
          }
          handleInstall()
        }}
      />
    </Box>
  )
}

export async function call(
  onDone: (result?: string) => void,
): Promise<React.ReactNode> {
  const defaultDir = await computeDefaultInstallDir()
  return (
    <NewInstallWizard
      defaultDir={defaultDir}
      onInstalled={dir =>
        onDone(
          `Assistant mode enabled. Local settings were updated and the assistant workspace is ready at ${dir}.`,
          { display: 'system' },
        )
      }
      onCancel={() => onDone(undefined, { display: 'skip' })}
      onError={message => onDone(`Assistant installation failed: ${message}`)}
    />
  )
}
