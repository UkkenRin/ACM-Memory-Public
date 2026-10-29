/**
 * Verify that every relative Markdown link resolves.
 *
 * GitHub silently renders a broken relative link as plain text, so a moved or
 * renamed document is invisible in review. This check fails the build instead.
 * External URLs are not fetched: the check must work offline and must not
 * turn a network hiccup into a red build.
 *
 * The syntax is parsed by `lib/markdown-links.mjs`, the same module the export gate
 * uses. Two regexes meant two answers: this file and `scanDocLinks` both handled inline
 * links only, so reference-style links were unchecked on both sides - a green mirror
 * said nothing about them.
 *
 * `--root <dir>` checks a tree other than this repository: the publication step runs
 * this against the staged export, which is the tree the reader will actually get. The
 * directory a run checks is printed, so a check that looked at the wrong tree says so.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractLinks, isExternal } from '../lib/markdown-links.mjs'

const argv = process.argv.slice(2)
let rootArg = null
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--root') rootArg = argv[++i]
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('usage: node scripts/check-doc-links.mjs [--root <dir>]')
    process.exit(0)
  } else {
    console.error(`unknown argument: ${argv[i]}`)
    process.exit(2)
  }
}

const root = rootArg ? resolve(rootArg) : fileURLToPath(new URL('../', import.meta.url))
if (!existsSync(root)) {
  console.error(`no such directory: ${root}`)
  process.exit(2)
}
const skip = new Set(['.git', 'node_modules', 'lib/vendor', '.tmp'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = relative(root, abs).replace(/\\/g, '/')
    if ([...skip].some((s) => rel === s || rel.startsWith(`${s}/`))) continue
    if (entry.isDirectory()) walk(abs, out)
    else if (entry.isFile() && extname(entry.name) === '.md') out.push(abs)
  }
  return out
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces to dashes. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()#!.,:;'"<>|+~?/\\]/g, '')
    .replace(/\s+/g, '-')
}

function headingsOf(file) {
  const text = readFileSync(file, 'utf8')
  const set = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) set.add(slug(m[2]))
  }
  return set
}

const headingCache = new Map()
function headingsFor(file) {
  if (!headingCache.has(file)) headingCache.set(file, headingsOf(file))
  return headingCache.get(file)
}

/** A GitHub anchor matches either the slug or the raw lowercase text. */
function anchorExists(file, anchor) {
  const set = headingsFor(file)
  return set.has(slug(anchor)) || set.has(anchor.toLowerCase())
}

const problems = []
const files = walk(root).filter((f) => !f.includes(join('lib', 'vendor')))

for (const file of files) {
  const relFile = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  for (const link of extractLinks(text)) {
    const raw = link.target
    if (isExternal(raw)) {
      if (raw.startsWith('#') && raw.length > 1 && !anchorExists(file, raw.slice(1))) {
        problems.push(`${relFile}: missing local anchor ${raw}`)
      }
      continue
    }
    const [target, anchor] = raw.split('#')
    if (!target) continue
    const abs = resolve(dirname(file), decodeURI(target))
    if (!existsSync(abs)) {
      problems.push(`${relFile}: missing target ${raw}`)
      continue
    }
    if (anchor && statSync(abs).isFile() && extname(abs) === '.md') {
      if (!anchorExists(abs, anchor)) problems.push(`${relFile}: missing anchor #${anchor} in ${target}`)
    }
  }
}

if (problems.length) {
  console.error(`Documentation link check failed (${problems.length}):\n` + problems.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation link check passed (${files.length} files, root ${root}).`)
}
