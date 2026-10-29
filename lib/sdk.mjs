// SDK\uFF1A\u7ED9\u522B\u7684\u7A0B\u5E8F\u7528\u7684\u95E8\u9762\u3002\u4E0D\u8BA4\u5BBF\u4E3B\uFF0C\u53EA\u8BA4\u4E00\u4E2A\u5E93\u8DEF\u5F84\u548C\u4F1A\u8BDD id\u3002
//
//   import { openMemory } from 'dsh-acm-memory/lib/sdk.mjs'
//   const acm = openMemory({ dbPath: 'C:/x/memory.db', sessionId: 'work' })
//   acm.remember({ text: 'master prefers short replies', key: 'master.style' })
//   acm.inject({ query: '\u4ED6\u559C\u6B22\u4EC0\u4E48\u6837\u7684\u56DE\u590D' })   // \u76F4\u63A5\u62FC\u8FDB system prompt
//   acm.checkpoint({ goal: '...', next: '...' })
//   acm.graphHtml()                               // \u5B58\u6210 html \u770B

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { openDb } from './db.mjs'
import { principalFromConfig, requireAction } from './auth.mjs'
import { backupDirFor, backupIfDue, listBackups, restoreBackup, verifyBackups } from './backup.mjs'
import { conflicts, feedback, feedbackStats, gc, history, loadWeights, mergeDuplicates, provenance, purge, purgeRange, quarantine, releaseQuarantine, remember, resolveConflict, search, forget, setAlias, aliasesOf, sourcesOf, stats, suspects, trustEvents, verifyPurged, weightsNow } from './memory.mjs'
import { evolve, evolutionLog, renderEvolution } from './evolve.mjs'
import { activeCheckpoint, markDelivered, receiptState, saveCheckpoint, saveOrUpdateAuto, scanCompactions, verifyRecovery } from './checkpoint.mjs'
import { decideProposal, loadPersona, pendingProposals } from './persona.mjs'
import { renderFoldText } from './fold.mjs'
import { redact } from './redact.mjs'
import { buildGraph, renderGraphHtml } from './graph.mjs'
import { buildInjectionText, mergeConfig, statusOf } from './core.mjs'
import { retentionReport } from './retention.mjs'
import { buildHandoff, verifyHandoff } from './handoff.mjs'
import { argue, claimMessage, completeMessage, decide as decideRecord, decisionView, decisions as listDecisions, inbox, openDecision, sendMessage } from './deliberation.mjs'
import { embedMissing, embedText, hybridSearch, vectorStats } from './embed.mjs'
import { acceptTask, assignTask, cancelTask, createTask, expireLeases, sweepExpiredLeases, failTask, getTask, listTasks, rejectTask, renewTask, retryTask, returnTask, taskEvents, verifyTask } from './tasks.mjs'

/**
 * Where a scoped export is allowed to land.
 *
 * `fold(path)` writes an owner-wide view of the store, so the destination is an
 * operator decision: the directory comes from configuration, never from the
 * request.
 *
 * Comparing path strings is not a filesystem boundary, and neither is `existsSync`.
 * `existsSync` answers "is there something at the end of this path *once links are
 * followed*", so a symlink pointing at a file that does not exist yet answers
 * `false` - it looks like an empty slot, and the write goes through the link. The
 * first version of this function walked up until `existsSync` said yes and then
 * took a prefix of a real path: a *dangling* link at the destination passed both
 * checks and `writeFileSync` created the file outside the export root.
 *
 * So nothing here follows a link by accident. Each path component below the base
 * is inspected with `lstatSync`, which reports the directory entry itself: a link
 * has an entry whether or not its target exists. Any link on the way - dangling or
 * not - is refused rather than resolved, and every intermediate component must
 * already be a real directory. The base itself is the one place where a link is
 * resolved, because the operator configured it; its real path is where the walk
 * starts, so `resolve`'s blindness to links and Windows' case folding and 8.3
 * aliases stop mattering.
 *
 * The destination may be absent (a new file) or an existing regular file (replaced
 * in place). It may not be a directory, a device, or a link. A missing
 * intermediate directory is a configuration mistake, not something to invent:
 * creating the path is what turned "export into this directory" into "export
 * wherever the last component points".
 *
 * Returns the path that was actually validated, so the write opens that path and
 * not a second resolution of the caller's string.
 */
