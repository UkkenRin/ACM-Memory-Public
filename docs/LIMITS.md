# Known limits

This file is the honest list of what ACM Memory does **not** do. It is written for
someone about to put their own notes into it, and it is deliberately blunt: every
item below is a property of the current code, not a bug we are about to fix.

## Retrieval

- Recall is **similarity-based**. A query that shares vocabulary with an unrelated
  fact can surface that fact, and the injected text has a fixed budget, so an
  unhelpful result can crowd out a useful one. There is no absolute relevance
  threshold you can tune; the ranking is relative.
- Extraction from conversation is **best effort**. The store remembers what it is
  told to remember, and what a model chose to write. It does not guarantee that the
  right sentence was extracted from a long conversation.
- Nothing here is a search engine over your files. It searches what was written to
  the store.

## Deletion

- `acm forget` is **soft invalidation**: the row stops being returned, but the text
  can remain in the SQLite file's free pages, in `-wal` segments, in backups already
  written, and in anything you exported (handoff JSON, folded markdown).
- `acm purge` is the operator-only hard delete of rows. It still does not rewrite
  every page, and it does not reach backups or exports.
- If you need "this text is gone from this machine", delete the database file and
  every backup beside it. That is the only operation with that meaning today.

## Identity and isolation

- There is **no authentication**. `ACM_AGENT`, `ACM_OWNER` and `acm task --actor` are
  labels, not credentials: any process that can read the database file can read every
  fact in it. `auth.mode: 'scoped'` requires a live grant before a read or a task
  transition, and the tool and resource surfaces ask for one too — but the principal
  that asks is still declared by the caller. A grant is a permission record, not proof
  of who is calling.
- **Every tool declares the verb it needs, and an upgrade does not grant it.** Until the missing verbs were required, seven tools had no verb at all, so a `scoped` store answered them to
  a caller holding no grant. Declaring the verb changes what an existing deployment may
  do: `acm_history` now needs `memory:read`, `acm_checkpoint` and `acm_feedback` need
  `memory:write-session`, `acm_alias` needs `memory:write-global`, `acm_forget` needs
  `memory:forget`, and `acm_gc` / `acm_evolve` need the new `operator:maintain`. None of
  those is backfilled. A scoped install that relied on the missing gates will start
  refusing, and the refusal names the verb, so the fix is a grant rather than a guess.
  `operator:maintain` also stops store-wide maintenance from borrowing
  `memory:write-global` (on the SDK side too): a principal allowed to record a fact is no
  longer allowed to purge the store or reweight retrieval because of it. `adminTools` and
  the single-user condition on those two remain, and they are independent of the verb -
  neither implies the other.
- **Project isolation covers tasks, not memory.** `acm_tasks` carries a `project`
  column, and every task read and transition requires the caller's project to match the
  task's. `acm_nodes` has no such column, so retrieval, injection and export read the
  whole owner partition whatever project a handle declares. `fold()` is therefore an
  owner-wide view; writing it to disk is an operator action that needs an untargeted
  `operator:export` grant, and in scoped mode the destination must be inside the
  configured `exportDir`. That directory must already exist; no configured directory
  means no export to disk. Below it, every path component is inspected with `lstat`,
  which reports the directory entry rather than following it — so a link is seen
  whether or not its target exists. Any link on the way, dangling or not, is refused
  rather than resolved, intermediate directories must already exist and be real
  directories, and the destination must be absent or an existing regular file. The
  file is then opened once, with `O_NOFOLLOW` where the platform has it, and written
  through that handle, so the final component cannot be swapped for a link between the
  check and the write. Two limits remain, and they are real: `O_NOFOLLOW` covers only
  the last component, so an intermediate directory swapped after validation is not
  caught (Node exposes no `openat`), and on Windows there is no such flag, so the
  `lstat` check is the whole guard there. Treat "memory is private per project" as not
  implemented, not as a promise.
- **A project-targeted `memory:read` is an authorization shape, not a filter.** It says
  which project's *tasks* a principal may touch, and it bounds the grant record; it does
  not narrow what retrieval, injection or `fold()` return, which stay owner-wide. Do not
  read `memory:read` with `target: alpha` as "alpha cannot see beta's facts" — it can,
  through `acm_search`, `acm://injection` and `fold()` without a path. The disk export is
  where a project-targeted grant is refused, and only because the write is owner-wide, not
  because the read is filtered.
- **A mailbox is partition data, so it has both a read and a write verb.** `acm_inbox`
  asks for `memory:read` before it looks, and `acm_send` asks for `mailbox:send` before
  it inserts a row — delivering into an inbox is a write, and a read grant must not imply
  it. The recipient is also the only agent that can claim or complete a message, which
  the store enforces on the row rather than in the caller. What this does not do: it does
  not authenticate the sender, so a principal with `mailbox:send` can still address any
  agent in its partition, and the `from` field is a claim like every other label here.
- **`mailbox:send` is a new verb, and upgrading does not grant it.** A `scoped` store that
  was configured before this verb existed has no grant row for it, so a client that could
  send will be refused until an operator adds `mailbox:send` to that principal. The upgrade
  does not backfill a broad grant on the operator's behalf: silently widening a permission
  during a version upgrade is exactly the kind of change a grant table exists to prevent.
  The refusal names the verb, so the fix is visible in the error rather than in a changelog.
