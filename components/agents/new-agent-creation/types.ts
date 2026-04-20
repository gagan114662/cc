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
  [key: string]: unknown
}
