export type Workflow = 'claude' | 'claude-review'

export type Warning = {
  title: string
  message: string
  instructions: string[]
}

export type InstallGitHubAppStep =
  | 'check-gh'
  | 'warnings'
  | 'choose-repo'
  | 'install-app'
  | 'check-existing-workflow'
  | 'check-secret'
  | 'api-key-choice'
  | 'existing-secret'
  | 'enter-api-key'
  | 'oauth-flow'
  | 'finalize'
  | 'success'
  | 'error'
  | string

export type State = {
  step: InstallGitHubAppStep
  selectedRepoName: string
  currentRepo: string
  useCurrentRepo: boolean
  apiKeyOrOAuthToken: string
  useExistingKey: boolean
  currentWorkflowInstallStep: number
  warnings: Warning[]
  secretExists: boolean
  secretName: string
  useExistingSecret: boolean
  workflowExists: boolean
  selectedWorkflows: Workflow[]
  selectedApiKeyOption: 'existing' | 'new' | 'oauth'
  authType: 'api_key' | 'oauth'
  workflowAction?: 'skip' | 'overwrite' | 'keep' | string
  error?: string
}
