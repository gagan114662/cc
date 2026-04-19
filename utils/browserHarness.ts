import { getIsInteractive, getIsNonInteractiveSession } from '../bootstrap/state.js'
import type { GlobalConfig } from './config.js'
import { getGlobalConfig } from './config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { which, whichSync } from './which.js'

export const BROWSER_HARNESS_REPO_URL =
  'https://github.com/browser-use/browser-harness'
export const BROWSER_HARNESS_DOCS_URL =
  'https://docs.browser-use.com/open-source/introduction'
export const BROWSER_HARNESS_INSTALL_DOC_URL =
  'https://github.com/browser-use/browser-harness/blob/main/install.md'
export const BROWSER_HARNESS_CLOUD_URL =
  'https://cloud.browser-use.com/new-api-key'

export const BROWSER_HARNESS_INSTALL_SNIPPET = `git clone ${BROWSER_HARNESS_REPO_URL} ~/Developer/browser-harness
cd ~/Developer/browser-harness
uv sync
uv tool install -e .`

export const BROWSER_HARNESS_REFERENCE_FILES = {
  'install.md': `# Browser Harness Install

Upstream source:
- Repo: ${BROWSER_HARNESS_REPO_URL}
- Install guide: ${BROWSER_HARNESS_INSTALL_DOC_URL}

Recommended local install:

\`\`\`bash
${BROWSER_HARNESS_INSTALL_SNIPPET}
command -v browser-harness
\`\`\`

Browser bootstrap:

1. Try the harness directly before asking the user to change browser settings.
2. If Chrome is running and attach fails with startup noise, keep retrying for a short window.
3. Only open \`chrome://inspect/#remote-debugging\` when the error indicates the profile has never enabled remote debugging.
4. If the daemon socket is stale, restart the harness daemon once and retry.
5. When you open a setup or verification tab, activate it so the user can see the live browser state.
`,
  'usage.md': `# Browser Harness Usage

Use the external \`browser-harness\` command directly from PATH.

Core contract from the upstream skill:

- Read the helper reference before inventing calls.
- First navigation is \`new_tab(url)\`, not \`goto(url)\`.
- Local browser work attaches to the user's running Chrome session.
- Remote browsers are for parallel or headless work and require \`BROWSER_USE_API_KEY\`.
- Use distinct \`BU_NAME\` values for parallel runs so sessions do not collide.

Quick example:

\`\`\`bash
browser-harness <<'PY'
new_tab("https://browser-use.com")
wait_for_load()
print(page_info())
PY
\`\`\`
`,
  'helpers-reference.md': `# Browser Harness Helper Reference

Common local-tab helpers:

- \`new_tab(url)\`: open and attach to a fresh tab
- \`goto(url)\`: navigate the currently attached tab
- \`page_info()\`: current URL, title, viewport, and page-size info
- \`wait_for_load(timeout=15)\`: wait for document readyState complete
- \`list_tabs()\`, \`current_tab()\`, \`switch_tab(targetId)\`
- \`screenshot(path="/tmp/shot.png", full=False)\`
- \`js(expression)\`: run JavaScript in the attached tab

Input helpers:

- \`click(x, y)\`
- \`type_text(text)\`
- \`press_key(key, modifiers=0)\`
- \`scroll(x, y, dy=-300, dx=0)\`
- \`dispatch_key(selector, key="Enter")\`
- \`upload_file(selector, path)\`

Network / utility helpers:

- \`http_get(url, headers=None)\`
- \`wait(seconds)\`

Remote browser helpers are pre-imported by the upstream harness runtime:

- \`start_remote_daemon("work")\`
- \`list_cloud_profiles()\`
- \`list_local_profiles()\`
- \`sync_local_profile()\`
`,
}

export type BrowserHarnessStatus = {
  installed: boolean
  executablePath: string | null
  remoteReady: boolean
  defaultEnabled: boolean
  currentEnabled: boolean
}

