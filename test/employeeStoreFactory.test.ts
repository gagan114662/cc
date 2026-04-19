// Factory dispatch — does CC_EMPLOYEE_BACKEND pick the right backend?
//
// Mirror of queueBackendFactory.test.ts. We don't exercise Postgres
// here (that's queueBackendRedis-style, guarded on DATABASE_URL). We
// only prove: env-var → module routing, case-insensitive match,
// typo-safe default to json, and singleton semantics.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetEmployeeStoreForTest,
  getEmployeeBackendKind,
  getEmployeeStore,
} from 'src/services/employeeStore/store.js'

const ORIGINAL_BACKEND = process.env.CC_EMPLOYEE_BACKEND
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL

beforeEach(() => {
  __resetEmployeeStoreForTest()
  delete process.env.CC_EMPLOYEE_BACKEND
  delete process.env.DATABASE_URL
})

afterEach(() => {
  __resetEmployeeStoreForTest()
  if (ORIGINAL_BACKEND === undefined) delete process.env.CC_EMPLOYEE_BACKEND
  else process.env.CC_EMPLOYEE_BACKEND = ORIGINAL_BACKEND
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
})

describe('employee store factory', () => {
  test('defaults to json when CC_EMPLOYEE_BACKEND is unset', async () => {
    expect(getEmployeeBackendKind()).toBe('json')
    const store = await getEmployeeStore()
    expect(store.kind).toBe('json')
  })

  test('defaults to json on unknown values (no silent upgrade to postgres)', async () => {
    // Typo-safety: an operator setting CC_EMPLOYEE_BACKEND=pg
    // (intending postgres) should NOT silently route to the
    // Postgres backend, which would then fail loudly on missing
    // DATABASE_URL during first use. We pin json-default so any
    // future "be helpful" change can't auto-promote typos.
    process.env.CC_EMPLOYEE_BACKEND = 'pg'
    __resetEmployeeStoreForTest()
    expect(getEmployeeBackendKind()).toBe('json')
    const store = await getEmployeeStore()
    expect(store.kind).toBe('json')
  })

  test('picks postgres when CC_EMPLOYEE_BACKEND=postgres (case-insensitive)', async () => {
    process.env.CC_EMPLOYEE_BACKEND = 'POSTGRES'
    // We don't set DATABASE_URL here — the factory returns the
    // backend object without opening a pool. Proving kind routing
    // is enough; real pool behavior is covered by
    // employeeStorePostgres.test.ts.
    __resetEmployeeStoreForTest()
    expect(getEmployeeBackendKind()).toBe('postgres')
    const store = await getEmployeeStore()
    expect(store.kind).toBe('postgres')
    await store.close()
  })

  test('returns the same instance across calls (singleton semantics)', async () => {
    const a = await getEmployeeStore()
    const b = await getEmployeeStore()
    expect(a).toBe(b)
  })
})
