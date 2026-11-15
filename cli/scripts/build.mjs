// Build script: compile TypeScript, then make sure the published entry point
// is a real executable with a shebang. npm only sets the mode on install, so
// the file on disk (and therefore in the tarball) must be 755 already.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHEBANG = '#!/usr/bin/env node\n'
const entry = join(root, 'dist', 'cli.js')

rmSync(join(root, 'dist'), { recursive: true, force: true })

const localTsc = join(root, 'node_modules', '.bin', 'tsc')
const tsc = existsSync(localTsc) ? localTsc : 'tsc'

const result = spawnSync(tsc, ['-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error(`failed to run tsc: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (!existsSync(entry)) {
  console.error(`expected build output at ${entry}`)
  process.exit(1)
}

// TypeScript preserves a leading shebang, but re-assert it so the build cannot
// silently ship a non-executable entry point.
const source = readFileSync(entry, 'utf8')
if (!source.startsWith('#!')) {
  writeFileSync(entry, SHEBANG + source)
}
chmodSync(entry, 0o755)

const mode = (readFileSync(entry, 'utf8').startsWith('#!') ? 'shebang ok' : 'shebang missing')
console.error(`build: dist/cli.js executable (mode 755, ${mode})`)
