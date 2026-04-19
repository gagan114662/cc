// JSONL queue backend (the default, zero-infra implementation).
//
// Thin adapter over the existing storage.ts + drainer.ts modules.
// The JSONL layer hasn't changed — this wrapper just exposes it
// through the QueueBackend contract so daemon + routes can speak
// to either backend without branching.

import { drainOnce } from '../drainer.js'
import {
  enqueueAssignment,
  recoverCrashedAssignments,
} from '../storage.js'
import type { QueueBackend } from '../backend.js'

export function createJsonlQueueBackend(): QueueBackend {
  return {
    kind: 'jsonl',
    async enqueue(input, ctx) {
      await enqueueAssignment(input, {
        projectRoot: ctx.projectRoot,
        tenantId: ctx.tenantId,
      })
    },
    async drainOnce(opts) {
      await drainOnce(opts)
    },
    async recover(ctx) {
      return recoverCrashedAssignments(ctx.projectRoot, ctx.tenantId)
    },
    async close() {
      // Nothing to release — JSONL owns no long-lived resources.
    },
  }
}
