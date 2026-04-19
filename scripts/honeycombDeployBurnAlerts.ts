#!/usr/bin/env bun
// Idempotently deploys burn-rate alerts for each SLO in
// services/observability/slos.ts to Honeycomb.
//
// Today the SLOs exist (post honeycombDeploySLOs) but nothing pages
// when the budget starts burning. Google SRE workbook says two alerts
// per SLO: fast (14.4× budget burn, catches acute regressions) and
// slow (6× burn, catches chronic drift). The rates already live on
// each SLODefinition.burnAlerts; this script translates them into
// Honeycomb's burn-alert model and reconciles per-(SLO, flavor).
//
// Exhaustion math: Honeycomb's exhaustion_minutes = "fire when current
// burn rate projects the budget will run out within N minutes." At
// burn rate R on a windowDays SLO, remaining budget lasts
// windowDays * 24 * 60 / R minutes. So fast burn alert on a 28-day SLO
// with R=14.4 → exhaustion_minutes = 2800.
//
// Auth: same config as honeycombDeploySLOs — HONEYCOMB_CONFIG_KEY must
// be a management-tier key (ingest keys can't write /1/burn_alerts).
//
// Safe to re-run: diffs existing alerts by (slo_id, flavor tag) and
// only POST/PATCHes when something drifted. --dry-run previews.

import path from 'node:path'
import { parseSettingsFile } from 'src/utils/settings/settings.js'
import {
  STARTER_SLOS,
  type SLODefinition,
} from '../services/observability/slos.js'

export type HoneycombConfig = {
  apiBaseUrl: string
  dataset: string
  configKey: string
}

export type BurnAlertFlavor = 'fast' | 'slow'

export type BurnAlertPayload = {
  // Honeycomb's /1/burn_alerts body. description holds the flavor tag
  // so the diff step can match existing alerts back to the registry
  // without relying on ordering.
  sli: { alias: string }
  slo_id: string
  exhaustion_minutes: number
  description: string
  alert_type: 'exhaustion_time'
}

export type PlannedBurnAlert = {
  action: 'create' | 'update' | 'skip'
  flavor: BurnAlertFlavor
  sloName: string
  payload: BurnAlertPayload
  existingId?: string
  reason: string
}

export type BurnAlertPlan = {
  items: PlannedBurnAlert[]
  // SLOs we couldn't find on the Honeycomb side — usually means
  // honeycombDeploySLOs hasn't been run yet for that registry entry.
  unresolvedSLOs: string[]
}

export type ExistingSLO = {
  id: string
  name?: string
}

export type ExistingBurnAlert = {
  id: string
  slo_id?: string
  exhaustion_minutes?: number
  description?: string
}

const FLAVOR_TAG = {
  fast: '[auto-burn-fast]',
  slow: '[auto-burn-slow]',
} as const

// windowDays * minutes-per-day / burnRate — see header comment.
export function exhaustionMinutes(
  windowDays: number,
  burnRate: number,
): number {
  if (burnRate <= 0) throw new Error(`invalid burnRate: ${burnRate}`)
  return Math.round((windowDays * 24 * 60) / burnRate)
}

export function buildBurnAlertPayload(
  slo: SLODefinition,
  sloId: string,
  flavor: BurnAlertFlavor,
): BurnAlertPayload {
  const rate = flavor === 'fast' ? slo.burnAlerts.fast : slo.burnAlerts.slow
  return {
    sli: { alias: `sli.${slo.id}` },
    slo_id: sloId,
    exhaustion_minutes: exhaustionMinutes(slo.windowDays, rate),
    alert_type: 'exhaustion_time',
    description: `${FLAVOR_TAG[flavor]} ${flavor === 'fast' ? 'Fast' : 'Slow'}-burn alert for "${slo.name}" (${rate}× burn). Auto-generated — edit services/observability/slos.ts.`,
  }
}

function findMatchingAlert(
  existing: ExistingBurnAlert[],
  sloId: string,
  flavor: BurnAlertFlavor,
): ExistingBurnAlert | undefined {
  const tag = FLAVOR_TAG[flavor]
  return existing.find(
    a => a.slo_id === sloId && (a.description ?? '').includes(tag),
  )
}

export function planBurnAlertDeployment(
  slos: readonly SLODefinition[],
  existingSLOs: ExistingSLO[],
  existingAlerts: ExistingBurnAlert[],
): BurnAlertPlan {
  const sloByName = new Map(
    existingSLOs.filter(s => s.name).map(s => [s.name as string, s]),
  )
  const items: PlannedBurnAlert[] = []
  const unresolvedSLOs: string[] = []

  for (const slo of slos) {
    const existing = sloByName.get(slo.name)
    if (!existing) {
      unresolvedSLOs.push(slo.name)
      continue
    }

    for (const flavor of ['fast', 'slow'] as const) {
      const payload = buildBurnAlertPayload(slo, existing.id, flavor)
      const match = findMatchingAlert(existingAlerts, existing.id, flavor)
      if (!match) {
        items.push({
          action: 'create',
          flavor,
          sloName: slo.name,
          payload,
          reason: `no ${flavor}-burn alert tagged for "${slo.name}"`,
        })
      } else if (match.exhaustion_minutes !== payload.exhaustion_minutes) {
        items.push({
          action: 'update',
          flavor,
          sloName: slo.name,
          payload,
          existingId: match.id,
          reason: `exhaustion_minutes drifted (${match.exhaustion_minutes} → ${payload.exhaustion_minutes})`,
        })
      } else {
        items.push({
          action: 'skip',
          flavor,
          sloName: slo.name,
          payload,
          existingId: match.id,
          reason: `${flavor}-burn alert in sync`,
        })
      }
    }
  }

  return { items, unresolvedSLOs }
}

