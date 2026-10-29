/**
 * What a client sees, in one place.
 *
 * Two hosts speak MCP: the stdio process (`lib/host/mcp.mjs`) and the offline HTTP
 * handler in this directory. They must answer `initialize` and `tools/list` the same
 * way, or one client learns a different store than the other. Keeping two
 * copies of the tool descriptions would make that a matter of remembering; this module
 * is the one copy.
 *
 * Nothing here imports the storage layer, and nothing here reads `process.env`. It is
 * data and string arithmetic, so the HTTP handler can answer `tools/list` without
 * opening a file it has not been authorised to open.
 */
import { readFileSync } from 'node:fs'

export const PROTOCOL = '2024-11-05'

// The version the client sees must be the version that is installed. A hardcoded
// string drifts silently, and a client caching it cannot tell builds apart.
export const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0-unknown'
  }
})()

export const SERVER_INFO = Object.freeze({ name: 'acm-memory', version: PACKAGE_VERSION })

export function jsonSchemaOf(parameters = {}) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(parameters)) {
    properties[k] = { type: v.type ?? 'string', ...(v.description ? { description: v.description } : {}) }
    if (v.items) properties[k].items = v.items
    if (v.required) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * English half of the external surface.
 *
 * The product has two users: a Chinese-speaking operator and an English-speaking one.
 * The maintained text in this repository is English; the runtime strings are Chinese
 * because the operator reads them. Everything a foreign MCP client sees is therefore
 * bilingual rather than one or the other.
 */
export const TOOL_SUMMARY = Object.freeze({
  'acm_capabilities': 'Report what this connection may do: auth mode, principal, granted actions, hidden tools and known limits',
  'acm_remember': 'Store one durable fact, preference or decision',
  'acm_search': 'Search memory by meaning and keywords',
  'acm_checkpoint': 'Save a task checkpoint so a later session can resume',
  'acm_forget': 'Mark one memory as no longer valid',
  'acm_alias': 'Teach a name that maps to another one',
  'acm_history': 'Show the revision history of one fact key',
  'acm_feedback': 'Record whether a recalled memory helped',
  'acm_evolve': 'Rebalance weights from recorded feedback',
  'acm_gc': 'Retire stale rows under the retention policy',
  'acm_send': 'Hand a task to another agent',
  'acm_inbox': 'List the work addressed to you that is not done yet',
  'acm_claim': 'Take ownership of one task; only one agent can hold it',
  'acm_complete': 'Close a task you claimed',
  'acm_task_create': 'Create a durable task with a state, an assignee and dependencies',
  'acm_task_list': 'List durable tasks in this partition',
  'acm_task_get': 'Read one task and its full transition trail',
  'acm_task_assign': 'Assign a task to an agent',
  'acm_task_accept': 'Start a task assigned to you and open a lease',
  'acm_task_return': 'Return a task with a result and evidence (kind:ref per line)',
  'acm_task_renew': 'Extend the lease on work you are still doing; nothing renews by itself',
  'acm_task_verify': 'Verify work someone else returned; the author cannot verify their own',
  'acm_task_reject': 'Send returned work back with a reason; attempts run out into failure',
  'acm_task_fail': 'Fail a task with a reason',
  'acm_task_cancel': 'Cancel a task that has not started',
  'acm_task_retry': 'Put an expired or failed task back to assigned',
})

export const RESOURCE_SUMMARY = Object.freeze({
  'acm://injection': 'Context that should be injected / \u8981\u6CE8\u5165\u7684\u4E0A\u4E0B\u6587',
  'acm://persona': 'Persona files, read only / \u4EBA\u683C\u6587\u4EF6\uFF08\u53EA\u8BFB\uFF09',
  'acm://status': 'Store status / \u5E93\u72B6\u6001',
})

export const bilingual = (english, chinese) => (english ? `${english} / ${chinese}` : chinese)

export const resourceTitle = (uri, fallback) => RESOURCE_SUMMARY[uri] ?? fallback

/**
 * One tool, as `tools/list` reports it.
 *
 * The schema is derived from the same `parameters` the tool runs against, so a
 * parameter cannot be accepted and undocumented.
 */
export function toolListing(spec) {
  return {
    name: spec.name,
    description: bilingual(TOOL_SUMMARY[spec.name], spec.description),
    inputSchema: jsonSchemaOf(spec.parameters),
  }
}

export const INSTRUCTIONS = bilingual(
  'Memory and task checkpoints. Read acm://injection before starting work, and again after a compaction or a new session.',
  '\u8BB0\u5FC6\u4E0E\u4EFB\u52A1\u68C0\u67E5\u70B9\u3002\u5F00\u5DE5\u524D\u8BFB acm://injection\uFF0C\u538B\u7F29\u6216\u6362\u4F1A\u8BDD\u540E\u4E5F\u8BFB\u5B83\u3002',
)
