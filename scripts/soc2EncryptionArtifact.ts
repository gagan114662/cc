#!/usr/bin/env bun

import { buildSoc2EncryptionArtifact } from '../services/security/artifacts.js'

const artifact = buildSoc2EncryptionArtifact()
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
} else {
  process.stdout.write(
    [
      'SOC 2 encryption-at-rest artifact',
      `Generated: ${artifact.generatedAt}`,
      `Enabled: ${artifact.encryptionAtRest.enabled ? 'yes' : 'no'}`,
      `Env: ${artifact.encryptionAtRest.env}`,
      `Algorithm: ${artifact.encryptionAtRest.algorithm}`,
      `Covered stores: ${artifact.encryptionAtRest.coveredStores.join(', ')}`,
    ].join('\n') + '\n',
  )
}