function exportRefusal(reason) {
  const err = new Error(`not authorized: operator:export (${reason})`)
  err.code = 'not-authorized'
  err.decision = { ok: false, reason, action: 'operator:export', mode: 'scoped' }
  return err
}

function assertExportInside(baseDir, outPath) {
  if (!baseDir) throw exportRefusal('export-dir-unset')

  const baseResolved = resolve(String(baseDir))
  let baseReal
  try {
    baseReal = realpathSync(baseResolved)
  } catch {
    throw exportRefusal('export-dir-missing')
  }
  if (!statSync(baseReal).isDirectory()) throw exportRefusal('export-dir-not-a-directory')

  const rel = relative(baseResolved, resolve(String(outPath)))
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '')
  if (!parts.length || isAbsolute(rel) || parts[0] === '..') throw exportRefusal('export-dir-mismatch')

  let cur = baseReal
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part)
    let st
    try {
      st = lstatSync(cur)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw exportRefusal('export-dir-missing')
      throw exportRefusal('export-dir-mismatch')
    }
    if (st.isSymbolicLink()) throw exportRefusal('export-path-is-link')
    if (!st.isDirectory()) throw exportRefusal('export-dir-mismatch')
  }

  const finalPath = join(baseReal, ...parts)
  let own
  try {
    own = lstatSync(finalPath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw exportRefusal('export-target-not-a-file')
  }
  if (own) {
    if (own.isSymbolicLink()) throw exportRefusal('export-path-is-link')
    if (!own.isFile()) throw exportRefusal('export-target-not-a-file')
  }
  return finalPath
}

/**
 * Open the validated path once and write through that handle.
 *
 * `O_NOFOLLOW` makes the open itself refuse a final component that has become a
 * link since the check, which is the one TOCTOU window a path check cannot close.
 * It only covers the last component: an intermediate directory swapped for a link
 * after validation is not caught, and that is the honest limit - a writer that must
 * survive an attacker with write access to the export directory needs `openat` per
 * component, which the Node surface does not offer. The caller of `fold(path)`
 * already holds `operator:export`, so this guards against the export directory
 * being lured somewhere else, not against an operator attacking themselves.
 *
 * `O_NOFOLLOW` is 0 where the platform has no such flag (Windows); there the check
 * above is the whole guard and the `lstat` on the final component is what stands.
 */
