/**
 * A grant can expire between two calls on the same handle.
 *
 * Revocation was covered; expiry was not, and it is the other way a permission can
 * disappear while a handle stays open. The decision belongs to the call, so the
 * second call must be refused even though the first one succeeded.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, upsertPrincipal } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-sdk-expiry-'))
const dbPath = join(dir, 'memory.db')
const principal = { id: 'bob', kind: 'agent', owner: 'bob' }
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}
const refused = (err) => String(err?.code ?? '') === 'not-authorized'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const db = openDb(dbPath)
  db.prepare("insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values ('bob','global','fact','k','bob note','[]',1)").run()
  upsertPrincipal(db, principal)
  // Two seconds, not 300 ms. The window has to cover `openMemory`, which opens SQLite and
  // then calls requireAction('memory:read') before the handle exists - on the windows-latest
  // runner that took longer than 300 ms, so the setup itself was refused and the failure
  // looked like a product defect in a test that had never failed before. The point of the
  // case is what happens *after* the handle is open, so the setup gets room and the sleep
  // below stays comfortably past the deadline.
  const granted = grant(db, { principal, action: 'memory:read', target: null, ttlMs: 2000 })
  db.close()

  t('the grant is issued with an expiry', () => {
    assert.ok(granted.id, 'no grant id returned')
  })

  const sdk = openMemory({ dbPath, config: { owner: 'bob', auth: { mode: 'scoped' }, agent: 'bob' } })

  t('the read works while the grant is alive', () => {
    assert.doesNotThrow(() => sdk.search('bob', { limit: 5 }), 'a live grant was refused')
  })

  await sleep(2600)

  t('the same handle is refused once the grant expires', () => {
    assert.throws(() => sdk.search('bob', { limit: 5 }), refused, 'an expired grant still read the partition')
  })

  t('the handle was not closed by the refusal: a fresh grant lets it read again', () => {
    const admin = openDb(dbPath)
    grant(admin, { principal, action: 'memory:read', target: null })
    admin.close()
    assert.doesNotThrow(() => sdk.search('bob', { limit: 5 }), 'the handle stopped working after one refusal')
  })

  sdk.close()
  console.log(`\nsdk grant expiry: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
