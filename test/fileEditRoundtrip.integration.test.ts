// Integration test for the FileEditTool apply/patch pipeline.
//
// End-to-end: writes a real file to a tmpdir, applies the
// exported applyEditToFile, writes the result back, reads it
// again, asserts the content matches what the patch-generation
// helpers also produce.
//
// Why integration, not unit: the utility module has several
// edit-replacement code paths (replaceAll, trailing-newline
// stripping, quote normalization). A unit test would only
// hit the function; this test hits the disk roundtrip, so a
// regression in path handling or IO ordering lights up here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyEditToFile,
  getPatchForEdit,
} from 'src/tools/FileEditTool/utils.js'

let workspace: string

beforeEach(async () => {
  workspace = path.join(
    tmpdir(),
    `cc-fileedit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('FileEditTool applyEditToFile — real-disk roundtrip', () => {
  test('replaces a single occurrence and writes back', async () => {
    const file = path.join(workspace, 'sample.ts')
    const original = [
      'export const greet = (name: string): string => {',
      '  return `hello, ${name}`',
      '}',
      '',
    ].join('\n')
    await writeFile(file, original, 'utf8')

    const onDisk = await readFile(file, 'utf8')
    const edited = applyEditToFile(onDisk, 'hello', 'hi')
    await writeFile(file, edited, 'utf8')

    const final = await readFile(file, 'utf8')
    expect(final).toContain('`hi, ${name}`')
    expect(final).not.toContain('`hello, ${name}`')
    // Ensure nothing else was mangled.
    expect(final.split('\n').length).toBe(original.split('\n').length)
  })

  test('replaceAll replaces every occurrence', () => {
    const original = 'foo bar foo baz foo'
    const edited = applyEditToFile(original, 'foo', 'qux', true)
    expect(edited).toBe('qux bar qux baz qux')
  })

  test('getPatchForEdit returns a patch whose application matches applyEditToFile', () => {
    const filePath = path.join(workspace, 'patchcheck.txt')
    const originalContent = 'line one\nline two\nline three\n'
    const oldString = 'line two'
    const newString = 'line 2 (edited)'

    const direct = applyEditToFile(originalContent, oldString, newString)

    // The patch helper should describe the same edit. We don't care
    // about the exact patch-format string here — we care that the
    // helper agrees on the post-edit state.
    const { updatedFile } = getPatchForEdit({
      filePath,
      fileContents: originalContent,
      oldString,
      newString,
      replaceAll: false,
    })

    expect(updatedFile).toBe(direct)
    expect(updatedFile).toContain('line 2 (edited)')
    expect(updatedFile).not.toContain('line two')
  })

  test('stripTrailingNewline path: old string without trailing newline, content has one', () => {
    const content = 'alpha\nbeta\n'
    // Deleting 'beta' with empty newString should strip its trailing \n.
    const edited = applyEditToFile(content, 'beta', '')
    expect(edited).toBe('alpha\n')
  })
})
