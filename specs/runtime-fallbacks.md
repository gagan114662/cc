# Optional Runtime Fallbacks

## overview
Optional native or external runtime dependencies must degrade safely when they are absent instead of crashing unrelated commands or UI flows.

## repl-bridge-state
Bootstrap state helpers must expose repl bridge state transitions through stable getter and setter behavior, with an inactive default.

## chrome-optional-runtime
Chrome MCP integration must report unavailability clearly and keep fallback browser tools available when the optional package is missing.

## color-diff-optional-runtime
Structured diff rendering must return safe fallback values when the optional native color module is unavailable.

## sandbox-optional-runtime
Sandbox helpers must expose safe fallback configs and violation stores when the optional sandbox runtime is unavailable.
