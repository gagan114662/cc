/**
 * Build-time substituted constants.
 *
 * The upstream build pipeline replaces `process.env.USER_TYPE` and
 * `process.env.NODE_ENV` with literal strings (`"external"`/`"ant"`,
 * `"production"`/`"test"`/`"development"`) during its intermediate compile
 * pass. The resulting .tsx files are then committed to this repo.
 *
 * We re-export those values through this module with an explicit `: string`
 * annotation rather than inlining `"external" as string` at every call site.
 * The annotation is load-bearing — without it TS narrows the value to the
 * singleton literal type and flags `USER_TYPE === 'ant'` as always false
 * (unreachable-branch error). Both branches must typecheck because the
 * alternative build flavour (ant) executes the other path; only dead-code
 * elimination at bundle time trims one branch per build.
 */

export const USER_TYPE: string = 'external'
export const NODE_ENV: string = 'production'
