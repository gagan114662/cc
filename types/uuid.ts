// Wider UUID alias used throughout the codebase. The upstream crypto module
// brands UUID as `${string}-${string}-${string}-${string}-${string}` which
// breaks every callsite that holds an unbranded string (message uuids,
// session ids, etc.). The runtime values are still RFC4122 strings; only
// the static type is widened.
export type UUID = string

// Re-export randomUUID so callers can switch entirely off `crypto` if they
// want a single import line. We cast to widen the return.
import { randomUUID as nodeRandomUUID } from 'crypto'
export const randomUUID = (): UUID => nodeRandomUUID() as UUID