function writeExportFile(finalPath, text) {
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0)
  let fd
  try {
    fd = openSync(finalPath, flags, 0o600)
  } catch (err) {
    if (err.code === 'ELOOP') throw exportRefusal('export-path-is-link')
    throw err
  }
  try {
    writeFileSync(fd, text, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function openMemory({ dbPath, sessionId = 'default', config = {} } = {}) {
  const cfg = mergeConfig({ ...config, ...(dbPath ? { dbPath } : {}) })
  const db = openDb(cfg.dbPath)
  const sid = sessionId
  // The owner boundary is a closure constant. It used to be read from the
  // published `config` object on every call, so a holder of an owner-bound
  // handle could assign `handle.config.owner = "someone-else"` and then read or
  // delete that partition through the same handle.
  const owner = cfg.owner ?? null
  // The actor is fixed for the life of the handle as well: a task recorded as
  // created by `sdk` must not be creatable as `someone-else` by passing a field.
  const actor = cfg.agent ?? 'sdk'
  // A frozen deep copy: callers may inspect the configuration but cannot steer
  // the handle by mutating it.
  const publicConfig = Object.freeze(JSON.parse(JSON.stringify(cfg)))
  // Same redaction the tool and distillation paths apply: secrets written
  // through the SDK must not land in the database in clear text.
  const guard = (v) => (cfg.redact?.enabled ? redact(v, cfg.redact).text : v)

  // A scoped store answers only to a principal holding a live grant for the
  // partition being opened. The tool path always consulted this; the SDK did not,
  // so a caller could name any owner and read it. Local mode keeps its documented
  // meaning (trust the machine), so single-owner use is unchanged.
  //
  // The grant's `target` is the **project**, everywhere. The open check used to
  // pass `target: owner` while every later call passed `target: cfg.project`, so
  // the same handle was judged against two different dimensions: an owner-named
  // grant opened a handle whose calls then asked about a project, and a
  // project-named grant could not open the handle at all. Both checks now ask the
  // same question, and a handle with no project (one that reads the whole
  // partition) needs a partition-wide grant - a grant narrowed to `alpha` does not
  // authorise a reader that never names `alpha`.
  const authMode = cfg.auth?.mode ?? 'local'
  const project = cfg.project ?? null
  const principal = principalFromConfig(cfg)

  // Every sensitive call revalidates: a handle outlives a revocation, and the
  // decision must belong to the call, not to the moment the handle was built.
  // `target` is the project restriction the grant vocabulary uses, not the owner;
  // the owner boundary is enforced by the query predicates.
  const authorize = (action, opts = {}) => {
    if (authMode !== 'scoped') return
    requireAction(db, principal, action, { mode: authMode, target: project, ...opts })
  }
  /** The same decision as `authorize`, asked as a question instead of a throw. */
  const permits = (action, opts = {}) => {
    if (authMode !== 'scoped') return true
    try {
      requireAction(db, principal, action, { mode: authMode, target: project, ...opts })
      return true
    } catch (err) {
      if (err?.code === 'not-authorized') return false
      throw err
    }
  }

  // Authentication comes before the first write. Opening a store used to run the
  // due-backup and the expired-lease sweep *before* the scoped check, so a handle
  // that then failed to authenticate had already copied the store or moved another
  // project's tasks into `expired`. Maintenance is a side effect on the whole
  // partition, so it now needs the verb that describes it: `operator:backup` for
  // the snapshot, `task:sweep` for the leases. A trusted local host keeps the
  // behaviour it documents - open, recover, carry on.
  try {
    if (authMode === 'scoped') {
      requireAction(db, principal, 'memory:read', { mode: authMode, target: project })
    }
    if (permits('operator:backup', { target: null })) {
      try { backupIfDue(db, cfg.dbPath, cfg.backup) } catch {}
    }
    if (permits('task:sweep')) {
      try {
        // A scoped handle sweeps only its own partition, and only the project it
        // names. The whole-store sweep belongs to a local host.
        if (authMode === 'scoped') expireLeases(db, { owner, project, at: Date.now() })
        else sweepExpiredLeases(db)
      } catch {}
    }
  } catch (err) {
    // A refusal after openDb() must not leave the handle behind: on Windows the
    // file then cannot be removed until the process exits.
    try { db.close() } catch {}
    throw err
  }

  // A task transition is authorized against the task it actually touches, the same
  // way `core.taskGate` does it for the tool path: a coarse check first, so a store
  // does not tell a principal with no grant whether a key exists, then the task's own
  // project. Authorizing by the caller's project alone would let a grant narrowed to
  // `alpha` accept, verify or cancel a task in `beta`.
  //
  // The caller's project is a boundary, not only a hint. A handle that declares
  // `alpha` must not reach a `beta` task even when it holds a wildcard grant: that
  // is one project's agent acting on another's work with a permission it was given
  // for its own. `core.taskGate` has always required the match, and this now does
  // too. A handle that names no project is the partition-wide reader and is judged
  // by its grants alone.
  const taskGate = (action, key) => {
    if (authMode !== 'scoped') return true
    requireAction(db, principal, action, {
      mode: authMode,
      target: project,
      // A caller that declares no project has no target to check yet; the precise
      // check below is the one that decides. Same reasoning as `core.taskGate`.
      anyTarget: project == null,
    })
    const found = getTask(db, { key, owner })
    // An unknown key is answered by the state machine as `not-found`, which says
    // nothing about any other project either.
    if (!found) return true
    if (project != null && String(found.project ?? '') !== String(project)) return false
    try {
      requireAction(db, principal, action, { mode: authMode, target: found.project ?? null })
    } catch (err) {
      // "not yours" and "no such task" answer the same, so the pair is not an
      // existence oracle across projects. A caller that is granted here keeps the
      // precise refusal from the state machine.
      if (err?.code === 'not-authorized' && err.decision?.reason === 'no-grant') return false
      throw err
    }
    return true
  }
  const acm = {
    config: publicConfig,
    sessionId: sid,

    remember(input) {
      authorize(input.scope === 'global' ? 'memory:write-global' : 'memory:write-session')
      const { source: rawSource, ...rest } = input
      return remember(db, {
        ...rest,
        text: guard(input.text),
        gloss: input.gloss ? guard(input.gloss) : input.gloss,
        scope: input.scope ?? sid,
        owner: owner,
        source: { sessionId: sid, kind: 'sdk', raw: guard(rawSource ?? input.text) },
      })
    },

    search(query, { limit = cfg.recallLimit } = {}) {
      authorize('memory:read')
      return search(db, { query, scope: sid, limit, owner: owner })
    },

    // \u5E26\u8BED\u4E49\u7684\u68C0\u7D22\uFF1A\u8981 await\uFF08\u6A21\u578B\u9996\u6B21\u52A0\u8F7D ~0.4s\uFF09
    async searchAsync(query, { limit = cfg.recallLimit } = {}) {
      authorize('memory:read')
      if (!cfg.embed?.enabled) return search(db, { query, scope: sid, limit, owner })
      return hybridSearch(db, query, { scope: sid, limit, owner, weight: cfg.embed.weight, minCos: cfg.embed.minCos })
    },

    // Pure functions over a string: no store is read or written, so there is no
    // partition to authorize. `embedMissing` writes vectors into it.
    embedText(text) { return embedText(text) },
    embedMissing(opts = {}) {
      authorize('memory:write-session')
      return embedMissing(db, opts) },
    vectorStats() {
      authorize('memory:read')
      return vectorStats(db, { owner: owner }) },

    forget(id, at) {
      authorize('memory:forget')
      return forget(db, id, at, owner)
    },

    /** Physically delete one memory in this partition. Irreversible. */
    purge(id) {
      authorize('memory:purge')
      return purge(db, id, { owner: owner })
    },
    /** Physically delete every memory created before a cutoff in this partition. */
    purgeRange(opts = {}) {
      authorize('memory:purge')
      return purgeRange(db, { ...opts, owner: owner })
    },
    /** Row counts that still reference an id after a purge, as evidence. */
    verifyPurged(id) {
      authorize('memory:read')
      return verifyPurged(db, id) },

    history(opts = {}) {
      authorize('memory:read')
      return history(db, { ...opts, scope: sid, owner: owner })
    },

    alias(alias, canonical) {
      authorize('memory:write-global')
      return setAlias(db, alias, canonical, owner)
    },
    aliases(term) {
      authorize('memory:read')
      return aliasesOf(db, term, owner) },
    sources(nodeId) {
      authorize('memory:read')
      return sourcesOf(db, nodeId, owner) },

    /** Fact keys that changed more than once, newest first. */
    conflicts(opts = {}) {
      authorize('memory:read')
      return conflicts(db, { ...opts, owner: owner }) },
    /** Pin one revision as the active answer and close the others. */
    resolveConflict(id) {
      authorize('memory:write-global')
      return resolveConflict(db, { id, owner: owner })
    },

    /** Node, raw evidence, votes and revision chain for one memory. */
    provenance(id) {
      authorize('memory:read')
      return provenance(db, id, { owner: owner }) },

    checkpoint(input = {}) {
      authorize('memory:write-session')
      // Declared fields only: spreading the caller object let it carry its own
      // owner or sessionId into the trusted checkpoint record.
      const { goal, done, next, files, decisions, turn } = input
      return { id: saveCheckpoint(db, { sessionId: sid, owner: owner, goal, done, next, files, decisions, turn, guard }) }
    },
    autoCheckpoint(goal, turn = null) {
      authorize('memory:write-session')
      return saveOrUpdateAuto(db, { sessionId: sid, goal, turn, owner: owner, guard })
    },
    checkpointNow() {
      authorize('memory:read')
      return activeCheckpoint(db, sid, owner) },
    markDelivered(checkpointId, note = 'sdk') {
      authorize('memory:write-session')
      return markDelivered(db, checkpointId, sid, note, owner) },
    receipts(checkpointId) {
      authorize('memory:read')
      return receiptState(db, checkpointId, owner) },
    /** Verify the recovery ledger for this session (exactly-once delivery). */
    verifyRecovery() {
      authorize('memory:read')
      return verifyRecovery(db, { sessionId: sid, owner: owner }) },

    /** \u538B\u7F29\u68C0\u6D4B\uFF1A\u628A\u5BBF\u4E3B\u7684\u4E8B\u4EF6\u65E5\u5FD7\u4E22\u8FDB\u6765\uFF0C\u8FD4\u56DE\u6210\u529F\u538B\u7F29\u4E86\u51E0\u6B21 */
    scan(events) { return scanCompactions(events) },

    /** \u8BE5\u6CE8\u5165\u7684\u90A3\u6BB5\u6587\u672C + \u91CC\u9762\u7528\u4E86\u54EA\u4E9B\u8BB0\u5FC6 */
    inject({ query = '', recovering = false } = {}) {
      // Injection is a read that leaks the most: it renders the partition's facts
      // into a prompt. It was the one memory surface with no check at all.
      authorize('memory:read')
      return buildInjectionText({ db, config: cfg, sessionId: sid, query, recovering })
    },

    persona(paths) {
      authorize('memory:read')
      return loadPersona(db, paths ?? cfg.personaFiles, { owner: owner, confineTo: cfg.personaFiles })
    },
    proposals() {
      authorize('memory:read')
      return pendingProposals(db, owner) },
    decide(id, approve) {
      // Approving a persona edit changes what the host will be told to be, so it is a
      // global write, not a session one.
      authorize('memory:write-global')
      return decideProposal(db, id, approve, { actor: cfg.owner ? `sdk:${cfg.owner}` : 'sdk:local', owner: owner })
    },

    /** \u7ED9\u4E00\u6761\u8BB0\u5FC6\u6295\u7968\uFF0C\u9519\u7684\u6512\u591A\u4E86\u4F1A\u81EA\u5DF1\u5931\u6548 */
    feedback(id, verdict, note = null) {
      authorize('memory:write-session')
      return feedback(db, id, verdict, { note, owner: owner }) },

    /** \u8DD1\u4E00\u8F6E\u8FDB\u5316\uFF1A\u5408\u5E76\u91CD\u590D + \u6309\u53CD\u9988\u8C03\u6743\u91CD */
    evolve(opts = {}) {
      // Store-wide maintenance, not a memory write: `memory:write-global` let
      // anyone who may record a fact also merge and reweight the whole store.
      authorize('operator:maintain')
      if (cfg.owner != null) throw new Error('evolve requires trusted single-user administrative mode')
      return evolve(db, opts)
    },
    evolutions(limit = 10) {
      authorize('memory:read')
      return evolutionLog(db, limit) },
    weights() {
      authorize('memory:read')
      return weightsNow() },
    feedbackStats(opts = {}) {
      authorize('memory:read')
      return feedbackStats(db, { ...opts, owner: owner }) },
    mergeDuplicates(opts = {}) {
      authorize('memory:write-global')
      if (cfg.owner != null) throw new Error('mergeDuplicates requires trusted single-user administrative mode')
      return mergeDuplicates(db, opts)
    },
    loadWeights() {
      authorize('memory:read')
      return loadWeights(db) },
    // \u7ACB\u523B\u5907\u4EFD\uFF08everyHours \u5F52\u96F6\uFF09\uFF0C\u8FD4\u56DE { created } / { skipped }
    // A backup copies the whole store - every owner in it - to a directory, so a
    // generic write grant is not permission for it. It is an operator action and
    // needs a partition-wide `operator:backup`; a grant narrowed to one project
    // does not authorise copying the others.
    backup(opts = {}) {
      authorize('operator:backup', { target: null })
      if (authMode === 'scoped') {
        if (opts && 'dir' in opts) {
          throw new Error('backup destination must come from configuration in scoped mode')
        }
        return backupIfDue(db, cfg.dbPath, { ...cfg.backup, everyHours: 0 })
      }
      return backupIfDue(db, cfg.dbPath, { ...cfg.backup, ...opts, everyHours: 0 })
    },
    backups() {
      authorize('operator:backup', { target: null })
      return listBackups(backupDirFor(cfg.dbPath, cfg.backup?.dir)) },
    /** Heuristic scan for instruction-like memories in this partition. */
    suspects(opts = {}) {
      authorize('memory:read')
      return suspects(db, { ...opts, owner: owner }) },
    /** Hide a memory from retrieval without deleting it. */
    quarantine(id, opts = {}) {
      authorize('memory:write-global')
      return quarantine(db, id, { ...opts, owner: owner }) },
    /** Restore a quarantined memory. */
    release(id, opts = {}) {
      authorize('memory:write-global')
      return releaseQuarantine(db, id, { ...opts, owner: owner }) },
    /** Audit trail for quarantine and release decisions. */
    trustEvents(opts = {}) {
      authorize('memory:read')
      return trustEvents(db, { ...opts, owner: owner }) },

    /** Shared decision records: propose, argue with evidence, decide. */
    openDecision(input = {}) {
      authorize('memory:write-session')
      return openDecision(db, { ...input, owner: owner }) },
    argue(decisionId, input = {}) {
      authorize('memory:write-session')
      return argue(db, decisionId, { ...input, owner: owner }) },
    decideOutcome(decisionId, input = {}) {
      authorize('memory:write-global')
      return decideRecord(db, decisionId, { ...input, owner: owner }) },
    decisions(opts = {}) {
      authorize('memory:read')
      return listDecisions(db, { ...opts, owner: owner }) },
    /** Post a message to another agent's mailbox. */
    send(input = {}) {
      authorize('memory:write-session')
      return sendMessage(db, { ...input, owner: owner }) },
    /** Work addressed to one agent; defaults to everything not yet done. */
    inbox(opts = {}) {
      authorize('memory:read')
      return inbox(db, { ...opts, owner: owner }) },
    claim(messageId, agent) {
      authorize('mailbox:claim')
      return claimMessage(db, { id: messageId, agent, owner: owner })
    },
    complete(messageId, agent) {
      authorize('mailbox:complete')
      return completeMessage(db, { id: messageId, agent, owner: owner })
    },
    decision(decisionId) {
      authorize('memory:read')
      return decisionView(db, decisionId, { owner: owner }) },

    /** Evidence-backed handoff package for this session. */
    handoff(opts = {}) {
      authorize('memory:read')
      return buildHandoff(db, { ...opts, sessionId: sid, owner }) },
    /** Re-check a handoff package against the live database. */
    verifyHandoff(pkg) {
      authorize('memory:read')
      return verifyHandoff(db, pkg, { owner: owner }) },

    /** What the current retention policy would delete, and what stays. */
    retention() {
      authorize('memory:read')
      return retentionReport(db, { owner: owner, backupDir: backupDirFor(cfg.dbPath, cfg.backup?.dir), policy: { backupKeep: cfg.backup?.keep } }) },

    /** Restore a snapshot to a path and prove the copy is usable. */
    // Restoring writes a whole store over a path the caller names. It can replace
    // every partition, so it is an operator action, not a write grant.
    restore(from, to, opts = {}) {
      authorize('operator:restore', { target: null })
      return restoreBackup(from, to, opts) },
    /** Integrity and contents of every backup, newest first. */
    verifyBackups() {
      authorize('memory:read')
      return verifyBackups(backupDirFor(cfg.dbPath, cfg.backup?.dir)) },
    gc(opts = {}) {
      // Deleting past retention is an operator act. It stays behind the
      // single-user administrative condition below; the verb is the other half.
      authorize('operator:maintain')
      if (cfg.owner != null) throw new Error('gc requires trusted single-user administrative mode')
      return gc(db, {
        days: cfg.gc.days,
        checkpointDays: cfg.gc.checkpointDays,
        proposalDays: cfg.gc.proposalDays,
        ...opts,
      })
    },

    // Caller options are spread first and scope/owner are pinned afterwards, so
    // a caller cannot widen the partition by passing its own owner or scope.
    graph(opts = {}) {
      authorize('memory:read')
      return buildGraph(db, { ...opts, scope: sid, owner: owner }) },
    graphHtml(opts = {}) {
      authorize('memory:read')
      return renderGraphHtml(acm.graph(opts), { sessionId: sid })
    },

    // Writing the export to a path is a filesystem action: `memory:read` lets the
    // caller see this partition, not create a readable dump wherever it likes.
    fold(outPath) {
      // `foldToMarkdown` reads every active node in the partition: `acm_nodes`
      // has no project column, so the text it returns is owner-wide whatever
      // project this handle names. Writing that to a path is therefore an
      // owner-wide export, and a grant narrowed to one project cannot describe
      // its reach - an `alpha` handle holding `operator:export target alpha`
      // used to write `beta` facts to disk.
      //
      // So: the grant must be untargeted (the grant vocabulary's own "covers any
      // target"), and in scoped mode the destination is the operator's, not the
      // caller's. No configured `exportDir` means no export to disk at all; the
      // in-memory form (`fold()` with no path) stays available under
      // `memory:read` and is documented as owner-wide.
      authorize('memory:read')
      const text = renderFoldText(db, { sessionId: sid, owner })
      if (!outPath) return text
      authorize('operator:export', { target: null })
      if (authMode === 'scoped') {
        writeExportFile(assertExportInside(cfg.exportDir, outPath), text)
        return text
      }
      // Local mode trusts the machine and the operator's own shell: the path is
      // theirs, and creating a directory on demand is what `acm fold --out`
      // has always done. Scoped mode is the one that needs the boundary.
      mkdirSync(dirname(String(outPath)), { recursive: true })
      writeFileSync(String(outPath), text, 'utf8')
      return text },

    stats() {
      authorize('memory:read')
      return stats(db, sid, owner) },
    status() {
      authorize('memory:read')
      return statusOf({ db, config: cfg, sessionId: sid }) },

    /** \u6362\u4F1A\u8BDD\uFF08\u540C\u4E00\u4E2A\u5E93\uFF09 */
    forSession(nextSessionId) {
      return openMemory({ dbPath: cfg.dbPath, sessionId: nextSessionId, config: cfg })
    },

    // Durable tasks.
    //
    // Every argument that decides *where* or *who* is bound **after** the caller's
    // options are read. An owner-bound handle must not be steerable by passing
    // `{ owner: 'someone-else' }`, and a caller must not be able to name an actor
    // other than the one this handle was opened with - that is the same closure
    // invariant the rest of this file already keeps for the owner. Operations take
    // only the fields they actually use, so anything else is ignored rather than
    // forwarded, and `allowSelfVerify` is not reachable from here at all.
    taskCreate(input = {}) {
      const { title, detail, assignee, dependsOn, priority, maxAttempts } = input
      // Creating work is a verb, not a side effect of being able to read: a
      // read-only scoped handle must not be able to enqueue tasks.
      authorize('task:create')
      return createTask(db, {
        title, detail, assignee, dependsOn, priority, maxAttempts,
        owner, project, createdBy: actor,
      })
    },
    // A project-scoped reader sees its own project's work only. `listTasks` filters
    // by the partition, so naming the project here is what keeps `beta` out of an
    // `alpha` handle's task list - the same boundary `taskGate` enforces on writes.
    tasks(filter = {}) {
      const { state, assignee, limit } = filter
      authorize('memory:read')
      return listTasks(db, { state, assignee, limit, owner, project })
    },
    task(key) {
      authorize('memory:read')
      const task = getTask(db, { key, owner })
      if (!task) return null
      // "not yours" answers like "no such task", so a handle cannot use the
      // difference to enumerate another project's keys.
      if (project != null && String(task.project ?? '') !== String(project)) return null
      return { task, events: taskEvents(db, { key, owner }) }
    },
    taskAssign(key, assignee) {
      if (!taskGate('task:assign', key)) return { ok: false, reason: 'not-found' }
      return assignTask(db, { key, owner, assignee, actor })
    },
    taskAccept(key, opts = {}) {
      if (!taskGate('task:accept', key)) return { ok: false, reason: 'not-found' }
      return acceptTask(db, { key, owner, actor, leaseMs: opts.leaseMs })
    },
    taskRenew(key, opts = {}) {
      if (!taskGate('task:renew', key)) return { ok: false, reason: 'not-found' }
      return renewTask(db, { key, owner, actor, leaseMs: opts.leaseMs })
    },
    taskReturn(key, opts = {}) {
      if (!taskGate('task:return', key)) return { ok: false, reason: 'not-found' }
      return returnTask(db, { key, owner, actor, result: opts.result, evidence: opts.evidence })
    },
    taskVerify(key, opts = {}) {
      if (!taskGate('task:verify', key)) return { ok: false, reason: 'not-found' }
      return verifyTask(db, { key, owner, actor, note: opts.note })
    },
    taskReject(key, reason) {
      if (!taskGate('task:reject', key)) return { ok: false, reason: 'not-found' }
      return rejectTask(db, { key, owner, actor, reason })
    },
    taskFail(key, reason) {
      if (!taskGate('task:fail', key)) return { ok: false, reason: 'not-found' }
      return failTask(db, { key, owner, actor, reason })
    },
    taskCancel(key, reason = null) {
      if (!taskGate('task:cancel', key)) return { ok: false, reason: 'not-found' }
      return cancelTask(db, { key, owner, actor, reason })
    },
    taskRetry(key, assignee = null) {
      if (!taskGate('task:retry', key)) return { ok: false, reason: 'not-found' }
      return retryTask(db, { key, owner, actor, assignee })
    },
    taskExpireLeases(at) {
      // Sweeping is maintenance over a *range* of tasks, so it needs its own verb
      // rather than borrowing a transition. The range is the caller's own: a handle
      // that names a project sweeps that project, and only a partition-wide grant
      // lets it touch the owner's other projects. Sweeping every project from a
      // grant narrowed to one was the design caveat this closes.
      authorize('task:sweep')
      return expireLeases(db, { owner, project, at })
    },

    close() { try { db.close() } catch {} },
  }

  return acm
}
