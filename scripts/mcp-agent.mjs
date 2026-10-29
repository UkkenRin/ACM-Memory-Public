/**
 * One MCP client, one agent name, one child process.
 *
 * Shared by the loop drivers so that a second driver does not grow a second copy of
 * the JSON-RPC plumbing - and so that both exercise the same client behaviour: strictly
 * sequential requests, a hard per-request timeout, and a dead child that rejects its
 * outstanding calls instead of hanging the run.
 *
 * Nothing here knows about tasks or memory. It speaks the protocol the product exposes,
 * which is the point: a driver only reaches the store through tools a foreign client
 * could call.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class McpAgent {
  /**
   * @param {string} name        agent name; becomes `ACM_AGENT` and the session prefix
   * @param {object} options
   * @param {string} options.dbPath         store the child opens
   * @param {string} options.mcpPath        the MCP server entry point to spawn
   * @param {string} [options.project]      `ACM_PROJECT`
   * @param {number} [options.rpcTimeout]   per-request timeout in ms
   * @param {string} [options.sessionPrefix] prefix for `ACM_SESSION`
   * @param {object} [options.env]          extra environment for this child only
   */
  constructor(name, { dbPath, mcpPath, project = null, rpcTimeout = 30_000, sessionPrefix = 'loop-', env = {} } = {}) {
    this.name = name
    this.rpcTimeout = rpcTimeout
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    this.dead = null
    this.env = {
      ...process.env,
      ACM_DB: dbPath,
      ACM_SESSION: `${sessionPrefix}${name}`,
      ACM_AGENT: name,
      ACM_AUTH_MODE: 'scoped',
      ...(project ? { ACM_PROJECT: project } : {}),
      ...env,
    }
    this.child = spawn(process.execPath, [mcpPath], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk) })
    this.child.on('exit', (code, signal) => {
      this.dead = `exit ${code ?? signal}`
      for (const [, entry] of this.pending) entry.reject(new Error(`${this.name} died: ${this.dead}`))
      this.pending.clear()
    })
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try { msg = JSON.parse(text) } catch { return }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else entry.resolve(msg.result)
    })
  }

  rpc(method, params) {
    if (this.dead) return Promise.reject(new Error(`${this.name} is gone (${this.dead})`))
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`${this.name} timed out on ${method} after ${this.rpcTimeout}ms`))
      }, this.rpcTimeout)
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async start() {
    const info = await this.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acm-loop-driver', version: '1' },
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return info
  }

  /** One tool call. Returns `{ok:true, value}` or `{ok:false, error}`; never throws. */
  async tool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args })
    if (result?.isError) return { ok: false, error: String(result.content?.[0]?.text ?? 'isError') }
    return { ok: true, value: result?.structuredContent ?? null }
  }

  kill(signal = 'SIGKILL') {
    if (!this.dead) { try { this.child.kill(signal) } catch {} }
  }

  async stop() {
    if (this.dead) return
    try { this.child.stdin.end() } catch {}
    await new Promise((r) => { const t = setTimeout(r, 1500); this.child.once('exit', () => { clearTimeout(t); r() }) })
    this.kill()
  }
}
