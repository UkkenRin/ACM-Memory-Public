/**
 * The handshake drill, asserted from its own JSON rather than from its exit code.
 *
 * The point of the drill is that two processes must agree on **one row**. A driver
 * whose reader accepted everything would still print three acks and exit 0 if it
 * were only counting them, so the assertions here are about which ack was accepted
 * and why the other two were not.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'mailbox-handshake.mjs')

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`ok   ${label}`) }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`) }
}

const run = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 120_000 })
if (run.status !== 0) {
  console.log(`FAIL the drill exits 0 - exit ${run.status}`)
  console.log(run.stderr?.slice(-800) ?? '')
  process.exit(1)
}

let report
try {
  report = JSON.parse(String(run.stdout).trim().split('\n').filter(Boolean).pop())
} catch (error) {
  console.log(`FAIL the drill prints one JSON object - ${error.message}`)
  process.exit(1)
}

ok('the probe is a random number, not a literal', /^probe:[0-9a-f]{6}$/.test(String(report.number ?? '')), String(report.number))
ok('the receiver read the same row the sender wrote',
  report.received?.id === report.sent?.id && String(report.received?.body ?? '').includes(report.number),
  `${report.received?.id} vs ${report.sent?.id}`)
ok('the receiver claimed before answering', report.steps?.find((s) => s.label.includes('claims it'))?.ok === true)

const staged = report.staged ?? []
ok('four acknowledgements were staged, three of them wrong', staged.length === 4, String(staged.length))
ok('one of the staged acks carries a number one hex digit off',
  staged.some((s) => s.kind === 'near-miss' && s.number !== report.number), JSON.stringify(staged.map((s) => s.kind)))
ok('one of them carries the right number under an id nobody sent',
  staged.some((s) => s.kind === 'wrong-id' && s.number === report.number), JSON.stringify(staged.map((s) => s.kind)))
ok('one of them names the probe correctly but files itself under another message',
  staged.some((s) => s.kind === 'wrong-field' && s.number === report.number), JSON.stringify(staged.map((s) => s.kind)))

const refused = report.readBack?.refused ?? []
ok('the near-miss is refused as a number mismatch',
  refused.some((r) => r.why === 'wrong-number'), JSON.stringify(refused))
ok('the text naming another id than the field is refused as contradictory',
  refused.some((r) => r.why === 'contradictory-id'), JSON.stringify(refused))
ok('the right text filed under another parent is refused as the wrong field',
  refused.some((r) => r.why === 'wrong-field'), JSON.stringify(refused))
ok('exactly one ack is accepted', (report.readBack?.accepted ?? []).length === 1, JSON.stringify(report.readBack?.accepted))
ok('the accepted one is the ack the receiver says it staged as exact',
  (report.readBack?.accepted ?? [])[0] === staged.find((s) => s.kind === 'exact')?.id,
  `accepted ${report.readBack?.accepted?.[0]} vs exact ${staged.find((s) => s.kind === 'exact')?.id}`)
ok('the drill itself reports closed', report.ok === true)
ok('every step in the drill passed', (report.steps ?? []).every((s) => s.ok), JSON.stringify((report.steps ?? []).filter((s) => !s.ok)))

console.log(`\nmailbox handshake: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
