// Can the acceptance step be done by a process that was told nothing?
//
// This runs `scripts/acceptance-blind.mjs` and reads its three verdicts. In that script
// the reviewer is a separate process whose environment is rebuilt from scratch, with no
// expected values in it; what is asserted here is its behaviour, not its implementation.
//
// The three staged tasks differ only in what the claim is worth: honest names a row and
// its real digest, wrong is one hex digit off, missing points at a memory nobody wrote.
// An acceptance that checks nothing verifies all three, which is the failure pinned here.
//
// The fourth task is the loop rather than a verdict: the worker returns a real memory
// that is not the one asked for, a reviewer sends it back, a restarted worker finds the
// reason on its queue and fixes it, and a second reviewer verifies. Both attempts have
// to stay on the record.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'acceptance-blind.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const run = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 180_000 })
let report = null
try { report = JSON.parse(run.stdout) } catch {}

ok('the drill exits 0', run.status === 0, `exit ${run.status} ${String(run.stderr).slice(-300)}`)
ok('and reports four results', Array.isArray(report?.results) && report.results.length === 4,
  JSON.stringify(report?.results ?? report).slice(0, 300))

const byKind = Object.fromEntries((report?.results ?? []).map((r) => [r.kind, r]))

ok('the honest return is accepted, and the task really moved to verified',
  byKind.honest?.verdict === 'verified' && byKind.honest?.state === 'verified',
  `${byKind.honest?.verdict} / ${byKind.honest?.state}`)
ok('a digest one hex digit off is rejected, with that reason',
  byKind.wrong?.verdict === 'rejected' && /digest/i.test(String(byKind.wrong?.reason)),
  String(byKind.wrong?.reason))
ok('and the task did not move to verified on a rejected return',
  byKind.wrong?.state !== 'verified', String(byKind.wrong?.state))
ok('the rejection is on the record, so the task is back on the worker queue',
  byKind.wrong?.state === 'assigned', String(byKind.wrong?.state))
ok('a reference to a memory that was never written is rejected',
  byKind.missing?.verdict === 'rejected' && /not-found/i.test(String(byKind.missing?.reason)),
  String(byKind.missing?.reason))
ok('and that task did not move either',
  byKind.missing?.state !== 'verified', String(byKind.missing?.state))

// A reviewer that cannot find the task must say so, not verify something. This is
// the same failure mode as a store that refuses everything passing a refusal test:
// "no answer" and "accepted" must never look alike.
{
  const scratch = mkdtempSync(join(tmpdir(), 'acm-blind-none-'))
  const empty = spawnSync(process.execPath, [script, '--review', 'T-nosuchkey-0000'], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, ACM_DB: join(scratch, 'empty.sqlite'), ACM_OWNER: 'x', ACM_AGENT: 'reviewer', ACM_AUTH_MODE: 'local' },
  })
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  const line = String(empty.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  let answer = null
  try { answer = JSON.parse(line) } catch {}
  ok('a reviewer pointed at no task answers "rejected", not "verified"',
    answer?.verdict === 'rejected', String(line ?? empty.stderr).slice(0, 200))
}

// The loop: wrong subject rejected, restarted worker reads the reason, second
// reviewer verifies, and both attempts are still readable afterwards.
ok('a return that cites the wrong artifact is rejected on the requirement, not the digest',
  /requirement-not-met/.test(String(byKind.resume?.attempts?.first)),
  String(byKind.resume?.attempts?.first))
ok('then a restarted worker finds the reason and the fix is accepted',
  byKind.resume?.verdict === 'verified' && byKind.resume?.state === 'verified',
  `${byKind.resume?.verdict} / ${byKind.resume?.state}`)
ok('both attempts and both decisions are on the record after the restart',
  byKind.resume?.log?.returns === 2 && byKind.resume?.log?.rejects === 1 && byKind.resume?.log?.verifies === 1,
  JSON.stringify(byKind.resume?.log ?? null))

// The negative controls are only worth something if the positive one is not
// vacuous: the honest return has to have gone through every step.
ok('the accepted return was checked step by step, not waved through',
  (byKind.honest?.checks ?? 0) >= 9, `${byKind.honest?.checks ?? 0} checks`)

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
