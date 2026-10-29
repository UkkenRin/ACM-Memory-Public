/**
 * Project boundaries and maintenance privilege through the SDK.
 *
 * Three ways a scoped handle could reach past what its grants describe, each
 * pinned here by a test that must fail without the fix:
 *
 * 1. A handle that declares project `alpha` could read a `beta` task and, holding a
 *    grant whose target is `null` (a wildcard), transition it. The caller's project
 *    is a boundary in `core.taskGate` and now is one here too.
 * 2. Opening a store wrote before it authenticated: the due-backup and the expired
 *    lease sweep ran ahead of the scoped check, so a handle that was then refused
 *    had already copied the store or moved other projects' tasks to `expired`.
 * 3. Copying the store, restoring one, and exporting the partition to a path were
 *    reachable with a generic read or write grant. They are operator actions now.
 *
 * Every assertion is about state that survives the call: task rows, task events,
 * backup files on disk. A refusal that leaves a write behind is not a refusal.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, upsertPrincipal } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'
import { backupDirFor, listBackups } from '../lib/backup.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-sdk-boundary-'))
const dbPath = join(dir, 'memory.db')
const backupDir = join(dir, 'backups')
const exportPath = join(dir, 'fold.md')

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}
const refused = (err) => String(err?.code ?? '') === 'not-authorized'

const withDb = (fn) => {
  const db = openDb(dbPath)
  try { return fn(db) } finally { db.close() }
}

const seedTask = ({ key, project, state = 'returned', leaseUntil = null }) =>
  withDb((db) => db.prepare(
    `insert into acm_tasks
       (task_key, owner, project, title, state, priority, created_by, assignee, lease_until, created_at, updated_at)
     values (?, 'bob', ?, ?, ?, 0, 'seed', 'maker', ?, 1, 1)`,
  ).run(key, project, `task in ${project}`, state, leaseUntil))

const taskRow = (key) => withDb((db) => db.prepare('select state, project from acm_tasks where task_key = ?').get(key))
const eventCount = (key) =>
  withDb((db) => db.prepare('select count(*) as n from acm_task_events where task_key = ?').get(key).n)

const addGrants = (principalId, list) => withDb((db) => {
  upsertPrincipal(db, { id: principalId, kind: 'agent', owner: 'bob' })
  for (const g of list) grant(db, { principal: { id: principalId, kind: 'agent', owner: 'bob' }, ...g })
})

const open = (agent, extra = {}) =>
  openMemory({ dbPath, config: { owner: 'bob', agent, auth: { mode: 'scoped' }, ...extra } })

try {
  // ---------------------------------------------------------------- fixtures
  withDb((db) => {
    for (const id of ['dave', 'erin', 'frank', 'gina', 'hank', 'ivan', 'judy', 'nobody']) {
      upsertPrincipal(db, { id, kind: 'agent', owner: 'bob' })
    }
    const seed = db.prepare(
      'insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    seed.run('bob', 'global', 'fact', 'alpha.fact', 'alpha fact', '[]', 1)
    seed.run('bob', 'global', 'fact', 'beta.fact', 'beta fact', '[]', 1)
  })
  seedTask({ key: 'T-alpha', project: 'alpha' })
  seedTask({ key: 'T-beta', project: 'beta' })
  // A lease that ran out before anything opened: the recovery the sweep performs.
  seedTask({ key: 'T-stale-alpha', project: 'alpha', state: 'running', leaseUntil: 1 })
  seedTask({ key: 'T-stale-beta', project: 'beta', state: 'running', leaseUntil: 1 })

  // ------------------------------------------------- opening must not write
  t('a refused open does not sweep leases or take a backup', () => {
    const before = listBackups(backupDirFor(dbPath, backupDir)).length
    assert.throws(
      () => open('nobody', { backup: { dir: backupDir, enabled: true, everyHours: 0 } }),
      refused,
      'a store with no grant opened',
    )
    assert.equal(taskRow('T-stale-alpha').state, 'running', 'a refused open expired a lease')
    assert.equal(eventCount('T-stale-alpha'), 0, 'a refused open wrote a task event')
    const after = listBackups(backupDirFor(dbPath, backupDir)).length
    assert.equal(after, before, 'a refused open wrote a backup')
  })

  // ------------------------------------------- the caller's project is a wall
  addGrants('dave', [
    { action: 'memory:read', target: 'alpha' },
    // A wildcard transition grant: the widest thing a project handle can hold.
    { action: 'task:verify', target: null },
  ])

  t('a project handle does not see another project’s tasks', () => {
    const alpha = open('dave', { project: 'alpha' })
    try {
      const listed = alpha.tasks({ limit: 50 }).map((x) => x.key)
      assert.ok(listed.includes('T-alpha'), `alpha task missing from its own list: ${listed.join(',')}`)
      assert.ok(!listed.includes('T-beta'), `alpha handle listed a beta task: ${listed.join(',')}`)
      assert.equal(alpha.task('T-beta'), null, 'alpha handle read a beta task by key')
      assert.ok(alpha.task('T-alpha'), 'alpha handle could not read its own task')
    } finally {
      alpha.close()
    }
  })

  t('a wildcard transition grant does not cross the caller’s project', () => {
    const before = eventCount('T-beta')
    const alpha = open('dave', { project: 'alpha' })
    let outcome = null
    try {
      outcome = alpha.taskVerify('T-beta')
    } finally {
      alpha.close()
    }
    assert.equal(outcome?.ok, false, `alpha handle verified a beta task: ${JSON.stringify(outcome)}`)
    assert.equal(outcome?.reason, 'not-found', 'the refusal named another project')
    assert.equal(taskRow('T-beta').state, 'returned', 'a refused transition changed the beta task')
    assert.equal(eventCount('T-beta'), before, 'a refused transition wrote an event')
  })

  t('the same transition is allowed inside its own project', () => {
    const alpha = open('dave', { project: 'alpha' })
    let outcome = null
    try {
      outcome = alpha.taskVerify('T-alpha')
    } finally {
      alpha.close()
    }
    assert.equal(outcome?.ok, true, `alpha handle could not verify its own task: ${JSON.stringify(outcome)}`)
    assert.equal(taskRow('T-alpha').state, 'verified', 'the transition did not land')
  })

  addGrants('erin', [
    { action: 'memory:read', target: null },
    { action: 'task:verify', target: null },
    { action: 'task:sweep', target: null },
  ])

  // ------------------------------------------------ the sweep stays in range
  t('a project handle recovers only its own project', () => {
    addGrants('frank', [
      { action: 'memory:read', target: 'alpha' },
      { action: 'task:sweep', target: 'alpha' },
    ])
    // Opening is a recovery point; here it must recover one project only.
    const alpha = open('frank', { project: 'alpha' })
    try {
      assert.equal(taskRow('T-stale-alpha').state, 'expired', 'the automatic sweep skipped its own project')
      assert.equal(taskRow('T-stale-beta').state, 'running', 'the automatic sweep reached another project')

      seedTask({ key: 'T-stale-alpha-2', project: 'alpha', state: 'running', leaseUntil: 1 })
      seedTask({ key: 'T-stale-beta-2', project: 'beta', state: 'running', leaseUntil: 1 })
      const swept = alpha.taskExpireLeases(Date.now())
      assert.deepEqual(swept.expired, ['T-stale-alpha-2'], `swept the wrong range: ${JSON.stringify(swept)}`)
    } finally {
      alpha.close()
    }
    assert.equal(taskRow('T-stale-alpha-2').state, 'expired', 'the alpha lease was not swept')
    assert.equal(taskRow('T-stale-beta-2').state, 'running', 'a project sweep expired another project')
  })

  t('a partition-wide handle recovers both projects and reads both', () => {
    const wide = open('erin')
    try {
      assert.equal(taskRow('T-stale-beta').state, 'expired', 'the partition-wide sweep missed beta')
      const listed = wide.tasks({ limit: 50 }).map((x) => x.key)
      assert.ok(listed.includes('T-alpha') && listed.includes('T-beta'), `partition reader filtered: ${listed.join(',')}`)
      assert.ok(wide.task('T-beta'), 'partition reader could not read a beta task')
    } finally {
      wide.close()
    }
  })

  t('a restart without task:sweep leaves the leases for a scheduler', () => {
    seedTask({ key: 'T-restart', project: 'alpha', state: 'running', leaseUntil: 1 })
    // A chat principal: it may read, and it may not sweep. The grant that opens a
    // store is not a grant to repair its leases, and a restart is exactly when an
    // expired lease would otherwise be recovered silently.
    addGrants('judy', [{ action: 'memory:read', target: 'alpha' }])
    const chat = open('judy', { project: 'alpha' })
    chat.close()
    assert.equal(taskRow('T-restart').state, 'running', 'a chat handle recovered leases it had no grant to sweep')

    // The scheduler holds the verb, and recovery happens on its next open.
    addGrants('judy', [{ action: 'task:sweep', target: 'alpha' }])
    const scheduler = open('judy', { project: 'alpha' })
    scheduler.close()
    assert.equal(taskRow('T-restart').state, 'expired', 'a granted scheduler did not recover the lease')
  })

  // --------------------------------------------------- operator-only actions
  addGrants('gina', [{ action: 'memory:read', target: 'alpha' }, { action: 'memory:write-global', target: 'alpha' }])

  t('a write grant is not permission to copy or restore the store', () => {
    const gina = open('gina', { project: 'alpha' })
    try {
      assert.throws(() => gina.backup({ dir: backupDir }), refused, 'memory:write-global authorised a whole-store backup')
      assert.throws(() => gina.restore(join(dir, 'nope.db'), join(dir, 'out.db')), refused, 'memory:write-global authorised a restore')
      assert.throws(() => gina.fold(exportPath), refused, 'memory:read authorised an export to a path')
      assert.equal(existsSync(exportPath), false, 'a refused export still wrote the file')
      // The read-only form of the export stays available: it returns the text and
      // touches no path.
      assert.ok(String(gina.fold()).includes('alpha fact'), 'the in-memory export stopped working')
    } finally {
      gina.close()
    }
  })

  t('a project-level operator grant cannot authorise a whole-store copy', () => {
    addGrants('gina', [{ action: 'operator:backup', target: 'alpha' }])
    const gina = open('gina', { project: 'alpha' })
    try {
      assert.throws(() => gina.backup(), refused, 'a project-level operator grant copied the whole store')
    } finally {
      gina.close()
    }
  })

  t('a project-targeted export grant cannot write the partition to disk', () => {
    addGrants('hank', [
      { action: 'memory:read', target: 'alpha' },
      { action: 'operator:export', target: 'alpha' },
    ])
    const target = join(dir, 'hank.md')
    const hank = open('hank', { project: 'alpha', exportDir: dir })
    try {
      assert.throws(() => hank.fold(target), refused, 'a project-targeted export grant wrote the owner-wide view')
      assert.equal(existsSync(target), false, 'a refused export still wrote the file')
      // The in-memory form is still a read; it returns text and touches no path.
      assert.ok(String(hank.fold()).includes('alpha fact'), 'the in-memory export stopped working')
    } finally {
      hank.close()
    }
  })

  t('a scoped export lands only inside the operator directory', () => {
    addGrants('ivan', [
      { action: 'memory:read', target: 'alpha' },
      { action: 'operator:export', target: null },
    ])
    // No destination configured: a scoped handle has no business choosing one.
    const unset = open('ivan', { project: 'alpha' })
    try {
      const attempted = join(dir, 'ivan.md')
      assert.throws(() => unset.fold(attempted), refused, 'an unconfigured destination still wrote a file')
      assert.equal(existsSync(attempted), false, 'the refused export wrote a file')
    } finally {
      unset.close()
    }

    // The operator creates the directory: a configured destination that does not
    // exist is a configuration mistake, not something to invent on first write.
    mkdirSync(join(dir, 'exports'), { recursive: true })
    // A prefix is not a directory: `exports-evil` sits beside `exports`, not in it.
    const ivan = open('ivan', { project: 'alpha', exportDir: join(dir, 'exports') })
    try {
      const escaped = join(dir, 'exports-evil', 'view.md')
      assert.throws(() => ivan.fold(escaped), refused, 'the caller escaped the operator directory')
      assert.equal(existsSync(join(dir, 'exports-evil')), false, 'the escaped export created a directory')
      // Subdirectories are the operator's to make, not the export's: a missing
      // intermediate directory is a configuration mistake, and inventing one is
      // what turned "write in here" into "write wherever the last part points".
      mkdirSync(join(dir, 'exports', 'nested'), { recursive: true })
      const nested = ivan.fold(join(dir, 'exports', 'nested', 'view.md'))
      assert.ok(nested.includes('alpha fact'), 'an export inside the configured directory was refused')
    } finally {
      ivan.close()
    }
  })

  t('an explicit partition-wide operator grant does authorise them', () => {
    // `operator:export` must be untargeted. `foldToMarkdown` reads every active
    // node in the partition - `acm_nodes` has no project column - so a grant that
    // names one project cannot describe what the write reaches. The destination
    // comes from `exportDir`, never from the call.
    addGrants('gina', [
      { action: 'operator:backup', target: null },
      { action: 'operator:export', target: null },
    ])
    const gina = open('gina', {
      project: 'alpha',
      exportDir: dir,
      backup: { dir: backupDir, enabled: true, everyHours: 6 },
    })
    try {
      const taken = gina.backup()
      assert.ok(taken.created, `the operator backup did not run: ${JSON.stringify(taken)}`)
      const written = gina.fold(exportPath)
      assert.ok(written.includes('alpha fact'), 'the operator export returned nothing')
      // The export is owner-wide by construction. Saying so in a test is what
      // stops the next reader from treating `target: 'alpha'` as isolation.
      assert.ok(written.includes('beta fact'), 'the documented owner-wide export lost another project’s memory')
    } finally {
      gina.close()
    }
    assert.ok(existsSync(exportPath), 'the granted export did not write the file')
    assert.ok(listBackups(backupDirFor(dbPath, backupDir)).length > 0, 'the granted backup wrote no file')

    // A destination supplied by the caller is refused even with the grant: the
    // path belongs to the operator's configuration, not to the request.
    const again = open('gina', { project: 'alpha', backup: { dir: backupDir, enabled: true, everyHours: 6 } })
    try {
      assert.throws(() => again.backup({ dir: join(dir, 'elsewhere') }), /configuration/, 'the caller chose the backup destination')
    } finally {
      again.close()
    }
  })

  console.log(`\nsdk boundary: ${pass} passed`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
