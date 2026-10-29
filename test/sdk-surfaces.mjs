/**
 * The remaining SDK surfaces obey the same rule.
 *
 * The gates were added where the audit pointed, but eight surfaces still ran with
 * partition scope only. Reads need `memory:read`; `checkpoint` writes a session
 * record (`memory:write-session`); pinning a revision changes the answer for
 * everyone in the partition (`memory:write-global`). A handle with only a read
 * grant must therefore read and must not write.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, upsertPrincipal } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-sdk-surf-'))
const dbPath = join(dir, 'memory.db')
const principal = { id: 'bob', kind: 'agent', owner: 'bob' }
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}
const refused = (err) => String(err?.code ?? '') === 'not-authorized'

try {
  const db = openDb(dbPath)
  db.prepare("insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values ('bob','global','fact','k','bob note','[]',1)").run()
  upsertPrincipal(db, principal)
  grant(db, { principal, action: 'memory:read', target: null })
  db.close()

  const sdk = openMemory({ dbPath, config: { owner: 'bob', auth: { mode: 'scoped' }, agent: 'bob' } })

  t('the read surfaces work with a read grant', () => {
    assert.doesNotThrow(() => sdk.history({ limit: 5 }), 'history refused a read grant')
    assert.doesNotThrow(() => sdk.conflicts({ limit: 5 }), 'conflicts refused a read grant')
    assert.doesNotThrow(() => sdk.aliases('k'), 'aliases refused a read grant')
  })

  t('checkpoint needs a write grant', () => {
    assert.throws(() => sdk.checkpoint({ goal: 'x', next: 'y' }), refused, 'checkpoint wrote with a read-only grant')
  })

  t('pinning a revision needs the global write grant', () => {
    assert.throws(() => sdk.resolveConflict(1), refused, 'resolveConflict ran with a read-only grant')
  })

  t('the read surfaces still work after the refusals', () => {
    assert.doesNotThrow(() => sdk.provenance(1), 'provenance broke after a refused write')
  })

  sdk.close()
  console.log(`\nsdk surfaces: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
