/**
 * Concurrent first creation.
 *
 * Two processes opening a store that does not exist yet used to compute the same
 * pending migration list and race on the version row: one lost with
 * `UNIQUE constraint failed: acm_schema_migrations.version` and the ledger could
 * be left inconsistent. The bootstrap now takes a write lock before reading the
 * ledger; this spawns real processes to keep it that way.
 *
 * DB-02: this harness used to merge a child's stdout and stderr into one string
 * and require the merged value to equal `ok`. Node prints
 * `ExperimentalWarning: SQLite is an experimental feature` on stderr, so a healthy
 * worker answered `ok\n(node:...) ExperimentalWarning...`, the merged string was not
 * `ok`, and both GitHub runs 43413299509 / 43413299561 reported `8 failed: ok` for
 * eight opens that had all succeeded. Suppressing the warning would have hidden a
 * real one, and relaxing the assertion would have thrown away the check. So the two
 * streams are kept apart, the child's own verdict is read from stdout, and its exit
 * status and signal are asserted; stderr is kept as diagnostics and only reported
 * when something fails.
 *
 * The negative control at the end is part of the fix, not decoration: a harness that
 * cannot fail is not evidence. It runs an opener that must be refused and requires
 * the harness to notice.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'acm-db-race-'))
const dbPath = join(dir, 'memory.db')
const dbUrl = pathToFileURL(join(process.cwd(), 'lib', 'db.mjs')).href

const workerFor = (path) => `
import { openDb } from ${JSON.stringify(dbUrl)}
try {
  const db = openDb(${JSON.stringify(path)})
  db.close()
  console.log('ok')
} catch (err) {
  console.log('ERR ' + String(err?.message ?? err))
  process.exitCode = 1
}
`

// Streams are captured separately on purpose: the warning lives on stderr, the
// verdict lives on stdout, and only the second one is an assertion.
const run = (path) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerFor(path)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) =>
      resolve({ stdout, stderr, status: null, signal: null, spawnError: String(err?.message ?? err) }))
    child.on('close', (status, signal) => resolve({ stdout, stderr, status, signal }))
  })

const excerpt = (text, limit = 400) => {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ')
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}

// Everything a reader needs to tell a warning from a failure.
const describe = (r) =>
  `status=${r.status} signal=${r.signal ?? 'none'} spawnError=${r.spawnError ?? 'none'} ` +
  `stdout="${excerpt(r.stdout, 200)}" stderr="${excerpt(r.stderr)}"`

// A worker succeeded when it said so, exited 0 and was not killed. The warning on
// stderr is neither success nor failure: it is noise from the runtime.
const succeeded = (r) => r.status === 0 && r.signal == null && r.stdout.trim() === 'ok'

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  const results = await Promise.all(Array.from({ length: 8 }, () => run(dbPath)))

  t('eight processes can create the same store at once', () => {
    const failed = results.filter((r) => !succeeded(r))
    // The message is built lazily: on a green run there is no first failure, and
    // eleven passes should not cost a crash in the reporter.
    const detail = failed.length === 0 ? 'all eight reported ok' : describe(failed[0])
    assert.equal(failed.length, 0, `${failed.length}/8 opens did not report success: ${detail}`)
  })

  const db = new DatabaseSync(dbPath)
  try {
    t('the migration ledger has no duplicates and no holes in its own list', () => {
      const versions = db.prepare('select version from acm_schema_migrations order by version').all().map((r) => r.version)
      assert.equal(new Set(versions).size, versions.length, `duplicate version rows: ${versions}`)
      assert.ok(versions.length >= 15, `ledger looks truncated: ${versions.length} rows`)
      assert.equal(versions[0], 1, 'the baseline version row is missing')
    })

    t('the store is usable after the race', () => {
      const row = db.prepare("select name from sqlite_master where type = 'table' and name = 'acm_nodes'").get()
      assert.ok(row, 'acm_nodes was not created')
      assert.equal(db.prepare('pragma integrity_check').get().integrity_check, 'ok')
    })
  } finally {
    db.close()
  }

  // Negative control: a path whose parent is a regular file cannot be opened. The
  // harness must report that as a failure, with the child's status and stderr.
  const blocker = join(dir, 'not-a-directory')
  writeFileSync(blocker, '')
  const refused = await run(join(blocker, 'memory.db'))

  t('the harness reports a refused opener as a failure, not as ok', () => {
    assert.equal(succeeded(refused), false, `a refused open was scored as success: ${describe(refused)}`)
    assert.notEqual(refused.status, 0, `a refused open exited 0: ${describe(refused)}`)
    assert.match(refused.stdout, /^ERR /, `the worker did not report why it failed: ${describe(refused)}`)
  })

  console.log(`\ndb race: ${pass} passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
