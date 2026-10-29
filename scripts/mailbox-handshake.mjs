#!/usr/bin/env node
/**
 * The first-crossing drill: one random number, two sides, one row each.
 *
 * This is the acceptance the owner asked for, run **without a listener**. Two
 * processes, each its own MCP stdio server, each its own agent name and session,
 * on one store, `scoped` authorization with real grants. The transport between
 * them is the same SQLite mailbox the HTTP entry point would serve; only the wire
 * is missing, so the protocol can be settled before anything is bound to a port.
 *
 * The agreement being replayed (stated by the Codex side in the thread):
 *
 *   workbuddy  acm_send -> codex         body carries `probe:<6 hex>`
 *   codex      acm_inbox -> reads it     one row, still pending
 *   codex      acm_send -> workbuddy     body carries `ack for #<original id>`
 *                                        and the same `probe:<6 hex>`
 *   codex      acm_complete              marks its own inbox row done
 *   workbuddy  acm_inbox -> reads ack    same number, same original id
 *   workbuddy  acm_complete              closes its own inbox row
 *
 * What makes this a check rather than a transcript: the ack is staged twice. The
 * first one carries a number one hex digit off, and the reader has to refuse it;
 * the second carries the real one and has to be accepted. A reader that only
 * prints what it found passes the second and cannot fail the first.
 *
 * Both sides stop and restart in between, so nothing crosses in the driver's
 * memory: the second process finds the row on disk or not at all.
 *
 *   node scripts/mailbox-handshake.mjs [--json] [--keep]
 *
 * Exit codes: 0 every step passed, 1 a step failed, 2 usage or configuration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { McpAgent } from './mcp-agent.mjs'
import { grant, principalFromConfig, ACTIONS } from '../lib/auth.mjs'
import { mergeConfig } from '../lib/core.mjs'
import { storeRefusal } from './store-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mcpPath = join(here, '..', 'lib', 'host', 'mcp.mjs')

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)
const asJson = flag('json')

const PROJECT = 'acceptance'
const OWNER = 'acceptance-2026-11-18'
const SENDER = 'workbuddy'
const RECEIVER = 'codex'

const dir = mkdtempSync(join(tmpdir(), 'acm-handshake-'))
const dbPath = resolve(arg('db', join(dir, 'memory.db')))
const guard = storeRefusal(dbPath)
if (guard) {
  console.error(`refusing: ${guard}`)
  process.exit(2)
}

const steps = []
const step = (label, ok, detail = '') => {
  steps.push({ label, ok, detail })
  if (!asJson) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
  return ok
}

/** Six hex characters, from the OS, not from a counter. */
const probe = () => `probe:${randomBytes(3).toString('hex')}`

/** One hex digit off, so a reader that compares the shape passes and a reader
 *  that compares the value does not. */
const nearMiss = (value) => {
  const hex = value.slice(-1)
  const other = hex === '0' ? '1' : '0'
  return `${value.slice(0, -1)}${other}`
}

function seedGrants() {
  const db = openDb(dbPath)
  try {
    const identities = [
      [SENDER, ['memory:read', 'mailbox:send', 'mailbox:claim', 'mailbox:complete']],
      [RECEIVER, ['memory:read', 'mailbox:send', 'mailbox:claim', 'mailbox:complete']],
    ]
    for (const [agent, actions] of identities) {
      const principal = principalFromConfig(mergeConfig({ agent, owner: OWNER, project: PROJECT }))
      for (const action of actions) {
        if (!ACTIONS.includes(action)) throw new Error(`granting an action that does not exist: ${action}`)
        const issued = grant(db, { principal, action, target: PROJECT, grantedBy: 'operator' })
        if (!issued.ok) throw new Error(`could not grant ${action} to ${agent}: ${issued.reason}`)
      }
    }
  } finally {
    db.close()
  }
}

const agent = (name) =>
  new McpAgent(name, { dbPath, mcpPath, project: PROJECT, env: { ACM_OWNER: OWNER }, sessionPrefix: 'hs-' })

