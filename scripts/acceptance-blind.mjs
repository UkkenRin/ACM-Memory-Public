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
 * A fourth task exercises the loop instead of a single verdict. The worker is
 * asked for a memory with an exact text and returns a different memory: same
 * shape, same digest discipline, wrong subject. The worker process then exits.
 * A fresh reviewer rejects it; a *restarted* worker has to rediscover the task
 * from its own queue, read the reason it was sent back, and fix the artifact;
 * a second fresh reviewer verifies. Both attempts stay readable afterwards.
 *
 *   node scripts/acceptance-blind.mjs [--json] [--keep]
 *   node scripts/acceptance-blind.mjs --review <key>     internal: the reviewer side
 *   node scripts/acceptance-blind.mjs --resume-worker    internal: the restarted worker
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

/**
 * The requirement is in the task, not in this file. It is read out of the detail
 * text so that the check below is about the task as assigned - a reviewer that
 * carried its own copy of the requirement would be checking the driver again.
 */
function requirementOf(detail) {
  const text = String(detail ?? '')
  const exact = text.match(/text is exactly "([^"]+)"/)
  if (exact) return { mode: 'exactly', text: exact[1] }
  const prefix = text.match(/starts with "([^"]+)"/)
  if (prefix) return { mode: 'prefix', text: prefix[1] }
  return null
}

function satisfies(requirement, actual) {
  if (!requirement) return true
  const got = String(actual ?? '')
  return requirement.mode === 'exactly' ? got === requirement.text : got.startsWith(requirement.text)
}

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
  // Saying "rejected" in stdout is not a decision. The store has to learn it too,
  // or the worker's queue never changes and the process that comes back has
  // nothing to come back to.
  const refuse = async (reason) => {
    const r = await s.tool('acm_task_reject', { key, reason })
    const state = r.value?.task?.state ?? null
    step('the store records the rejection', state === 'assigned', state ?? r.value?.reason ?? r.error ?? '?')
    return { ...verdict('rejected', reason), state }
  }

  try {
    await s.start()

    const got = await s.tool('acm_task_get', { key })
    const task = got.value?.task
    if (!step('the task is readable', Boolean(task), got.ok ? (task?.state ?? 'no task') : got.error)) {
      return refuse('task-not-readable')
    }
    if (!step('the task is waiting for acceptance', task.state === 'returned', `state ${task.state}`)) {
      return verdict('rejected', `not-returned:${task.state}`)
    }

    // The result is the worker's persistence, not a value passed in. A reviewer
    // that cannot parse it has nothing to check, and says so.
    const text = String(task.result ?? '')
    const parsed = text.match(/recorded (\S+) as memory #(\d+), digest ([0-9a-f]{16})/)
    if (!step('the result states what it did, in a form that can be re-checked', Boolean(parsed), text.slice(0, 80))) {
      return refuse('result-not-parseable')
    }
    const [, token, idText, claimed] = parsed
    const id = Number(idText)

    // The evidence must corroborate the result. Two records that disagree are
    // worse than one record: a successor cannot tell which one is the work.
    const cited = (task.evidence ?? []).filter((e) => e.kind === 'memory')
    if (!step('the return cites the memory as evidence', cited.length > 0, `${(task.evidence ?? []).length} evidence rows`)) {
      return refuse('no-memory-evidence')
    }
    if (!step('the evidence names the same row and digest as the result', cited.some((e) => e.ref === `${id}#${claimed}`), cited.map((e) => e.ref).join(' '))) {
      return refuse('evidence-does-not-match-result')
    }

    // Re-read. `scope: 'all'` reaches the worker's session; the digest is computed
    // from the row that came back, not from anything this process was told.
    const found = await s.tool('acm_search', { query: token, scope: 'all' })
    const row = (found.value?.items ?? []).find((i) => i.id === id)
    if (!step('the memory the result names exists', Boolean(row), row ? `#${row.id}` : `${(found.value?.items ?? []).length} hits, no #${id}`)) {
      return refuse('referenced-memory-not-found')
    }
    const actual = digest(row.text)
    if (!step('the digest recomputed from the store matches the claim', actual === claimed, `claimed ${claimed}, actual ${actual}`)) {
      return refuse(`digest-mismatch:${claimed}!=${actual}`)
    }

    // The citation is checked; the requirement may not be. A matching digest only
    // says the reference is internally consistent - two memories written in one
    // session can both be real and only one be the work. When the requirement is
    // not written in a form this process can decide, the honest answer is "I
    // checked the reference and I cannot judge the work": the task stays where the
    // worker left it and a human or a smarter reader takes it. Verifying here would
    // be the same failure as verifying without reading anything, only quieter.
    const req = requirementOf(task.detail)
    if (!req) {
      step('the requirement is stated in a form this reviewer can decide', false, JSON.stringify(String(task.detail ?? '').slice(0, 80)))
      return { verdict: 'needs-review', reason: `requirement-not-parseable: cited memory #${id}, digest ${actual} checks out`, checks, state: task.state }
    }
    if (!step(`the cited memory is the one the task asked for (${req.mode} "${req.text}")`,
      satisfies(req, row.text), JSON.stringify(String(row.text ?? '').slice(0, 80)))) {
      return refuse(`requirement-not-met:${req.mode}`)
    }

    const verified = await s.tool('acm_task_verify', { key, note: `re-read memory #${id}, digest ${actual}` })
    if (!step('the store accepts the verification', verified.value?.task?.state === 'verified', verified.value?.task?.state ?? verified.error ?? '?')) {
      return refuse(`verify-refused:${verified.value?.reason ?? verified.error ?? '?'}`)
    }
    return verdict('verified', `memory #${id}, digest ${actual}`)
  } finally {
    await s.stop()
  }
}

