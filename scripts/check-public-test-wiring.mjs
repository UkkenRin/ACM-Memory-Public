/**
 * A published test that nothing runs is not coverage.
 *
 * The release gate moved verification to the public mirror, where standard runners are free and
 * `ci-public.yml` runs six legs. That promise has a hole nobody was checking: the mirror
 * runs `package.json`'s `test:all`, which is generated from the private
 * `package.public.json`, and **that file lists its own set of tests**. A test can be
 * classified public, exported, and readable in the mirror while no script ever invokes it -
 * in which case six green legs mean six legs of an older subset.
 *
 * That is exactly what happened. `test/memory-scope.mjs` was published in batch 24 and
 * `test/mcp-discovery.mjs` in batch 28, and neither appeared in the public `test:all`;
 * five older ones (`capabilities`, `tool-read-gate`, `sdk-boundary`, `export-containment`,
 * `host-startup-side-effects`) were in the same state. Seven published tests had never run
 * on Windows or macOS. The audit found the two newest by comparing the two package files,
 * which is a comparison a script should make.
 *
 * So this checks both directions:
 *
 *   1. **published but never run** - the coverage gap above;
 *   2. **run but not published** - a script that names `test/foo.mjs` the mirror does not
 *      ship dies with ENOENT on all six legs - the same shape as the mirror test that
 *      asked for a file the mirror does not ship.
 *
 * It reads whichever layout it is in. In the private tree the classification lives in
 * `public-manifest.json` and the public scripts in `package.public.json`; in the mirror
 * there is no `public-manifest.json` (deliberately) and the scripts are `package.json`, so
 * the file list comes from `export-manifest.json` instead. A tree that matches neither is
 * refused rather than assumed fine.
 *
 * Usage:
 *   node scripts/check-public-test-wiring.mjs
 *   node scripts/check-public-test-wiring.mjs --manifest <path> --package <path>
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : null
}

/** Files that are helpers, not tests: they are imported or spawned, never run alone. */
const isAuxiliary = (p) => {
  const name = basename(p)
  return name.startsWith('_') || p.includes('/fixtures/') || name.endsWith('-child.mjs')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The list of test files a tree says it publishes. */
function publishedTests() {
  const explicit = argOf('manifest')
  if (explicit) return { files: readJson(explicit).publicPaths ?? [], from: explicit }

  const manifestPath = join(root, 'public-manifest.json')
  if (existsSync(manifestPath)) {
    return { files: readJson(manifestPath).publicPaths ?? [], from: 'public-manifest.json' }
  }
  const exportPath = join(root, 'export-manifest.json')
  if (existsSync(exportPath)) {
    return { files: Object.keys(readJson(exportPath).files ?? {}), from: 'export-manifest.json' }
  }
  throw new Error('no public-manifest.json and no export-manifest.json: cannot tell which tree this is')
}

/** The commands a tree's `test:all` actually runs. */
function wiredTests() {
  const explicit = argOf('package')
  const path = explicit ?? (existsSync(join(root, 'package.public.json'))
    ? join(root, 'package.public.json')
    : join(root, 'package.json'))
  const pkg = readJson(path)
  const script = pkg.scripts?.['test:all']
  if (typeof script !== 'string') throw new Error(`${path} has no scripts["test:all"]`)
  const run = new Set()
  for (const m of script.matchAll(/node\s+(test\/[^\s&|]+\.mjs)/g)) run.add(m[1])
  return { run, from: path }
}

let published
let wired
try {
  published = publishedTests()
  wired = wiredTests()
} catch (err) {
  console.error(`public test wiring: ${err.message}`)
  process.exit(2)
}

const publicTests = new Set(
  published.files.filter((f) => /^test\/.*\.mjs$/.test(f) && !isAuxiliary(f)),
)

const problems = []
for (const t of [...publicTests].sort()) {
  if (!wired.run.has(t)) problems.push(`published but never run: ${t}`)
}
for (const t of [...wired.run].sort()) {
  if (!publicTests.has(t) && !published.files.includes(t)) problems.push(`run but not published: ${t}`)
}

if (problems.length) {
  console.error(`public test wiring failed (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(`\nPublic tests come from ${published.from}, commands from ${wired.from}.`)
  console.error('A published test that no script runs is not coverage; a script that runs an')
  console.error('unpublished test is a red leg on six machines.')
  process.exitCode = 1
} else {
  console.log(`public test wiring passed (${publicTests.size} published tests, all in test:all)`)
  console.log(`  tests from ${published.from}, commands from ${wired.from}`)
}
