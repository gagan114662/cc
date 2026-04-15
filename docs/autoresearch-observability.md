# Autoresearch Observability

This repo sends autoresearch telemetry through the existing OpenTelemetry OTLP path. Honeycomb is the backend only when the runtime OTLP environment variables point at Honeycomb.

## Connection Path

- Telemetry starts in [entrypoints/init.ts](/Users/gaganarora/Desktop/my%20projects/cc/entrypoints/init.ts).
- OTLP exporter setup lives in [utils/telemetry/instrumentation.ts](/Users/gaganarora/Desktop/my%20projects/cc/utils/telemetry/instrumentation.ts).
- Structured event emission lives in [utils/telemetry/events.ts](/Users/gaganarora/Desktop/my%20projects/cc/utils/telemetry/events.ts).
- Autoresearch lifecycle and scorecard events live in [services/autoresearch/runtime.ts](/Users/gaganarora/Desktop/my%20projects/cc/services/autoresearch/runtime.ts).
- Splitter topology and work-item mapping live in [services/autoresearch/splitter.ts](/Users/gaganarora/Desktop/my%20projects/cc/services/autoresearch/splitter.ts).

## Runtime Env

Use OTLP to point the harness at Honeycomb:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=true
export OTEL_SERVICE_NAME="cc-harness"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io:443"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_API_KEY,x-honeycomb-dataset=cc-harness"
```

If you use the EU region, switch the endpoint to `https://api.eu1.honeycomb.io:443`.

For this repo, the local non-checked-in settings entrypoint is [settings.local.json](/Users/gaganarora/Desktop/my%20projects/cc/.claude/settings.local.json). A repeatable smoke path is available through `bun run smoke:honeycomb`, which loads the local env, runs an autoresearch cycle, emits `autoresearch_honeycomb_smoke`, and flushes telemetry.

Use two keys:

- `HONEYCOMB_INGEST_KEY` for OTLP export.
- `HONEYCOMB_QUERY_KEY` for verification scripts and Honeycomb query access.

Honeycomb verification needs a **configuration key** with query permissions. An ingest key can send telemetry, but it cannot inspect datasets.

The repo also records real Claude Code usage into the autoresearch state directory through [autoresearchSessionObservation.ts](/Users/gaganarora/Desktop/my%20projects/cc/.claude/hooks/autoresearchSessionObservation.ts). Use `bun run autoresearch:status` for a local, non-Honeycomb trend summary based on those recorded sessions.

For Honeycomb-side verification:

- `bun run honeycomb:verify`
  prints a machine-readable summary of whether Honeycomb can see the autoresearch and Claude-session events.
- `bun run honeycomb:proof`
  writes [honeycomb-autoresearch-proof.html](/Users/gaganarora/Desktop/my%20projects/cc/honeycomb-autoresearch-proof.html) with an HTML proof report grounded in Honeycomb query results.

## Event Families

These are the main event names emitted by autoresearch:

- `autoresearch_splitter_topology_loaded`
- `autoresearch_benchmark_admitted`
- `autoresearch_case_result`
- `autoresearch_challenge_result`
- `autoresearch_experiment_scored`
- `autoresearch_dogfood_observation`
- `autoresearch_claude_code_session_observed`
- `autoresearch_claude_code_trend_snapshot`
- `autoresearch_teacher_audit_opened`
- `autoresearch_teacher_audit_resolved`
- `autoresearch_lane_transition`
- `autoresearch_rollback_triggered`
- `autoresearch_cycle_completed`
- `autoresearch_control_plane_snapshot`
- `autoresearch_cycle_failed`

## Core Fields

Use these field groups as the backbone of the Honeycomb UI:

- Control plane:
  `autoresearch.repo`,
  `autoresearch.corpus_version`,
  `autoresearch.challenge_set_version`,
  `autoresearch.teacher_frozen`,
  `autoresearch.teacher_quality_verdict`,
  `autoresearch.open_audit_count`,
  `autoresearch.current_champion_candidate_id`
- Learning:
  `autoresearch.current_mistake_count`,
  `autoresearch.new_mistake_count`,
  `autoresearch.fixed_mistake_count`,
  `autoresearch.repeated_mistake_count`,
  `autoresearch.current_mistake_tags`,
  `autoresearch.new_mistake_tags`,
  `autoresearch.fixed_mistake_tags`,
  `autoresearch.repeated_mistake_tags`
- Claude Code session learning:
  `autoresearch.claude_code_total_session_count`,
  `autoresearch.claude_code_success_session_count`,
  `autoresearch.claude_code_regression_session_count`,
  `autoresearch.claude_code_high_confidence_regression_session_count`,
  `autoresearch.claude_code_current_mistake_tags`,
  `autoresearch.claude_code_new_mistake_tags`,
  `autoresearch.claude_code_fixed_mistake_tags`,
  `autoresearch.claude_code_repeated_mistake_tags`,
  `autoresearch.claude_code_session_id`,
  `autoresearch.claude_code_event_type`,
  `autoresearch.claude_code_failure_tags`,
  `autoresearch.claude_code_heuristic_confidence`
