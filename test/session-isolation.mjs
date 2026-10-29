// Two agents on one machine must not overwrite each other's checkpoints
//
// Before the fix `sessionIdFromEnv()` answered `cli` for every process: alpha saved, beta
// saved, beta's save retired alpha's row, and alpha's next `inject` restored beta's goal.
// Two real processes reproduce that, and each must get its own goal back after a restart.
//
// The migration case is checked too: a store whose checkpoint sits under the bare `cli` id
// must still restore for the per-agent session rather than starting blank.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDb } from '../lib/db.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'lib', 'host', 'cli.mjs')

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { failures.push(`${name} ${extra}`); console.log(`  NO  ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'acm-sessions-'))
const dbPath = join(dir, 'store.sqlite')
const base = { PATH: process.env.PATH, ACM_DB: dbPath, ACM_OWNER: 'sessions' }
const as = (agent) => ({ ...base, ACM_AGENT: agent })

const cliRun = (agent, args) => spawnSync(process.execPath, [cli, ...args], { env: as(agent), encoding: 'utf8', timeout: 60_000 })

try {
  // ── two agents, each with its own goal
  const saved = ['alpha', 'beta'].map((agent) => cliRun(agent, ['checkpoint', '--goal', `${agent} synthetic goal`]))
  ok('both agents saved a checkpoint', saved.every((r) => r.status === 0), saved.map((r) => `${r.status}`).join(','))

  for (const agent of ['alpha', 'beta']) {
    // A fresh process is the point: nothing is carried over but the environment.
    const restored = cliRun(agent, ['inject'])
    ok(`${agent} restores its own goal after a restart`,
      restored.status === 0 && restored.stdout.includes(`${agent} synthetic goal`),
      `exit ${restored.status}`)
    const other = agent === 'alpha' ? 'beta' : 'alpha'
    ok(`${agent} does not restore ${other}'s goal`,
      !restored.stdout.includes(`${other} synthetic goal`), restored.stdout.split('\n').find((l) => l.includes('goal')) ?? '')
  }

  // ── one active checkpoint per identity, and the store says so
  {
    const db = openDb(dbPath)
    const rows = db.prepare('select session_id, count(*) c from acm_checkpoints where superseded_by is null group by session_id').all()
    db.close()
    ok('each identity has exactly one active checkpoint',
      rows.length === 2 && rows.every((r) => Number(r.c) === 1),
      rows.map((r) => `${r.session_id}=${r.c}`).join(' '))
  }

  // ── migration: a store written before this change still restores
  {
    const legacyPath = join(dir, 'legacy.sqlite')
    const db = openDb(legacyPath)
    db.prepare('insert into acm_checkpoints (session_id, owner, goal, done, next, files, decisions, turn, created_at) values (?,?,?,?,?,?,?,?,?)')
      .run('cli', 'sessions', 'goal written before the change', '', '', '', '', null, Date.now() - 60_000)
    db.close()
    const restored = spawnSync(process.execPath, [cli, 'inject'], {
      env: { ...as('alpha'), ACM_DB: legacyPath }, encoding: 'utf8', timeout: 60_000,
    })
    ok('a checkpoint stored under the old shared id is still restored',
      restored.status === 0 && restored.stdout.includes('goal written before the change'),
      `exit ${restored.status}`)
  }

  // ── an explicit session is still shared on purpose
  {
    const sharedPath = join(dir, 'shared.sqlite')
    const env = (agent) => ({ ...base, ACM_DB: sharedPath, ACM_AGENT: agent, ACM_SESSION: 'one-room' })
    spawnSync(process.execPath, [cli, 'checkpoint', '--goal', 'shared goal'], { env: env('alpha'), encoding: 'utf8', timeout: 60_000 })
    const asBeta = spawnSync(process.execPath, [cli, 'inject'], { env: env('beta'), encoding: 'utf8', timeout: 60_000 })
    ok('ACM_SESSION still makes two callers share one session',
      asBeta.status === 0 && asBeta.stdout.includes('shared goal'), `exit ${asBeta.status}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(failures.length
  ? `\n\u6709\u5931\u8D25  ${pass} \u9879\u901A\u8FC7\uFF0C${failures.length} \u9879\u5931\u8D25`
  : `\n\u5168\u7EFF  ${pass} \u9879\u901A\u8FC7`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
