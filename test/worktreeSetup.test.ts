import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performPostCreationSetup } from 'src/utils/worktree.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir =>
      rm(dir, { recursive: true, force: true }),
    ),
  )
})

describe('worktree post-creation setup', () => {
  test('copies the parent .env and runs bin/setup_workspace with worktree context', async () => {
    const repoRoot = await createTempDir('cc-worktree-repo-')
    const parentWorktreePath = await createTempDir('cc-worktree-parent-')
    const worktreePath = await createTempDir('cc-worktree-child-')

    await writeFile(
      path.join(parentWorktreePath, '.env'),
      'DATABASE_URL=postgres://parent\n',
      'utf-8',
    )
    await mkdir(path.join(worktreePath, 'bin'), { recursive: true })
    await writeFile(
      path.join(worktreePath, 'bin', 'setup_workspace'),
      [
        '#!/usr/bin/env bash',
        'set -eu',
        'test -f "$CLAUDE_CODE_WORKTREE_PATH/.env"',
        'printf \'%s\\n\' "$CLAUDE_CODE_PARENT_WORKTREE_PATH" > "$CLAUDE_CODE_WORKTREE_PATH/parent-path.txt"',
        'printf \'%s\\n\' "$CLAUDE_CODE_REPO_ROOT" > "$CLAUDE_CODE_WORKTREE_PATH/repo-root.txt"',
        'printf \'%s\\n\' "$CLAUDE_CODE_WORKTREE_PATH" > "$CLAUDE_CODE_WORKTREE_PATH/worktree-path.txt"',
      ].join('\n'),
      'utf-8',
    )

    await performPostCreationSetup(repoRoot, worktreePath, parentWorktreePath)

    expect(await readFile(path.join(worktreePath, '.env'), 'utf-8')).toBe(
      'DATABASE_URL=postgres://parent\n',
    )
    expect(
      await readFile(path.join(worktreePath, 'parent-path.txt'), 'utf-8'),
    ).toBe(`${parentWorktreePath}\n`)
    expect(
      await readFile(path.join(worktreePath, 'repo-root.txt'), 'utf-8'),
    ).toBe(`${repoRoot}\n`)
    expect(
      await readFile(path.join(worktreePath, 'worktree-path.txt'), 'utf-8'),
    ).toBe(`${worktreePath}\n`)
  })

  test('surfaces setup script failures instead of silently leaving a half-ready worktree', async () => {
    const repoRoot = await createTempDir('cc-worktree-repo-')
    const worktreePath = await createTempDir('cc-worktree-child-')

    await mkdir(path.join(worktreePath, 'bin'), { recursive: true })
    await writeFile(
      path.join(worktreePath, 'bin', 'setup_workspace'),
      [
        '#!/usr/bin/env bash',
        'echo "setup failed" >&2',
        'exit 23',
      ].join('\n'),
      'utf-8',
    )

    await expect(
      performPostCreationSetup(repoRoot, worktreePath, repoRoot),
    ).rejects.toThrow('exit code 23')
  })
})
