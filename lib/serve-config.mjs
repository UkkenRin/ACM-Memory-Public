/**
 * The four values, as code rather than as a promise.
 *
 * Binding a port is the one thing in this project that a standing rule says may not
 * happen without the owner naming four values first: the port, the bind address, the
 * credential lifetime, and how it is shut down. A rule like that is worth nothing if it
 * lives in a document, because the code path that would violate it does not read the
 * document. So the entry point refuses to start unless all four arrive explicitly, and
 * this module is that refusal, written as a pure function so a test can walk every
 * branch without a socket.
 *
 * Three consequences of taking that seriously:
 *
 * 1. **No defaults.** A missing port is not 8787; it is a refusal that names the missing
 *    name. Defaults are how a decision gets made by whoever wrote the parser.
 * 2. **The bind address must be an address.** `localhost` resolves to whatever the host
 *    file says, which may be `::1` on one machine and `127.0.0.1` on the next, so the
 *    value that gets authorised and the value that gets bound could differ. Only literals
 *    are accepted.
 * 3. **Anything off loopback needs TLS at this process.** The design puts a reverse
 *    proxy in front and keeps this process on loopback precisely so that plaintext never
 *    reaches a network. A configuration that binds publicly without a certificate is not
 *    a slower version of that design; it is the design removed.
 *
 * What it cannot check: whether the owner actually said these values. That is the one
 * thing no program can verify about itself, and it is why the values are echoed back
 * verbatim before the socket opens.
 */

export const LOOPBACK = Object.freeze(['127.0.0.1', '::1'])

/** A credential that outlives the window it was issued for is a credential that gets
 *  copied into a config file. An hour is already generous for a handshake. */
export const MAX_TTL_MS = 60 * 60 * 1000

/** And one that expires before the handshake could finish is not a credential, it is a
 *  race. One second is the floor below which the value is certainly a typo. */
export const MIN_TTL_MS = 1000

/** Shutdown is declared, not inferred: the operator has to say how this process is
 *  stopped, because "I will kill it" and "systemd will stop it" confirm differently. */
export const STOP_MODES = Object.freeze(['systemd', 'signal'])

const REQUIRED = ['port', 'bind', 'ttl', 'stop']

function isIpLiteral(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255)
  }
  // Deliberately shallow: `::1` and `::` are the two this project cares about, and a
  // deep v6 parser here would be a second implementation of something Node already has.
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':')
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {{ok:true, config:object}|{ok:false, missing:string[], errors:string[]}}
 */
export function resolveServeConfig(env = {}) {
  const read = (name) => {
    const value = env[name]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  const port = read('ACM_SERVE_PORT')
  const bind = read('ACM_SERVE_BIND')
  const ttl = read('ACM_SERVE_TTL_MS')
  const stop = read('ACM_SERVE_STOP')

  const missing = []
  if (!port) missing.push('ACM_SERVE_PORT')
  if (!bind) missing.push('ACM_SERVE_BIND')
  if (!ttl) missing.push('ACM_SERVE_TTL_MS')
  if (!stop) missing.push('ACM_SERVE_STOP')
  if (missing.length) return { ok: false, missing, errors: [] }

  const errors = []

  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    errors.push(`ACM_SERVE_PORT must be an integer 1-65535, got ${JSON.stringify(port)}`)
  }

  if (!isIpLiteral(bind)) {
    errors.push(`ACM_SERVE_BIND must be an address literal, got ${JSON.stringify(bind)}`)
  }

  const ttlNumber = Number(ttl)
  if (!Number.isInteger(ttlNumber) || ttlNumber < MIN_TTL_MS) {
    errors.push(`ACM_SERVE_TTL_MS must be an integer of at least ${MIN_TTL_MS}, got ${JSON.stringify(ttl)}`)
  } else if (ttlNumber > MAX_TTL_MS) {
    errors.push(`ACM_SERVE_TTL_MS must not exceed ${MAX_TTL_MS} (one hour), got ${ttlNumber}`)
  }

  if (!STOP_MODES.includes(stop)) {
    errors.push(`ACM_SERVE_STOP must be one of ${STOP_MODES.join('|')}, got ${JSON.stringify(stop)}`)
  }

  const loopback = LOOPBACK.includes(bind)
  const cert = read('ACM_SERVE_TLS_CERT')
  const keyFile = read('ACM_SERVE_TLS_KEY')
  if (!loopback) {
    // Off loopback, plaintext is not an option this process gets to pick.
    if (!cert || !keyFile) {
      errors.push(`ACM_SERVE_BIND ${bind} is not loopback, so ACM_SERVE_TLS_CERT and ACM_SERVE_TLS_KEY are both required`)
    }
  } else if (Boolean(cert) !== Boolean(keyFile)) {
    errors.push('ACM_SERVE_TLS_CERT and ACM_SERVE_TLS_KEY must be given together or not at all')
  }

  if (errors.length) return { ok: false, missing: [], errors }

  return {
    ok: true,
    config: {
      port: portNumber,
      bind,
      loopback,
      ttlMs: ttlNumber,
      stop,
      tls: loopback && !cert ? null : { cert, key: keyFile },
      // Echoed back to the operator verbatim, so the thing that is about to be bound is
      // the thing that was authorised and not a normalised version of it.
      asGiven: { ACM_SERVE_PORT: port, ACM_SERVE_BIND: bind, ACM_SERVE_TTL_MS: ttl, ACM_SERVE_STOP: stop },
    },
  }
}

/** One line per value, in the order the rule names them. Used by `--print` and by the
 *  startup banner: the same text, so an operator comparing the two is comparing the
 *  real thing with itself. */
export function describeServeConfig(config) {
  return [
    `port      ${config.port}`,
    `bind      ${config.bind}${config.loopback ? ' (loopback)' : ''}`,
    `ttl       ${config.ttlMs} ms`,
    `stop      ${config.stop}`,
    `tls       ${config.tls ? `cert ${config.tls.cert}` : 'none (loopback, plaintext)'}`,
  ].join('\n')
}
