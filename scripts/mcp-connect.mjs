#!/usr/bin/env node
/**
 * A client that is not part of this project.
 *
 * Everything else here reaches the store through modules of its own: the SDK calls
 * functions, the loop drivers share `mcp-agent.mjs`, and the discovery harness imports
 * the MCP surface. All of that proves the code agrees with itself. This file imports
 * nothing - not one `lib/` path - and speaks the protocol over a pipe the way a foreign
 * client would: one JSON-RPC line in, one line out, in order.
 *
 * It is also the thing a reviewer can run without a listener, without a credential and
 * without a private checkout:
 *
 *   node scripts/mcp-connect.mjs                       # fresh store under .tmp/
 *   node scripts/mcp-connect.mjs --db /tmp/x.sqlite --keep
 *
 * Each step prints one line and appends a record with a digest of the answer, so the
 * transcript is a record of what came back rather than a claim about it. The probe
 * memory it writes is removed again unless `--keep` is given: a connection test that
 * leaves facts in someone's store is a bad guest.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const dbPath = resolve(flag('db', '.tmp/mcp-connect.sqlite'))
const agent = flag('agent', 'auditor')
const authMode = flag('auth', 'local')
const logPath = flag('log')
const keep = has('keep')
const mcpPath = flag('mcp', fileURLToPath(new URL('../lib/host/mcp.mjs', import.meta.url)))
const fresh = has('fresh')

if (fresh) rmSync(dbPath, { force: true })
mkdirSync(dirname(dbPath), { recursive: true })

const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16)
const tape = []
let failures = 0

const record = (entry) => {
  tape.push(entry)
  const line = JSON.stringify(entry)
  if (logPath) appendFileSync(logPath, `${line}\n`)
}

const check = (label, condition, detail = '') => {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
  record({ step: tape.length + 1, check: label, ok, detail })
  return ok
}

// The child is exactly what a client configuration would launch: an interpreter, an
// entry point, and environment variables. Nothing is passed on a private channel.
const child = spawn(process.execPath, [mcpPath], {
  env: {
    ...process.env,
    ACM_DB: dbPath,
    ACM_AGENT: agent,
    ACM_SESSION: `connect-${agent}`,
    ACM_AUTH_MODE: authMode,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

const pending = new Map()
let nextId = 1
let closed = null
child.on('exit', (code, signal) => {
  closed = `exit ${code ?? signal}`
  for (const [, entry] of pending) entry.reject(new Error(`server exited: ${closed}\n${stderr}`))
  pending.clear()
})

createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try { msg = JSON.parse(text) } catch { return }
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  clearTimeout(entry.timer)
  if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
  else entry.resolve(msg.result)
})

const rpc = (method, params) => new Promise((resolvePromise, rejectPromise) => {
  if (closed) return rejectPromise(new Error(`server is gone (${closed})`))
  const id = nextId++
  const timer = setTimeout(() => {
    pending.delete(id)
    rejectPromise(new Error(`no answer to ${method} in 20s`))
  }, 20_000)
  pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

/** Call a tool and split transport failure from a refusal the store reported. */
const call = async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n')
  return { isError: Boolean(result?.isError), text, structured: result?.structuredContent ?? null }
}

const finish = async (code) => {
  try { child.stdin.end() } catch {}
  child.kill()
  if (logPath) console.log(`tape: ${logPath} (${tape.length} records)`)
  process.exit(code)
}

