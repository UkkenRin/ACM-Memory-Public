// A worker that is told nothing must still find the work.
//
// The driver is the experiment; this file reads its tape. What is asserted here cannot
// be asserted by reading the driver's source: that the id the worker claimed arrived in
// a response, that the tool names it used came from `tools/list`, and that a store with
// no work produces a red run rather than a green one on an empty list.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'mcp-discovery.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

function run(extraArgs = []) {
  const r = spawnSync(process.execPath, [script, '--json', ...extraArgs], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '--experimental-sqlite' },
  })
  let report = null
  try { report = JSON.parse(r.stdout) } catch {}
  return { status: r.status, report, stderr: r.stderr }
}

// 1. The discovery run
{
  const { status, report, stderr } = run()
  const step = (fragment) => (report?.steps ?? []).find((s) => s.name.includes(fragment))

  ok('the run exits 0', status === 0, `exit ${status} ${String(stderr).slice(-300)}`)
  ok('every step passed', (report?.steps ?? []).length > 0 && (report?.steps ?? []).every((s) => s.ok),
    (report?.steps ?? []).filter((s) => !s.ok).map((s) => `${s.name} -> ${String(s.detail ?? '').slice(0, 160)}`).join('; '))

  // Three processes, not three objects
  const pids = new Set((report?.pids ?? []).map((p) => p.pid))
  ok('three agents ran as three processes', pids.size === 3 && [...pids].every((p) => Number.isInteger(p)), [...pids].join(','))
  ok('each ran under its own session', new Set((report?.pids ?? []).map((p) => p.session)).size === 3,
    (report?.pids ?? []).map((p) => p.session).join(','))

  // The id was discovered, and the tape shows where it came from
  ok('the id used came from the inbox response', report?.discovered?.source === 'acm_inbox' && Number.isInteger(report?.discovered?.id),
    JSON.stringify(report?.discovered))
  ok('the inbox held exactly the order the gatekeeper sent', step('finds its own work')?.ok === true,
    String(step('finds its own work')?.detail ?? 'missing'))
  ok('the item the worker took is not the one addressed to another name', step('not the id of the delivery')?.ok === true,
    String(step('not the id of the delivery')?.detail ?? 'missing'))

  // The tool names came from the protocol, not from the driver
  ok('the surface was learned from tools/list', step('learns the tool surface')?.ok === true,
    String(step('learns the tool surface')?.detail ?? 'missing'))
  ok('every tool the worker called is one the listing named', step('only calls it could name')?.ok === true,
    String(step('only calls it could name')?.detail ?? 'missing'))

  // Ordering in the tape: listing before using
  const tape = report?.tape ?? []
  const workerTape = tape.filter((t) => t.agent === 'worker').map((t) => t.tool ?? t.method)
  const iList = workerTape.indexOf('tools/list')
  const iInbox = workerTape.indexOf('acm_inbox')
  const iClaim = workerTape.indexOf('acm_claim')
  ok('the worker listed the tools before touching the store', iList >= 0 && iList < iInbox, workerTape.join(' -> '))
  ok('and asked the inbox before it had anything to claim', iInbox >= 0 && iInbox < iClaim, workerTape.join(' -> '))
  ok('no request carried an id before the inbox answered', !tape.some((t) => t.agent === 'worker' && t.args && 'id' in t.args
    && workerTape.indexOf(t.tool) < iInbox), JSON.stringify(tape.filter((t) => t.agent === 'worker' && t.args?.id)))

  // The tape holds the response side, not just the request side: the claim rests on
  // "this id came out of that call", and before batch 29 the tape could not show it.
  const inboxCall = tape.find((t) => t.agent === 'worker' && t.tool === 'acm_inbox')
  ok('the tape records the id inside the inbox response itself',
    Array.isArray(inboxCall?.resultIds) && inboxCall.resultIds.includes(report?.discovered?.id),
    `resultIds ${JSON.stringify(inboxCall?.resultIds ?? null)} vs discovered ${JSON.stringify(report?.discovered?.id)}`)
  ok('and records a digest of every response, so two tapes can be compared',
    tape.filter((t) => t.method === 'tools/call').every((t) => typeof t.resultDigest === 'string' && t.resultDigest.length === 16),
    tape.filter((t) => t.method === 'tools/call').map((t) => t.resultDigest).join(','))

  // The rival is refused for the right reason, not by luck
  ok('a second process found nothing left to do', step('sees nothing addressed to it')?.ok === true,
    String(step('sees nothing addressed to it')?.detail ?? 'missing'))
  ok('and was refused with the named reason, not merely a false result',
    step('cannot claim the item')?.ok === true && step('cannot claim the item')?.detail === 'not-your-inbox',
    `detail=${JSON.stringify(step('cannot claim the item')?.detail ?? null)}`)
}

// 2. No work in the store: the run must go red, not green on an empty list
{
  const dir = mkdtempSync(join(tmpdir(), 'acm-discovery-neg-'))
  const db = join(dir, 'empty.db')
  const r = spawnSync(process.execPath, [script, '--json', '--db', db, '--no-order'], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '--experimental-sqlite' },
  })
  let report = null
  try { report = JSON.parse(r.stdout) } catch {}
  ok('the empty-store run fails', r.status !== 0, `exit ${r.status}`)
  ok('and says which step failed rather than printing a green summary',
    (report?.steps ?? []).some((s) => !s.ok), (report?.steps ?? []).filter((s) => !s.ok).map((s) => s.name).join('; ').slice(0, 200))
  ok('the failure is the discovery step, not a crash before it',
    (report?.steps ?? []).filter((s) => !s.ok).some((s) => s.name.includes('finds its own work')),
    (report?.steps ?? []).map((s) => `${s.ok ? '+' : '-'}${s.name}`).join(' | ').slice(0, 300))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\nFAILED  ${pass} passed, ${failures.length} failed`
  : `\nALL GREEN  ${pass} passed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
