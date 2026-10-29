#!/usr/bin/env node
/**
 * Scoped mode, with grants in place, across separate processes.
 *
 * `mcp-connect.mjs --expect denied` proves the negative half: a caller with no
 * credential is refused, and the tool surface shrinks to what it may call. The
 * audit's independent run of that script and its own JSON-RPC client confirmed the
 * refusals. What neither covered is the other half - three principals, each holding
 * only the verbs its role needs, doing one piece of work end to end while every
 * refusal stays in place. A store that refuses everything is as broken as one that
 * refuses nothing, and only the positive flow can tell them apart.
 *
 * So this script seeds grants (an operator's act, done here through the library),
 * then starts four MCP servers - one at a time, each its own process and session -
 * and speaks JSON-RPC to them. Every assertion below is about an answer that came
 * back over the pipe; the seeding is setup and is not counted as evidence.
 *
 *   node scripts/mcp-scoped-flow.mjs --fresh --db /tmp/scoped.sqlite
 *   node scripts/mcp-scoped-flow.mjs --log /tmp/scoped.jsonl
 *
 * Exit code is the verdict: 0 when every step passed.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { openDb } from '../lib/db.mjs'
import { grant } from '../lib/auth.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const dbPath = resolve(flag('db', '.tmp/mcp-scoped-flow.sqlite'))
const logPath = flag('log')
const keep = has('keep')
const owner = flag('owner', 'scoped-flow')
const mcpPath = flag('mcp', fileURLToPath(new URL('../lib/host/mcp.mjs', import.meta.url)))

if (has('fresh')) rmSync(dbPath, { force: true })
mkdirSync(dirname(dbPath), { recursive: true })

// The roles are grants, not names: nothing here says "planner may create" except
// this table, and `worker` holds `task:verify` on purpose - the refusal it gets
// later is about who it is, not about what it was allowed.
const ROLES = {
  planner: ['memory:read', 'memory:write-global', 'mailbox:send', 'task:create', 'task:assign'],
  worker: ['memory:read', 'mailbox:claim', 'mailbox:complete', 'task:accept', 'task:renew', 'task:return', 'task:verify'],
  reviewer: ['memory:read', 'task:verify', 'task:reject'],
  intruder: [],
}

const seed = openDb(dbPath)
try {
  for (const [agent, actions] of Object.entries(ROLES)) {
    const principal = { kind: 'agent', id: agent, owner, project: null }
    for (const action of actions) {
      const r = grant(seed, { principal, action, grantedBy: 'scoped-flow' })
      if (!r.ok) throw new Error(`seed failed for ${agent}/${action}: ${r.reason}`)
    }
  }
} finally {
  // Windows will not delete a file a handle still holds. Close before anything
  // else touches this path, and let the children open it themselves.
  seed.close()
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16)
const tape = []
let failures = 0

const record = (entry) => {
  tape.push(entry)
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
}

const check = (label, condition, detail = '') => {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
  record({ step: tape.length + 1, check: label, ok, detail })
  return ok
}

/** One server process, one session, nothing shared with the next but the file. */
function startAgent(agent) {
  const child = spawn(process.execPath, [mcpPath], {
    env: {
      ...process.env,
      ACM_DB: dbPath,
      ACM_OWNER: owner,
      ACM_AGENT: agent,
      ACM_SESSION: `scoped-${agent}-${Date.now()}`,
      ACM_AUTH_MODE: 'scoped',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderr = ''
  let closed = null
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })

  const pending = new Map()
  let nextId = 1
  child.on('exit', (code, signal) => {
    closed = `exit ${code ?? signal}`
    for (const [, entry] of pending) entry.reject(new Error(`server exited: ${closed}\n${stderr}`))
    pending.clear()
  })

  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let msg
    try { msg = JSON.parse(text) } catch { return }
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
    else entry.resolve(msg.result)
  })

  const rpc = (method, params) => new Promise((resolvePromise, rejectPromise) => {
    if (closed) return rejectPromise(new Error(`server is gone (${closed})`))
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`no answer to ${method} in 20s`))
    }, 20_000)
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  /** A tool call, split into "transport refused" and "store answered". */
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args })
    const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n')
    return { isError: Boolean(result?.isError), text, value: result?.structuredContent ?? null }
  }

  const tools = async () => (await rpc('tools/list', {})).tools.map((t) => t.name)

  return {
    rpc,
    call,
    tools,
    async open() {
      const init = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: `scoped-${agent}`, version: '1' },
      })
      return init
    },
    async close() {
      try { child.stdin.end() } catch {}
      child.kill()
    },
  }
}

