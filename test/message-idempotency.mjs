/**
 * Idempotent delivery (IDEM-01).
 *
 * A sender that retries after a timeout, or a relay re-importing a message it
 * already carried, must not produce a second row and a second delivery. The key
 * is recorded in `acm_meta`, so no schema change is involved.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { sendMessage, inbox } from '../lib/deliberation.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-idem-'))
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  const db = openDb(join(dir, 'memory.db'))
  const count = () => db.prepare('select count(*) as c from acm_mailbox').get().c

  t('the same key delivers one message and returns the original id', () => {
    const first = sendMessage(db, { to: 'bob', from: 'alice', body: 'build is green', messageKey: 'm-1' })
    assert.equal(first.ok, true)
    assert.equal(first.duplicate, undefined)
    const again = sendMessage(db, { to: 'bob', from: 'alice', body: 'build is green', messageKey: 'm-1' })
    assert.equal(again.ok, true)
    assert.equal(again.id, first.id, 'a retry produced a different id')
    assert.equal(again.duplicate, true, 'a retry was not reported as a duplicate')
    assert.equal(count(), 1, 'a retry created a second row')
  })

  t('a different key is a different message', () => {
    sendMessage(db, { to: 'bob', from: 'alice', body: 'build is green', messageKey: 'm-2' })
    assert.equal(count(), 2)
  })

  t('no key keeps the old behaviour, because callers may want two notices', () => {
    sendMessage(db, { to: 'bob', from: 'alice', body: 'same text, no key' })
    sendMessage(db, { to: 'bob', from: 'alice', body: 'same text, no key' })
    assert.equal(count(), 4)
  })

  t('the same key in another partition is not a duplicate', () => {
    const a = sendMessage(db, { to: 'bob', from: 'alice', body: 'p', messageKey: 'shared', owner: 'team-a' })
    const b = sendMessage(db, { to: 'bob', from: 'alice', body: 'p', messageKey: 'shared', owner: 'team-b' })
    assert.notEqual(a.id, b.id, 'a key leaked across partitions')
  })

  t('the retried message is still exactly one item in the inbox', () => {
    const items = inbox(db, { agent: 'bob' })
    assert.equal(items.filter((m) => m.body === 'build is green').length, 2, 'expected the two keyed messages')
  })

  t('an empty key is refused instead of silently disabling idempotency', () => {
    const r = sendMessage(db, { to: 'bob', from: 'alice', body: 'x', messageKey: '' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'empty-message-key')
  })

  t('the same key with different content is a conflict, not a silent success', () => {
    const before = count()
    sendMessage(db, { to: 'bob', from: 'alice', body: 'original', messageKey: 'm-conflict' })
    const clash = sendMessage(db, { to: 'bob', from: 'alice', body: 'different', messageKey: 'm-conflict' })
    assert.equal(clash.ok, false, 'a reused key with new content was accepted')
    assert.equal(clash.reason, 'message-key-conflict')
    assert.equal(count(), before + 1, 'the conflicting send still inserted a row')
  })
  console.log(`\nmessage idempotency: ${pass} passed`)
} finally {
  try { db.close() } catch {}
  // Windows can keep the sqlite files briefly; a stranded temp directory is not a
  // test failure, and hiding a real assertion behind cleanup would be worse.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