// ── the staging side ────────────────────────────────────────────────────────

// The last one is the shape a real task often takes: the requirement is prose, not
// a pattern. Nine reviewers out of ten would read it and judge it; a script can
// only decide what it can parse, and must say so rather than fall through to the
// digest check and call that acceptance.
const FREEFORM = '\u8bf7\u628a\u989c\u8272\u4fdd\u5b58\u4e3a\u84dd\u8272\u3002'

const ORDER = ['honest', 'wrong', 'missing', 'freeform']

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
  const token = `${runId}-${kind}`
  const made = await planner.tool('acm_task_create', {
    title: `${kind} work for ${runId}`,
    detail: kind === 'freeform' ? FREEFORM : `record a memory that starts with "${token}", then return its id and digest`,
    assignee: 'worker',
  })
  if (!made.ok) throw new Error(`create failed: ${made.error}`)
  const key = made.value?.task?.key
  if (!key) throw new Error('create returned no key')

  const accepted = await worker.tool('acm_task_accept', { key })
  if (accepted.value?.task?.state !== 'running') throw new Error(`accept failed: ${accepted.value?.reason ?? accepted.error}`)

  // For the free-form task the artifact is deliberately *not* what the prose asks
  // for. A reviewer that cannot read the prose has no way to notice, which is
  // exactly the case being pinned.
  const body = kind === 'freeform' ? `${token} orange fixture` : `${token} recorded by worker`
  const wrote = await worker.tool('acm_remember', { text: body, scope: 'session', kind: 'fact' })
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

/**
 * The resume task. The worker does real work and writes two memories: the one
 * the task asks for, and a decoy with the same prefix. It then returns the decoy
 * - a citation that parses, that names a row that exists, that carries that
 * row's true digest, and that is not the artifact the task asked for.
 *
 * A reviewer that only re-derives the digest accepts this. That is the point.
 */
async function stageResume(planner, worker, owner, runId) {
  const token = `${runId}-resume`
  const required = `${token}-done`
  const made = await planner.tool('acm_task_create', {
    title: `resume work for ${runId}`,
    detail: `record a memory whose text is exactly "${required}", then return its id and digest`,
    assignee: 'worker',
  })
  if (!made.ok) throw new Error(`create failed: ${made.error}`)
  const key = made.value?.task?.key
  if (!key) throw new Error('create returned no key')

  const accepted = await worker.tool('acm_task_accept', { key })
  if (accepted.value?.task?.state !== 'running') throw new Error(`accept failed: ${accepted.value?.reason ?? accepted.error}`)

  const good = await worker.tool('acm_remember', { text: required, scope: 'session', kind: 'fact' })
  if (!Number.isInteger(good.value?.id)) throw new Error(`remember failed: ${good.error ?? JSON.stringify(good.value)}`)
  const decoy = await worker.tool('acm_remember', { text: `${token}-decoy`, scope: 'session', kind: 'fact' })
  if (!Number.isInteger(decoy.value?.id)) throw new Error(`remember failed: ${decoy.error ?? JSON.stringify(decoy.value)}`)

  const read = await worker.tool('acm_search', { query: token })
  const row = (read.value?.items ?? []).find((i) => i.id === decoy.value.id)
  if (!row) throw new Error('the decoy did not read back')

  const ret = await worker.tool('acm_task_return', {
    key,
    result: `recorded ${token} as memory #${row.id}, digest ${digest(row.text)}`,
    evidence: `memory:${row.id}#${digest(row.text)}\nnote:two memories written, this one cited`,
  })
  if (ret.value?.task?.state !== 'returned') throw new Error(`return failed: ${ret.value?.reason ?? ret.error}`)

  return { kind: 'resume', key, token, required, trueId: good.value.id, decoyId: row.id, decoyDigest: digest(row.text) }
}