const must = (result, what) => {
  if (!result.ok) throw new Error(`${what}: ${result.error}`)
  return result.value
}

/** What a real reader would check: the number it sent and the id it sent it under.
 *  Two separate claims, so a body can carry the right number under the wrong id and
 *  be caught for the right reason. */
function ackMatches(message, { number, originalId }) {
  const text = String(message?.body ?? '')
  const numbers = text.match(/probe:[0-9a-f]{6}/g) ?? []
  const ids = text.match(/#(\d+)/g) ?? []
  const sameNumber = numbers.length === 1 && numbers[0] === number
  // The parent is a field on the row. The number in the prose is what a person
  // reads. Both have to agree with what was sent, and with each other: a row whose
  // field says #1 while its text says #1001 is a broken acknowledgement whatever
  // the field says, and a reader that only trusts the field would call it valid.
  const fieldId = message?.replyTo == null ? null : Number(message.replyTo)
  const fieldOk = fieldId === originalId
  const proseOk = ids.some((id) => Number(id.slice(1)) === originalId)
  const why = !sameNumber ? 'wrong-number' : !fieldOk ? 'wrong-field' : !proseOk ? 'contradictory-id' : 'matched'
  const ok = sameNumber && fieldOk && proseOk
  return { sameNumber, fieldOk, proseOk, ok, why, numbers, ids, fieldId }
}

async function sendSide(number) {
  const side = agent(SENDER)
  try {
    await side.start()
    const sent = must(await side.tool('acm_send', {
      to: RECEIVER,
      body: `handshake ${number} - read this from the ACM inbox and ack it`,
      kind: 'notice',
    }), 'send probe')
    return { id: Number(sent.id), number }
  } finally {
    await side.stop()
  }
}

async function receiveSide({ id, number }) {
  const side = agent(RECEIVER)
  try {
    await side.start()
    const inbox = must(await side.tool('acm_inbox', {}), 'receiver inbox')
    const found = (inbox.items ?? []).find((m) => String(m.body ?? '').includes(number))
    if (!step('the receiver finds the probe on its own queue', Boolean(found), `scanned ${inbox.items?.length ?? 0} rows`)) {
      return { read: null, staged: [] }
    }
    const claimed = must(await side.tool('acm_claim', { id: found.id }), 'claim probe')

    // Staged: the wrong number goes out first and is kept. If the reader on the
    // other side accepts this one, the drill is supposed to fail.
    const wrongNumber = nearMiss(number)
    const wrongAck = must(await side.tool('acm_send', {
      to: SENDER,
      body: `ack for #${found.id} ${wrongNumber}`,
      kind: 'notice',
      replyTo: found.id,
    }), 'send near-miss ack')

    // Second stage: the right number under an id nobody sent. A reader that only
    // matches the number passes this; one that matches the message does not.
    const wrongId = must(await side.tool('acm_send', {
      to: SENDER,
      body: `ack for #${found.id + 1000} ${number}`,
      kind: 'notice',
      replyTo: found.id,
    }), 'send wrong-id ack')

    // Third stage: the field points at a real message that is not the probe, while
    // the text names the probe correctly. A reader that trusted the prose is happy;
    // a reader that trusts the field alone is happy too - only one that compares
    // the field to what it actually sent refuses this.
    const stray = must(await side.tool('acm_send', {
      to: SENDER,
      body: `unrelated note ${number}-noise`,
      kind: 'notice',
    }), 'send stray message')
    const wrongField = must(await side.tool('acm_send', {
      to: SENDER,
      body: `ack for #${found.id} ${number}`,
      kind: 'notice',
      replyTo: Number(stray.id),
    }), 'send wrong-field ack')

    const rightAck = must(await side.tool('acm_send', {
      to: SENDER,
      body: `ack for #${found.id} ${number}`,
      kind: 'notice',
      replyTo: found.id,
    }), 'send ack')

    const done = must(await side.tool('acm_complete', { id: found.id }), 'complete probe')
    return {
      read: { id: found.id, body: found.body, sender: found.sender },
      claimed: Boolean(claimed.ok),
      completed: Boolean(done.ok),
      staged: [
        { kind: 'near-miss', id: Number(wrongAck.id), number: wrongNumber },
        { kind: 'wrong-id', id: Number(wrongId.id), number },
        { kind: 'wrong-field', id: Number(wrongField.id), number },
        { kind: 'exact', id: Number(rightAck.id), number },
      ],
    }
  } finally {
    await side.stop()
  }
}

async function readBack({ id, number, staged }) {
  const side = agent(SENDER)
  try {
    await side.start()
    const inbox = must(await side.tool('acm_inbox', {}), 'sender inbox')
    const acks = (inbox.items ?? []).filter((m) => String(m.body ?? '').startsWith('ack for #'))
    const judged = acks.map((m) => ({ id: m.id, body: m.body, ...ackMatches(m, { number, originalId: id }) }))
    const accepted = judged.filter((a) => a.ok)
    const refused = judged.filter((a) => !a.ok)

    for (const a of judged) {
      if (a.ok) must(await side.tool('acm_complete', { id: a.id }), 'close ack')
    }

    const stagedIds = new Set((staged ?? []).map((s) => s.id))
    return {
      saw: judged.length,
      accepted: accepted.map((a) => a.id),
      refused: refused.map((a) => ({ id: a.id, why: a.why, numbers: a.numbers, ids: a.ids })),
      allStagedArrived: judged.every((a) => stagedIds.has(a.id)),
    }
  } finally {
    await side.stop()
  }
}

async function main() {
  const number = probe()
  seedGrants()

  const sent = await sendSide(number)
  step('the probe is one random number, one message', Number.isInteger(sent.id) && /^probe:[0-9a-f]{6}$/.test(sent.number), `#${sent.id} ${sent.number}`)

  const got = await receiveSide(sent)
  step('the receiver reads the same row, not a copy of it', Boolean(got.read) && String(got.read.body).includes(number), got.read ? `#${got.read.id} from ${got.read.sender}` : 'not found')
  step('the receiver claims it before answering', got.claimed === true, String(got.claimed))

  const back = await readBack({ id: sent.id, number, staged: got.staged })
  step('all four acknowledgements arrive, so the controls are not vacuous', back.saw === 4, `${back.saw} ack(s)`)
  step('the ack carrying a different number is refused for that reason',
    back.refused.some((r) => r.why === 'wrong-number'), JSON.stringify(back.refused))
  step('an ack whose text names another id than its own field is refused as contradictory',
    back.refused.some((r) => r.why === 'contradictory-id'), JSON.stringify(back.refused))
  step('an ack whose reply field points at another message is refused as the wrong parent',
    back.refused.some((r) => r.why === 'wrong-field'), JSON.stringify(back.refused))
  step('only one of the four is accepted', back.accepted.length === 1, JSON.stringify(back.accepted))

  // The two ends have to agree on the same message, not merely each report success.
  const agreed = back.accepted.length === 1 && got.staged.some((s) => s.kind === 'exact' && back.accepted[0] === s.id)
  step('the accepted ack is the one the receiver says it sent', agreed, `accepted ${back.accepted[0] ?? 'none'} vs staged ${JSON.stringify(got.staged.map((s) => s.id))}`)

  const failed = steps.filter((s) => !s.ok)
  const report = {
    number,
    sent,
    received: got.read,
    staged: got.staged,
    readBack: back,
    steps,
    ok: failed.length === 0,
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    console.log(`\nhandshake: ${failed.length === 0 ? 'closed' : `${failed.length} failed`} - ${number} crossed ${back.saw} rows and came back on one of them`)
  }

  if (flag('keep')) console.log(`db: ${dbPath}`)
  else rmSync(dir, { recursive: true, force: true })

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`handshake failed: ${error.message}`)
  process.exit(1)
})
