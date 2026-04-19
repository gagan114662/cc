# syntax=docker/dockerfile:1.7
# Multi-stage build for cc-rebuilt.
# Stage 1 installs deps with the full toolchain, stage 2 builds both
# bundles (CLI + daemon), stage 3 ships a minimal runtime image that only
# carries the two self-contained bundles — no host node_modules.

ARG BUN_VERSION=1.3.11

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build && bun run build:daemon

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CC_DAEMON_HTTP_PORT=8181
ENV CC_DAEMON_CLI_BUNDLE=/app/dist/cli.js

# Ship only the two bundles — they are self-contained and don't need
# host node_modules at runtime.
COPY --from=build /app/dist/cli.js ./dist/cli.js
COPY --from=build /app/dist/daemon.js ./dist/daemon.js
COPY --from=build /app/package.json ./package.json

# Non-root user. /app/.claude is the mount point for employee.json at
# runtime; bake an empty dir so the daemon can boot without a mount
# (health probe returns 0 duties, not an error).
RUN useradd -r -u 10001 -g root cc \
  && mkdir -p /app/.claude \
  && chown -R cc:root /app
USER cc

EXPOSE 8181

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.CC_DAEMON_HTTP_PORT || 8181) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "./dist/daemon.js"]
