#!/usr/bin/env bun
// Idempotently deploys services/observability/slos.ts to Honeycomb.
//
// Before this, slos.ts was a declarative registry that nothing read —
// the 3 SLOs never materialized in Honeycomb, so no dashboards, no
// burn-rate alerts. This script creates them (and the SLI derived
// columns they depend on) and updates them when the registry drifts.
//
// Auth: reads .claude/settings.local.json the same way honeycombVerify
// does, then requires HONEYCOMB_CONFIG_KEY in env (a management-tier key
// — the ingest key does not have slo/derived-column write scopes).
//
// Safe to re-run: diff against /1/slos/:dataset and /1/derived_columns
// decides per-SLO whether to POST, PATCH, or skip. --dry-run prints the
// plan without any writes.

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

export type DerivedColumnPayload = {
  alias: string
  expression: string
  description: string
}

export type SLOPayload = {
  name: string
  description: string
  sli: { alias: string }
  time_period_days: number
  target_per_million: number
}

export type DeployPlan = {
  derivedColumns: Array<{
    action: 'create' | 'update' | 'skip'
    payload: DerivedColumnPayload
    existingId?: string
    reason: string
  }>
  slos: Array<{
    action: 'create' | 'update' | 'skip'
    payload: SLOPayload
    existingId?: string
    reason: string
  }>
}

export type ExistingResource = {
  id: string
  name?: string
  alias?: string
  expression?: string
  description?: string
  target_per_million?: number
  time_period_days?: number
  sli?: { alias?: string }
}

export function sliAliasFor(slo: SLODefinition): string {
  return `sli.${slo.id}`
}

export function buildDerivedColumnPayload(
  slo: SLODefinition,
): DerivedColumnPayload {
  return {
    alias: sliAliasFor(slo),
    expression: slo.sli,
    description: `SLI for ${slo.name}. Auto-generated from services/observability/slos.ts — edit there, not in Honeycomb.`,
  }
}

export function buildSLOPayload(slo: SLODefinition): SLOPayload {
  return {
    name: slo.name,
    description: slo.description,
    sli: { alias: sliAliasFor(slo) },
    time_period_days: slo.windowDays,
    target_per_million: Math.round(slo.target * 1_000_000),
  }
}

function derivedColumnNeedsUpdate(
  existing: ExistingResource,
  next: DerivedColumnPayload,
): boolean {
  return (
    existing.expression !== next.expression ||
    existing.description !== next.description
  )
}

function sloNeedsUpdate(existing: ExistingResource, next: SLOPayload): boolean {
  return (
    existing.name !== next.name ||
    existing.description !== next.description ||
    existing.target_per_million !== next.target_per_million ||
    existing.time_period_days !== next.time_period_days ||
    existing.sli?.alias !== next.sli.alias
  )
}

