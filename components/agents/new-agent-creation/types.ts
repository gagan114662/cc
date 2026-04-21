import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'

// Wizard-state accumulator for the new-agent creation flow. All fields optional —
// step components fill them in as the user advances. initialData starts as `{}`.
export type AgentWizardData = {
  location?: string
  method?: string
  generate?: Record<string, unknown>
  type?: string
  prompt?: string
  description?: string
  tools?: string[]
  model?: string
  color?: string
  memory?: string
  // Fields written across wizard-steps. Typed as `any` for the AgentDefinition-shaped
  // fields because the wizard mutates partial drafts and the final shape is
  // assembled in ConfirmStep before validateAgent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalAgent?: any
  agentType?: string
  generationPrompt?: string
  selectedModel?: string
  selectedTools?: string[]
  systemPrompt?: string
  whenToUse?: string
  wasGenerated?: boolean
  [key: string]: unknown
}

// Re-export for convenience so wizard files can pull both from types.js
export type { AgentDefinition }
