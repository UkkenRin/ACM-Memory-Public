/**
 * A migration that cannot take the write lock must refuse.
 *
 * It used to swallow the failure (`locked = false`) and run the schema changes
 * anyway - the unprotected path the lock exists to prevent. This holds a real write
 * lock from another connection and asserts that the opener refuses, that the store
 * is untouched, and that the refused handle was closed (the directory can be
 * removed afterwards, which is how a leaked handle shows up on Windows).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDb } from '../lib/db.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-lockfail-'))
const dbPath = join(dir, 'legacy.db')
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

function makeV7(path) {
  const raw = new DatabaseSync(path)
  raw.exec(`
    create table acm_meta (k text primary key, v text not null);
    create table acm_schema_migrations (version integer primary key, applied_at integer not null);
    insert into acm_schema_migrations (version, applied_at) values (1,0),(2,0),(3,0),(4,0),(5,0),(6,0),(7,0);
  `)
  raw.close()
}

try {
  makeV7(dbPath)
  const holder = new DatabaseSync(dbPath)
  holder.exec('BEGIN IMMEDIATE')

  let refused = null
  try {
    const db = openDb(dbPath)
    db.close()
  } catch (err) {
    refused = err
  }

  t('an opener that cannot take the lock refuses instead of migrating', () => {
    assert.ok(refused, 'openDb migrated while another connection held the write lock')
    assert.match(String(refused.message), /refusing to open|write lock/, String(refused.message))
  })

  t('the store is untouched by the refusal', () => {
    const check = new DatabaseSync(dbPath, { readOnly: true })
    const version = check.prepare('select max(version) as v from acm_schema_migrations').get().v
    check.close()
    assert.equal(version, 7, `the ledger moved to v${version} without a lock`)
  })

  holder.exec('ROLLBACK')
  holder.close()

  t('the refused handle was closed, so the directory can be removed', () => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    assert.equal(existsSync(dir), false)
  })

  console.log(`\nmigration lock: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir left behind: ${dir}`)
  }
}