export function planDeployment(
  slos: readonly SLODefinition[],
  existingDerived: ExistingResource[],
  existingSLOs: ExistingResource[],
): DeployPlan {
  const derivedByAlias = new Map(
    existingDerived.filter(d => d.alias).map(d => [d.alias as string, d]),
  )
  const slosByName = new Map(
    existingSLOs.filter(s => s.name).map(s => [s.name as string, s]),
  )

  const plan: DeployPlan = { derivedColumns: [], slos: [] }

  for (const slo of slos) {
    const derivedPayload = buildDerivedColumnPayload(slo)
    const sloPayload = buildSLOPayload(slo)

    const existingDerivedRow = derivedByAlias.get(derivedPayload.alias)
    if (!existingDerivedRow) {
      plan.derivedColumns.push({
        action: 'create',
        payload: derivedPayload,
        reason: `no existing derived column matches alias "${derivedPayload.alias}"`,
      })
    } else if (derivedColumnNeedsUpdate(existingDerivedRow, derivedPayload)) {
      plan.derivedColumns.push({
        action: 'update',
        payload: derivedPayload,
        existingId: existingDerivedRow.id,
        reason: 'expression or description drifted from registry',
      })
    } else {
      plan.derivedColumns.push({
        action: 'skip',
        payload: derivedPayload,
        existingId: existingDerivedRow.id,
        reason: 'derived column in sync with registry',
      })
    }

    const existingSLO = slosByName.get(sloPayload.name)
    if (!existingSLO) {
      plan.slos.push({
        action: 'create',
        payload: sloPayload,
        reason: `no existing SLO named "${sloPayload.name}"`,
      })
    } else if (sloNeedsUpdate(existingSLO, sloPayload)) {
      plan.slos.push({
        action: 'update',
        payload: sloPayload,
        existingId: existingSLO.id,
        reason: 'target, window, description, or SLI alias drifted from registry',
      })
    } else {
      plan.slos.push({
        action: 'skip',
        payload: sloPayload,
        existingId: existingSLO.id,
        reason: 'SLO in sync with registry',
      })
    }
  }

  return plan
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
  const apiBaseUrl =
    env.HONEYCOMB_API_BASE_URL ?? 'https://api.honeycomb.io'
  const dataset = env.HONEYCOMB_DATASET
  const configKey =
    process.env.HONEYCOMB_CONFIG_KEY ?? env.HONEYCOMB_CONFIG_KEY ?? ''
  if (!dataset) {
    throw new Error(
      'HONEYCOMB_DATASET missing from .claude/settings.local.json — configure it before deploying SLOs.',
    )
  }
  if (!configKey) {
    throw new Error(
      'HONEYCOMB_CONFIG_KEY missing. Export a management-tier API key — ingest keys cannot create derived columns or SLOs.',
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
    throw new Error(`${method} ${pathSuffix} → ${res.status}: ${text.slice(0, 400)}`)
  }
  return (await res.json()) as T
}

async function listDerivedColumns(
  config: HoneycombConfig,
): Promise<ExistingResource[]> {
  return hc(config, 'GET', `/1/derived_columns/${config.dataset}`)
}

async function listSLOs(config: HoneycombConfig): Promise<ExistingResource[]> {
  return hc(config, 'GET', `/1/slos/${config.dataset}`)
}

async function applyPlan(
  config: HoneycombConfig,
  plan: DeployPlan,
): Promise<{ derivedColumns: string[]; slos: string[] }> {
  const derivedResults: string[] = []
  for (const item of plan.derivedColumns) {
    if (item.action === 'create') {
      await hc(config, 'POST', `/1/derived_columns/${config.dataset}`, item.payload)
      derivedResults.push(`created ${item.payload.alias}`)
    } else if (item.action === 'update' && item.existingId) {
      await hc(
        config,
        'PATCH',
        `/1/derived_columns/${config.dataset}/${item.existingId}`,
        item.payload,
      )
      derivedResults.push(`updated ${item.payload.alias}`)
    } else {
      derivedResults.push(`skipped ${item.payload.alias}`)
    }
  }

  const sloResults: string[] = []
  for (const item of plan.slos) {
    if (item.action === 'create') {
      await hc(config, 'POST', `/1/slos/${config.dataset}`, item.payload)
      sloResults.push(`created ${item.payload.name}`)
    } else if (item.action === 'update' && item.existingId) {
      await hc(
        config,
        'PATCH',
        `/1/slos/${config.dataset}/${item.existingId}`,
        item.payload,
      )
      sloResults.push(`updated ${item.payload.name}`)
    } else {
      sloResults.push(`skipped ${item.payload.name}`)
    }
  }

  return { derivedColumns: derivedResults, slos: sloResults }
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

if (import.meta.main) {
  const { dryRun, json } = parseArgs(process.argv.slice(2))
  const config = loadConfig(process.cwd())

  const [existingDerived, existingSLOs] = await Promise.all([
    listDerivedColumns(config),
    listSLOs(config),
  ])
  const plan = planDeployment(STARTER_SLOS, existingDerived, existingSLOs)

  if (dryRun) {
    const out = { dryRun: true, dataset: config.dataset, plan }
    process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : renderText(plan))
    process.exit(0)
  }

  const applied = await applyPlan(config, plan)
  const out = { dryRun: false, dataset: config.dataset, plan, applied }
  process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : renderText(plan, applied))
}

function renderText(
  plan: DeployPlan,
  applied?: { derivedColumns: string[]; slos: string[] },
): string {
  const lines: string[] = []
  lines.push('Derived columns:')
  for (const item of plan.derivedColumns) {
    lines.push(`  [${item.action}] ${item.payload.alias} — ${item.reason}`)
  }
  lines.push('SLOs:')
  for (const item of plan.slos) {
    lines.push(`  [${item.action}] ${item.payload.name} — ${item.reason}`)
  }
  if (applied) {
    lines.push('Applied:')
    for (const r of applied.derivedColumns) lines.push(`  ${r}`)
    for (const r of applied.slos) lines.push(`  ${r}`)
  }
  return lines.join('\n') + '\n'
}
