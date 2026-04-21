/**
 * Phantom stub — `claude up` subcommand.
 *
 * ant-only (`USER_TYPE === 'ant'` gate in main.tsx:4386). Runs the
 * "# claude up" section of the nearest CLAUDE.md to bootstrap/upgrade
 * the local dev environment.
 *
 * Callsite (main.tsx:4390):
 *   const { up } = await import('src/cli/up.js')
 *   await up()
 */

import { USER_TYPE } from '../utils/buildConstants.js'

export async function up(): Promise<void> {
  throw new Error('not implemented')
}
