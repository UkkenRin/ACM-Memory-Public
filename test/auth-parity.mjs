// One identity, one write: MCP and the SDK must give the same answer
//
// Before the fix `acm_remember` declared only `memory:write-global`, while the default
// scope is session. In scoped mode a principal with no grants had its session write
// accepted through MCP and refused through the SDK, and a principal holding only the
// session verb did not see the tool at all. Two entry points disagreeing about "who am I
// and what may I do" leaves the caller unable to decide what to do next.
//
// The comparison runs over three identities - session verb only, global verb only, nothing -
// asking MCP (a real subprocess) and the SDK (in process) the same question, then checking
// that tool discovery describes the same store the calls do.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { grant } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'acm-parity-'))
const dbPath = join(dir, 'store.sqlite')
const owner = 'parity'

const ROLES = {
  'session-only': ['memory:read', 'memory:write-session'],
  'global-only': ['memory:read', 'memory:write-global'],
  nobody: [],
}

{
  const db = openDb(dbPath)
  for (const [agent, actions] of Object.entries(ROLES)) {
    for (const action of actions) {
      const r = grant(db, { principal: { kind: 'agent', id: agent, owner, project: null }, action, grantedBy: 'parity' })
      if (!r.ok) throw new Error(`grant ${agent}/${action}: ${r.reason}`)
    }
  }
  db.close()
}

/** Ask the MCP host, as a fresh process, and report whether the call was refused. */
function askMcp(agent, name, args) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ]
  const out = spawnSync(process.execPath, [mcpPath], {
    input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    env: { PATH: process.env.PATH, ACM_DB: dbPath, ACM_OWNER: owner, ACM_AGENT: agent, ACM_SESSION: `p-${agent}-${Date.now()}`, ACM_AUTH_MODE: 'scoped' },
    encoding: 'utf8', timeout: 60_000,
  })
  const replies = String(out.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const call = replies.find((r) => r.id === 2)
  if (!call) return { refused: true, detail: `no reply (exit ${out.status})` }
  return { refused: Boolean(call.result?.isError), detail: String(call.result?.content?.[0]?.text ?? '').slice(0, 80) }
}

/** Ask the SDK the same question in-process. */
function askSdk(agent, scope) {
  // A handle that cannot even be opened is a refusal too - `memory:read` gates the
  // constructor - so both cases answer the same question.
  let handle = null
  try {
    handle = openMemory({ dbPath, sessionId: `s-${agent}`, config: { owner, agent, auth: { mode: 'scoped' } } })
    handle.remember({ text: `parity ${agent} ${scope}`, scope })
    return { refused: false, detail: 'accepted' }
  } catch (err) {
    return { refused: err?.code === 'not-authorized', detail: String(err?.message ?? err).slice(0, 80) }
  } finally {
    handle?.close()
  }
}

try {
  for (const agent of Object.keys(ROLES)) {
    for (const scope of ['session', 'global']) {
      const viaMcp = askMcp(agent, 'acm_remember', { text: `parity ${agent} ${scope}`, scope, kind: 'fact' })
      const viaSdk = askSdk(agent, scope)
      ok(`${agent} writing a ${scope} memory: MCP and SDK agree`,
        viaMcp.refused === viaSdk.refused,
        `MCP ${viaMcp.refused ? 'refused' : 'accepted'} (${viaMcp.detail}) vs SDK ${viaSdk.refused ? 'refused' : 'accepted'} (${viaSdk.detail})`)
    }
  }

  // The specific claim from the review: no grants at all means the default write is
  // refused, not accepted because the tool only asked about the global verb.
  ok('a principal with no grants cannot write a session memory through MCP',
    askMcp('nobody', 'acm_remember', { text: 'should not land', scope: 'session', kind: 'fact' }).refused)
  ok('nor through the SDK',
    askSdk('nobody', 'session').refused)

  // Tool discovery has to describe the same store the calls do.
  {
    const out = spawnSync(process.execPath, [mcpPath], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`,
      env: { PATH: process.env.PATH, ACM_DB: dbPath, ACM_OWNER: owner, ACM_AGENT: 'session-only', ACM_AUTH_MODE: 'scoped' },
      encoding: 'utf8', timeout: 60_000,
    })
    const list = String(out.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r?.id === 3)[0]
    const names = (list?.result?.tools ?? []).map((t) => t.name)
    ok('a principal holding only memory:write-session still sees acm_remember',
      names.includes('acm_remember'), `${names.length} tools`)
  }
  {
    const out = spawnSync(process.execPath, [mcpPath], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`,
      env: { PATH: process.env.PATH, ACM_DB: dbPath, ACM_OWNER: owner, ACM_AGENT: 'nobody', ACM_AUTH_MODE: 'scoped' },
      encoding: 'utf8', timeout: 60_000,
    })
    const list = String(out.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r?.id === 3)[0]
    const names = (list?.result?.tools ?? []).map((t) => t.name)
    ok('a principal with no grants is not shown acm_remember',
      !names.includes('acm_remember') && names.includes('acm_capabilities'), names.join(','))
  }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
