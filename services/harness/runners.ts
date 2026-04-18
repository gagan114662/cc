import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/v4'
import { safeParseJSON } from 'src/utils/json.js'
import type { HarnessAgentKind } from './types.js'

const HarnessRunnerManifestEntrySchema = z
  .object({
    id: z.string().min(1),
    agentKind: z.enum(['claude', 'codex']),
    slotCapacity: z.number().int().positive(),
    labels: z.array(z.string()).default([]),
  })
  .strict()

const HarnessRunnerManifestSchema = z
  .object({
    version: z.literal('1').default('1'),
    runners: z.array(HarnessRunnerManifestEntrySchema).min(1),
  })
  .strict()

export type HarnessRunnerManifestEntry = z.infer<
  typeof HarnessRunnerManifestEntrySchema
>

export type HarnessRunnerManifest = z.infer<typeof HarnessRunnerManifestSchema>

export function getHarnessRunnerManifestPath(repoRoot: string): string {
  return path.join(repoRoot, '.claude', 'harness.runners.json')
}

export function getDefaultHarnessRunnerManifest(): HarnessRunnerManifest {
  return HarnessRunnerManifestSchema.parse({
    version: '1',
    runners: [
      {
        id: 'claude-primary',
        agentKind: 'claude',
        slotCapacity: 25,
        labels: ['shared', 'cc', 'claude'],
      },
      {
        id: 'codex-primary',
        agentKind: 'codex',
        slotCapacity: 25,
        labels: ['shared', 'cc', 'codex'],
      },
    ],
  })
}

export async function readHarnessRunnerManifest(
  repoRoot: string,
): Promise<HarnessRunnerManifest> {
  try {
    const raw = await readFile(getHarnessRunnerManifestPath(repoRoot), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    if (parsed == null) {
      return getDefaultHarnessRunnerManifest()
    }
    return HarnessRunnerManifestSchema.parse(parsed)
  } catch {
    return getDefaultHarnessRunnerManifest()
  }
}

export async function readHarnessRunnerEntry(
  repoRoot: string,
  runnerId: string,
): Promise<HarnessRunnerManifestEntry | null> {
  const manifest = await readHarnessRunnerManifest(repoRoot)
  return manifest.runners.find(runner => runner.id === runnerId) ?? null
}

export function computeHarnessRunnerManifestSummary(
  manifest: HarnessRunnerManifest,
): {
  expectedRunners: string[]
  expectedSlotCapacity: number
  slotCapacityByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
} {
  return manifest.runners.reduce(
    (summary, runner) => {
      summary.expectedRunners.push(runner.id)
      summary.expectedSlotCapacity += runner.slotCapacity
      summary.slotCapacityByAgentKind[runner.agentKind] += runner.slotCapacity
      return summary
    },
    {
      expectedRunners: [],
      expectedSlotCapacity: 0,
      slotCapacityByAgentKind: { claude: 0, codex: 0 },
    } as {
      expectedRunners: string[]
      expectedSlotCapacity: number
      slotCapacityByAgentKind: Record<Exclude<HarnessAgentKind, 'either'>, number>
    },
  )
}
