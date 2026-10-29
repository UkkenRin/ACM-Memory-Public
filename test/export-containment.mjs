/**
 * The export directory is a filesystem boundary, not a string prefix.
 *
 * `fold(path)` writes an owner-wide view of the store, so the destination is the
 * operator's decision. The first version compared resolved path strings, which
 * collapses `..` and nothing else: a symlink (or a Windows junction) inside the
 * export directory passes a prefix test and writes wherever it points. These
 * checks are the ones a string comparison cannot answer.
 *
 * Every case asserts the file system afterwards, not that a call threw.
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.mjs'
import { grant, principalFromConfig, upsertPrincipal } from '../lib/auth.mjs'
import { openMemory } from '../lib/sdk.mjs'

const root = mkdtempSync(join(tmpdir(), 'acm-export-boundary-'))
const dbPath = join(root, 'memory.db')
const exportDir = join(root, 'exports')
const outside = join(root, 'outside')
mkdirSync(exportDir, { recursive: true })
mkdirSync(outside, { recursive: true })

let pass = 0
const t = (name, fn) => {
  fn()
  pass += 1
  console.log(`  ok ${name}`)
}
const skipped = (name, why) => console.log(`  skip ${name} (${why})`)
const refused = (err) => String(err?.code ?? '') === 'not-authorized'

const db = openDb(dbPath)
upsertPrincipal(db, { id: 'exporter', kind: 'agent', owner: 'bob' })
const principal = principalFromConfig({ agent: 'exporter', owner: 'bob', project: 'alpha' })
for (const g of [
  { action: 'memory:read', target: 'alpha' },
  { action: 'operator:export', target: null },
]) grant(db, { principal, ...g })
db.prepare(
  'insert into acm_nodes (owner, scope, kind, key, text, tokens, created_at) values (?, ?, ?, ?, ?, ?, ?)',
).run('bob', 's', 'fact', 'alpha.fact', 'ALPHA-NOTE', '[]', 1)
db.close()

const open = (extra = {}) =>
  openMemory({
    dbPath,
    sessionId: 's',
    config: { owner: 'bob', agent: 'exporter', project: 'alpha', exportDir, auth: { mode: 'scoped' }, ...extra },
  })

/** Directory links behave differently per platform; junction is the portable one. */
const linkDir = (target, path) => {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}
const linkFile = (target, path) => {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

try {
  // ------------------------------------------------------------------ baseline
  t('a nested path inside the directory is written', () => {
    // The operator creates directories; the export only writes files. Creating a
    // path on demand is what made "write here" mean "write wherever the last
    // component points" in the first place.
    mkdirSync(join(exportDir, 'nested'), { recursive: true })
    const target = join(exportDir, 'nested', 'view.md')
    const h = open()
    try {
      const text = h.fold(target)
      assert.ok(text.includes('ALPHA-NOTE'), 'the export returned nothing')
    } finally {
      h.close()
    }
    assert.ok(existsSync(target), 'a legal export did not write its file')
    assert.ok(readFileSync(target, 'utf8').includes('ALPHA-NOTE'), 'the written file is not the export')
  })

  t('a parent traversal is refused', () => {
    const target = join(exportDir, '..', 'escaped.md')
    const h = open()
    try {
      assert.throws(() => h.fold(target), refused, 'a traversal was accepted')
    } finally {
      h.close()
    }
    assert.equal(existsSync(join(root, 'escaped.md')), false, 'the traversal wrote a file')
  })

  // ------------------------------------------------- links inside the directory
  const dirLink = join(exportDir, 'to-outside')
  if (linkDir(outside, dirLink)) {
    t('a linked directory inside the export root is refused', () => {
      const target = join(dirLink, 'planted.md')
      const h = open()
      try {
        assert.throws(() => h.fold(target), refused, 'a symlinked directory was treated as inside the export root')
      } finally {
        h.close()
      }
      assert.equal(existsSync(join(outside, 'planted.md')), false, 'a write escaped through the link')
    })
  } else {
    skipped('a linked directory inside the export root is refused', 'this platform/user cannot create directory links')
  }

  const fileLink = join(exportDir, 'to-outside.md')
  const outsideFile = join(outside, 'target.md')
  writeFileSync(outsideFile, 'ORIGINAL\n', 'utf8')
  if (linkFile(outsideFile, fileLink)) {
    t('a destination that is itself a link is refused, not followed', () => {
      const h = open()
      try {
        assert.throws(() => h.fold(fileLink), refused, 'the export followed a link and wrote through it')
      } finally {
        h.close()
      }
      assert.equal(readFileSync(outsideFile, 'utf8'), 'ORIGINAL\n', 'the linked file was overwritten')
    })
  } else {
    skipped('a destination that is itself a link is refused, not followed', 'this platform/user cannot create file links')
  }

  // --------------------------------------------------------- dangling links
  //
  // The regression this file exists for. A symlink whose target does not exist is
  // reported as absent by anything that follows links, so the first implementation
  // read it as an empty slot: the walk-up stepped over it, the prefix test passed,
  // and `writeFileSync` created the file on the far side of the link. `lstat`
  // reports the directory entry, which exists regardless of the target.
  const danglingTarget = join(outside, 'not-created.md')
  const danglingLink = join(exportDir, 'dangling.md')
  if (linkFile(danglingTarget, danglingLink)) {
    t('a destination that is a dangling link is refused, and nothing is created', () => {
      assert.equal(existsSync(danglingTarget), false, 'the fixture target already exists, it proves nothing')
      const h = open()
      try {
        assert.throws(() => h.fold(danglingLink), refused, 'a dangling link was treated as an empty destination')
      } finally {
        h.close()
      }
      assert.equal(existsSync(danglingTarget), false, 'the export created a file outside the root through a dangling link')
      assert.ok(lstatSync(danglingLink).isSymbolicLink(), 'the link itself was replaced')
    })
  } else {
    skipped('a destination that is a dangling link is refused, and nothing is created', 'this platform/user cannot create file links')
  }

  const danglingDir = join(root, 'outside-not-created')
  const danglingDirLink = join(exportDir, 'dangling-dir')
  if (linkDir(danglingDir, danglingDirLink)) {
    t('a dangling link in the middle of the path is refused', () => {
      assert.equal(existsSync(danglingDir), false, 'the fixture target already exists, it proves nothing')
      const h = open()
      try {
        assert.throws(() => h.fold(join(danglingDirLink, 'view.md')), refused, 'a dangling directory link was walked through')
      } finally {
        h.close()
      }
      assert.equal(existsSync(danglingDir), false, 'the export created a directory outside the root through a dangling link')
    })
  } else {
    skipped('a dangling link in the middle of the path is refused', 'this platform/user cannot create directory links')
  }

  t('a missing intermediate directory is refused rather than created', () => {
    const target = join(exportDir, 'never-made', 'view.md')
    const h = open()
    try {
      assert.throws(() => h.fold(target), refused, 'the export invented an intermediate directory')
    } finally {
      h.close()
    }
    assert.equal(existsSync(join(exportDir, 'never-made')), false, 'the refused export created the directory anyway')
  })

  // ---------------------------------------------------------- existing entries
  t('an existing regular file is replaced', () => {
    const target = join(exportDir, 'existing.md')
    writeFileSync(target, 'STALE CONTENT\n', 'utf8')
    const h = open()
    try {
      h.fold(target)
    } finally {
      h.close()
    }
    const text = readFileSync(target, 'utf8')
    assert.ok(text.includes('ALPHA-NOTE'), 'the export did not replace the file')
    assert.ok(!text.includes('STALE CONTENT'), 'the old content survived')
  })

  t('a directory at the destination is refused', () => {
    const target = join(exportDir, 'a-directory')
    mkdirSync(target, { recursive: true })
    const h = open()
    try {
      assert.throws(() => h.fold(target), refused, 'a directory was accepted as an export target')
    } finally {
      h.close()
    }
    assert.ok(lstatSync(target).isDirectory(), 'the directory was replaced')
  })

  // ---------------------------------------------------------- the base itself
  t('a configured directory that does not exist is refused', () => {
    const h = open({ exportDir: join(root, 'not-created') })
    try {
      assert.throws(() => h.fold(join(root, 'not-created', 'view.md')), refused, 'a missing export root was invented')
    } finally {
      h.close()
    }
    assert.equal(existsSync(join(root, 'not-created')), false, 'the refused export created the directory')
  })

  t('a configured destination that is a file is refused', () => {
    const notADir = join(root, 'a-file.txt')
    writeFileSync(notADir, 'x\n', 'utf8')
    const h = open({ exportDir: notADir })
    try {
      assert.throws(() => h.fold(join(root, 'a-file.txt', 'view.md')), refused, 'a file was accepted as the export root')
    } finally {
      h.close()
    }
  })

  console.log(`\nexport containment: ${pass} passed`)
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    console.log(`  note: temp dir could not be removed: ${root}`)
  }
}