// ── the restarted worker ────────────────────────────────────────────────────
// Started after the rejection, with an identity and nothing else. It finds the
// task on its own queue, reads why it came back, and fixes the artifact. No key
// and no expected text are passed in; the detail it reads is the same detail the
// reviewer reads.

async function resumeWorkerSide() {
  const dbPath = process.env.ACM_DB
  const owner = process.env.ACM_OWNER ?? null
  if (!dbPath) throw new Error('ACM_DB is required in resume mode')

  const s = new McpAgent('worker', { dbPath, mcpPath, env: owner ? { ACM_OWNER: owner } : {} })
  const notes = []
  const step = (name, ok, detail) => { notes.push({ name, ok, detail }); return ok }
  try {
    await s.start()
    const queue = await s.tool('acm_task_list', { state: 'assigned', assignee: 'worker' })
    const item = (queue.value?.items ?? [])[0]
    if (!step('a returned task is waiting on the worker queue', Boolean(item), `${(queue.value?.items ?? []).length} items`)) {
      return { ok: false, reason: 'no-task-on-queue', notes }
    }
    const key = item.key
    const got = await s.tool('acm_task_get', { key })
    const task = got.value?.task
    const sentBack = got.value?.events?.filter((e) => e.action === 'reject').pop()
    const why = task?.lastReason ?? sentBack?.payload?.reason ?? null
    if (!step('the reason it was sent back is readable from the record', Boolean(why), String(why))) {
      return { ok: false, key, reason: 'no-reason-on-record', notes }
    }
    const req = requirementOf(task?.detail)
    if (!step('the requirement is readable from the task', Boolean(req), String(task?.detail ?? '').slice(0, 60))) {
      return { ok: false, key, reason: 'no-requirement', notes }
    }

    const accepted = await s.tool('acm_task_accept', { key })
    if (accepted.value?.task?.state !== 'running') return { ok: false, key, reason: `accept-refused:${accepted.value?.reason ?? accepted.error}`, notes }
    const wrote = await s.tool('acm_remember', { text: req.text, scope: 'session', kind: 'fact' })
    if (!Number.isInteger(wrote.value?.id)) return { ok: false, key, reason: `remember-failed:${wrote.error}`, notes }
    const read = await s.tool('acm_search', { query: req.text })
    const row = (read.value?.items ?? []).find((i) => i.id === wrote.value.id)
    if (!row) return { ok: false, key, reason: 'memory-did-not-read-back', notes }
    const ret = await s.tool('acm_task_return', {
      key,
      result: `recorded ${req.text} as memory #${row.id}, digest ${digest(row.text)}`,
      evidence: `memory:${row.id}#${digest(row.text)}\nnote:fixed after ${why}`,
    })
    if (ret.value?.task?.state !== 'returned') return { ok: false, key, reason: `return-refused:${ret.value?.reason ?? ret.error}`, notes }
    return { ok: true, key, reason: why, id: row.id, digest: digest(row.text), state: ret.value.task.state, notes }
  } finally {
    await s.stop()
  }
}