// ---- HTTP + orchestration (not pure, not unit-tested) ----

function loadConfig(repoRoot: string): HoneycombConfig {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.local.json')
  const { settings, errors } = parseSettingsFile(settingsPath)
  if (errors.length > 0) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${errors.map(e => e.message).join('; ')}`,
    )
  }
  const env = settings?.env ?? {}
  const apiBaseUrl = env.HONEYCOMB_API_BASE_URL ?? 'https://api.honeycomb.io'
  const dataset = env.HONEYCOMB_DATASET
  const configKey =
    process.env.HONEYCOMB_CONFIG_KEY ?? env.HONEYCOMB_CONFIG_KEY ?? ''
  if (!dataset) {
    throw new Error(
      'HONEYCOMB_DATASET missing from .claude/settings.local.json — configure it before deploying burn alerts.',
    )
  }
  if (!configKey) {
    throw new Error(
      'HONEYCOMB_CONFIG_KEY missing. Export a management-tier API key — ingest keys cannot create burn alerts.',
    )
  }
  return { apiBaseUrl, dataset, configKey }
}

async function hc<T>(
  config: HoneycombConfig,
  method: 'GET' | 'POST' | 'PATCH',
  pathSuffix: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.apiBaseUrl}${pathSuffix}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Honeycomb-Team': config.configKey,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `${method} ${pathSuffix} → ${res.status}: ${text.slice(0, 400)}`,
    )
  }
  return (await res.json()) as T
}

async function listSLOs(config: HoneycombConfig): Promise<ExistingSLO[]> {
  return hc(config, 'GET', `/1/slos/${config.dataset}`)
}

async function listBurnAlerts(
  config: HoneycombConfig,
): Promise<ExistingBurnAlert[]> {
  return hc(config, 'GET', `/1/burn_alerts/${config.dataset}`)
}

async function applyPlan(
  config: HoneycombConfig,
  plan: BurnAlertPlan,
): Promise<string[]> {
  const results: string[] = []
  for (const item of plan.items) {
    if (item.action === 'create') {
      await hc(config, 'POST', `/1/burn_alerts/${config.dataset}`, item.payload)
      results.push(`created ${item.flavor}-burn for "${item.sloName}"`)
    } else if (item.action === 'update' && item.existingId) {
      await hc(
        config,
        'PATCH',
        `/1/burn_alerts/${config.dataset}/${item.existingId}`,
        item.payload,
      )
      results.push(`updated ${item.flavor}-burn for "${item.sloName}"`)
    } else {
      results.push(`skipped ${item.flavor}-burn for "${item.sloName}"`)
    }
  }
  return results
}

function parseArgs(argv: string[]): { dryRun: boolean; json: boolean } {
  let dryRun = false
  let json = false
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--json') json = true
  }
  return { dryRun, json }
}

function renderText(plan: BurnAlertPlan, applied?: string[]): string {
  const lines: string[] = []
  lines.push('Burn-rate alerts:')
  for (const item of plan.items) {
    lines.push(
      `  [${item.action}] ${item.flavor}-burn for "${item.sloName}" — ${item.reason}`,
    )
  }
  if (plan.unresolvedSLOs.length > 0) {
    lines.push('Unresolved SLOs (run honeycomb:slos:deploy first):')
    for (const name of plan.unresolvedSLOs) lines.push(`  - ${name}`)
  }
  if (applied) {
    lines.push('Applied:')
    for (const r of applied) lines.push(`  ${r}`)
  }
  return lines.join('\n') + '\n'
}

if (import.meta.main) {
  const { dryRun, json } = parseArgs(process.argv.slice(2))
  const config = loadConfig(process.cwd())

  const [existingSLOs, existingAlerts] = await Promise.all([
    listSLOs(config),
    listBurnAlerts(config),
  ])
  const plan = planBurnAlertDeployment(
    STARTER_SLOS,
    existingSLOs,
    existingAlerts,
  )

  if (dryRun) {
    const out = { dryRun: true, dataset: config.dataset, plan }
    process.stdout.write(
      json ? JSON.stringify(out, null, 2) + '\n' : renderText(plan),
    )
    process.exit(0)
  }

  const applied = await applyPlan(config, plan)
  const out = { dryRun: false, dataset: config.dataset, plan, applied }
  process.stdout.write(
    json ? JSON.stringify(out, null, 2) + '\n' : renderText(plan, applied),
  )
}
