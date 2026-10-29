# Connecting a client to the MCP surface

This page is for someone who wants to see the server answer a real client, not read a
claim that it does. Everything here runs on one machine, over stdio, with no listener, no
port, no network credential and no private checkout: `lib/host/mcp.mjs` and the modules it
imports are all in this repository, and the store it opens is a file you create.

Requires Node 22 or newer — the store is `node:sqlite`. No install step: the server has no
third-party dependencies, and `lib/vendor` (a local embedding model, about 38 MB) is only
used for semantic search. A copy without it still connects, still writes and still reads
back; the retrieval that comes back is lexical rather than semantic. Measured both ways:
146 files / 39 MB and 1.3 MB without `lib/vendor` give the same 17 checks and 0 failures.

## 1. The entry point

```sh
node lib/host/mcp.mjs
```

It reads one JSON-RPC message per line on stdin and writes one per line on stdout, which is
what the `stdio` transport is. Launching it by hand and typing nothing is correct: it waits.

Configuration is by environment only:

| Variable | Meaning | Default |
|---|---|---|
| `ACM_DB` | path to the store file; created if absent | `./.acm/memory.sqlite` |
| `ACM_AGENT` | the name this client acts as | `agent` |
| `ACM_SESSION` | session id; memories written without one are not session-scoped | `default` |
| `ACM_OWNER` | owner partition | unset |
| `ACM_PROJECT` | project partition | unset |
| `ACM_AUTH_MODE` | `local` (no checks) or `scoped` (grants required) | `local` |
| `ACM_MAINTENANCE` | `1` takes a backup at startup; anything else does not | unset |

`ACM_MAINTENANCE` is worth knowing about: the host used to snapshot the store before it
had read a request, and that is a side effect a client should have to ask for.

## 2. A client configuration

Any client that speaks MCP over stdio takes the same three fields. For a Claude Desktop
`claude_desktop_config.json`, or the equivalent in Cursor:

```json
{
  "mcpServers": {
    "acm-memory": {
      "command": "node",
      "args": ["/absolute/path/to/ACM-Memory/lib/host/mcp.mjs"],
      "env": {
        "ACM_DB": "/absolute/path/to/acm.sqlite",
        "ACM_AGENT": "auditor",
        "ACM_AUTH_MODE": "local"
      }
    }
  }
}
```

MCP Inspector, without a config file:

```sh
npx @modelcontextprotocol/inspector node lib/host/mcp.mjs
```

## 3. A client that is not part of this repository

`scripts/mcp-connect.mjs` imports nothing from `lib/`. It spawns the server exactly as a
config would, then speaks the protocol line by line, and prints what came back:

```sh
node scripts/mcp-connect.mjs --fresh --db /tmp/acm-connect.sqlite
```

What a passing run looks like (17 checks, store freshly created):

```
ok   initialize answered - acm-memory 1.0.0-rc.2, protocol 2024-11-05
ok   instructions are present - 162 chars
ok   tools/list answered - 26 tools
ok   resources/list answered - 3 resources
ok   acm://status reads back as json - 591 chars
ok   status does not leak the database path - dbPath absent
ok   acm_remember returns the id of the row it wrote - {"id":1,"superseded":null}
ok   acm_search returns the fact that was just written - 1 hit(s)
ok   acm_inbox answers - {"items":[]}
ok   an unknown tool is refused, not silently emptied
ok   acm_forget reports that it forgot the row - {"ok":true}
ok   the fact is gone when read again - no longer returned
connected: 17 checks, 0 failed
```

Two of those checks exist because a weaker version of this script passed when it should
not have: a refusal arrives as `{ ok: false }` inside a *successful* response, and a delete
is only real when a later read cannot find the row.

`--log <file>` writes each step as one JSON line with a digest of the answer, so a
transcript can be handed to someone else instead of a summary of it.

## 4. What a scoped store looks like from outside

With `--auth scoped` and no grants, the same client gets a smaller surface and named
refusals:

```sh
node scripts/mcp-connect.mjs --fresh --db /tmp/acm-scoped.sqlite --auth scoped --expect denied
```

```
ok   tools/list answered - 1 tools
ok   an uncredentialed surface is trimmed, not merely refused later - 1 tool(s): acm_capabilities
ok   a read names the verb it wanted - -32603: not authorized: memory:read (no-grant)
ok   a write is refused with a reason, not an empty success - not authorized: memory:write-global (no-grant)
refused as configured: 8 checks, 0 failed
```

The refusal text is quoted from the coded part onward; the leading label is localised.
That is the shape to check when reviewing authorization: the tool is not listed *and* the
call is refused with the verb it wanted, rather than listed and then failing late, or
failing without saying why.

Granting is an operator act and lives in `lib/auth.mjs`; the scoped-handle tests in this
repository grant from there if you want a working example.

## 5. The same store with grants: three roles, one task

A store that refuses everything and a store that refuses nothing look identical to a
negative test. `scripts/mcp-scoped-flow.mjs` covers the other half: it seeds grants for
three principals, then starts four servers - one at a time, each its own process and
session - and makes them do one piece of work end to end.

```sh
node scripts/mcp-scoped-flow.mjs --fresh --db /tmp/acm-scoped-flow.sqlite
```

| principal | verbs it holds |
|---|---|
| `planner` | `memory:read`, `memory:write-global`, `mailbox:send`, `task:create`, `task:assign` |
| `worker` | `memory:read`, `mailbox:claim`, `mailbox:complete`, `task:accept`, `task:renew`, `task:return`, `task:verify` |
| `reviewer` | `memory:read`, `task:verify`, `task:reject` |
| `intruder` | none |

The transcript (31 checks) is the evidence, not the table:

```
ok   planner sees the tool its grant names - 11 tools
ok   planner does not see a verb it does not hold
ok   a principal without mailbox:claim cannot take it - not authorized: mailbox:claim (no-grant)
ok   worker discovers the task from the store - 1 listed
ok   worker holds task:verify and still cannot verify its own work - self-verification-refused
ok   reviewer verifies
ok   the verifier is recorded as the reviewer - reviewer
ok   no grants means one tool, the one that explains why - acm_capabilities
ok   a new session reads the whole trail - assigned -> running -> returned -> verified
scoped flow: 31 checks, 0 failed
```

Two details are deliberate. `worker` holds `task:verify`, so the refusal it gets on its own
return is `self-verification-refused` - about who it is, not about what it was allowed. And
the task key is read back from `acm_task_list` rather than passed in, so the worker has to
find its work the way an agent would.

Grants are seeded through `lib/auth.mjs`, which is setup, not evidence: every assertion
after that comes from a JSON-RPC answer over the pipe. To check that the negatives are real,
comment out the `mode === 'local'` branch in `authorize()` and rerun - five checks go red,
including the two that name a verb in the refusal.

## 6. What this page does not cover

- **A listener.** Nothing here binds a socket. Exposing this surface over HTTP is a
  different object with a different threat model, and it is not configured in this
  repository.
- **A remote peer.** Every step above is one process talking to one child process on one
  machine. Cross-host work is tracked separately and is not what these checks prove.
- **Your store.** Use a path you are willing to have written to; the probe fact is removed
  again unless you pass `--keep`.
