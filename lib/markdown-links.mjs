/**
 * Extract relative links from Markdown, once, for both sides of the gate.
 *
 * Two checks need this answer and they must not disagree: the export gate asks "will
 * this link resolve in the tree I am about to publish", and the mirror's own
 * `check-doc-links` asks "does it resolve here". When each kept its own regex, they
 * disagreed about reference-style links - the gate could not see `[x][id]`, and neither
 * could the check, so a green public CI said nothing about that format. The public CI
 * failing on `bf54bbc` is the same defect one level up: a rule on one side that the
 * other side did not share.
 *
 * What is supported is a deliberate subset, and it is the subset this repository uses:
 *
 *   - inline `[text](target "title")`, `![alt](target)`, targets in `<...>` when they
 *     contain spaces, and targets with balanced parentheses (`foo_(bar).md`);
 *   - reference links and images: `[text][id]`, `[text][]`, `[text]`, `![alt][id]`,
 *     resolved against `[id]: target` definitions in the same file;
 *   - HTML `<a href>` and `<img src>`, reported with `kind: 'html'` so the caller can
 *     decide. The gate refuses them on purpose (see `scanDocLinks`); the file-system
 *     check can verify them, so it does.
 *
 * Not supported: setext-style references, links inside fenced code blocks (they are
 * reported, and a caller that cares must skip them itself), and `[text]` shortcuts whose
 * definition lives in another file (GitHub does not resolve those either).
 */

const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm
const HTML_ANCHOR = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** True when a target makes no claim about this tree. */
export function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target) || target.startsWith('/')
}

/**
 * Read one inline link target starting just after `(`.
 *
 * Written as a scanner rather than a regex because the two interesting shapes -
 * `<path with space.md>` and `foo_(bar).md` - are exactly what `[^)\s]+` gets wrong,
 * and a gate that truncates a target checks a different string than the reader clicks.
 */
function readTarget(text, from) {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i += 1
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1)
    if (end === -1) return null
    return text.slice(i + 1, end)
  }
  let depth = 0
  const start = i
  for (; i < text.length; i += 1) {
    const c = text[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      if (depth === 0) break
      depth -= 1
    } else if (/\s/.test(c) && depth === 0) break
  }
  return text.slice(start, i)
}

/**
 * Every link in one Markdown document, in source order.
 *
 * Returns `[{ target, kind }]` with `kind` one of `inline`, `reference`, `html`.
 * Duplicates are kept: two links to the same missing file are two places to fix.
 */
export function extractLinks(text) {
  const definitions = new Map()
  for (const m of text.matchAll(DEFINITION)) {
    const id = m[1].trim().toLowerCase()
    if (!definitions.has(id)) definitions.set(id, m[2])
  }

  const links = []
  for (const [index, m] of [...text.matchAll(/(!?)\[([^\]]*)\]\(/g)].entries()) {
    const target = readTarget(text, m.index + m[0].length)
    if (target === null) continue
    links.push({ target, kind: 'inline', index })
  }

  // Reference forms. `[text][id]` and `![alt][id]` first, then the collapsed `[text][]`
  // and the shortcut `[text]`, which only count when a definition exists.
  const referenced = new Set()
  for (const m of text.matchAll(/(!?)\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const id = (m[3] || m[2]).trim().toLowerCase()
    referenced.add(m.index)
    const target = definitions.get(id)
    if (target !== undefined) links.push({ target, kind: 'reference', id })
  }
  for (const m of text.matchAll(/(!?)\[([^\]]+)\](?!\(|\[)/g)) {
    if (referenced.has(m.index)) continue
    const target = definitions.get(m[2].trim().toLowerCase())
    if (target !== undefined) links.push({ target, kind: 'reference', id: m[2].trim() })
  }

  for (const re of [HTML_ANCHOR, HTML_IMAGE]) {
    for (const m of text.matchAll(re)) {
      links.push({ target: m[1] ?? m[2] ?? '', kind: 'html' })
    }
  }

  return links.filter((l) => l.target)
}
