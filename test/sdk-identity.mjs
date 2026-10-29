// Four boundary claims from the 2026-11-18 review, as tests that fail on the old code.
//
// The review's shape: the MCP path fixes the acting agent and asks for a delivery verb;
// the SDK path took both from the caller. Each case here is one of those four, run on a
// scoped synthetic store with grants the caller really holds, so a refusal cannot be
// mistaken for a missing grant.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openMemory } from '../lib/sdk.mjs'
import { openDb } from '../lib/db.mjs'
import { grant, principalFromConfig } from '../lib/auth.mjs'
import { mergeConfig } from '../lib/core.mjs'

const dir = mkdtempSync(join(tmpdir(), 'acm-sdk-identity-'))
const dbPath = join(dir, 'db.sqlite')

const seed = openDb(dbPath)
const GRANTS = {
  alice: ['memory:read', 'memory:write-session', 'memory:write-global'],
  bob: ['memory:read', 'mailbox:claim', 'mailbox:complete'],
  carol: ['memory:read', 'mailbox:send'],
}
for (const [agent, actions] of Object.entries(GRANTS)) {
  const principal = principalFromConfig(mergeConfig({ agent, project: 'alpha' }))
  for (const action of actions) {
    const issued = grant(seed, { principal, action, target: 'alpha', grantedBy: 'operator' })
    assert.equal(issued.ok, true, `grant ${action} to ${agent}: ${issued.reason}`)
  }
}
const writeGlobal = principalFromConfig(mergeConfig({ agent: 'alice', project: 'alpha' }))
grant(seed, { principal: writeGlobal, action: 'memory:write-global', target: null, grantedBy: 'operator' })
seed.close()

// Every handle holds the database open. On Linux the cleanup still unlinks the file with
// readers attached; on Windows it comes back `EBUSY` and the suite fails after every
// assertion passed - which is how the two Windows legs found this.
const handles = []
const open = (agent) => {
  const handle = openMemory({
    dbPath,
    sessionId: `s-${agent}`,
    config: { agent, project: 'alpha', auth: { mode: 'scoped' } },
  })
  handles.push(handle)
  return handle
}
const alice = open('alice')
const bob = open('bob')
const carol = open('carol')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}
const refuses = (fn) => {
  try {
    fn()
    return { refused: false }
  } catch (err) {
    return { refused: true, code: err?.code, message: err?.message }
  }
}

// A. Delivery is its own verb, and the sender is the handle.
//    Before the fix: alice sent with a session-write grant alone, and `from: 'carol'`
//    was stored as carol.
{
  const r = refuses(() => alice.send({ to: 'bob', from: 'alice', body: 'hello' }))
  ok('send is refused with memory:write-session and no mailbox:send', r.refused && r.message.includes('mailbox:send'), JSON.stringify(r))

  const spoof = refuses(() => carol.send({ to: 'bob', from: 'alice', body: 'signed by alice' }))
  ok('send refuses a from that is not this handle', spoof.refused && spoof.code === 'not-authorized', JSON.stringify(spoof))

  const sent = (() => {
    try { return carol.send({ to: 'bob', body: 'from carol, as carol' }) } catch (err) { return { ok: false, error: err.message } }
  })()
  ok('send with mailbox:send works and needs no from', sent.ok === true && sent.id > 0, JSON.stringify(sent))
}

// B. Mailbox reads and moves belong to the handle's agent.
//    Before the fix: alice read bob's inbox, claimed his message as bob, completed it as bob.
{
  const read = refuses(() => alice.inbox({ agent: 'bob' }))
  ok('inbox refuses another agent name', read.refused && read.code === 'not-authorized', JSON.stringify(read))

  const mine = bob.inbox({})
  ok('inbox with no argument shows this handle\'s own mailbox', Array.isArray(mine) && mine.length >= 1, JSON.stringify(mine.map((m) => m.id)))
  const id = mine[0]?.id

  const claim = refuses(() => alice.claim(id, 'bob'))
  ok('claim refuses to claim as another agent', claim.refused && claim.code === 'not-authorized', JSON.stringify(claim))
  const complete = refuses(() => carol.complete(id, 'bob'))
  ok('complete refuses to complete as another agent', complete.refused && complete.code === 'not-authorized', JSON.stringify(complete))

  const ownClaim = bob.claim(id, 'bob')
  ok('the owner of the mailbox can still claim', ownClaim.ok === true && ownClaim.claimedBy === 'bob', JSON.stringify(ownClaim))
}

// C. A decision record names the handle, not a string the caller passed.
//    Before the fix: alice recorded a proposal as `proposer` and an approval as `decider`.
{
  const spoofOpen = refuses(() => alice.openDecision({ topic: 'ship it?', proposal: 'ship', actor: 'proposer' }))
  ok('openDecision refuses an actor that is not this handle', spoofOpen.refused && spoofOpen.code === 'not-authorized', JSON.stringify(spoofOpen))

  const opened = alice.openDecision({ topic: 'ship it?', proposal: 'ship' })
  ok('openDecision records this handle as proposer', opened.ok === true, JSON.stringify(opened))

  const spoofDecide = refuses(() => alice.decideOutcome(opened.id, { actor: 'decider', outcome: 'approved' }))
  ok('decideOutcome refuses an actor that is not this handle', spoofDecide.refused && spoofDecide.code === 'not-authorized', JSON.stringify(spoofDecide))

  const decided = alice.decideOutcome(opened.id, { outcome: 'approved' })
  ok('decideOutcome records this handle as the decider', decided.ok === true && decided.state === 'approved', JSON.stringify(decided))
  const view = alice.decision(opened.id)
  ok('the record holds no name the caller supplied',
    view.decision.proposer === 'alice' && view.decision.decidedBy === 'alice', JSON.stringify(view.decision))
}

// D. Store-wide maintenance needs the maintenance verb.
//    Before the fix: mergeDuplicates ran with memory:write-global while evolve refused.
{
  const merge = refuses(() => alice.mergeDuplicates({}))
  ok('mergeDuplicates is refused with only memory:write-global', merge.refused && merge.message.includes('operator:maintain'), JSON.stringify(merge))
  const evolve = refuses(() => alice.evolve({}))
  ok('evolve already refused the same grant', evolve.refused && evolve.message.includes('operator:maintain'), JSON.stringify(evolve))

  const db = openDb(dbPath)
  const p = principalFromConfig(mergeConfig({ agent: 'alice', project: 'alpha' }))
  grant(db, { principal: p, action: 'operator:maintain', target: null, grantedBy: 'operator' })
  db.close()
  const allowed = alice.mergeDuplicates({})
  ok('with operator:maintain the same call is allowed', typeof allowed.merged === 'number', JSON.stringify(allowed))
}

for (const handle of handles) { try { handle.close() } catch {} }
// The OS can hold the last handle for a moment after close. A temp directory that outlives
// the run is untidy; a green suite reported as red is worse, so the removal is best-effort.
try { rmSync(dir, { recursive: true, force: true }) } catch {}
console.log('')
if (failures.length) {
  console.log(`FAILED ${failures.length}`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
console.log(`ALL GREEN ${pass} passed`)
