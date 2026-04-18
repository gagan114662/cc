import path from 'node:path'
import {
  readHarnessRunnerEntry,
  readHarnessRunnerManifest,
} from 'src/services/harness/runners.js'

function usage(): never {
  console.error(
    'Usage: bun ./scripts/harnessRunnerManifest.ts list [--ids] | get <runner-id> [--field id|agentKind|slotCapacity|labelsCsv|labelsJson]',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const repoRoot = path.resolve(import.meta.dir, '..')

  if (command === 'list') {
    const manifest = await readHarnessRunnerManifest(repoRoot)
    if (args.includes('--ids')) {
      console.log(manifest.runners.map(runner => runner.id).join('\n'))
      return
    }
    console.log(JSON.stringify(manifest, null, 2))
    return
  }

  if (command === 'get') {
    const runnerId = args[0]
    if (!runnerId) {
      usage()
    }
    const fieldFlagIndex = args.findIndex(arg => arg === '--field')
    const field = fieldFlagIndex >= 0 ? args[fieldFlagIndex + 1] : undefined
    const runner = await readHarnessRunnerEntry(repoRoot, runnerId)
    if (!runner) {
      console.error(`Unknown harness runner: ${runnerId}`)
      process.exit(1)
    }
    switch (field) {
      case undefined:
        console.log(JSON.stringify(runner, null, 2))
        return
      case 'id':
        console.log(runner.id)
        return
      case 'agentKind':
        console.log(runner.agentKind)
        return
      case 'slotCapacity':
        console.log(String(runner.slotCapacity))
        return
      case 'labelsCsv':
        console.log(runner.labels.join(','))
        return
      case 'labelsJson':
        console.log(JSON.stringify(runner.labels))
        return
      default:
        usage()
    }
  }

  usage()
}

await main()
