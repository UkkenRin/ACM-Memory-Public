/**
 * Authorized reads and mutations through the SDK.
 *
 * The tool path has always consulted `requireAction`. The SDK did not, then only at
 * construction. A handle outlives a revocation, so every sensitive call revalidates,
 * with the operation it actually performs.
 *
 * The reopened audit widened this: the checks now cover every memory-leaking surface -
 * `inject`, `handoff`, `history`, `checkpoint`, `receipts` and the task methods -
 * not only the four that were listed first. Two defects the review named are
 * asserted here as well:
 *
 * - `inject()` had no check at all, so revoking a read grant still let the handle
 *   render the partition's facts into a prompt.
 * - `target` meant the owner at open time and the project on every later call, and a
 *   handle that named no project accepted ANY targeted grant (`anyTarget`). A grant
 *   narrowed to `alpha` therefore authorised a reader that never named `alpha`. The
 *   target is the project everywhere now, and a handle with no project needs a
 *   partition-wide grant (`target = null`).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, revokeGrant, upsertPrincipal } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-sdk-auth-'))
const dbPath = join(dir, 'memory.db')
const principal = { id: 'bob', kind: 'agent', owner: 'bob' }
let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}
const refused = (err) => String(err?.code ?? '') === 'not-authorized'
const counts = () => {
  const db = openDb(dbPath)
  try {
    return {
      tasks: db.prepare('select count(*) as n from acm_tasks').get().n,
      events: db.prepare('select count(*) as n from acm_task_events').get().n,
      aliceNodes: db.prepare("select count(*) as n from acm_nodes where owner = 'alice' and status = 'active'").get().n,
    }
  } finally {
    db.close()
  }
}

try {
  const db = openDb(dbPath)
  const seed = db.prepare('insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values (?, ?, ?, ?, ?, ?, ?)')
  seed.run('alice', 'global', 'fact', 'k1', 'alice secret', '[]', 1)
  seed.run('bob', 'global', 'fact', 'k2', 'bob note', '[]', 1)
  const aliceNodeId = db.prepare("select id from acm_nodes where owner = 'alice'").get().id
  upsertPrincipal(db, principal)
  // `target: null` is the partition-wide grant: it covers every project, including a
  // handle that names none. A grant narrowed to a project is issued separately below.
  const readGrant = grant(db, { principal, action: 'memory:read', target: null })
  db.close()

  t('a scoped store refuses a handle with no grant', () => {
    const bare = openDb(dbPath)
    const other = { id: 'carol', kind: 'agent', owner: 'carol' }
    upsertPrincipal(bare, other)
    bare.close()
    assert.throws(
      () => openMemory({ dbPath, config: { owner: 'carol', auth: { mode: 'scoped' }, agent: 'carol' } }),
      refused,
      'a scoped store opened without any grant',
    )
  })

  const sdk = openMemory({ dbPath, config: { owner: 'bob', auth: { mode: 'scoped' }, agent: 'bob' } })

  t('the granted handle reads its own partition', () => {
    const text = JSON.stringify(sdk.search('bob', { limit: 10 }) ?? [])
    assert.ok(text.includes('bob note'), 'the granted read returned nothing')
    assert.ok(!text.includes('alice secret'), 'alice leaked into a bob-scoped search')
  })

  t('injection renders this partition only', () => {
    const injected = JSON.stringify(sdk.inject({ query: 'bob' }) ?? '')
    assert.ok(!injected.includes('alice secret'), 'injection leaked another owner’s fact')
  })

  t('a mutation without a grant is refused on the call, not at open', () => {
    assert.throws(() => sdk.remember({ text: 'should not land' }), refused, 'remember ran without a grant')
    assert.throws(() => sdk.forget(1), refused, 'forget ran without a grant')
    assert.throws(() => sdk.purge(1), refused, 'purge ran without a grant')
    assert.throws(() => sdk.taskCreate({ title: 'should not land' }), refused, 'taskCreate ran without a grant')
  })

  t('revoking the read grant closes every read path on an already-open handle', () => {
    const admin = openDb(dbPath)
    revokeGrant(admin, { id: readGrant.id, by: 'test' })
    admin.close()
    assert.throws(() => sdk.search('bob', { limit: 10 }), refused, 'a revoked grant still read the partition')
    assert.throws(() => sdk.inject({ query: 'bob' }), refused, 'a revoked grant still injected the partition')
    assert.throws(() => sdk.history({ limit: 5 }), refused, 'a revoked grant still listed history')
    assert.throws(() => sdk.handoff({}), refused, 'a revoked grant still built a handoff package')
  })

  t('a narrow delete grant does not authorise erase', () => {
    const admin = openDb(dbPath)
    grant(admin, { principal, action: 'memory:read', target: null })
    const forgetGrant = grant(admin, { principal, action: 'memory:forget', target: null })
    admin.close()
    assert.throws(() => sdk.purge(1), refused, 'memory:forget was accepted as permission to purge')
    assert.doesNotThrow(() => sdk.search('bob', { limit: 5 }), 'the restored read grant did not apply')
    const revoked = openDb(dbPath)
    revokeGrant(revoked, { id: forgetGrant.id, by: 'test' })
    revoked.close()
  })

  t('a project-scoped grant does not authorise a handle that names no project', () => {
    const admin = openDb(dbPath)
    const dave = { id: 'dave', kind: 'agent', owner: 'bob' }
    upsertPrincipal(admin, dave)
    grant(admin, { principal: dave, action: 'memory:read', target: 'alpha' })
    admin.close()
    assert.throws(
      () => openMemory({ dbPath, config: { owner: 'bob', agent: 'dave', auth: { mode: 'scoped' } } }),
      refused,
      'a grant for project alpha opened a partition-wide handle',
    )
    assert.throws(
      () => openMemory({ dbPath, config: { owner: 'bob', agent: 'dave', project: 'beta', auth: { mode: 'scoped' } } }),
      refused,
      'a grant for project alpha opened a handle for project beta',
    )
    assert.doesNotThrow(
      () => openMemory({ dbPath, config: { owner: 'bob', agent: 'dave', project: 'alpha', auth: { mode: 'scoped' } } }),
      'a grant for project alpha did not open a handle for project alpha',
    )
  })

  t('a read-only handle cannot create a task, and refusal writes nothing', () => {
    const before = counts()
    assert.throws(() => sdk.taskCreate({ title: 'read only' }), refused, 'a read-only handle created a task')
    const after = counts()
    assert.equal(after.tasks, before.tasks, 'a refused taskCreate wrote a task row')
    assert.equal(after.events, before.events, 'a refused taskCreate wrote an event row')
  })

  t('another owner’s id is not readable or erasable through this handle', () => {
    const before = counts()
    const seen = sdk.provenance(aliceNodeId)
    assert.ok(seen == null || JSON.stringify(seen) === '{}' || seen?.node == null,
      `provenance returned another owner’s node: ${JSON.stringify(seen)?.slice(0, 120)}`)
    // A granted mutation must still miss the row: ownership is a query predicate, not
    // an argument the caller supplies.
    let outcome = 'unchanged'
    try {
      const forgotten = sdk.forget(aliceNodeId)
      if (forgotten?.ok === true) outcome = 'changed'
    } catch (err) {
      if (!refused(err)) throw err
    }
    assert.equal(outcome, 'unchanged', 'forget touched another owner’s node')
    assert.equal(counts().aliceNodes, before.aliceNodes, 'another owner’s node was erased')
  })

  t('a task transition is authorised against the task’s own project', () => {
    const admin = openDb(dbPath)
    const dave = { id: 'dave', kind: 'agent', owner: 'bob' }
    grant(admin, { principal: dave, action: 'memory:read', target: 'beta' })
    grant(admin, { principal: dave, action: 'task:create', target: 'alpha' })
    grant(admin, { principal: dave, action: 'task:verify', target: 'beta' })
    admin.close()

    // The task lives in `alpha`; the caller is granted `beta` only for the transition.
    const maker = openMemory({ dbPath, config: { owner: 'bob', agent: 'dave', project: 'alpha', auth: { mode: 'scoped' } } })
    const created = maker.taskCreate({ title: 'alpha work', assignee: 'dave' })
    maker.close()
    assert.equal(created.ok, true, `could not create the alpha task: ${JSON.stringify(created)}`)

    const beta = openMemory({ dbPath, config: { owner: 'bob', agent: 'dave', project: 'beta', auth: { mode: 'scoped' } } })
    // The refusal is a structured `not-found`, the same answer the tool path gives,
    // so a caller cannot tell "another project" from "no such key". An exception is
    // equally acceptable; what is not acceptable is a transition.
    let outcome = null
    try {
      outcome = beta.taskVerify(created.task.key)
    } catch (err) {
      assert.ok(refused(err), `a beta grant verified an alpha task: ${err?.message}`)
      outcome = { ok: false, reason: 'refused' }
    }
    beta.close()
    assert.equal(outcome?.ok, false, `a beta grant verified an alpha task: ${JSON.stringify(outcome)}`)
  })

  t('local mode is unchanged', () => {
    const local = openMemory({ dbPath, config: { owner: 'alice', agent: 'local-operator' } })
    assert.ok(local, 'local mode refused to open')
    assert.doesNotThrow(() => local.inject({ query: 'anything' }), 'local mode refused injection')
    assert.doesNotThrow(() => local.taskCreate({ title: 'local task' }), 'local mode refused task creation')
    local.close()
  })

  sdk.close()
  console.log(`\nsdk auth: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
