#!/usr/bin/env node
/**
 * Can the acceptance step be done by a process that was told nothing?
 *
 * The scoped flow proved that a reviewer principal can call `acm_task_verify`.
 * It did not prove that the reviewer could *justify* the call: the driver held the
 * token, the row id and the expected digest in memory, handed them to the reviewer
 * section, and compared. A reviewer that is given the answer and asked to agree is
 * not an acceptance step.
 *
 * So this script makes the reviewer a **separate process** and gives it two things:
 * an identity and a task key. No token, no id, no digest, no expected verdict - the
 * environment is built from scratch rather than inherited. If the acceptance can be
 * completed, it is because the returned work carries enough to re-derive it.
 *
 * Three tasks are staged by a planner and a worker through the tool surface:
 *
 *   honest   the result names a memory id and its digest, and both are true
 *   wrong    the same shape, with one hex digit of the digest changed
 *   missing  a well-formed reference to a memory that was never written
 *
 * The reviewer must verify the first and reject the other two. A driver that
 * checked nothing would verify all three; that is the failure this pins.
 *
 *   node scripts/acceptance-blind.mjs [--json] [--keep]
 *   node scripts/acceptance-blind.mjs --review <key>     internal: the reviewer side
 *
 * Exit codes: 0 every expectation held, 1 one did not, 2 usage or setup error.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { grant } from '../lib/auth.mjs'
import { McpAgent } from './mcp-agent.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const self = fileURLToPath(import.meta.url)
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')
const digest = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16)

// ── the reviewer side ───────────────────────────────────────────────────────
// Everything below runs in a process that received a key and nothing else. It
// reads the task, parses what the worker wrote, and re-derives the claim from the
// store. It never sees the staging code above.

async function reviewerSide(key) {
  const dbPath = process.env.ACM_DB
  const owner = process.env.ACM_OWNER ?? null
  if (!dbPath) throw new Error('ACM_DB is required in review mode')

  const s = new McpAgent('reviewer', { dbPath, mcpPath, env: owner ? { ACM_OWNER: owner } : {} })
  const checks = []
  const step = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok }
  const verdict = (v, reason) => ({ verdict: v, reason, checks })

  try {
    await s.start()

    const got = await s.tool('acm_task_get', { key })
    const task = got.value?.task
    if (!step('the task is readable', Boolean(task), got.ok ? (task?.state ?? 'no task') : got.error)) {
      return verdict('rejected', 'task-not-readable')
    }
    if (!step('the task is waiting for acceptance', task.state === 'returned', `state ${task.state}`)) {
      return verdict('rejected', `not-returned:${task.state}`)
    }

    // The result is the worker's persistence, not a value passed in. A reviewer
    // that cannot parse it has nothing to check, and says so.
    const text = String(task.result ?? '')
    const parsed = text.match(/recorded (\S+) as memory #(\d+), digest ([0-9a-f]{16})/)
    if (!step('the result states what it did, in a form that can be re-checked', Boolean(parsed), text.slice(0, 80))) {
      return verdict('rejected', 'result-not-parseable')
    }
    const [, token, idText, claimed] = parsed
    const id = Number(idText)

    // The evidence must corroborate the result. Two records that disagree are
    // worse than one record: a successor cannot tell which one is the work.
    const cited = (task.evidence ?? []).filter((e) => e.kind === 'memory')
    if (!step('the return cites the memory as evidence', cited.length > 0, `${(task.evidence ?? []).length} evidence rows`)) {
      return verdict('rejected', 'no-memory-evidence')
    }
    if (!step('the evidence names the same row and digest as the result', cited.some((e) => e.ref === `${id}#${claimed}`), cited.map((e) => e.ref).join(' '))) {
      return verdict('rejected', 'evidence-does-not-match-result')
    }

    // Re-read. `scope: 'all'` reaches the worker's session; the digest is computed
    // from the row that came back, not from anything this process was told.
    const found = await s.tool('acm_search', { query: token, scope: 'all' })
    const row = (found.value?.items ?? []).find((i) => i.id === id)
    if (!step('the memory the result names exists', Boolean(row), row ? `#${row.id}` : `${(found.value?.items ?? []).length} hits, no #${id}`)) {
      return verdict('rejected', 'referenced-memory-not-found')
    }
    const actual = digest(row.text)
    if (!step('the digest recomputed from the store matches the claim', actual === claimed, `claimed ${claimed}, actual ${actual}`)) {
      return verdict('rejected', `digest-mismatch:${claimed}!=${actual}`)
    }

    const verified = await s.tool('acm_task_verify', { key, note: `re-read memory #${id}, digest ${actual}` })
    if (!step('the store accepts the verification', verified.value?.task?.state === 'verified', verified.value?.task?.state ?? verified.error ?? '?')) {
      return verdict('rejected', `verify-refused:${verified.value?.reason ?? verified.error ?? '?'}`)
    }
    return verdict('verified', `memory #${id}, digest ${actual}`)
  } finally {
    await s.stop()
  }
}

// ── the staging side ────────────────────────────────────────────────────────

const ORDER = ['honest', 'wrong', 'missing']

const ROLES = {
  planner: ['memory:read', 'task:create', 'task:assign'],
  worker: ['memory:read', 'memory:write-session', 'task:accept', 'task:return'],
  reviewer: ['memory:read', 'task:verify', 'task:reject'],
}

function seedGrants(dbPath, owner) {
  const db = openDb(dbPath)
  try {
    for (const [agent, actions] of Object.entries(ROLES)) {
      for (const action of actions) {
        const r = grant(db, { principal: { kind: 'agent', id: agent, owner, project: null }, action, grantedBy: 'acceptance-blind' })
        if (!r.ok) throw new Error(`grant ${agent}/${action} failed: ${r.reason}`)
      }
    }
  } finally {
    db.close()
  }
}

/** Stage one task and return what the *driver* knows - which the reviewer will not. */
async function stage(planner, worker, owner, kind, runId) {
  const made = await planner.tool('acm_task_create', {
    title: `${kind} work for ${runId}`,
    detail: `record a memory that starts with ${runId}-${kind}, then return its id and digest`,
    assignee: 'worker',
  })
  if (!made.ok) throw new Error(`create failed: ${made.error}`)
  const key = made.value?.task?.key
  if (!key) throw new Error('create returned no key')

  const accepted = await worker.tool('acm_task_accept', { key })
  if (accepted.value?.task?.state !== 'running') throw new Error(`accept failed: ${accepted.value?.reason ?? accepted.error}`)

  const token = `${runId}-${kind}`
  const wrote = await worker.tool('acm_remember', { text: `${token} recorded by worker`, scope: 'session', kind: 'fact' })
  const id = wrote.value?.id
  if (!Number.isInteger(id)) throw new Error(`remember failed: ${wrote.error ?? JSON.stringify(wrote.value)}`)

  const read = await worker.tool('acm_search', { query: token })
  const row = (read.value?.items ?? []).find((i) => i.id === id)
  if (!row) throw new Error('the memory did not read back')
  const real = digest(row.text)

  // The three shapes differ only in what the claim is worth. The reviewer has to
  // tell them apart without being told which is which.
  let claimId = id
  let claimDigest = real
  if (kind === 'wrong') claimDigest = `${real.slice(0, 15)}${real[15] === '0' ? '1' : '0'}`
  if (kind === 'missing') claimId = 999_999

  const ret = await worker.tool('acm_task_return', {
    key,
    result: `recorded ${token} as memory #${claimId}, digest ${claimDigest}`,
    evidence: `memory:${claimId}#${claimDigest}\nnote:acm_remember then acm_search in one worker session`,
  })
  if (ret.value?.task?.state !== 'returned') throw new Error(`return failed: ${ret.value?.reason ?? ret.error}`)

  return { kind, key, token, trueId: id, trueDigest: real, claimId, claimDigest }
}