- Scorecards:
  `autoresearch.task_success_rate`,
  `autoresearch.artifact_validity_rate`,
  `autoresearch.unsupported_claim_rate`,
  `autoresearch.verifier_bypass_rate`,
  `autoresearch.phase_violation_rate`,
  `autoresearch.missing_evidence_completion_rate`,
  `autoresearch.challenge_set_catch_rate`,
  `autoresearch.hidden_holdout_predictive_accuracy`,
  `autoresearch.dogfood_miss_rate`,
  `autoresearch.token_cost_delta_pct`,
  `autoresearch.runtime_delta_pct`
- Rollout:
  `autoresearch.lane`,
  `autoresearch.promotion_decision`,
  `autoresearch.promotion_target_lane`,
  `autoresearch.rollback_reason`,
  `autoresearch.rollback_lane`
- Splitter:
  `autoresearch.splitter_enabled`,
  `autoresearch.splitter_execution_mode`,
  `autoresearch.splitter_service_id`,
  `autoresearch.splitter_region`,
  `autoresearch.splitter_domain`,
  `autoresearch.splitter_domain_type`,
  `autoresearch.splitter_workstream`,
  `autoresearch.splitter_work_item_id`,
  `autoresearch.splitter_shard_key`

## Honeycomb Board

Create one dedicated board for the harness and add these sections:

- Learning Overview
  Filter to `event.name = autoresearch_control_plane_snapshot`.
  Plot `autoresearch.new_mistake_count`, `autoresearch.fixed_mistake_count`, and `autoresearch.repeated_mistake_count` over time.
- Claude Code Learning
  Filter to `autoresearch_claude_code_trend_snapshot` and `autoresearch_claude_code_session_observed`.
  Plot `autoresearch.claude_code_new_mistake_tags`, `autoresearch.claude_code_fixed_mistake_tags`, and `autoresearch.claude_code_regression_session_count` over time, and break down session events by `autoresearch.claude_code_event_type`.
- Teacher Health
  Filter to `autoresearch_teacher_audit_opened`, `autoresearch_teacher_audit_resolved`, `autoresearch_cycle_completed`.
  Break down by `autoresearch.audit_reason` and `autoresearch.teacher_quality_verdict`.
- Promotion Funnel
  Filter to `autoresearch_experiment_scored`, `autoresearch_lane_transition`, `autoresearch_rollback_triggered`.
  Break down by `autoresearch.promotion_decision` and `autoresearch.lane`.
- Trust Guardrails
  Filter to `autoresearch_experiment_scored`.
  Visualize `unsupported_claim_rate`, `verifier_bypass_rate`, `phase_violation_rate`, and `missing_evidence_completion_rate`.
- Benchmark Quality
  Filter to `autoresearch_benchmark_admitted`, `autoresearch_case_result`, `autoresearch_challenge_result`.
  Break down by `autoresearch.benchmark_tier`, `autoresearch.case_passed`, and `autoresearch.challenge_caught`.
- Splitter Topology
  Filter to `autoresearch_splitter_topology_loaded`, `autoresearch_case_result`, `autoresearch_dogfood_observation`.
  Break down by `autoresearch.splitter_domain`, `autoresearch.splitter_domain_type`, and `autoresearch.splitter_workstream`.

## Triggers

Set Honeycomb triggers for:

- any `autoresearch_teacher_audit_opened`
- any `autoresearch_rollback_triggered`
- any `autoresearch.teacher_frozen = true`
- any `autoresearch.new_mistake_count > 0` while `autoresearch.lane` is `dogfood` or `canary`
- any `event.name = autoresearch_claude_code_session_observed` where `autoresearch.claude_code_actual_regression = true`
- any `event.name = autoresearch_claude_code_trend_snapshot` where `autoresearch.claude_code_new_mistake_tags != ""`
- any `autoresearch.challenge_set_catch_rate < 1`
- any `autoresearch.hidden_holdout_predictive_accuracy < 1`

## SLOs

Create SLOs on the trusted-output metrics:

- unsupported-claim rate remains `0`
- verifier-bypass rate remains `0`
- phase-violation rate remains `0`
- missing-evidence completion rate remains `0`
- challenge-set catch rate remains `1`
- hidden-holdout predictive accuracy remains `1`
- dogfood miss rate remains `0`

## Splitter Topology

The current config in [autoresearch.config.json](/Users/gaganarora/Desktop/my%20projects/cc/autoresearch.config.json) maps work like this:

- `eval-tasks`
  `global` domain for candidate-by-case benchmark execution.
- `benchmark-admission`
  `global` domain for proposal replay and benchmark admission.
- `dogfood-observations`
  `regional` domain for transcript mining and dogfood regressions.
- `promotion-controller`
  `unit` domain for singleton promotion and rollback control.

This repo is currently in `topology_only` mode. That means the runtime emits Splitter-compatible ownership metadata now, but it does not yet talk to a live Splitter coordinator.
