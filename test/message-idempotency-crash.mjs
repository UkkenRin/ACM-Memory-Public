/**
 * A sender that dies mid-send must leave nothing behind (IDEM-01).
 *
 * sendMessage() inserts the mailbox row and claims the idempotency key inside one
 * transaction. If the process dies between those statements - or before the commit -
 * the store must contain neither, so a retry is a first attempt rather than a
 * duplicate. This runs the two statements in a child process and exits without
 * committing, which is the closest deterministic stand-in for that crash.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { sendMessage } from '../lib/deliberation.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-idem-crash-'))
const dbPath = join(dir, 'memory.db')
const dbUrl = pathToFileURL(join(process.cwd(), 'lib', 'db.mjs')).href

const worker = `
import { openDb } from ${JSON.stringify(dbUrl)}
const db = openDb(${JSON.stringify(dbPath)})
db.exec('begin immediate')
db.prepare("insert into acm_mailbox (owner, recipient, sender, kind, body, state, created_at) values (null, 'bob', 'alice', 'notice', 'crash', 'pending', 1)").run()
db.prepare("insert into acm_meta (k, v) values ('msgkey:[null,\\"alice\\",\\"crash-1\\"]', '{\\"id\\":1}')").run()
// Deliberately no COMMIT: process death inside the transaction.
process.exit(9)
`

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  openDb(dbPath).close()

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { encoding: 'utf8' })
    child.stderr.on('data', () => {})
    child.on('close', (c) => resolve(c))
  })

  t('the child died inside the transaction', () => {
    assert.equal(code, 9, `child exited ${code}`)
  })

  t('nothing from the aborted send survived', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('select count(*) as c from acm_mailbox').get().c
    const keys = db.prepare("select count(*) as c from acm_meta where k like 'msgkey:%'").get().c
    db.close()
    assert.equal(rows, 0, `${rows} mailbox rows survived a rolled-back send`)
    assert.equal(keys, 0, `${keys} ledger keys survived a rolled-back send`)
  })

  t('a retry after the crash is a first attempt, not a duplicate', () => {
    const db = openDb(dbPath)
    const r = sendMessage(db, { to: 'bob', from: 'alice', body: 'crash', messageKey: 'crash-1' })
    const rows = db.prepare('select count(*) as c from acm_mailbox').get().c
    db.close()
    assert.equal(r.ok, true)
    assert.equal(r.duplicate, undefined, 'the retry was treated as a duplicate of a rolled-back send')
    assert.equal(rows, 1, `${rows} rows after the retry`)
  })

  console.log(`\nmessage idempotency after a crash: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