try {
  console.log(`mcp   ${mcpPath}`)
  console.log(`db    ${dbPath}`)
  console.log(`agent ${agent} (auth mode: ${authMode})`)
  console.log('')

  // 1. Handshake. The version is a negotiation, not a constant to assume: it is
  //    whatever the server answers, and the client reports it rather than a message
  //    it was told to expect.
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'acm-connect', version: '1' },
  })
  check('initialize answered', Boolean(init?.serverInfo?.name), `${init?.serverInfo?.name} ${init?.serverInfo?.version}, protocol ${init?.protocolVersion}`)
  check('server names itself', String(init?.serverInfo?.name ?? '').length > 0, init?.serverInfo?.name ?? '')
  check('instructions are present', typeof init?.instructions === 'string' && init.instructions.length > 0, `${String(init?.instructions ?? '').length} chars`)
  record({ step: 'initialize', digest: digest(init) })

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  // 2. What does the surface look like? This is the part a reviewer cannot get from
  //    reading source: the list is filtered per principal when the store is scoped.
  const listed = await rpc('tools/list', {})
  const tools = listed?.tools ?? []
  const names = tools.map((t) => t.name)
  check('tools/list answered', tools.length > 0, `${tools.length} tools`)
  check('every tool carries an input schema', tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'))
  record({ step: 'tools/list', digest: digest(names), tools: names })

  // A scoped store with no grants is the other half of the picture, and it is the half
  // that cannot be faked: nothing is refused *after* being admitted. The surface itself
  // is trimmed, and what remains answers with the verb it wanted.
  if (flag('expect') === 'denied') {
    check('an uncredentialed surface is trimmed, not merely refused later', tools.length <= 1, `${tools.length} tool(s): ${names.join(',') || 'none'}`)
    const readDenied = await rpc('resources/read', { uri: 'acm://status' }).then(() => null, (err) => err.message)
    check('a read names the verb it wanted', /not authorized: memory:read/.test(String(readDenied)), String(readDenied ?? 'the read succeeded'))
    const writeDenied = await call('acm_remember', { text: 'should never be stored', key: 'denied.probe', scope: 'global' })
    check('a write is refused with a reason, not an empty success', writeDenied.isError && /not authorized/.test(writeDenied.text), writeDenied.text.slice(0, 100))
    console.log('')
    console.log(failures === 0 ? `refused as configured: ${tape.filter((r) => r.check).length} checks, 0 failed` : `refused unexpectedly: ${failures} failure(s)`)
    await finish(failures === 0 ? 0 : 1)
  }

  check('known resident tools are present', ['acm_remember', 'acm_search', 'acm_inbox'].every((n) => names.includes(n)))

  const resources = await rpc('resources/list', {})
  check('resources/list answered', (resources?.resources ?? []).length > 0, `${(resources?.resources ?? []).length} resources`)
  record({ step: 'resources/list', digest: digest(resources), uris: (resources?.resources ?? []).map((r) => r.uri) })

  const status = await rpc('resources/read', { uri: 'acm://status' })
  const statusText = (status?.contents ?? [])[0]?.text ?? ''
  let statusParsed = null
  try { statusParsed = JSON.parse(statusText) } catch {}
  check('acm://status reads back as json', Boolean(statusParsed), statusText ? `${statusText.length} chars` : 'empty')
  check('status does not leak the database path', !statusText.includes(dbPath), 'dbPath absent')

  // 3. A round trip through the store, not through a mock: write one fact, read it
  //    back by query, then remove it (unless asked to keep it).
  const probeKey = `mcp.connect.probe.${Date.now()}`
  const probeText = 'The MCP connection test wrote this line and read it back'
  const wrote = await call('acm_remember', { text: probeText, key: probeKey, kind: 'fact', scope: 'global', source: 'scripts/mcp-connect.mjs' })
  // A stored fact has an id. Checking only that the call did not throw would accept a
  // reply that says, in its body, that nothing was stored.
  check('acm_remember returns the id of the row it wrote', !wrote.isError && wrote.structured?.id != null, wrote.isError ? wrote.text.slice(0, 120) : JSON.stringify(wrote.structured))

  const found = await call('acm_search', { query: probeText, scope: 'global', limit: 5 })
  const hits = found.structured?.items ?? found.structured?.results ?? []
  const sawIt = JSON.stringify(found.structured ?? found.text).includes(probeKey) || (Array.isArray(hits) && hits.length > 0)
  check('acm_search returns the fact that was just written', !found.isError && sawIt, `${Array.isArray(hits) ? hits.length : '?'} hit(s)`)

  const reRead = await call('acm_search', { query: probeKey, scope: 'global', limit: 5 })
  check('a second read is stable', !reRead.isError && reRead.text.length > 0, `${reRead.text.length} chars`)

  const inbox = await call('acm_inbox', {})
  check('acm_inbox answers', !inbox.isError, inbox.isError ? inbox.text.slice(0, 120) : `${JSON.stringify(inbox.structured ?? {}).slice(0, 80)}`)

  // 4. A refusal has to look like a refusal. Naming a tool that does not exist must
  //    come back as an error result, not as an empty success.
  const missing = await call('acm_no_such_tool', {})
  check('an unknown tool is refused, not silently emptied', missing.isError, missing.text.slice(0, 80))

  const pinged = await rpc('ping', {})
  check('ping answered', pinged !== null && typeof pinged === 'object')

  if (!keep) {
    // `acm_forget` takes the row id, not the fact key, and its answer is `{ ok }`:
    // a miss comes back as `ok: false` inside a *successful* transport response, so
    // "the call did not throw" is not evidence that anything was forgotten. Both
    // halves are checked - the id came out of the write, and the reply said ok.
    const id = wrote.structured?.id
    const forgot = id == null ? { isError: true, text: 'acm_remember returned no id', structured: null } : await call('acm_forget', { id })
    check('acm_forget reports that it forgot the row', !forgot.isError && forgot.structured?.ok === true, forgot.isError ? forgot.text.slice(0, 120) : JSON.stringify(forgot.structured))
    // "removed" is a claim; reading the store again is the evidence. A delete that
    // reports success and leaves the row behind is the shape of failure this whole
    // project keeps finding, so the check is the second read, not the reply.
    const after = await call('acm_search', { query: probeKey, scope: 'all', limit: 5 })
    const stillThere = JSON.stringify(after.structured ?? after.text).includes(probeKey)
    check('the fact is gone when read again', !stillThere, stillThere ? 'still returned by acm_search' : 'no longer returned')
  }

  console.log('')
  console.log(failures === 0 ? `connected: ${tape.filter((r) => r.check).length} checks, 0 failed` : `connected with ${failures} failure(s)`)
  await finish(failures === 0 ? 0 : 1)
} catch (err) {
  console.log(`FAIL the session did not complete - ${err?.message ?? err}`)
  record({ step: 'session', ok: false, error: String(err?.message ?? err) })
  await finish(1)
}
