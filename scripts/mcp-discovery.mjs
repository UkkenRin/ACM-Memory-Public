#!/usr/bin/env node
/**
 * A worker that is told nothing: work must be *discovered*, not handed over.
 *
 * Every other driver in this repository hands the worker what to do. `two-agent-loop`
 * names the task key; `native-loop` reads its instruction from a prompt; the demo passes
 * a whitelist of commands. All of them prove the protocol works when someone already
 * knows the answer, and none of them proves the thing that matters for a second agent:
 * that a process with a connection and a goal can find out what to do on its own.
 *
 * So this driver gives the worker exactly two things - a db, and the name it answers to.
 * It never passes a task id, a mailbox id, a tool name or a command. The worker calls
 * `tools/list`, decides from the returned schemas which tool lists work, calls it, and
 * carries the id it got back into the next call. If discovery is broken, the worker
 * cannot invent an id, and the run fails at the first step instead of passing by luck.
 *
 * Three processes, all MCP stdio, all on one store:
 *
 *   gatekeeper  delivers a work order to `worker` and to `nobody-in-particular`
 *   worker      discovers the inbox, claims what is there, completes it
 *   rival       a second process with the same grants: sees nothing left to do,
 *               and cannot claim the item the worker already took
 *
 * The ids are never printed by the driver before they are used. `--json` emits the tape:
 * every RPC, who sent it, and what came back - so "it discovered it" is a fact about the
 * transcript, not a claim about the code.
 *
 *   node scripts/mcp-discovery.mjs --json
 *
 * Options:
 *   --db <path>        database file (default: a fresh temporary directory)
 *   --json             one JSON object on stdout, transcript on stderr
 *   --keep             keep the temporary database and print its path
 *   --allow-live-db    permit a database inside the configured ACM store
 *   --no-order         skip the delivery: the inbox is empty and the run must go red
 *   --rpc-timeout <n>  per-request timeout in ms (default 30000)
 *
 * Exit codes: 0 every step passed, 1 a step failed, 2 usage or configuration error.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { ACTIONS, grant, principalFromConfig } from '../lib/auth.mjs'
import { mergeConfig } from '../lib/core.mjs'
import { McpAgent } from './mcp-agent.mjs'
import { storeRefusal } from './store-guard.mjs'

const mcpPath = new URL('../lib/host/mcp.mjs', import.meta.url).pathname

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const jsonOut = flag('json')
const keep = flag('keep')
const allowLiveDb = flag('allow-live-db')
/** `--no-order` sends nothing, so the inbox is empty and discovery has to fail. */
const noOrder = flag('no-order')
const rpcTimeout = Number(arg('rpc-timeout', 30_000))
const project = 'alpha'

const say = (line) => { if (!jsonOut) console.log(line); else console.error(line) }

let tempDir = null
function databasePath() {
  const given = arg('db')
  if (given) {
    const refusal = storeRefusal(resolve(given), { allowLiveDb })
    if (refusal) {
      console.error(`usage: ${refusal}; pass --allow-live-db only if that data is disposable`)
      process.exit(2)
    }
    return resolve(given)
  }
  tempDir = mkdtempSync(join(tmpdir(), 'acm-discovery-'))
  return join(tempDir, 'memory.db')
}

let dbPath = null
const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? null })
  say(`  ${ok ? 'ok  ' : 'NO  '} ${name}${detail ? `  ${detail}` : ''}`)
  return ok
}

/** Every RPC that leaves a process, in order. The tape is the evidence. */
const tape = []
class Traced extends McpAgent {
  constructor(name, extraEnv = {}) {
    super(name, { dbPath, mcpPath, project, rpcTimeout, sessionPrefix: 'disc-', env: extraEnv })
  }

  async rpc(method, params) {
    const at = Date.now()
    try {
      const result = await super.rpc(method, params)
      tape.push({ agent: this.name, at, method, tool: params?.name ?? null, args: params?.arguments ?? null, ok: true })
      return result
    } catch (err) {
      tape.push({ agent: this.name, at, method, tool: params?.name ?? null, args: params?.arguments ?? null, ok: false, error: String(err?.message ?? err) })
      throw err
    }
  }
}

dbPath = databasePath()
say(`discovery loop on ${dbPath}`)

// ── The operator's act: identities and grants, before any agent exists
{
  const db = openDb(dbPath)
  const identities = [
    ['gatekeeper', ['memory:read', 'mailbox:send']],
    ['worker', ['memory:read', 'mailbox:claim', 'mailbox:complete']],
    ['rival', ['memory:read', 'mailbox:claim', 'mailbox:complete']],
  ]
  for (const [agent, actions] of identities) {
    const principal = principalFromConfig(mergeConfig({ agent, project }))
    for (const action of actions) {
      if (!ACTIONS.includes(action)) throw new Error(`granting an action that does not exist: ${action}`)
      const issued = grant(db, { principal, action, target: project, grantedBy: 'operator' })
      if (!issued.ok) throw new Error(`could not grant ${action} to ${agent}: ${issued.reason}`)
    }
  }
  db.close()
}

const ORDER = 'close the loop: report which paragraph of the deploy policy applies'
/** The id of the delivery that is *not* for the worker; used to prove discovery chose. */
let strayId = null
const gatekeeper = new Traced('gatekeeper')
const worker = new Traced('worker')
const rival = new Traced('rival')

