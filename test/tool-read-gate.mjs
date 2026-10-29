/**
 * Who may read: the tool surface, across the grant matrix.
 *
 * The project predicates added in the previous batch narrowed *what* these tools
 * return; they never decided *who* may ask. `acm_search`, `acm_task_list` and
 * `acm_task_get` answered any caller that could reach them, so a scoped store
 * handed its memory to a principal holding no grant at all.
 *
 * The matrix below is the one a reviewer asked for: a caller that declares a
 * project and one that declares none, each with no grant, a project-targeted
 * grant, and an untargeted (partition-wide) grant. Two properties are checked
 * throughout:
 *
 * - the refusal happens **before** the lookup, so "exists elsewhere" and "does
 *   not exist" produce byte-identical answers (no existence oracle), and
 * - a refusal leaves the store exactly as it was.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, principalFromConfig, upsertPrincipal } from '../lib/auth.mjs'
import { TOOLS, mergeConfig } from '../lib/core.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-read-gate-'))
const dbPath = join(dir, 'memory.db')
const db = openDb(dbPath)
const SID = 's'

let pass = 0
const t = async (name, fn) => {
  await fn()
  pass += 1
  console.log(`  ok ${name}`)
}

const call = (name, args, config) =>
  TOOLS.find((x) => x.name === name).run(args, { db, config, sessionId: SID })

/** Run and report the refusal instead of throwing, so two answers can be compared. */
const attempt = async (name, args, config) => {
  try {
    return { threw: false, value: await call(name, args, config) }
  } catch (err) {
    return { threw: true, code: err.code, message: String(err.message), decision: err.decision }
  }
}

const cfg = (agent, project, mode = 'scoped') =>
  mergeConfig({ dbPath, agent, owner: 'bob', project, personaFiles: [], auth: { mode } })

