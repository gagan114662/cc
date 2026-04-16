#!/usr/bin/env bun

import { execa } from 'execa'

async function main(): Promise<void> {
  const result = await execa('git', ['config', 'core.hooksPath', '.githooks'], {
    reject: false,
  })
  if (result.exitCode === 0) {
    console.log('Configured git hooks path to .githooks')
    return
  }
  console.log('Skipping git hooks setup outside a writable git repo.')
}

await main()
