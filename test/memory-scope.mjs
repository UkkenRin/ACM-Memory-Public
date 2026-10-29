/**
 * Reading across sessions, within one owner.
 *
 * A scope is a session id, and a second agent cannot name the first one's session: it
 * was not there when the id was made. The demo that motivated this file failed for
 * exactly that reason - the assignee searched, got nothing, and only succeeded after
 * it read the CLI source and re-ran the command with the producer's session name
 * patched in. A hand-off that requires guessing someone else's session id is not a
 * hand-off.
 *
 * `ANY_SCOPE` widens to every scope of this owner and no further. These assertions are
 * the "and no further" part: widening scope must not widen the partition.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { ANY_SCOPE, forget, remember, search } from '../lib/memory.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-scope-'))
const db = openDb(join(dir, 'memory.db'))

let passed = 0
const ok = (name, cond, detail = '') => {
  if (!cond) {
    console.error(`  NO  ${name} ${detail}`)
    process.exitCode = 1
    return
  }
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('[a memory written by one session is invisible to another]')
{
  remember(db, { text: 'the launch code is ORCHID-7', key: 'launch-code', kind: 'fact', scope: 'session-a' })
  remember(db, { text: 'the launch window is december', key: 'launch-window', kind: 'fact', scope: 'session-a' })
  remember(db, { text: 'shared convention: dates are ISO', key: 'convention-date', kind: 'preference', scope: 'global' })

  const fromB = search(db, { query: 'ORCHID-7', scope: 'session-b' })
  ok('another session does not see it by text', fromB.length === 0, `${fromB.length} hits`)

  const byKeyB = search(db, { query: 'launch-code', scope: 'session-b' })
  ok('and not by its exact key either', byKeyB.length === 0, `${byKeyB.length} hits`)

  const fromA = search(db, { query: 'ORCHID-7', scope: 'session-a' })
  ok('the session that wrote it still sees it', fromA.length === 1, `${fromA.length} hits`)

  const globalFromB = search(db, { query: 'convention', scope: 'session-b' })
  ok('global memory was already visible to every session', globalFromB.length === 1, `${globalFromB.length} hits`)
}

console.log('[ANY_SCOPE is how a hand-off reads what it was handed]')
{
  const byText = search(db, { query: 'ORCHID-7', scope: ANY_SCOPE })
  ok('the other session finds it by text', byText.length === 1, `${byText.length} hits`)

  const byKey = search(db, { query: 'launch-code', scope: ANY_SCOPE })
  // The exact key hit ranks first; a second row may still come back through the word
  // "launch" in its text, which is the retrieval layer working as designed.
  ok('and by exact key, which is what a task detail names',
    byKey.length >= 1 && byKey[0].key === 'launch-code', JSON.stringify(byKey.map((n) => n.key)))

  const both = search(db, { query: 'launch', scope: ANY_SCOPE })
  ok('a prefix of the key reaches more than one row', both.length >= 2, `${both.length} hits`)

  // 'global' is the narrow reading: the two session rows must not appear.
  const globalOnly = search(db, { query: 'launch', scope: 'global' })
  ok('scope=global stays narrow, so the two readings differ', globalOnly.length === 0, `${globalOnly.length} hits`)
}

console.log('[widening the scope does not widen the partition]')
{
  remember(db, { text: 'other owner secret is PLUM-9', key: 'secret', kind: 'fact', scope: 'session-a', owner: 'bob' })

  const mine = search(db, { query: 'PLUM-9', scope: ANY_SCOPE, owner: null })
  ok("another owner's row is invisible even at ANY_SCOPE", mine.length === 0, `${mine.length} hits`)

  const theirs = search(db, { query: 'PLUM-9', scope: ANY_SCOPE, owner: 'bob' })
  ok('and visible to its own owner at the same scope', theirs.length === 1, `${theirs.length} hits`)

  const mineAgain = search(db, { query: 'launch', scope: ANY_SCOPE, owner: 'bob' })
  ok('the widening is per owner in both directions', mineAgain.length === 0, `${mineAgain.length} hits`)
}

console.log('[a forgotten row is gone whatever the scope]')
{
  const row = search(db, { query: 'launch-window', scope: ANY_SCOPE })[0]
  assert.ok(row, 'the row to forget must exist')
  forget(db, row.id)
  const after = search(db, { query: 'launch-window', scope: ANY_SCOPE })
  ok('ANY_SCOPE still filters on status', after.every((n) => n.id !== row.id),
    `still present: ${after.map((n) => n.id).join(',')}`)
}

console.log(`memory scope: ${passed} passed`)
db.close()
rmSync(dir, { recursive: true, force: true })