- One store is one trust boundary: one person, one machine. Do not share a store
  between people, do not put it on a network share, and do not enable the optional
  HTTP surface on a network you do not control (it is off by default).
- **Expired task leases are recovered by whoever holds `task:sweep`.** In scoped mode a
  handle without that grant does not sweep when it opens, so a scheduler or an operator
  holding the grant must call `taskExpireLeases()` after a restart. Nothing renews or
  recovers a lease by itself, and the verb is never granted to a chat principal
  implicitly.
- A task's `confirmed` state is a record of what a person typed, not a
  cryptographic proof that a person approved anything.

## Durability

- The database is a single SQLite file. Corrupt it (or lose the disk) and the
  memories are gone unless you have a backup. Take one; `acm backup` verifies what
  it writes.
- Two processes writing the same store at once is not a supported pattern. SQLite
  will serialise most of it, and the second writer can fail with a `busy` error
  rather than retrying indefinitely.
- A schema upgrade writes a verified snapshot beside the database first, and
  **refuses to migrate** if it cannot. If you see that refusal, your store is not
  half-migrated - but you need disk space or a writable directory to proceed.

## Host integration

- The **DSH host plugin is experimental**: it is covered by scripted host tests, not
  by a long live session. The supported surfaces are the CLI (`acm`) and the MCP
  server (`acm-mcp`).
- The optional HTTP routes are an integration point, not a service. They are off
  unless configured, and they are not hardened for untrusted clients.
- **Startup maintenance is the operator's decision, not a client's.** The MCP stdio host
  opens the database when it starts, and it takes a snapshot only when the process was
  launched with `ACM_MAINTENANCE=1`. Without the flag a client can connect, list tools and
  be refused a write without causing a backup, a prune or a task event. The CLI keeps its
  startup snapshot because running `acm` is already an operator act.
- There is no remote MCP transport yet. A hosted assistant cannot reach this store over
  HTTP: there is no listener, no socket and no TLS anywhere in this build, and the design
  notes stay in the private repository. The ordering a transport would need -
  credential, then principal, then grant, then one operation - is exercised end to end in
  the development tree against a real store, and the protocol half (`initialize`,
  `tools/list`, `tools/call`, one session per verified principal) is answered by a handler
  that takes a request object and returns a status, headers and a body. That handler is
  not published and does not listen. It exists so the protocol can be tested without a
  port, and so the process that would expose it has exactly one job left.
- **A credential can be a signature instead of a shared secret, and that is still not a
  transport.** With `ACM_KEYRING` the store verifies an Ed25519 signature over each
  request against enrolled public keys, so the serving side holds no secret and a captured
  credential does not work against a different request. The process doing the verifying
  is the same process holding the database, so on one machine this changes what has to be
  stolen, not what has to be reached. There is no listener, no TLS and no pairing, and the
  nonce inside a signed request is remembered only by the process that saw it: a captured
  request is refused for as long as that process lives, and a restart forgets every nonce -
  so a proof captured before a crash stays replayable for the rest of its minute. A bearer
  token carries no nonce at all and is replayable until it expires. This tool therefore
  claims **no network replay protection**: it is an offline, single-process, owner-only
  store, and a listener reachable by anyone else would have to land a mechanism that
  survives a restart - durable consumption, or an epoch that makes proofs issued before the
  restart unverifiable - before it could be described in any other way. Keeping nonces in
  memory is a stated limit with a stated cost, not a table someone forgot to add: a durable
  nonce is a write that must commit before every reply, and one that does not commit before
  the reply is a guarantee that quietly ends at the crash.
- **The handler bounds a caller, and the numbers are written down.** Four requests in
  flight per principal, a bucket of ten with one refill per second, and 256 principals of
  state; the excess is `429` with `retry-after`, and an unauthenticated request is neither
  counted nor allowed to create state. Eight live sessions per principal and 512 per
  process, refused with `429` and a `retry-after` that names a real session's expiry - the
  caller's own oldest when its own count refused it, the table's oldest when the table is
  full; a refusal opens nothing and no live session is evicted. An already-spent proof is refused before any
  allowance is charged, and a caller's own allowance is checked before the shared record of
  spent nonces is written, so neither a replay nor a request that is already being refused
  for rate can cost another client anything. The window a nonce must outlive is fixed by the
  signature, not by configuration. Those numbers are chosen for one owner and a handful
  of clients. They are not a capacity plan, they do not bound an anonymous flood - that is
  a connection-level job - and nothing here has been measured against a real workload.

## Collaboration features

- Mailbox (send/inbox/claim/complete) and tasks (create/assign/accept/return/verify)
  are present in the build and **out of scope** for a single-user memory install.
  They exist to support an agent-to-agent workflow that is not finished.
- Nothing schedules work. A task is a record, not a queue.

## What has never been tested

- Windows 11 with Node 22 is where this build was exercised; Linux and macOS are
  covered by the project's test suite but not by a release run on every commit.
- No real model has been used to grade retrieval quality. There is no published
  accuracy number, and you should not assume one.
