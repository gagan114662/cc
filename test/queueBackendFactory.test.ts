// Factory dispatch — does CC_QUEUE_BACKEND pick the right backend?
//
// We don't care here what the Redis backend does in practice (that's
// covered by queueBackendRedis.test.ts, which is skipIf no Redis
// available). We only need to prove the factory routes env-var ->
// module correctly, and that the default is JSONL.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetQueueBackendForTest,
  getQueueBackend,
  getQueueBackendKind,
} from 'src/services/assignmentQueue/backend.js'

const ORIGINAL_BACKEND = process.env.CC_QUEUE_BACKEND
const ORIGINAL_REDIS_URL = process.env.REDIS_URL

beforeEach(() => {
  __resetQueueBackendForTest()
  delete process.env.CC_QUEUE_BACKEND
  delete process.env.REDIS_URL
})

afterEach(() => {
  __resetQueueBackendForTest()
  if (ORIGINAL_BACKEND === undefined) delete process.env.CC_QUEUE_BACKEND
  else process.env.CC_QUEUE_BACKEND = ORIGINAL_BACKEND
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL
})

describe('queue backend factory', () => {
  test('defaults to jsonl when CC_QUEUE_BACKEND is unset', async () => {
    expect(getQueueBackendKind()).toBe('jsonl')
    const backend = await getQueueBackend()
    expect(backend.kind).toBe('jsonl')
  })

  test('defaults to jsonl on unknown values (no silent upgrade to redis)', async () => {
    // Typo-safety: if an operator sets CC_QUEUE_BACKEND=redis-cluster
    // (intending redis), we should not silently fall back to jsonl
    // without flagging it. Current behavior: non-"redis" → jsonl,
    // which is safe. This test pins that so a future "be helpful"
    // change can't auto-promote typos to redis.
    process.env.CC_QUEUE_BACKEND = 'sqs'
    __resetQueueBackendForTest()
    expect(getQueueBackendKind()).toBe('jsonl')
    const backend = await getQueueBackend()
    expect(backend.kind).toBe('jsonl')
  })

  test('picks redis when CC_QUEUE_BACKEND=redis (case-insensitive)', async () => {
    process.env.CC_QUEUE_BACKEND = 'REDIS'
    process.env.REDIS_URL = 'redis://localhost:6379'
    __resetQueueBackendForTest()
    expect(getQueueBackendKind()).toBe('redis')
    // We don't actually create a Redis connection here — factory
    // returns the backend object, which only opens connections on
    // first enqueue/drain. Proving the kind is enough for routing.
    const backend = await getQueueBackend()
    expect(backend.kind).toBe('redis')
    await backend.close()
  })

  test('returns the same instance across calls (singleton semantics)', async () => {
    const a = await getQueueBackend()
    const b = await getQueueBackend()
    expect(a).toBe(b)
  })
})
