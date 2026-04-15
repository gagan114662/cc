import { createHash } from 'node:crypto'
import {
  type SplitterConfig,
  SplitterConfigSchema,
  type SplitterDomain,
  type SplitterWorkstream,
} from './types.js'

export type SplitterTelemetryContext = {
  workstream: SplitterWorkstream
  candidateId?: string
  caseId?: string
  challengeId?: string
  observationId?: string
  experimentId?: string
}

const DEFAULT_SPLITTER_DOMAINS: SplitterDomain[] = [
  {
    id: 'eval-tasks',
    workstream: 'candidate_eval',
    type: 'global',
    shardKeyStrategy: 'candidate_case_digest',
    description:
      'Distributes candidate-by-case benchmark execution across evaluator workers.',
    regionAffinity: false,
  },
  {
    id: 'benchmark-admission',
    workstream: 'benchmark_admission',
    type: 'global',
    shardKeyStrategy: 'proposal_case_digest',
    description:
      'Owns replay, stability, and challenge-discrimination checks for benchmark proposals.',
    regionAffinity: false,
  },
  {
    id: 'dogfood-observations',
    workstream: 'dogfood_observation',
    type: 'regional',
    shardKeyStrategy: 'observation_digest',
    description:
      'Processes dogfood regressions and transcript-derived observations near the source region.',
    regionAffinity: true,
  },
  {
    id: 'promotion-controller',
    workstream: 'promotion_controller',
    type: 'unit',
    shardKeyStrategy: 'singleton',
    description:
      'Holds singleton ownership for promotion, rollback, and teacher-freeze decisions.',
    regionAffinity: false,
  },
]

function stableDigest(parts: Array<string | undefined>): string {
  const value = parts.filter(Boolean).join('|')
  return createHash('sha256').update(value).digest('hex')
}

function formatDigestAsId(digest: string): string {
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-')
}

export function getDefaultSplitterDomains(): SplitterDomain[] {
  return DEFAULT_SPLITTER_DOMAINS.map(domain => ({ ...domain }))
}

export function resolveAutoresearchSplitterConfig(
  splitterConfig: SplitterConfig | undefined,
): SplitterConfig | undefined {
  if (!splitterConfig) {
    return undefined
  }

  const mergedDomains = new Map(
    getDefaultSplitterDomains().map(domain => [domain.workstream, domain]),
  )

  for (const domain of splitterConfig.domains) {
    mergedDomains.set(domain.workstream, domain)
  }

  return SplitterConfigSchema().parse({
    ...splitterConfig,
    domains: [...mergedDomains.values()],
  })
}

export function getSplitterDomainForWorkstream(
  splitterConfig: SplitterConfig | undefined,
  workstream: SplitterWorkstream,
): SplitterDomain | undefined {
  return splitterConfig?.domains.find(domain => domain.workstream === workstream)
}

function buildWorkItemIdentity(
  context: SplitterTelemetryContext,
): {
  workItemKind: string
  workItemId: string
  shardKey: string
} {
  switch (context.workstream) {
    case 'candidate_eval': {
      if (context.caseId) {
        const digest = stableDigest([
          context.workstream,
          context.candidateId,
          context.caseId,
        ])
        return {
          workItemKind: 'candidate_case',
          workItemId: formatDigestAsId(digest),
          shardKey: formatDigestAsId(digest),
        }
      }

      if (context.challengeId) {
        const digest = stableDigest([
          context.workstream,
          context.candidateId,
          context.challengeId,
        ])
        return {
          workItemKind: 'candidate_challenge',
          workItemId: formatDigestAsId(digest),
          shardKey: formatDigestAsId(digest),
        }
      }

      const digest = stableDigest([context.workstream, context.candidateId])
      return {
        workItemKind: 'candidate_batch',
        workItemId: formatDigestAsId(digest),
        shardKey: formatDigestAsId(digest),
      }
    }
    case 'benchmark_admission': {
      const digest = stableDigest([context.workstream, context.caseId])
      return {
        workItemKind: 'benchmark_case',
        workItemId: formatDigestAsId(digest),
        shardKey: formatDigestAsId(digest),
      }
    }
    case 'dogfood_observation': {
      const digest = stableDigest([
        context.workstream,
        context.observationId,
        context.candidateId,
      ])
      return {
        workItemKind: 'dogfood_observation',
        workItemId: formatDigestAsId(digest),
        shardKey: formatDigestAsId(digest),
      }
    }
    case 'promotion_controller':
    default: {
      if (context.experimentId || context.candidateId) {
        const digest = stableDigest([
          context.workstream,
          context.experimentId,
          context.candidateId,
        ])
        return {
          workItemKind: 'promotion_decision',
          workItemId: formatDigestAsId(digest),
          shardKey: 'singleton',
        }
      }
      return {
        workItemKind: 'singleton_controller',
        workItemId: 'singleton',
        shardKey: 'singleton',
      }
    }
  }
}

export function buildSplitterTopologyTelemetryFields(
  splitterConfig: SplitterConfig | undefined,
): Record<string, string | undefined> {
  if (!splitterConfig) {
    return {
      'autoresearch.splitter_enabled': 'false',
    }
  }

  return {
    'autoresearch.splitter_enabled': String(splitterConfig.enabled),
    'autoresearch.splitter_execution_mode': splitterConfig.executionMode,
    'autoresearch.splitter_service_id': splitterConfig.serviceId,
    'autoresearch.splitter_region': splitterConfig.region,
    'autoresearch.splitter_cluster_id': splitterConfig.clusterId,
    'autoresearch.splitter_domain_count': String(splitterConfig.domains.length),
    'autoresearch.splitter_domains': splitterConfig.domains
      .map(domain => domain.id)
      .join(','),
    'autoresearch.splitter_workstreams': splitterConfig.domains
      .map(domain => domain.workstream)
      .join(','),
  }
}

export function buildSplitterTelemetryFields(
  splitterConfig: SplitterConfig | undefined,
  context: SplitterTelemetryContext,
): Record<string, string | undefined> {
  const topologyFields = buildSplitterTopologyTelemetryFields(splitterConfig)
  if (!splitterConfig?.enabled) {
    return topologyFields
  }

  const domain = getSplitterDomainForWorkstream(splitterConfig, context.workstream)
  const workItemIdentity = buildWorkItemIdentity(context)

  return {
    ...topologyFields,
    'autoresearch.splitter_domain': domain?.id,
    'autoresearch.splitter_domain_type': domain?.type,
    'autoresearch.splitter_domain_description': domain?.description,
    'autoresearch.splitter_workstream': context.workstream,
    'autoresearch.splitter_region_affinity': domain
      ? String(domain.regionAffinity)
      : undefined,
    'autoresearch.splitter_shard_key_strategy': domain?.shardKeyStrategy,
    'autoresearch.splitter_work_item_kind': workItemIdentity.workItemKind,
    'autoresearch.splitter_work_item_id': workItemIdentity.workItemId,
    'autoresearch.splitter_shard_key': workItemIdentity.shardKey,
  }
}
