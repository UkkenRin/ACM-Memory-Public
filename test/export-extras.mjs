/**
 * The export verifier's blind spot, pinned in both directions.
 *
 * On 2026-11-18 fourteen probe files went from `.tmp*` into the public mirror. The
 * verifier had passed seconds earlier, and it was not wrong to: it deliberately skips
 * test scratch so that running the suite inside a tree does not fail the check on the
 * suite's own leftovers (`PUB-12`). The publish step then walked the directory and
 * shipped everything it found, including the scratch.
 *
 * So the leniency is a decision, not a bug, and the fix is a second question asked on
 * the publish path. These checks keep both halves honest: the default still ignores
 * scratch (or every run after `test:all` goes red), and `--strict-extras` reports it
 * (or the next publish repeats the accident).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verify = fileURLToPath(new URL('../scripts/verify-export.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'acm-export-extras-'))
const sha = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex')

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}

const run = (...args) => {
  try {
    const stdout = execFileSync(process.execPath, [verify, '--root', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

try {
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'README.md'), '# t\n')
  writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
    exportId: 'test',
    files: {
      'README.md': sha('# t\n'),
      'lib/a.mjs': sha('export const a = 1\n'),
    },
  }))

  t('a tree that matches its manifest passes', () => {
    const r = run('--require')
    if (r.code !== 0) throw new Error(r.out)
  })

  t('a file outside the manifest is caught', () => {
    writeFileSync(join(root, 'stray.txt'), 'x')
    const r = run('--require')
    if (r.code !== 1 || !r.out.includes('not in the manifest: stray.txt')) throw new Error(r.out)
    rmSync(join(root, 'stray.txt'))
  })

  t('test scratch is ignored by default, on purpose', () => {
    mkdirSync(join(root, '.tmp'), { recursive: true })
    writeFileSync(join(root, '.tmp', 'probe.sqlite'), 'sqlite')
    const r = run('--require')
    if (r.code !== 0) throw new Error(r.out)
  })

  t('--strict-extras reports the same scratch, by name', () => {
    const r = run('--require', '--strict-extras')
    if (r.code !== 1) throw new Error(`expected exit 1, got ${r.code}\n${r.out}`)
    if (!r.out.includes('not in the manifest: .tmp/probe.sqlite')) throw new Error(r.out)
  })

  t('a `.tmp-` sibling is scratch too', () => {
    mkdirSync(join(root, '.tmp-smoke'), { recursive: true })
    writeFileSync(join(root, '.tmp-smoke', 'diag.log'), 'log')
    const r = run('--require', '--strict-extras')
    if (!r.out.includes('not in the manifest: .tmp-smoke/diag.log')) throw new Error(r.out)
  })

  t('and strict goes green once the scratch is gone', () => {
    rmSync(join(root, '.tmp'), { recursive: true, force: true })
    rmSync(join(root, '.tmp-smoke'), { recursive: true, force: true })
    const r = run('--require', '--strict-extras')
    if (r.code !== 0) throw new Error(r.out)
  })

  t('strict still catches a hash mismatch, not just extras', () => {
    writeFileSync(join(root, 'README.md'), '# changed\n')
    const r = run('--require', '--strict-extras')
    if (r.code !== 1 || !r.out.includes('hash mismatch: README.md')) throw new Error(r.out)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nexport extras: ${pass} passed`)