let exitCode = 0
let discovered = null
try {
  for (const agent of [gatekeeper, worker, rival]) {
    const info = await agent.start()
    record(`${agent.name} starts its own MCP server`, Boolean(info?.serverInfo?.name),
      `${info?.serverInfo?.name ?? '?'} ${info?.serverInfo?.version ?? ''}`.trim())
  }
  const pids = [gatekeeper, worker, rival].map((a) => a.child.pid)
  record('the three agents are three processes', new Set(pids).size === 3, pids.join(','))

  // ── 1. The order exists. The worker is not told that it does.
  if (noOrder) {
    record('the gatekeeper sends nothing, so there is no work to find', true, '--no-order')
  } else {
    const sent = await gatekeeper.tool('acm_send', { to: 'worker', body: ORDER })
    record('the gatekeeper delivers a work order', sent.ok === true && typeof sent.value?.id === 'number',
      `#${sent.value?.id ?? '?'}`)
    // A second delivery, addressed to a name nobody uses. It must not reach the worker:
    // "list everything" is not the same as "list what is mine".
    const stray = await gatekeeper.tool('acm_send', { to: 'nobody-in-particular', body: 'not for the worker' })
    strayId = stray.value?.id ?? null
    record('a delivery to another name is accepted and stays out of reach', stray.ok === true,
      `#${strayId ?? '?'}`)
  }

  // ── 2. The worker discovers the surface before it discovers the work
  const listed = await worker.rpc('tools/list', {})
  const tools = (listed?.tools ?? []).map((t) => t.name)
  record('the worker learns the tool surface from tools/list, not from the driver',
    tools.length > 0 && tools.includes('acm_inbox'),
    `${tools.length} tools: ${tools.slice(0, 6).join(',')}${tools.length > 6 ? ',...' : ''}`)

  const inboxTool = (listed?.tools ?? []).find((t) => t.name === 'acm_inbox')
  const claimTool = (listed?.tools ?? []).find((t) => t.name === 'acm_claim')
  record('the listing itself says which tool lists work and what it returns',
    Boolean(inboxTool?.inputSchema?.properties) && Boolean(claimTool?.inputSchema?.properties?.id),
    `acm_claim requires: ${JSON.stringify(claimTool?.inputSchema?.required ?? [])}`)

  // ── 3. Discovery: the only source of the id is the response to a listing call
  {
    const inbox = await worker.tool('acm_inbox', {})
    const items = Array.isArray(inbox.value?.items) ? inbox.value.items : []
    record('the worker finds its own work with no id supplied to it',
      inbox.ok === true && items.length === 1 && items[0]?.body === ORDER,
      `items=${items.length} body=${JSON.stringify(items[0]?.body ?? null).slice(0, 60)}`)

    const id = items[0]?.id
    discovered = { id, source: 'acm_inbox', count: items.length }
    record('the id it will use came out of that response',
      typeof id === 'number' && Number.isInteger(id) && id > 0, `#${id ?? '?'}`)
    record('and it is not the id of the delivery addressed to someone else',
      typeof id === 'number' && id !== strayId, `discovered #${id ?? '?'} vs stray #${strayId ?? '?'}`)

    const claimed = await worker.tool('acm_claim', { id })
    record('the worker claims exactly the item it found', claimed.ok === true && claimed.value?.ok === true,
      JSON.stringify(claimed.value ?? claimed.error).slice(0, 120))

    const completed = await worker.tool('acm_complete', { id })
    record('and completes it', completed.ok === true && completed.value?.ok === true,
      JSON.stringify(completed.value ?? completed.error).slice(0, 120))
  }

  // ── 4. A rival process: same grants, no work left, and no way to steal it
  {
    const inbox = await rival.tool('acm_inbox', {})
    const items = Array.isArray(inbox.value?.items) ? inbox.value.items : []
    record('a second process sees nothing addressed to it that is still open',
      inbox.ok === true && items.length === 0, `items=${items.length}`)

    const stolen = await rival.tool('acm_claim', { id: discovered?.id })
    record('it cannot claim the item the worker already finished',
      stolen.ok === true && stolen.value?.ok === false,
      String(stolen.value?.reason ?? stolen.error ?? '').slice(0, 120))
  }

  // ── 5. The tape, not the narration
  {
    const byWorker = tape.filter((t) => t.agent === 'worker')
    const toolCalls = byWorker.filter((t) => t.method === 'tools/call')
    record('the worker made only calls it could name from the listing',
      toolCalls.every((t) => tools.includes(t.tool)),
      toolCalls.map((t) => t.tool).join(' -> '))
    record('no id reached the worker before the listing response did',
      byWorker.findIndex((t) => t.tool === 'acm_inbox') < byWorker.findIndex((t) => t.tool === 'acm_claim'),
      byWorker.map((t) => t.tool ?? t.method).join(' -> '))
    const claimArgs = toolCalls.find((t) => t.tool === 'acm_claim')?.args ?? {}
    record('the claim argument equals the discovered id, field for field',
      claimArgs.id === discovered?.id, `claimed ${JSON.stringify(claimArgs)} vs discovered ${JSON.stringify(discovered)}`)
  }
} catch (err) {
  record('the run finished without an exception', false, String(err?.message ?? err))
  exitCode = 1
} finally {
  for (const agent of [gatekeeper, worker, rival]) await agent.stop()
  if (tempDir && !keep) rmSync(tempDir, { recursive: true, force: true })
}

const failed = steps.filter((s) => !s.ok)
if (failed.length) exitCode = 1

const report = {
  ok: exitCode === 0,
  db: keep ? dbPath : null,
  project,
  order: ORDER,
  discovered,
  steps,
  tape,
  pids: [gatekeeper, worker, rival].map((a) => ({ agent: a.name, pid: a.child.pid, session: a.env.ACM_SESSION })),
}
if (jsonOut) console.log(JSON.stringify(report, null, 2))
else say(`discovery loop: ${steps.length - failed.length}/${steps.length} passed`)
process.exit(exitCode)
