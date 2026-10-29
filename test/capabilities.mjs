/**
 * What a connection may do, said before it tries.
 *
 * Two changes borrowed from how a mature desktop HUD exposes its tools: the tool
 * list is filtered to what the caller may actually call, and a `capabilities`
 * tool answers the same question directly. The distinction that matters is that
 * neither is the gate. A hidden tool that a client calls by name is still
 * refused by the tool itself, and this file asserts that, because a list is
 * easier to trust than a refusal and therefore easier to get wrong.
 *
 * It also records the tools that have no verb at all. That list used to name seven
 * tools, which is how the missing verbs were found; they carry verbs now, so the list has one
 * honest entry left (`acm_capabilities` itself, which reports grants and reads no
 * user data). The assertion is that the list cannot grow silently: a new tool
 * without a declared verb turns this file red instead of quietly becoming
 * callable by anyone.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { openDb } from '../lib/db.mjs'
import { ACTIONS, grant, principalFromConfig, upsertPrincipal } from '../lib/auth.mjs'
import { TOOLS, mergeConfig, toolVerbs } from '../lib/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')
const dir = mkdtempSync(join(tmpdir(), 'acm-capabilities-'))
const dbPath = join(dir, 'memory.db')

const db = openDb(dbPath)
const base = { dbPath, owner: 'bob', personaFiles: [] }
const cfg = (agent, mode = 'scoped', project = null) =>
  mergeConfig({ ...base, agent, project, auth: { mode } })

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ok ${name}`)
  } else {
    fails.push(`${name}${extra ? ` - ${extra}` : ''}`)
    console.log(`  FAIL ${name}${extra ? ` - ${extra}` : ''}`)
  }
}

function mcp(agent, mode, lines, project = null) {
  const env = {
    ...process.env,
    ACM_DB: dbPath,
    ACM_OWNER: 'bob',
    ACM_AGENT: agent,
    ACM_AUTH_MODE: mode,
    ACM_SESSION: 'cap-test',
    ACM_MAINTENANCE: '0',
  }
  if (project) env.ACM_PROJECT = project
  else delete env.ACM_PROJECT
  const r = spawnSync(process.execPath, [mcpPath], {
    env,
    input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `mcp exited ${r.status}: ${r.stderr || r.error?.message}`)
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cap-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
]

const namesOf = (out) => (out.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name)
const capabilitiesOf = (out) => out.find((m) => m.id === 3)?.result?.structuredContent

// The tools that used to answer any caller because they had no verb.
const FORMERLY_UNGATED = ['acm_checkpoint', 'acm_forget', 'acm_alias', 'acm_history', 'acm_feedback', 'acm_evolve', 'acm_gc']
// The only tool allowed to have no verb: it reports what a connection may do and
// reads no stored data, so gating it would gate the question about gates. It is
// excluded from its own `ungated` list, which is why that list is asserted empty.
const BY_DESIGN_UNVERBED = ['acm_capabilities']

try {
  for (const id of ['nobody', 'reader', 'mailer']) {
    upsertPrincipal(db, { id, kind: 'agent', owner: 'bob' })
  }
  grant(db, { principal: principalFromConfig(cfg('reader')), action: 'memory:read', target: null })
  grant(db, { principal: principalFromConfig(cfg('mailer')), action: 'mailbox:send', target: null })

  // ------------------------------------------------------------ local mode
  {
    const out = mcp('nobody', 'local', [...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acm_capabilities', arguments: {} } }])
    const names = namesOf(out)
    const caps = capabilitiesOf(out)
    ok('acm_capabilities answers on a scoped-capable host', !!caps, 'the tool is missing')
    ok('local mode lists every tool', names.includes('acm_search') && names.includes('acm_send') && names.includes('acm_task_verify'), `${names.length} tools`)
    ok('local mode reports the mode it ran in', caps?.mode === 'local', caps?.mode)
    ok('local mode grants every action', caps?.actions?.length === ACTIONS.length, `${caps?.actions?.length} of ${ACTIONS.length}`)
    // `acm_capabilities` is excluded from its own list, so an empty list means
    // "nothing is callable without a verb", which is the property that was broken.
    ok('nothing is left without a verb', Array.isArray(caps?.ungated) && caps.ungated.length === 0, JSON.stringify(caps?.ungated))
    // A tool may declare several verbs (`acm_remember` switches on the scope), so the
    // question is about the list, not about a single field.
    ok('every other tool declares a verb',
      TOOLS.filter((x) => !BY_DESIGN_UNVERBED.includes(x.name)).every((x) => toolVerbs(x).length > 0 && toolVerbs(x).every((v) => ACTIONS.includes(v))),
      TOOLS.filter((x) => !BY_DESIGN_UNVERBED.includes(x.name) && !toolVerbs(x).every((v) => ACTIONS.includes(v))).map((x) => `${x.name}:${toolVerbs(x).join('|') || 'none'}`).join(','))
    ok('no tool declares a verb that is not an action',
      TOOLS.every((x) => toolVerbs(x).every((v) => ACTIONS.includes(v))),
      TOOLS.filter((x) => !toolVerbs(x).every((v) => ACTIONS.includes(v))).map((x) => `${x.name}:${toolVerbs(x).join('|')}`).join(','))
    ok('the tool list matches capabilities', JSON.stringify([...names].sort()) === JSON.stringify([...(caps?.tools?.visible ?? [])].sort()), `${names.length} vs ${caps?.tools?.visible?.length}`)
  }

  // ------------------------------------------------- scoped, no grant at all
  {
    const out = mcp('nobody', 'scoped', [...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acm_capabilities', arguments: {} } }])
    const names = namesOf(out)
    const caps = capabilitiesOf(out)
    ok('a caller with no grant does not see acm_search', !names.includes('acm_search'), names.join(','))
    ok('a caller with no grant does not see acm_send', !names.includes('acm_send'), names.join(','))
    ok('a caller with no grant does not see acm_task_create', !names.includes('acm_task_create'), names.join(','))
    ok('the hidden list names them instead', ['acm_search', 'acm_send', 'acm_task_create'].every((n) => caps?.tools?.hidden?.includes(n)), JSON.stringify(caps?.tools?.hidden))
    ok('capabilities itself is always visible', names.includes('acm_capabilities'), names.join(','))
    ok('the tools that used to answer anyone are now hidden', FORMERLY_UNGATED.every((n) => !names.includes(n)), FORMERLY_UNGATED.filter((n) => names.includes(n)).join(','))
  }

  // ------------------------------------------------------ one read verb only
  {
    const out = mcp('reader', 'scoped', [...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acm_capabilities', arguments: {} } }])
    const names = namesOf(out)
    const caps = capabilitiesOf(out)
    ok('memory:read reveals the read tools', ['acm_search', 'acm_inbox', 'acm_task_list', 'acm_task_get'].every((n) => names.includes(n)), names.join(','))
    ok('memory:read does not reveal acm_send', !names.includes('acm_send'), names.join(','))
    ok('memory:read does not reveal acm_task_verify', !names.includes('acm_task_verify'), names.join(','))
    ok('the granted action list is exactly what was granted', JSON.stringify(caps?.actions) === JSON.stringify(['memory:read']), JSON.stringify(caps?.actions))
  }

  // -------------------------------------------------- one write verb only
  {
    const out = mcp('mailer', 'scoped', [...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])
    const names = namesOf(out)
    ok('mailbox:send reveals acm_send', names.includes('acm_send'), names.join(','))
    ok('mailbox:send does not reveal acm_search', !names.includes('acm_search'), names.join(','))
  }

  // ------------------------------------- the list is not the gate, in either mode
  {
    const before = Number(db.prepare('select count(*) c from acm_mailbox').get().c)
    const out = mcp('reader', 'scoped', [
      ...INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acm_send', arguments: { to: 'someone', body: 'hello' } } },
    ])
    const result = out.find((m) => m.id === 2)?.result
    ok('a hidden tool called by name is still refused', result?.isError === true, JSON.stringify(result)?.slice(0, 200))
    ok('the refusal names the verb, not the list', /mailbox:send/.test(result?.content?.[0]?.text ?? ''), result?.content?.[0]?.text)
    const after = Number(db.prepare('select count(*) c from acm_mailbox').get().c)
    ok('the refused delivery wrote nothing', after === before, `${before} -> ${after}`)
  }
} finally {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\ncapabilities: ${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
