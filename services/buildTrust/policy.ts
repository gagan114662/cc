import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BuildTrustPolicySchema,
  type BuildTrustPolicy,
} from 'src/services/buildTrust/types.js'

export async function loadBuildTrustPolicy(
  repoRoot: string,
  policyPath: string = 'build-trust.policy.json',
): Promise<BuildTrustPolicy> {
  const resolvedPath = path.resolve(repoRoot, policyPath)
  const raw = await readFile(resolvedPath, 'utf8')
  const parsed = JSON.parse(raw)
  return BuildTrustPolicySchema().parse(parsed)
}
