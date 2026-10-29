/**
 * A new session must see the work waiting for it.
 *
 * Cross-session recovery is not only "the facts came back": if another agent sent
 * this one a message, or a task was assigned to it, a session that cannot see that
 * has to be told by the owner - which is the relay this product exists to remove.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { buildInjectionText } from '../lib/core.mjs'
import { sendMessage } from '../lib/deliberation.mjs'
import { assignTask, createTask } from '../lib/tasks.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-xsession-'))
const dbPath = join(dir, 'memory.db')
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

try {
  const db = openDb(dbPath)

  t('a session with nothing waiting gets no pending-work line', () => {
    const out = buildInjectionText({ db, config: { agent: 'bob', owner: null }, sessionId: 'sB' })
    assert.ok(!/\u5F85\u4F60\u5904\u7406/.test(out.text), 'pending work was claimed with nothing pending')
  })

  // Session A leaves work for B.
  sendMessage(db, { to: 'bob', from: 'alice', body: 'please review the migration' })
  const task = createTask(db, { title: 'review migration', createdBy: 'alice' })
  const key = task.task?.key ?? task.key
  const assigned = assignTask(db, { key, assignee: 'bob', actor: 'alice' })
  assert.equal(assigned.ok, true, `assign failed: ${JSON.stringify(assigned)}`)

  t('a new session is told there is a message and a task for it', () => {
    const out = buildInjectionText({ db, config: { agent: 'bob', owner: null }, sessionId: 'sB-new' })
    assert.match(out.text, /\u5F85\u4F60\u5904\u7406/, 'no pending-work line for a session with work waiting')
    assert.match(out.text, /\u672A\u8BFB\u6D88\u606F 1 \u6761/, `message count wrong:\n${out.text}`)
    assert.match(out.text, /\u5F85\u4F60\u5904\u7406\u7684\u4EFB\u52A1 1 \u4EF6/, `task count wrong:\n${out.text}`)
  })

  t('another agent is not told about that work', () => {
    const out = buildInjectionText({ db, config: { agent: 'carol', owner: null }, sessionId: 'sC' })
    assert.ok(!/\u5F85\u4F60\u5904\u7406/.test(out.text), 'carol was told about work addressed to bob')
  })

  t('an answered message stops being counted', () => {
    const msg = db.prepare("select id from acm_mailbox where recipient = 'bob'").get()
    db.prepare("update acm_mailbox set state = 'done' where id = ?").run(msg.id)
    const out = buildInjectionText({ db, config: { agent: 'bob', owner: null }, sessionId: 'sB-2' })
    assert.ok(!/\u672A\u8BFB\u6D88\u606F/.test(out.text), 'a completed message was still counted')
  })

  db.close()
  console.log(`\ncross-session recovery: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
