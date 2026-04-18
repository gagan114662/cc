# Hosted Harness Control Plane

This repo can run the hosted harness control plane locally with Postgres and Redis instead of the filesystem fallback.

## One-time local setup

Run:

```bash
./bin/setup_harness_control_plane
```

That command:

- starts Postgres on `127.0.0.1:54329`
- starts Redis on `127.0.0.1:63879`
- writes `.claude/harness.control-plane.env`

Then load the env file into your shell:

```bash
source ./.claude/harness.control-plane.env
```

Verify that the harness is really using the hosted backend:

```bash
bun ./entrypoints/cli.tsx harness status --json
```

The status payload should show:

```json
{
  "controlPlane": {
    "kind": "postgres-redis"
  }
}
```

## Package shortcuts

You can also use:

```bash
bun run harness:control-plane:setup
bun run harness:control-plane:status
bun run harness:control-plane:doctor
bun run harness:control-plane:down
```

## Shared / Always-On Setup

When you want multiple machines to share one harness queue:

1. Provision shared Postgres and Redis.
2. Export the shared URLs in your shell:

```bash
export CLAUDE_CODE_HARNESS_POSTGRES_URL='postgres://...'
export CLAUDE_CODE_HARNESS_REDIS_URL='redis://...'
export CLAUDE_CODE_HARNESS_TENANT_ID='your-org-or-team'
export CLAUDE_CODE_HARNESS_WORKERS='50'
```

3. Run:

```bash
./bin/setup_shared_harness_control_plane
```

That writes `.claude/harness.control-plane.shared.env` and verifies the shared backend with a real Postgres probe, Redis probe, and Redis lease test.

4. On each runner machine:

```bash
source ./.claude/harness.control-plane.shared.env
./bin/start_shared_harness_daemon --runner claude-primary
./bin/start_shared_harness_daemon --runner codex-primary
```

5. Verify:

```bash
bun ./entrypoints/cli.tsx daemon status --json
```

The status payload should show `"controlPlane": { "kind": "postgres-redis" }`, plus registered runners and slot capacity by agent kind. Every runner using the same tenant id will share the same queue and lease space.

## launchd Worker Management

On this Mac, you can keep the shared harness alive without an open terminal:

```bash
./bin/install_shared_harness_launch_agents
./bin/status_shared_harness_launch_agents
```

That installs one LaunchAgent per named runner from `.claude/harness.runners.json` and keeps it alive with `KeepAlive=true`. Each runner service then spawns its own worker children, so the shared fleet is runner-first instead of worker-number based. The daemon and harness status payloads now surface expected vs registered runners, Claude vs Codex slot capacity, queued capacity shortfalls, and internal-versus-Honeycomb observability health.

To remove them:

```bash
./bin/uninstall_shared_harness_launch_agents
```

## Honeycomb Observability

Browser login is enough to bootstrap OTLP export on this Mac if you use the Chrome helper. The harness still needs a Honeycomb ingest key under the hood, and query verification remains richer when you also provide a query key.

Fastest path if you are already signed into Honeycomb in Chrome:

```bash
./bin/setup_harness_observability_from_chrome
```

Manual path when you already have the keys in your shell:

```bash
export HONEYCOMB_INGEST_KEY='...'
export HONEYCOMB_QUERY_KEY='...'
export HONEYCOMB_DATASET='cc-harness'
./bin/setup_harness_observability
```

That writes `.claude/harness.observability.env`, which the launchd workers will source automatically.

If the launchd workers are already running, restart them so the new OTLP env is picked up:

```bash
bun run harness:service:restart
```

Verification flow:

```bash
source ./.claude/harness.observability.env
bun run harness:observability:doctor
bun run harness:observability:smoke
```

The harness now emits dedicated wide events for:

- poll snapshots
- job leasing
- job outcomes
- webhook ingestion
- repo pause/resume
- worker lifecycle
- control-plane doctor results

## Environment variables

The harness switches to hosted mode when these are set:

- `CLAUDE_CODE_HARNESS_CONTROL_PLANE_BACKEND=postgres-redis`
- `CLAUDE_CODE_HARNESS_POSTGRES_URL`
- `CLAUDE_CODE_HARNESS_REDIS_URL`
- `CLAUDE_CODE_HARNESS_TENANT_ID`

Use the same `CLAUDE_CODE_HARNESS_TENANT_ID` across workers that should share the same queue and lease space.

## Notes

- Filesystem mode remains as an explicit degraded fallback for offline or local-only development.
- `./bin/stop_harness_control_plane` shuts the local services down.
- If you already run Postgres or Redis locally on those ports, override `CLAUDE_CODE_HARNESS_POSTGRES_PORT` or `CLAUDE_CODE_HARNESS_REDIS_PORT` before running setup.
- `bun run harness:control-plane:doctor` is the fastest way to prove a shared backend is reachable before you start workers.
- Honeycomb query access is optional for readiness. Internal hosted readback is the source of truth; Honeycomb export stays a sink.
