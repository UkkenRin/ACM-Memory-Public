// Injected text: the single entry point; assembled by priority, cut from the tail when over budget.

import { clamp } from './text.mjs'

const DAY = 86_400_000
const MONTH = 30 * DAY

/**
 * Coarse age. `now` is a parameter rather than `Date.now()`: the renderer must be
 * deterministic for a fixed clock, or the same data renders differently across a
 * minute boundary and the injected block churns for no information gain.
 */
function ago(ts, now = Date.now()) {
  const d = Math.max(0, Number(now) - Number(ts ?? now))
  if (d < 3_600_000) return '\u521A\u521A'
  if (d < DAY) return `${Math.floor(d / 3_600_000)} \u5C0F\u65F6\u524D`
  if (d < MONTH) return `${Math.floor(d / DAY)} \u5929\u524D`
  return `${Math.floor(d / MONTH)} \u4E2A\u6708\u524D`
}

function mmdd(ts) {
  const t = new Date(Number(ts))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/**
 * Provenance labels are a whitelist, and none of them claims authorship.
 *
 * `kind` is caller-supplied through `remember({ source: { kind } })`, so "manual"
 * only means the fact was written down explicitly - a user typing it and a model
 * calling `acm_remember` look identical from here. Labelling that "you said"
 * would be a claim the store cannot support. Anything off this list gets no
 * label at all, which is the honest default: silence, not a guess.
 */
const PROVENANCE = {
  plugin: '\u6A21\u578B\u62BD\u53D6',
  distill: '\u6A21\u578B\u62BD\u53D6',
  import: '\u5BFC\u5165',
  tool: '\u5DE5\u5177',
}

export function provenanceLabel(kind) {
  const key = String(kind ?? '')
  // Object.hasOwn, not a bare lookup: `kind` is caller-supplied, so a value like
  // "constructor" or "toString" would otherwise resolve to an inherited member
  // and render a function source into the injected block.
  return Object.hasOwn(PROVENANCE, key) ? PROVENANCE[key] : null
}

function checkpointBlock(cp, recovering, now) {
  const head = recovering ? '\u3010\u538B\u7F29\u540E\u6062\u590D · \u4EFB\u52A1\u72B6\u6001\u3011' : '\u3010\u4EFB\u52A1\u72B6\u6001\u3011'
  const lines = [head]
  if (cp.goal) lines.push(`\u76EE\u6807\uFF1A${cp.goal}`)
  if (cp.done) lines.push(`\u5DF2\u5B8C\u6210\uFF1A${cp.done}`)
  if (cp.next) lines.push(`\u4E0B\u4E00\u6B65\uFF1A${cp.next}`)
  if (cp.files) lines.push(`\u6587\u4EF6\uFF1A${cp.files}`)
  if (cp.decisions) lines.push(`\u5DF2\u5B9A\uFF1A${cp.decisions}`)
  lines[0] += `\uFF08${ago(cp.createdAt, now)}\uFF09`
  if (recovering) lines.push('\uFF08\u4E0A\u9762\u8FD9\u6BB5\u662F\u538B\u7F29\u524D\u5B58\u7684\uFF0C\u538B\u7F29\u540E\u6765\u7684\u5BF9\u8BDD\u53EF\u80FD\u5DF2\u7ECF\u63A8\u8FDB\u8FC7\uFF0C\u5148\u6838\u5BF9\u518D\u52A8\u624B\u3002\uFF09')
  return lines.join('\n')
}

function memoryBlock(items, { now, provenance, compact }) {
  if (!items.length) return ''
  const lines = ['\u3010\u8BB0\u5F97\u7684\u4E8B\u3011']
  for (const m of items) {
    const key = m.key ? `${m.key} = ` : ''
    const age = ago(m.createdAt, now)
    const when = compact ? age : `${age} · ${mmdd(m.createdAt)}`
    const kind = provenance instanceof Map ? provenance.get(m.id) : provenance?.[m.id]
    const label = provenanceLabel(kind)
    const tag = label ? ` · ${label}` : ''
    lines.push(`- [${when}${tag}] ${key}${m.text}`)
  }
  return lines.join('\n')
}

function warnBlock(warns) {
  if (!warns.length) return ''
  return ['\u3010\u9700\u8981\u4F60\u77E5\u9053\u3011', ...warns.map((w) => `- ${w}`)].join('\n')
}

/**
 * @param {{checkpoint?: object|null, memories?: object[], warns?: string[], recovering?: boolean, budget?: number, now?: number, provenance?: Map<number,string>|object|null}} p
 */
/** Counts only: enough to make a session look, not a second inbox listing. */
function waitBlock(waiting) {
  if (!waiting) return ''
  const parts = []
  if (waiting.messages > 0) parts.push(`\u672A\u8BFB\u6D88\u606F ${waiting.messages} \u6761`)
  if (waiting.tasks > 0) parts.push(`\u5F85\u4F60\u5904\u7406\u7684\u4EFB\u52A1 ${waiting.tasks} \u4EF6`)
  if (!parts.length) return ''
  return `\u7B49\u4F60\u5904\u7406\uFF1A${parts.join('\uFF0C')}\u3002\u5148\u770B acm_inbox \u4E0E acm_task\uFF0C\u518D\u5F00\u5DE5\u3002`
}

export function renderInjection({
  checkpoint = null,
  memories = [],
  warns = [],
  recovering = false,
  budget = 1400,
  now = Date.now(),
  provenance = null,
  waiting = null,
}) {
  const cpBlock = checkpoint ? checkpointBlock(checkpoint, recovering, now) : ''
  const warn = warnBlock(warns)
  // Pending work is stated before the memories: a session that cannot see a
  // message addressed to it, or a task assigned to it, has to be told by the
  // owner, which is the relay this product exists to remove.
  const wait = waitBlock(waiting)
  const build = (list, compact) => [cpBlock, wait, memoryBlock(list, { now, provenance, compact }), warn]
    .filter(Boolean)
    .join('\n\n')

  let out = build(memories, false)
  if (out.length > budget) {
    // Keep the fact, drop the redundant calendar date. The age is what stops
    // "three months" and "four days" looking identical; a bare MM-DD follows from
    // the age, so it is the cheapest thing to give up. Only after that are
    // trailing memories removed, and task state is never cut.
    out = build(memories, true)
  }
  let list = [...memories]
  while (list.length > 1 && out.length > budget) {
    list = list.slice(0, -1)
    out = build(list, true)
  }
  return clamp(out, budget)
}