function resumeWorkerInChild(dbPath, owner) {
  const env = {
    PATH: process.env.PATH,
    ACM_DB: dbPath,
    ACM_OWNER: owner,
    ACM_AGENT: 'worker',
    ACM_SESSION: `acceptance-resume-${Date.now()}`,
    ACM_AUTH_MODE: 'scoped',
  }
  const out = spawnSync(process.execPath, [self, '--resume-worker'], { env, encoding: 'utf8', timeout: 120_000 })
  const line = String(out.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  if (!line) return { ok: false, reason: `no output (exit ${out.status}): ${String(out.stderr ?? '').slice(-300)}`, notes: [] }
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, reason: `unparseable output: ${line.slice(0, 200)}`, notes: [] }
  }
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
  let resume = null

  try {
    await planner.start()
    await worker.start()
    for (const kind of ORDER) rows.push(await stage(planner, worker, owner, kind, runId))
    resume = await stageResume(planner, worker, owner, runId)
  } finally {
    // Stop the staging processes before any reviewer starts. From here on the
    // reviewer cannot reach the driver's memory by talking to it - and for the
    // resume task the worker is gone as well, so the second attempt has to come
    // from a process that was not there for the first one.
    await planner.stop()
    await worker.stop()
  }

  for (const row of rows) {
    const answer = reviewInChild(dbPath, owner, row.key)
    results.push({ ...row, answer })
  }

  const stateOf = (key) => {
    const d = openDb(dbPath)
    try {
      const row = d.prepare('select state from acm_tasks where task_key = ?').get(key)
      return row?.state ?? null
    } finally {
      d.close()
    }
  }

  // The loop, in the order it would happen: review, send back, restart, review.
  // The driver never passes the requirement, the reason or the key to either side
  // except through the store.
  const firstAnswer = reviewInChild(dbPath, owner, resume.key)
  const firstState = stateOf(resume.key)
  const restarted = resumeWorkerInChild(dbPath, owner)
  const secondAnswer = reviewInChild(dbPath, owner, resume.key)

  // Read the store, not the answers: the claim is about what happened to the task,
  // and a reviewer that said "rejected" while the row moved to verified would be
  // worse than a wrong label.
  const db = openDb(dbPath)
  let states
  let trail
  try {
    states = Object.fromEntries(
      db.prepare('select task_key, state from acm_tasks').all().map((r) => [r.task_key, r.state]),
    )
    trail = db.prepare('select action, actor, payload from acm_task_events where task_key = ? order by id').all(resume.key)
  } finally {
    db.close()
  }
  for (const r of results) r.state = states[r.key] ?? null

  const count = (action) => trail.filter((e) => e.action === action).length
  const returns = count('return')
  const rejects = count('reject')
  const verifies = count('verify')

  const expectations = {
    honest: (r) => r.answer.verdict === 'verified' && r.state === 'verified',
    wrong: (r) => r.answer.verdict === 'rejected' && r.state !== 'verified' && /digest/i.test(String(r.answer.reason)),
    missing: (r) => r.answer.verdict === 'rejected' && r.state !== 'verified' && /not-found/i.test(String(r.answer.reason)),
    freeform: (r) => r.answer.verdict === 'needs-review' && r.state === 'returned' && /not-parseable/i.test(String(r.answer.reason)),
  }
  const lines = results.map((r) => ({
    kind: r.kind,
    verdict: r.answer.verdict,
    reason: r.answer.reason,
    state: r.state,
    checks: r.answer.checks?.length ?? 0,
    ok: expectations[r.kind](r),
  }))

  // A second attempt that only exists because the driver asked for it would not
  // prove the loop. Every clause below is read from the store or from a process
  // that was started after the rejection.
  const resumeOk =
    firstAnswer.verdict === 'rejected' && /requirement-not-met/.test(String(firstAnswer.reason)) &&
    firstState === 'assigned' &&
    restarted.ok === true && /requirement-not-met/.test(String(restarted.reason)) &&
    secondAnswer.verdict === 'verified' &&
    states[resume.key] === 'verified' &&
    returns === 2 && rejects === 1 && verifies === 1

  lines.push({
    kind: 'resume',
    verdict: secondAnswer.verdict,
    reason: `attempt 1 ${firstAnswer.verdict} (${firstAnswer.reason}), restarted worker ${restarted.ok ? `read "${restarted.reason}"` : `failed: ${restarted.reason}`}, attempt 2 ${secondAnswer.verdict} (${secondAnswer.reason})`,
    state: states[resume.key] ?? null,
    checks: (firstAnswer.checks?.length ?? 0) + (secondAnswer.checks?.length ?? 0),
    attempts: { first: firstAnswer.reason, second: secondAnswer.reason },
    log: { returns, rejects, verifies },
    ok: resumeOk,
  })
  const failed = lines.filter((l) => !l.ok)

  if (asJson) {
    console.log(JSON.stringify({ dbPath: keep ? dbPath : null, results: lines }, null, 1))
  } else {
    for (const l of lines) {
      const log = l.log ? `, ${l.log.returns} returns / ${l.log.rejects} reject / ${l.log.verifies} verify on record` : ''
      console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.kind}: reviewer ${l.verdict} (${l.reason}), task ${l.state}, ${l.checks} checks${log}`)
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
} else if (process.argv.includes('--resume-worker')) {
  resumeWorkerSide()
    .then((r) => {
      console.log(JSON.stringify(r))
      process.exit(r.ok ? 0 : 3)
    })
    .catch((err) => {
      console.log(JSON.stringify({ ok: false, reason: String(err?.message ?? err), notes: [] }))
      process.exit(4)
    })
} else {
  main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`acceptance blind failed: ${err?.stack ?? err}`); process.exit(2) })
}