export function browserHarnessRemoteConfiguredFromSources(
  processEnv: NodeJS.ProcessEnv,
  configEnv: Record<string, string> | undefined,
): boolean {
  const runtimeValue = processEnv.BROWSER_USE_API_KEY?.trim()
  if (runtimeValue) {
    return true
  }
  const configValue = configEnv?.BROWSER_USE_API_KEY?.trim()
  return Boolean(configValue)
}

export function isBrowserHarnessInstalledSync(): boolean {
  return whichSync('browser-harness') !== null
}

export async function isBrowserHarnessInstalled(): Promise<boolean> {
  return (await which('browser-harness')) !== null
}

export function shouldEnableBrowserHarness(): boolean {
  if (
    getIsNonInteractiveSession() &&
    !isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_BROWSER_HARNESS)
  ) {
    return false
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_BROWSER_HARNESS)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_BROWSER_HARNESS)) {
    return false
  }

  return getGlobalConfig().browserHarnessDefaultEnabled === true
}

export function shouldAutoEnableBrowserHarness(): boolean {
  return (
    getIsInteractive() &&
    isBrowserHarnessInstalledSync() &&
    shouldEnableBrowserHarness()
  )
}

export function buildBrowserHarnessSkillPrompt(args?: string): string {
  return `# Browser Harness

Use the external Browser Use browser-harness backend for browser automation, scraping, verification, and logged-in web workflows.

Before running a task:

1. Read \`install.md\` if the command is missing or browser attach/setup looks unhealthy.
2. Read \`usage.md\` and \`helpers-reference.md\` before inventing calls.
3. Run \`browser-harness\` directly from PATH; do not wrap it in extra shells unless needed for env setup.

Important operating rules:

- First navigation is \`new_tab(url)\`, not \`goto(url)\`, so you do not clobber the user's active tab.
- When you open a setup or verification tab, activate it so the user can see the browser move.
- Prefer local browser mode for tasks that depend on the user's current authenticated Chrome session.
- Prefer remote mode for parallel/headless work; remote mode requires \`BROWSER_USE_API_KEY\` and distinct \`BU_NAME\` values.
- If browser-harness reveals a durable site-specific trick, summarize it back as a candidate skill/pack learning instead of burying it in narration.

Example:

\`\`\`bash
browser-harness <<'PY'
new_tab("https://example.com")
wait_for_load()
print(page_info())
PY
\`\`\`

Task:

${args || 'Use browser-harness to complete the requested browser task.'}
`
}

export function buildBrowserFunnelAuditWorkflowPrompt(args?: string): string {
  return `${buildBrowserHarnessSkillPrompt(
    args ||
      'Audit the current website funnel in the browser, capture concrete friction points, and propose the next fixes.',
  )}

Workflow deliverable requirements:

- Walk the live browser flow from landing page to the most relevant conversion point.
- Capture concrete evidence for every meaningful friction point.
- Prefer screenshots, page-state notes, and DOM/console evidence over generic commentary.
- Return enough detail for a final artifact covering:
  - the funnel path audited
  - the top friction points
  - recommended fixes
  - any blockers that prevented a full audit
`
}

export async function getBrowserHarnessStatus(): Promise<BrowserHarnessStatus> {
  const executablePath = await which('browser-harness')
  const config = getGlobalConfig()

  return {
    installed: executablePath !== null,
    executablePath,
    remoteReady: browserHarnessRemoteConfiguredFromSources(
      process.env,
      config.env,
    ),
    defaultEnabled: config.browserHarnessDefaultEnabled === true,
    currentEnabled: shouldEnableBrowserHarness(),
  }
}

export function browserHarnessRemoteConfigured(
  config: Pick<GlobalConfig, 'env'> = getGlobalConfig(),
): boolean {
  return browserHarnessRemoteConfiguredFromSources(process.env, config.env)
}