async function as(agent, fn) {
  const s = startAgent(agent)
  try {
    await s.open()
    return await fn(s)
  } finally {
    await s.close()
  }
}

const looksDenied = (r) => r.isError && /not authorized/i.test(r.text)

try {
  console.log(`mcp   ${mcpPath}`)
  console.log(`db    ${dbPath} (owner ${owner}, auth mode scoped)`)
  console.log('')

  const work = {}
  work.fact = `scoped-flow-${digest(Date.now())}`

  // ---- planner: writes the work down and hands it over --------------------
  await as('planner', async (s) => {
    const names = await s.tools()
    check('planner sees the tool its grant names', names.includes('acm_task_create'), `${names.length} tools`)
    check('planner does not see a verb it does not hold', !names.includes('acm_task_verify'))

    const mem = await s.call('acm_remember', { text: `${work.fact}: the mirror is read-only`, scope: 'global', kind: 'fact' })
    // `acm_remember` answers with the row it wrote, not with `ok`, and its declared
    // output schema says so (`{id, superseded}`). The id is the success signal; a
    // client that looks for `ok` here is reading a different tool's contract.
    check('planner writes a global memory', Number.isInteger(mem.value?.id), `id ${mem.value?.id ?? '?'}${mem.isError ? ` / ${mem.text.slice(0, 60)}` : ''}`)
    work.memoryId = mem.value?.id ?? null

    const sent = await s.call('acm_send', { to: 'worker', body: 'read the mirror and report', messageKey: `${work.fact}-msg` })
    check('planner delivers a mailbox item', sent.value?.ok === true, `id ${sent.value?.id ?? '?'}`)
    work.messageId = sent.value?.id ?? null

    const again = await s.call('acm_send', { to: 'worker', body: 'read the mirror and report', messageKey: `${work.fact}-msg` })
    check('the same message key does not deliver twice', again.value?.id === work.messageId, `duplicate ${again.value?.duplicate ?? false}`)

    const task = await s.call('acm_task_create', { title: 'read the mirror', assignee: 'worker' })
    work.key = task.value?.task?.key ?? null
    check('planner creates and assigns a task', task.value?.ok === true && /^T-/.test(work.key ?? ''), work.key ?? 'no key')
    check('a new task starts assigned to its executor', task.value?.task?.state === 'assigned', task.value?.task?.state ?? '?')

    const claimed = await s.call('acm_claim', { id: work.messageId })
    check('a principal without mailbox:claim cannot take it', looksDenied(claimed), claimed.text.slice(0, 60))
  })

  // ---- worker: finds the work, does it, hands it back ---------------------
  await as('worker', async (s) => {
    const names = await s.tools()
    check('worker sees accept/return', names.includes('acm_task_accept') && names.includes('acm_task_return'))
    check('worker does not see create', !names.includes('acm_task_create'))

    const inbox = await s.call('acm_inbox', {})
    check('worker reads the delivery', (inbox.value?.items ?? []).some((m) => m.id === work.messageId))

    const claim = await s.call('acm_claim', { id: work.messageId })
    check('worker claims it', claim.value?.ok === true, claim.value?.reason ?? '')
    const done = await s.call('acm_complete', { id: work.messageId })
    check('worker completes it', done.value?.ok === true, done.value?.reason ?? '')

    const listed = await s.call('acm_task_list', {})
    // The key comes from the list, not from this script: finding work is the job.
    const found = (listed.value?.items ?? []).find((t) => t.key === work.key)
    check('worker discovers the task from the store', Boolean(found), `${(listed.value?.items ?? []).length} listed`)

    const accept = await s.call('acm_task_accept', { key: work.key })
    check('worker accepts', accept.value?.task?.state === 'running', accept.value?.task?.state ?? accept.value?.reason ?? '')

    const ret = await s.call('acm_task_return', { key: work.key, result: 'mirror read, no writes attempted', evidence: 'note:read-only mirror\ncommand:git remote -v' })
    check('worker returns it with evidence', ret.value?.task?.state === 'returned', ret.value?.reason ?? '')
    check('the return carries both evidence rows', (ret.value?.task?.evidence ?? []).length === 2, `${(ret.value?.task?.evidence ?? []).length} rows`)

    const selfVerify = await s.call('acm_task_verify', { key: work.key })
    check('worker holds task:verify and still cannot verify its own work', selfVerify.value?.reason === 'self-verification-refused', selfVerify.value?.reason ?? '')

    const create = await s.call('acm_task_create', { title: 'self-assigned follow-up' })
    check('worker cannot create work', looksDenied(create), create.text.slice(0, 60))

    const send = await s.call('acm_send', { to: 'planner', body: 'done' })
    check('worker cannot put words in a mailbox', looksDenied(send), send.text.slice(0, 60))
  })

  // ---- reviewer: the only principal that can close it --------------------
  await as('reviewer', async (s) => {
    const names = await s.tools()
    check('reviewer sees verify', names.includes('acm_task_verify'))
    check('reviewer does not see return or create', !names.includes('acm_task_return') && !names.includes('acm_task_create'))

    const before = await s.call('acm_task_get', { key: work.key })
    check('reviewer reads the returned task', before.value?.task?.state === 'returned', before.value?.task?.state ?? before.value?.reason ?? '')

    const verify = await s.call('acm_task_verify', { key: work.key, note: 'evidence matches the claim' })
    check('reviewer verifies', verify.value?.task?.state === 'verified', verify.value?.reason ?? '')
    check('the verifier is recorded as the reviewer', verify.value?.task?.verifiedBy === 'reviewer', verify.value?.task?.verifiedBy ?? '-')

    const send = await s.call('acm_send', { to: 'worker', body: 'approved' })
    check('reviewer cannot send either', looksDenied(send), send.text.slice(0, 60))
  })

  // ---- a fourth principal with no grants: the surface, not a promise -----
  await as('intruder', async (s) => {
    const names = await s.tools()
    check('no grants means one tool, the one that explains why', names.length === 1 && names[0] === 'acm_capabilities', names.join(','))
    const read = await s.call('acm_search', { query: work.fact })
    check('and reading the memory it can see listed is refused', looksDenied(read), read.text.slice(0, 60))
  })

  // ---- a fresh process: the work outlived the sessions that made it -----
  await as('worker', async (s) => {
    const search = await s.call('acm_search', { query: work.fact })
    check('a new session finds the memory', (search.value?.items ?? []).some((i) => i.id === work.memoryId), `${(search.value?.items ?? []).length} hits`)

    const trail = await s.call('acm_task_get', { key: work.key })
    const states = (trail.value?.events ?? []).map((e) => e.to)
    check('a new session reads the whole trail', ['assigned', 'running', 'returned', 'verified'].every((x) => states.includes(x)), states.join(' -> '))
    check('and it still says who verified', trail.value?.task?.verifiedBy === 'reviewer', trail.value?.task?.verifiedBy ?? '-')
  })
} catch (err) {
  failures += 1
  console.error(`FAIL run aborted: ${err?.message ?? err}`)
  record({ step: tape.length + 1, check: 'run aborted', ok: false, detail: String(err?.message ?? err) })
}

if (!keep) rmSync(dbPath, { force: true })
if (logPath) console.log(`tape: ${logPath} (${tape.length} records)`)
console.log(failures === 0 ? `\nscoped flow: ${tape.length} checks, 0 failed` : `\nscoped flow: ${tape.length} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
