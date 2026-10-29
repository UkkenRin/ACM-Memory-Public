// Two directions, both of which have already happened once.
//
// `test/memory-scope.mjs` and `test/mcp-discovery.mjs` were published and never run on the
// six legs; `test/package-public-sync.mjs` asked for a file the mirror does not ship and
// turned four legs red in four minutes. A check that only looks one way would have missed
// one of them.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'check-public-test-wiring.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'acm-wiring-'))
function caseFile(name, body) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body, null, 2))
  return path
}
function run(manifest, pkg) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--manifest', manifest, '--package', pkg], { encoding: 'utf8' })
    return { status: 0, out: stdout }
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// 1. Agreed: every published test is run, and nothing else is
{
  const manifest = caseFile('m-ok.json', { publicPaths: ['test/a.mjs', 'test/b.mjs', 'test/_helper.mjs', 'test/fixtures/stub.mjs', 'lib/x.mjs'] })
  const pkg = caseFile('p-ok.json', { scripts: { 'test:all': 'node scripts/check-syntax.mjs && node test/a.mjs && node test/b.mjs' } })
  const { status, out } = run(manifest, pkg)
  ok('a wired tree passes', status === 0, out.slice(-200))
  ok('and the report states how many tests it counted and where they came from',
    /2 published tests/.test(out) && out.includes(manifest), out.slice(0, 200))
}

// 2. Published, never run: the coverage gap
{
  const manifest = caseFile('m-gap.json', { publicPaths: ['test/a.mjs', 'test/forgotten.mjs'] })
  const pkg = caseFile('p-gap.json', { scripts: { 'test:all': 'node test/a.mjs' } })
  const { status, out } = run(manifest, pkg)
  ok('a published test that nothing runs fails the check', status === 1, `exit ${status}`)
  ok('and is named, not counted', out.includes('published but never run: test/forgotten.mjs'), out.slice(0, 300))
}

// 3. Run, not published: the red-leg-on-six-machines case
{
  const manifest = caseFile('m-missing.json', { publicPaths: ['test/a.mjs'] })
  const pkg = caseFile('p-missing.json', { scripts: { 'test:all': 'node test/a.mjs && node test/only-in-private.mjs' } })
  const { status, out } = run(manifest, pkg)
  ok('a script naming an unpublished test fails the check', status === 1, `exit ${status}`)
  ok('and is named with the reason it matters', out.includes('run but not published: test/only-in-private.mjs'), out.slice(0, 300))
}

// 4. Helpers are not tests: an underscore file or a fixture is exempt in both directions
{
  const manifest = caseFile('m-helper.json', { publicPaths: ['test/a.mjs', 'test/_writer.mjs', 'test/host-drill-child.mjs', 'test/fixtures/stub-mcp.mjs'] })
  const pkg = caseFile('p-helper.json', { scripts: { 'test:all': 'node test/a.mjs' } })
  const { status, out } = run(manifest, pkg)
  ok('imported helpers and child processes are not required to be run alone', status === 0, out.slice(-200))
}

// 5. A tree that is neither layout is refused, not guessed at
{
  const pkg = caseFile('p-noall.json', { scripts: {} })
  try {
    const out = execFileSync(process.execPath, [script, '--manifest', join(dir, 'nope.json'), '--package', pkg], { encoding: 'utf8' })
    ok('a missing manifest is refused', false, out.slice(0, 200))
  } catch (err) {
    ok('a missing manifest is refused instead of reported clean', (err.status ?? 1) === 2, `exit ${err.status}`)
  }
}

rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(failures.length
  ? `\nFAILED  ${pass} passed, ${failures.length} failed`
  : `\nALL GREEN  ${pass} passed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
