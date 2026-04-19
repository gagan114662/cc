import {
  BROWSER_HARNESS_REFERENCE_FILES,
  buildBrowserHarnessSkillPrompt,
  isBrowserHarnessInstalledSync,
} from '../../utils/browserHarness.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerBrowserHarnessSkill(): void {
  registerBundledSkill({
    name: 'browser-harness',
    description:
      'Drives the external browser-use/browser-harness backend for browser automation, scraping, and logged-in web workflows.',
    aliases: ['browser-use'],
    whenToUse:
      'When browser work is needed and browser-harness is installed locally. Use /browser to set it up first if needed.',
    argumentHint: '[browser task]',
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    userInvocable: true,
    isEnabled: () => isBrowserHarnessInstalledSync(),
    files: BROWSER_HARNESS_REFERENCE_FILES,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildBrowserHarnessSkillPrompt(args) }]
    },
  })
}
