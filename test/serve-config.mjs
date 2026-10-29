/**
 * The refusal, branch by branch, with no socket anywhere.
 *
 * Every case here is one way the four values can be wrong *before* anything is bound.
 * The reason this test exists as a separate file is that the interesting behaviour of
 * the entry point is not "does it listen" - that is three lines of Node - but "does
 * it stop when the owner has not said the thing". A test that had to bind a port to
 * check the second would need the authorisation it is checking for.
 */
import { resolveServeConfig, describeServeConfig, MAX_TTL_MS, MIN_TTL_MS, STOP_MODES, LOOPBACK } from '../lib/serve-config.mjs'

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`ok   ${label}`) }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`) }
}

const base = {
  ACM_SERVE_PORT: '8787',
  ACM_SERVE_BIND: '127.0.0.1',
  ACM_SERVE_TTL_MS: '900000',
  ACM_SERVE_STOP: 'signal',
}

const withEnv = (patch) => resolveServeConfig({ ...base, ...patch })

// --- missing values: no defaults, and every missing name is reported at once
{
  const all = resolveServeConfig({})
  ok('an empty environment is refused', all.ok === false)
  ok('all four names are reported, not just the first',
    all.missing.length === 4, JSON.stringify(all.missing))
  ok('and the error list is empty, because nothing was wrong with the values', all.errors.length === 0)
}

for (const name of Object.keys(base)) {
  const env = { ...base }
  delete env[name]
  const result = resolveServeConfig(env)
  ok(`missing ${name} alone is refused, and named`, result.ok === false && result.missing[0] === name,
    JSON.stringify(result.missing))
}

// An empty string is not a value. Treating it as one would make `ACM_SERVE_PORT=` mean 0.
{
  const result = withEnv({ ACM_SERVE_PORT: '   ' })
  ok('a whitespace-only value counts as missing, not as zero', result.ok === false && result.missing.includes('ACM_SERVE_PORT'),
    JSON.stringify(result))
}

// --- port
for (const [value, why] of [['0', 'zero'], ['70000', 'above the range'], ['87a', 'not a number'], ['-1', 'negative']]) {
  ok(`port ${JSON.stringify(value)} is refused (${why})`, withEnv({ ACM_SERVE_PORT: value }).ok === false, value)
}
ok('port 8787 is accepted', withEnv({}).ok === true)

// --- bind
for (const value of ['localhost', 'example.com', '', '127.0.0.1:8787']) {
  const result = withEnv({ ACM_SERVE_BIND: value })
  ok(`bind ${JSON.stringify(value)} is refused as not an address literal`, result.ok === false, JSON.stringify(result.errors ?? []))
}
ok('bind 127.0.0.1 is loopback', withEnv({}).ok && withEnv({}).config.loopback === true)
ok('bind ::1 is loopback', withEnv({ ACM_SERVE_BIND: '::1' }).ok && withEnv({ ACM_SERVE_BIND: '::1' }).config.loopback === true)

// --- off loopback needs TLS, and half a TLS config is not half a TLS config
{
  const bare = withEnv({ ACM_SERVE_BIND: '0.0.0.0' })
  ok('a public bind without TLS is refused', bare.ok === false && /TLS/.test(bare.errors.join(' ')), JSON.stringify(bare.errors))
  const half = withEnv({ ACM_SERVE_BIND: '0.0.0.0', ACM_SERVE_TLS_CERT: '/tmp/c.pem' })
  ok('a public bind with only a certificate is still refused', half.ok === false)
  const full = withEnv({ ACM_SERVE_BIND: '0.0.0.0', ACM_SERVE_TLS_CERT: '/tmp/c.pem', ACM_SERVE_TLS_KEY: '/tmp/k.pem' })
  ok('a public bind with both files is accepted', full.ok === true && full.config.tls?.cert === '/tmp/c.pem')
  const lone = withEnv({ ACM_SERVE_TLS_KEY: '/tmp/k.pem' })
  ok('a key without a certificate on loopback is refused as a half config', lone.ok === false, JSON.stringify(lone.errors))
}

// --- credential lifetime
for (const [value, why] of [[String(MAX_TTL_MS + 1), 'above the hour'], ['0', 'zero'], ['-5', 'negative'], ['abc', 'not a number']]) {
  ok(`ttl ${JSON.stringify(value)} is refused (${why})`, withEnv({ ACM_SERVE_TTL_MS: value }).ok === false, value)
}
ok(`ttl ${MIN_TTL_MS} is accepted (the floor itself)`, withEnv({ ACM_SERVE_TTL_MS: String(MIN_TTL_MS) }).ok === true)
ok(`ttl ${MAX_TTL_MS} is accepted (the ceiling itself)`, withEnv({ ACM_SERVE_TTL_MS: String(MAX_TTL_MS) }).ok === true)

// --- how it stops
ok('an undeclared stop mode is refused rather than assumed', withEnv({ ACM_SERVE_STOP: 'whatever' }).ok === false)
for (const mode of STOP_MODES) {
  ok(`stop mode ${mode} is accepted`, withEnv({ ACM_SERVE_STOP: mode }).ok === true)
}

// --- the echo: the values about to be bound are the values as given
{
  const result = resolveServeConfig({ ...base, ACM_SERVE_PORT: '08787' })
  ok('the port is passed to the socket as a number', result.config.port === 8787, String(result.config.port))
  ok('the value is echoed back exactly as typed, not normalised',
    result.ok && result.config.asGiven.ACM_SERVE_PORT === '08787', JSON.stringify(result.config?.asGiven))
  const text = describeServeConfig(result.config)
  ok('the description names all four', ['port', 'bind', 'ttl', 'stop'].every((w) => text.includes(w)), text)
}

ok('LOOPBACK is exactly the two addresses the design talks about', LOOPBACK.length === 2 && LOOPBACK.includes('127.0.0.1') && LOOPBACK.includes('::1'), JSON.stringify(LOOPBACK))

console.log(`\nserve config: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
