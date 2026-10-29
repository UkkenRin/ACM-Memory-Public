/**
 * Idempotent delivery across processes (IDEM-01).
 *
 * The single-process test cannot show what happens when two senders race: the
 * ledger claim has to settle exactly one winner, and every caller must be told the
 * same message id. Four real processes send the same key at the same time.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'acm-idem-x-'))
const dbPath = join(dir, 'memory.db')
const root = process.cwd()
const dbUrl = pathToFileURL(join(root, 'lib', 'db.mjs')).href
const delibUrl = pathToFileURL(join(root, 'lib', 'deliberation.mjs')).href

const worker = `
import { openDb } from ${JSON.stringify(dbUrl)}
import { sendMessage } from ${JSON.stringify(delibUrl)}
try {
  const db = openDb(${JSON.stringify(dbPath)})
  const r = sendMessage(db, { to: 'bob', from: 'alice', body: 'race', messageKey: 'race-1' })
  db.close()
  console.log(JSON.stringify(r))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
}
`

// DB-02, second instance: this harness merged stderr into stdout and then parsed the
// result as JSON. Node writes `ExperimentalWarning: SQLite is an experimental
// feature` to stderr, so the last line became "(Use `node --trace-warnings ...`)"
// and four successful senders were reported as `4 failed`. The verdict is on stdout,
// the warning is on stderr, and the exit status is its own assertion.
const run = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
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

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  const raw = await Promise.all([run(), run(), run(), run()])
  const results = raw.map((r) => {
    // The worker prints exactly one JSON line on stdout. Take the last one, keep the
    // status and the stderr beside it so a refusal can be read instead of guessed.
    const line = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? ''
    let value
    try {
      value = JSON.parse(line)
    } catch {
      value = { ok: false, error: line.slice(0, 160) }
    }
    return { ...value, status: r.status, signal: r.signal, stderr: r.stderr }
  })
  const describe = (r) =>
    `status=${r.status} signal=${r.signal ?? 'none'} ok=${r.ok} ` +
    `error="${String(r.error ?? '').slice(0, 120)}" stderr="${String(r.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}"`

  t('every racing sender succeeds', () => {
    const failed = results.filter((r) => !r.ok)
    const detail = failed.length === 0 ? 'all four reported ok' : describe(failed[0])
    assert.equal(failed.length, 0, `${failed.length} failed: ${detail}`)
  })

  t('every racing sender exited cleanly', () => {
    const bad = results.filter((r) => r.status !== 0 || r.signal != null)
    const detail = bad.length === 0 ? 'all four exited 0' : describe(bad[0])
    assert.equal(bad.length, 0, `${bad.length} did not exit cleanly: ${detail}`)
  })

  t('they are all told the same message id', () => {
    const ids = new Set(results.map((r) => r.id))
    assert.equal(ids.size, 1, `different ids returned: ${[...ids].join(', ')}`)
  })

  t('exactly one row was delivered', () => {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('select count(*) as c from acm_mailbox').get()
    db.close()
    assert.equal(row.c, 1, `${row.c} rows for one key`)
  })

  t('the store is still consistent', () => {
    const db = new DatabaseSync(dbPath)
    const verdict = db.prepare('pragma integrity_check').get().integrity_check
    db.close()
    assert.equal(verdict, 'ok', `integrity_check said ${verdict}`)
  })

  console.log(`\nmessage idempotency across processes: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