const seedNode = (key, text) =>
  db.prepare(
    'insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run('bob', SID, 'fact', key, text, '[]', 1)

const seedTask = (key, project) =>
  db.prepare(
    `insert into acm_tasks
       (task_key, owner, project, title, state, priority, created_by, assignee, created_at, updated_at)
     values (?, 'bob', ?, ?, 'returned', 0, 'seed', 'maker', 1, 1)`,
  ).run(key, project, `task in ${project}`)

const taskState = (key) => db.prepare('select state from acm_tasks where task_key = ?').get(key)?.state
const eventCount = (key) => db.prepare('select count(*) as n from acm_task_events where task_key = ?').get(key).n

const addGrants = (agent, list) => {
  const principal = principalFromConfig(cfg(agent, null))
  for (const g of list) grant(db, { principal, ...g })
}

try {
  for (const id of ['nobody', 'alpha-reader', 'wide-reader', 'null-alpha', 'null-wide', 'mailer']) {
    upsertPrincipal(db, { id, kind: 'agent', owner: 'bob' })
  }
  seedNode('alpha.fact', 'ALPHA-NOTE')
  seedNode('beta.fact', 'BETA-NOTE')
  seedTask('T-alpha', 'alpha')
  seedTask('T-beta', 'beta')

  addGrants('alpha-reader', [{ action: 'memory:read', target: 'alpha' }])
  addGrants('wide-reader', [{ action: 'memory:read', target: null }])
  addGrants('null-alpha', [{ action: 'memory:read', target: 'alpha' }])
  addGrants('null-wide', [{ action: 'memory:read', target: null }])
  addGrants('mailer', [{ action: 'memory:read', target: 'alpha' }, { action: 'mailbox:send', target: 'alpha' }])

  // ------------------------------------------------------- no grant at all
  const searchDenied = await attempt('acm_search', { query: 'NOTE' }, cfg('nobody', 'alpha'))
  await t('a caller with no grant cannot search memory', () => {
    assert.equal(searchDenied.threw, true, `search answered a caller with no grant: ${JSON.stringify(searchDenied).slice(0, 200)}`)
    assert.equal(searchDenied.code, 'not-authorized', `wrong refusal: ${searchDenied.code}`)
  })

  const listDenied = await attempt('acm_task_list', {}, cfg('nobody', 'alpha'))
  await t('and cannot list tasks', () => {
    assert.equal(listDenied.threw, true, `task_list answered a caller with no grant: ${JSON.stringify(listDenied).slice(0, 200)}`)
    assert.equal(listDenied.code, 'not-authorized', `wrong refusal: ${listDenied.code}`)
  })

  const onReal = await attempt('acm_task_get', { key: 'T-alpha' }, cfg('nobody', 'alpha'))
  const onFake = await attempt('acm_task_get', { key: 'T-nope' }, cfg('nobody', 'alpha'))
  await t('nor read one, and the answer does not say whether the key exists', () => {
    assert.equal(onReal.threw, true, 'task_get answered a caller with no grant')
    assert.equal(
      JSON.stringify({ ...onReal, decision: null }),
      JSON.stringify({ ...onFake, decision: null }),
      `an ungranted caller could tell a real key from a fake one:\n  ${JSON.stringify(onReal)}\n  ${JSON.stringify(onFake)}`,
    )
  })

  // ------------------------------------- project-targeted grant, project set
  const alphaSearch = await attempt('acm_search', { query: 'NOTE' }, cfg('alpha-reader', 'alpha'))
  await t('a project grant reads its own project’s memory', () => {
    assert.equal(alphaSearch.threw, false, `an alpha reader was refused: ${JSON.stringify(alphaSearch).slice(0, 200)}`)
    const texts = alphaSearch.value.items.map((x) => x.text)
    assert.ok(texts.includes('ALPHA-NOTE'), `alpha memory missing: ${texts.join('|')}`)
  })

  const alphaList = await attempt('acm_task_list', {}, cfg('alpha-reader', 'alpha'))
  await t('and lists only its own project’s tasks', () => {
    assert.equal(alphaList.threw, false, `an alpha reader was refused: ${JSON.stringify(alphaList).slice(0, 200)}`)
    const keys = alphaList.value.items.map((x) => x.key)
    assert.ok(keys.includes('T-alpha'), `alpha task missing: ${keys.join(',')}`)
    assert.ok(!keys.includes('T-beta'), `alpha reader listed a beta task: ${keys.join(',')}`)
  })

  const beforeEvents = eventCount('T-beta')
  const crossGet = await attempt('acm_task_get', { key: 'T-beta' }, cfg('alpha-reader', 'alpha'))
  const missingGet = await attempt('acm_task_get', { key: 'T-nope' }, cfg('alpha-reader', 'alpha'))
  await t('and cannot read another project’s task, which answers like a missing key', () => {
    assert.equal(crossGet.threw, false, `the read threw instead of answering not-found: ${JSON.stringify(crossGet).slice(0, 200)}`)
    assert.equal(crossGet.value?.ok, false, `alpha reader read a beta task: ${JSON.stringify(crossGet.value).slice(0, 200)}`)
    assert.equal(crossGet.value?.reason, 'not-found', 'the refusal named another project')
    assert.equal(
      JSON.stringify(crossGet.value),
      JSON.stringify(missingGet.value),
      `another project’s key is distinguishable from a missing one:\n  ${JSON.stringify(crossGet.value)}\n  ${JSON.stringify(missingGet.value)}`,
    )
    assert.equal(taskState('T-beta'), 'returned', 'a refused read changed the task')
    assert.equal(eventCount('T-beta'), beforeEvents, 'a refused read wrote an event')
  })

  // ---------------------------------- partition-wide grant, project still set
  const wideList = await attempt('acm_task_list', {}, cfg('wide-reader', 'alpha'))
  await t('an untargeted grant does not widen the caller’s declared project', () => {
    assert.equal(wideList.threw, false, `a wide reader was refused: ${JSON.stringify(wideList).slice(0, 200)}`)
    const keys = wideList.value.items.map((x) => x.key)
    assert.ok(keys.includes('T-alpha'), 'a wide reader lost its own project')
    assert.ok(!keys.includes('T-beta'), `a wide grant read past the declared project: ${keys.join(',')}`)
  })

  // -------------------------------- a caller that declares no project at all
  const nullAlpha = await attempt('acm_task_list', {}, cfg('null-alpha', null))
  await t('a caller with no declared project needs a partition-wide grant', () => {
    assert.equal(nullAlpha.threw, true, `an alpha grant covered a project-less reader: ${JSON.stringify(nullAlpha).slice(0, 200)}`)
    assert.equal(nullAlpha.code, 'not-authorized', `wrong refusal: ${nullAlpha.code}`)
  })

  const nullWide = await attempt('acm_task_list', {}, cfg('null-wide', null))
  await t('and with one, reads the whole partition', () => {
    assert.equal(nullWide.threw, false, `a partition reader was refused: ${JSON.stringify(nullWide).slice(0, 200)}`)
    const keys = nullWide.value.items.map((x) => x.key)
    assert.ok(keys.includes('T-alpha') && keys.includes('T-beta'), `partition reader filtered: ${keys.join(',')}`)
  })

  // ------------------------------------------------ mailbox: read and write
  //
  // A mailbox row is data in the partition. Reading it is a read; delivering to it
  // is a write. Both surfaces answered any caller: `acm_inbox` had no gate at all,
  // and `acm_send` inserted its row before asking anything - so a principal with no
  // grants could read every message in the store and put words in any inbox.
  const mailboxCount = () => Number(db.prepare('select count(*) as c from acm_mailbox').get().c)
  db.prepare(
    `insert into acm_mailbox (owner, recipient, sender, kind, body, state, created_at)
     values ('bob', 'alpha-reader', 'seed', 'notice', 'SEEDED-MESSAGE', 'pending', 1)`,
  ).run()

  const inboxDenied = await attempt('acm_inbox', {}, cfg('nobody', 'alpha'))
  await t('a caller with no grant cannot read a mailbox', () => {
    assert.equal(inboxDenied.threw, true, `inbox answered a caller with no grant: ${JSON.stringify(inboxDenied).slice(0, 200)}`)
    assert.equal(inboxDenied.code, 'not-authorized', `wrong refusal: ${inboxDenied.code}`)
  })

  const mailBefore = mailboxCount()
  const sendDenied = await attempt('acm_send', { to: 'alpha-reader', body: 'a stranger wrote this' }, cfg('nobody', 'alpha'))
  await t('nor deliver into one, and the refused delivery leaves no row', () => {
    assert.equal(sendDenied.threw, true, `send answered a caller with no grant: ${JSON.stringify(sendDenied).slice(0, 200)}`)
    assert.equal(sendDenied.code, 'not-authorized', `wrong refusal: ${sendDenied.code}`)
    assert.equal(mailboxCount(), mailBefore, 'a refused delivery still wrote a mailbox row')
  })

  const inboxAllowed = await attempt('acm_inbox', {}, cfg('alpha-reader', 'alpha'))
  await t('a reader with memory:read sees its own mailbox', () => {
    assert.equal(inboxAllowed.threw, false, `a granted reader was refused: ${JSON.stringify(inboxAllowed).slice(0, 200)}`)
    const bodies = inboxAllowed.value.items.map((m) => m.body)
    assert.ok(bodies.includes('SEEDED-MESSAGE'), `the message was not returned: ${bodies.join('|')}`)
  })

  const sendAllowed = await attempt('acm_send', { to: 'alpha-reader', body: 'DELIVERED-BY-MAILER' }, cfg('mailer', 'alpha'))
  await t('and a principal holding mailbox:send can deliver', () => {
    assert.equal(sendAllowed.threw, false, `a mailer was refused: ${JSON.stringify(sendAllowed).slice(0, 200)}`)
    assert.ok(Number(sendAllowed.value?.id) > 0, `no message id returned: ${JSON.stringify(sendAllowed.value).slice(0, 120)}`)
    assert.equal(mailboxCount(), mailBefore + 1, 'the delivery did not add exactly one row')
  })

  // --------------------------------------- the seven that used to ask nothing
  //
  // These tools carried no `action` and never called `requireActionFor`, so a
  // caller holding no grant at all reached them. Measured on the real host before
  // the fix, an ungranted scoped client read a private fact through
  // `acm_history`, wrote a checkpoint, set an alias on another principal's name,
  // and marked a memory `forgotten` - the owner then saw `[forgotten]`.
  //
  // `acm_gc` and `acm_evolve` were the two that were not simply open: both throw
  // unless `owner == null` and `adminTools === true`. They still had no verb, so
  // they get `operator:maintain` as well, which is a separate condition and not a
  // replacement for the administrative one.
  const tables = ['acm_nodes', 'acm_aliases', 'acm_checkpoints', 'acm_feedback', 'acm_source_events', 'acm_node_sources']
  const dump = () => tables.map((t) => `${t}=${JSON.stringify(db.prepare(`select * from ${t}`).all())}`).join('\n')
  const seededId = db.prepare("select id from acm_nodes where key = 'alpha.fact'").get().id

  const ungated = [
    ['acm_history', { limit: 5 }, 'memory:read'],
    ['acm_checkpoint', { goal: 'injected goal' }, 'memory:write-session'],
    ['acm_alias', { alias: 'boss', canonical: 'bob' }, 'memory:write-global'],
    ['acm_forget', { id: seededId }, 'memory:forget'],
    ['acm_feedback', { id: seededId, verdict: 'wrong' }, 'memory:write-session'],
    ['acm_gc', { dryRun: true }, 'operator:maintain'],
    ['acm_evolve', { dryRun: true }, 'operator:maintain'],
  ]

  for (const [name, args, verb] of ungated) {
    const before = dump()
    const denied = await attempt(name, args, cfg('nobody', 'alpha'))
    await t(`${name} refuses a caller with no grant, and changes nothing`, () => {
      assert.equal(denied.threw, true, `${name} answered a caller with no grant: ${JSON.stringify(denied).slice(0, 200)}`)
      assert.equal(denied.code, 'not-authorized', `${name} refused with ${denied.code}`)
      assert.match(String(denied.message), new RegExp(verb.replace(':', '\\:')), `${name} did not name ${verb}: ${denied.message}`)
      assert.equal(dump(), before, `${name} changed the store while refusing`)
    })
  }

  // The refusal must not depend on the tool being hidden from `tools/list`: a
  // caller that knows the name calls it directly, and gets the same refusal.
  const directForget = await attempt('acm_forget', { id: seededId }, cfg('nobody', 'alpha'))
  await t('hiding a tool is not what refuses it', () => {
    assert.equal(directForget.threw, true, 'a named call bypassed the gate')
    assert.equal(db.prepare("select count(*) c from acm_nodes where key = 'alpha.fact'").get().c, 1, 'the memory disappeared')
  })

  // `local` mode keeps its documented meaning: the machine is trusted, so the
  // gate answers `local-trust` and nothing above changes for a single-user store.
  const localRead = await attempt('acm_task_get', { key: 'T-beta' }, cfg('nobody', null, 'local'))
  await t('local mode still answers without a grant', () => {
    assert.equal(localRead.threw, false, `local mode refused a read: ${JSON.stringify(localRead).slice(0, 200)}`)
    assert.equal(localRead.value?.ok, true, `local mode did not return the task: ${JSON.stringify(localRead.value).slice(0, 200)}`)
  })

  // ------------------------------- the tool surface and the SDK must agree
  //
  // This was two surfaces drifting apart: `sdk.forget` demanded
  // `memory:forget` from the day the SDK was written, while `acm_forget` - the
  // same operation - demanded nothing at all. A handle cannot be opened without a
  // grant in scoped mode, so this compares the declarations in the source rather
  // than calling into a handle it could not build.
  const sdkSource = readFileSync(new URL('../lib/sdk.mjs', import.meta.url), 'utf8')
  const sdkVerb = (method) => {
    const at = sdkSource.indexOf(`    ${method}(`)
    if (at < 0) return null
    const m = /authorize\('([^']+)'/.exec(sdkSource.slice(at, at + 400))
    return m?.[1] ?? null
  }
  const sameOperation = [
    ['acm_forget', 'forget'],
    ['acm_checkpoint', 'checkpoint'],
    ['acm_alias', 'alias'],
    ['acm_history', 'history'],
    ['acm_feedback', 'feedback'],
    ['acm_gc', 'gc'],
    ['acm_evolve', 'evolve'],
  ]
  for (const [toolName, method] of sameOperation) {
    await t(`${toolName} declares the verb its SDK method demands`, () => {
      const toolVerb = TOOLS.find((x) => x.name === toolName)?.action
      const sdk = sdkVerb(method)
      assert.ok(sdk, `sdk.${method} calls no authorize`)
      assert.equal(toolVerb, sdk, `tool declares ${toolVerb}, sdk.${method} demands ${sdk}`)
    })
  }

  console.log(`\ntool read gate: ${pass} passed`)
} finally {
  db.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${dir}`)
  }
}
