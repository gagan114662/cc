import { buildAlertingSecurityArtifact } from '../alerting/dispatcher.js'
import { buildBillingSecurityArtifact } from '../billing/usageLedger.js'
import { buildInboxSecurityArtifact } from '../email/inboxStore.js'
import { buildWorkspaceSecurityArtifact } from '../workspaces/lifecycleLog.js'

export function buildSoc2EncryptionArtifact(now?: () => Date): {
  generatedAt: string
  encryptionAtRest: {
    enabled: boolean
    env: string
    algorithm: string
    coveredStores: string[]
  }
} {
  const inbox = buildInboxSecurityArtifact(now)
  const billing = buildBillingSecurityArtifact(now)
  const alerting = buildAlertingSecurityArtifact(now)
  const workspaces = buildWorkspaceSecurityArtifact(now)

  return {
    generatedAt: inbox.generatedAt,
    encryptionAtRest: {
      enabled:
        inbox.encryptionAtRest.enabled ||
        billing.encryptionAtRest.enabled ||
        alerting.encryptionAtRest.enabled ||
        workspaces.encryptionAtRest.enabled,
      env: inbox.encryptionAtRest.env,
      algorithm: inbox.encryptionAtRest.algorithm,
      coveredStores: Array.from(
        new Set([
          ...inbox.encryptionAtRest.coveredStores,
          ...billing.encryptionAtRest.coveredStores,
          ...alerting.encryptionAtRest.coveredStores,
          ...workspaces.encryptionAtRest.coveredStores,
        ]),
      ).sort(),
    },
  }
}
