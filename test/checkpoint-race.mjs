// One owner/session may have exactly one current checkpoint at any instant
//
// Before the fix `saveCheckpoint` read the previous row outside the transaction and then
// ran `begin immediate`: two savers could both read the same prev, both insert with
// `superseded_by` null, and recovery would pick whichever had the later timestamp - which
// is not necessarily the last write.
//
// Here two processes really write at the same time, a third connection samples the
// invariant while they run, and the only question asked is how many active rows exist.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'
import { saveCheckpoint, activeCheckpoint } from '../lib/checkpoint.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'acm-race-'))
const dbPath = join(dir, 'store.sqlite')
const worker = join(dir, 'writer.mjs')
const lib = join(here, '..', 'lib')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

writeFileSync(worker, `
import { openDb } from ${JSON.stringify(join(lib, 'db.mjs'))}
import { saveCheckpoint } from ${JSON.stringify(join(lib, 'checkpoint.mjs'))}
// A few milliseconds between saves widens the window a reader-then-writer bug
// needs, so the run is not only fast - it is adversarial.
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const db = openDb(${JSON.stringify(dbPath)})
for (let i = 0; i < 20; i++) { nap(1 + (i % 3)); saveCheckpoint(db, { sessionId: 'cli:race', owner: 'race', goal: 'w' + process.argv[2] + '-' + i }) }
`)

try {
  // The writers run in the background while this process watches the invariant from
  // the outside: at no instant may there be two active rows, not just at the end.
  const running = ['a', 'b'].map((tag) => spawn(process.execPath, [worker, tag], { stdio: ['ignore', 'pipe', 'pipe'] }))
  let peak = 0
  let samples = 0
  const watcher = openDb(dbPath)
  try {
    while (running.some((c) => c.exitCode === null && !c.killed)) {
      const c = Number(watcher.prepare("select count(*) c from acm_checkpoints where session_id = 'cli:race' and superseded_by is null").get().c)
      if (c > peak) peak = c
      samples++
      if (samples > 4000) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      if (running.every((x) => x.exitCode !== null)) break
    }
  } finally {
    await Promise.all(running.map((c) => new Promise((done) => (c.exitCode !== null ? done() : c.once('exit', done)))))
    watcher.close()
  }
  const runs = running.map((c) => ({ status: c.exitCode }))
  ok('both writers finished without an error',
    runs.every((r) => r.status === 0),
    runs.map((r) => `exit ${r.status}`).join(' | '))
  ok('at no instant during the run were there two active checkpoints',
    peak <= 1, `peak ${peak} over ${samples} samples`)

  const db = openDb(dbPath)
  const rows = db.prepare("select id, superseded_by from acm_checkpoints where session_id = 'cli:race' order by id").all()
  const active = rows.filter((r) => r.superseded_by == null)
  const total = rows.length
  db.close()

  ok('every save was recorded', total === 40, `${total} rows`)
  ok('exactly one checkpoint is active at the end', active.length === 1,
    `${active.length} active of ${total}`)

  // The invariant is about the store, not about this one run: a successor that reads
  // now gets one goal, and it is the last one written.
  const after = openDb(dbPath)
  const current = activeCheckpoint(after, 'cli:race', 'race')
  const latest = after.prepare("select goal from acm_checkpoints where session_id = 'cli:race' order by id desc limit 1").get()
  after.close()
  ok('the active checkpoint is the most recent write', current?.goal === latest?.goal,
    `${current?.goal ?? '-'} vs ${latest?.goal ?? '-'}`)

  // A fork left by an older version is collapsed by the next save rather than kept.
  {
    const forkPath = join(dir, 'fork.sqlite')
    const fork = openDb(forkPath)
    const at = Date.now() - 10_000
    const ins = fork.prepare('insert into acm_checkpoints (session_id, owner, goal, done, next, files, decisions, turn, created_at) values (?,?,?,?,?,?,?,?,?)')
    ins.run('cli:fork', 'race', 'first', '', '', '', '', null, at)
    ins.run('cli:fork', 'race', 'second', '', '', '', '', null, at + 1)
    const before = fork.prepare("select count(*) c from acm_checkpoints where session_id = 'cli:fork' and superseded_by is null").get().c
    saveCheckpoint(fork, { sessionId: 'cli:fork', owner: 'race', goal: 'third' })
    const afterFork = fork.prepare("select count(*) c from acm_checkpoints where session_id = 'cli:fork' and superseded_by is null").get().c
    fork.close()
    ok('a store that already had two active rows is collapsed by the next save',
      Number(before) === 2 && Number(afterFork) === 1, `${before} -> ${afterFork}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
