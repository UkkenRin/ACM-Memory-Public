/**
 * Connecting to the MCP host must not be the same as causing maintenance.
 *
 * The stdio host used to take a backup during module startup, before it had read
 * a single request, and the backup path prunes older snapshots. Locally that is
 * harmless: the process was launched by whoever owns the database. The same
 * startup code behind a transport a remote caller can reach would let an
 * unauthenticated connection write a snapshot and delete older ones, which is a
 * side effect no authorization check had approved.
 *
 * The fix is one flag: `ACM_MAINTENANCE=1` marks the process that owns the store.
 * These checks pin both directions, because a test that only asserts "no backup"
 * passes just as well when backups are broken:
 *
 *   1. a client that connects, lists tools and is refused a write leaves no
 *      snapshot, no task event and no mailbox row behind;
 *   2. the same launch with `ACM_MAINTENANCE=1` produces exactly one verifiable
 *      snapshot, so the absence in (1) is a decision and not a dead code path.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { checkBackup } from '../lib/backup.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, '..', 'lib', 'host', 'cli.mjs')
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')
const dir = mkdtempSync(join(tmpdir(), 'acm-startup-'))
const dbPath = join(dir, 'memory.db')
const backupDir = join(dir, 'backups')

const baseEnv = { ...process.env, ACM_DB: dbPath, ACM_SESSION: 'startup-test' }
delete baseEnv.ACM_MAINTENANCE

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

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' })
  assert.equal(r.status, 0, `cli ${args.join(' ')} exited ${r.status}: ${r.stderr || r.error?.message}`)
  return r.stdout.trim()
}

function mcp(extraEnv, lines) {
  const r = spawnSync(process.execPath, [mcpPath], {
    env: { ...baseEnv, ...extraEnv },
    input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `mcp exited ${r.status}: ${r.stderr || r.error?.message}`)
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function counts() {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const one = (sql) => Number(raw.prepare(sql).get().c)
    return {
      nodes: one('select count(*) c from acm_nodes'),
      mailbox: one('select count(*) c from acm_mailbox'),
      tasks: one('select count(*) c from acm_tasks'),
      events: one('select count(*) c from acm_task_events'),
    }
  } finally {
    raw.close()
  }
}

function snapshots() {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir).filter((f) => f.startsWith('memory-') && f.endsWith('.db'))
}

const INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
]

try {
  // A store with content, so a snapshot would be a real file rather than an
  // empty database, and so the event counters start from something non-zero.
  cli(['remember', '--text', 'the store keeps its own record of what happened'])
  cli(['remember', '--text', 'a second fact so the backup has more than one page'])
  cli(['task', 'create', '--title', 'startup side effect probe'])
  // The CLI is an operator surface and takes its own snapshot at startup; that is
  // the behaviour the MCP host must not inherit. Clear those so the counters below
  // measure the client, not the setup.
  rmSync(backupDir, { recursive: true, force: true })
  const before = counts()
  ok('the fixture has content', before.nodes >= 2 && before.tasks >= 1, JSON.stringify(before))

  // (1) A client connects, lists tools and has a write refused. Nothing may
  // move: no snapshot, no event, no mailbox row.
  const refused = mcp({ ACM_AUTH_MODE: 'scoped', ACM_AGENT: 'untrusted' }, [
    ...INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acm_send', arguments: { to: 'someone', text: 'hello' } } },
  ])
  const sendResult = refused.find((m) => m.id === 3)?.result
  ok('an unauthenticated write is refused', sendResult?.isError === true, JSON.stringify(sendResult))
  ok('the refusal names the missing verb', /not authorized/.test(sendResult?.content?.[0]?.text ?? ''), sendResult?.content?.[0]?.text)
  ok('connecting created no snapshot', snapshots().length === 0, snapshots().join(', '))
  const after = counts()
  ok('connecting changed no store counter', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)

  // (2) The operator process asks for maintenance and gets exactly one snapshot.
  const maintained = mcp({ ACM_MAINTENANCE: '1' }, [
    ...INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ])
  ok('the maintained process answers tools/list', Array.isArray(maintained.find((m) => m.id === 2)?.result?.tools))
  const made = snapshots()
  ok('the operator process wrote exactly one snapshot', made.length === 1, made.join(', '))
  const proof = made.length === 1 ? checkBackup(join(backupDir, made[0])) : { ok: false, reason: 'no snapshot' }
  ok('the snapshot verifies as a recovery point', proof.ok === true, proof.reason ?? '')
  ok('the snapshot holds the store contents', proof.ok && proof.nodes === before.nodes, `${proof.nodes} vs ${before.nodes}`)
  const final = counts()
  ok('maintenance added no task event', final.events === before.events, `${before.events} -> ${final.events}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\nstartup side effects: ${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
