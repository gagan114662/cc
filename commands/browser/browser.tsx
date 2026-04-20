import * as React from 'react'
import { useEffect, useState } from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { Box, Text } from '../../ink.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as SafeString,
} from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  BROWSER_HARNESS_CLOUD_URL,
  BROWSER_HARNESS_DOCS_URL,
  BROWSER_HARNESS_INSTALL_DOC_URL,
  BROWSER_HARNESS_INSTALL_SNIPPET,
  BROWSER_HARNESS_REPO_URL,
  type BrowserHarnessStatus,
  getBrowserHarnessStatus,
} from '../../utils/browserHarness.js'

type Action =
  | 'toggle-default'
  | 'open-repo'
  | 'open-install'
  | 'open-docs'
  | 'open-cloud'
  | 'done'

function BrowserHarnessDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}) {
  const [status, setStatus] = useState<BrowserHarnessStatus | null>(null)
  const [selectKey, setSelectKey] = useState(0)

  useEffect(() => {
    logEvent('tengu_browser_harness_panel_opened', {})
    void getBrowserHarnessStatus().then(setStatus)
  }, [])

  if (status === null) {
    return <LoadingState message="Checking Browser Harness status..." />
  }

  const refreshStatus = () => {
    void getBrowserHarnessStatus().then(setStatus)
  }

  const handleAction = async (action: Action) => {
    setSelectKey(current => current + 1)
    switch (action) {
      case 'toggle-default': {
        const nextEnabled = !status.defaultEnabled
        saveGlobalConfig(current => ({
          ...current,
          browserHarnessDefaultEnabled: nextEnabled,
        }))
        logEvent('tengu_browser_harness_default_toggled', {
          enabled: nextEnabled,
        })
        setStatus({
          ...status,
          defaultEnabled: nextEnabled,
          currentEnabled:
            process.env.CLAUDE_CODE_ENABLE_BROWSER_HARNESS === undefined
              ? nextEnabled
              : status.currentEnabled,
        })
        break
      }
      case 'open-repo':
        await openBrowser(BROWSER_HARNESS_REPO_URL)
        logEvent('tengu_browser_harness_link_opened', {
          target: 'repo' as SafeString,
        })
        break
      case 'open-install':
        await openBrowser(BROWSER_HARNESS_INSTALL_DOC_URL)
        logEvent('tengu_browser_harness_link_opened', {
          target: 'install' as SafeString,
        })
        break
      case 'open-docs':
        await openBrowser(BROWSER_HARNESS_DOCS_URL)
        logEvent('tengu_browser_harness_link_opened', {
          target: 'docs' as SafeString,
        })
        break
      case 'open-cloud':
        await openBrowser(BROWSER_HARNESS_CLOUD_URL)
        logEvent('tengu_browser_harness_link_opened', {
          target: 'cloud' as SafeString,
        })
        break
      case 'done':
        onDone()
        return
    }

    refreshStatus()
  }

  const toggleLabel = `Enabled by default: ${status.defaultEnabled ? 'Yes' : 'No'}`

  return (
    <Dialog
      title="Browser Harness"
      onCancel={() => onDone()}
      hideInputGuide={true}
    >
      <Box flexDirection="column">
        <Text>
          Browser Harness adds an external CDP-based browser backend alongside
          Claude in Chrome.
        </Text>
        <Box flexDirection="column">
          <Text>
            Installed:{' '}
            {status.installed ? (
              <Text color="success">Yes</Text>
            ) : (
              <Text color="warning">Not detected</Text>
            )}
          </Text>
          <Text>
            Remote browsers:{' '}
            {status.remoteReady ? (
              <Text color="success">API key configured</Text>
            ) : (
              <Text color="warning">Not configured</Text>
            )}
          </Text>
          <Text>
            Active in this session:{' '}
            {status.currentEnabled ? (
              <Text color="success">Enabled</Text>
            ) : (
              <Text color="inactive">Disabled</Text>
            )}
          </Text>
        </Box>
        {status.executablePath ? (
          <Text dimColor={true}>Executable: {status.executablePath}</Text>
        ) : (
          <Text dimColor={true}>
            Install with:
            {'\n'}
            {BROWSER_HARNESS_INSTALL_SNIPPET}
          </Text>
        )}
        <Text dimColor={true}>
          Use /chrome for Claude in Chrome settings. Use the
          browser-harness skill once the external command is installed and on
          PATH.
        </Text>
        <Select
          key={selectKey}
          options={[
            { label: toggleLabel, value: 'toggle-default' },
            { label: 'Open install guide', value: 'open-install' },
            { label: 'Open Browser Harness repo', value: 'open-repo' },
            { label: 'Open Browser Use docs', value: 'open-docs' },
            { label: 'Open remote browser key page', value: 'open-cloud' },
            { label: 'Done', value: 'done' },
          ]}
          onChange={(value: string) => {
            void handleAction(value as Action)
          }}
          hideIndexes={true}
          onCancel={() => onDone()}
        />
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  if (getGlobalConfig().browserHarnessDefaultEnabled === undefined) {
    saveGlobalConfig(current => ({
      ...current,
      browserHarnessDefaultEnabled: false,
    }))
  }
  return <BrowserHarnessDialog onDone={onDone} />
}
