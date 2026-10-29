/**
 * A task whose agent died returns to the queue when the store is opened.
 *
 * A lease is a deadline. Without a sweep on open, a crashed agent leaves its task
 * `running` until a host tick or a human runs `acm task expire`, so "recover after a
 * failure" depends on the owner remembering to ask.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDb } from '../lib/db.mjs'
import { acceptTask, assignTask, createTask } from '../lib/tasks.mjs'
import { openMemory } from '../lib/sdk.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-task-rec-'))
const dbPath = join(dir, 'memory.db')
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  // A previous session takes the task and dies with the lease already lapsed.
  const db = openDb(dbPath)
  const created = createTask(db, { title: 'nightly rebuild', createdBy: 'alice' })
  const key = created.task.key
  assignTask(db, { key, assignee: 'bob', actor: 'alice' })
  const accepted = acceptTask(db, { key, actor: 'bob', leaseMs: 1000, at: Date.now() - 60_000 })
  assert.equal(accepted.ok, true, `could not stage the lease: ${JSON.stringify(accepted)}`)
  db.close()

  t('the task is running before anything opens the store', () => {
    // A raw connection, because openDb() itself sweeps now and would hide the state
    // this assertion is about.
    const raw = new DatabaseSync(dbPath, { readOnly: true })
    const row = raw.prepare('select state from acm_tasks where task_key = ?').get(key)
    raw.close()
    assert.ok(row, 'fixture task missing')
    assert.equal(row.state, 'running', `fixture was not staged as running: ${row.state}`)
  })

  t('opening the store sweeps the expired lease', () => {
    const sdk = openMemory({ dbPath, config: { agent: 'bob' } })
    sdk.close()
    const check = openDb(dbPath)
    const row = check.prepare('select state from acm_tasks where task_key = ?').get(key)
    check.close()
    assert.notEqual(row.state, 'running', `task still running after reopen: ${row.state}`)
  })

  t('the recovery is recorded as an event, not a silent edit', () => {
    const check = openDb(dbPath)
    const events = check.prepare('select action from acm_task_events where task_key = ?').all(key).map((e) => e.action)
    check.close()
    assert.ok(events.length > 0, 'no task events at all')
    assert.ok(
      events.includes('expire') || events.includes('expired'),
      `no expire event: ${events.join(',')}`,
    )
  })

  console.log(`\ntask recovery: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