function reviewInChild(dbPath, owner, key) {
  // Built, not inherited. If the reviewer ever needed something the staging side
  // holds, this is the line that would have to change - and it is visible.
  const env = {
    PATH: process.env.PATH,
    ACM_DB: dbPath,
    ACM_OWNER: owner,
    ACM_AGENT: 'reviewer',
    ACM_SESSION: `acceptance-review-${Date.now()}`,
    ACM_AUTH_MODE: 'scoped',
  }
  const out = spawnSync(process.execPath, [self, '--review', key], { env, encoding: 'utf8', timeout: 120_000 })
  const line = String(out.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  if (!line) return { verdict: 'error', reason: `no output (exit ${out.status}): ${String(out.stderr ?? '').slice(-300)}`, checks: [] }
  try {
    return JSON.parse(line)
  } catch {
    return { verdict: 'error', reason: `unparseable output: ${line.slice(0, 200)}`, checks: [] }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const keep = argv.includes('--keep')
  const dbArg = argv[argv.indexOf('--db') + 1]

  const dir = mkdtempSync(join(tmpdir(), 'acm-acceptance-'))
  const dbPath = dbArg && !dbArg.startsWith('--') ? dbArg : join(dir, 'store.sqlite')
  const owner = 'acceptance-blind'
  const runId = `ab-${Date.now().toString(36)}`

  seedGrants(dbPath, owner)

  const planner = new McpAgent('planner', { dbPath, mcpPath, env: { ACM_OWNER: owner } })
  const worker = new McpAgent('worker', { dbPath, mcpPath, env: { ACM_OWNER: owner } })
  const rows = []
  const results = []

  try {
    await planner.start()
    await worker.start()
    for (const kind of ORDER) rows.push(await stage(planner, worker, owner, kind, runId))
  } finally {
    // Stop the staging processes before any reviewer starts. From here on the
    // reviewer cannot reach the driver's memory by talking to it.
    await planner.stop()
    await worker.stop()
  }

  for (const row of rows) {
    const answer = reviewInChild(dbPath, owner, row.key)
    results.push({ ...row, answer })
  }

  // Read the store, not the answers: the claim is about what happened to the task,
  // and a reviewer that said "rejected" while the row moved to verified would be
  // worse than a wrong label.
  const db = openDb(dbPath)
  let states
  try {
    states = Object.fromEntries(
      db.prepare('select task_key, state from acm_tasks').all().map((r) => [r.task_key, r.state]),
    )
  } finally {
    db.close()
  }
  for (const r of results) r.state = states[r.key] ?? null

  const expectations = {
    honest: (r) => r.answer.verdict === 'verified' && r.state === 'verified',
    wrong: (r) => r.answer.verdict === 'rejected' && r.state !== 'verified' && /digest/i.test(String(r.answer.reason)),
    missing: (r) => r.answer.verdict === 'rejected' && r.state !== 'verified' && /not-found/i.test(String(r.answer.reason)),
  }
  const lines = results.map((r) => ({
    kind: r.kind,
    verdict: r.answer.verdict,
    reason: r.answer.reason,
    state: r.state,
    checks: r.answer.checks?.length ?? 0,
    ok: expectations[r.kind](r),
  }))
  const failed = lines.filter((l) => !l.ok)

  if (asJson) {
    console.log(JSON.stringify({ dbPath: keep ? dbPath : null, results: lines }, null, 1))
  } else {
    for (const l of lines) {
      console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.kind}: reviewer ${l.verdict} (${l.reason}), task ${l.state}, ${l.checks} checks`)
    }
    console.log(`acceptance blind: ${lines.length - failed.length}/${lines.length} as expected`)
    if (keep) console.log(`store kept at ${dbPath}`)
  }

  if (!keep) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return failed.length === 0 ? 0 : 1
}

if (process.argv.includes('--review')) {
  const i = process.argv.indexOf('--review')
  const key = process.argv[i + 1]
  if (!key) { console.error('--review needs a task key'); process.exit(2) }
  reviewerSide(key)
    .then((r) => {
      console.log(JSON.stringify(r))
      process.exit(r.verdict === 'verified' ? 0 : 3)
    })
    .catch((err) => {
      console.log(JSON.stringify({ verdict: 'error', reason: String(err?.message ?? err), checks: [] }))
      process.exit(4)
    })
} else {
  main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`acceptance blind failed: ${err?.stack ?? err}`); process.exit(2) })
}
