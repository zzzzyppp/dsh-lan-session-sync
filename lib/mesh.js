// Flat-mesh engine for file-level sync.
//
// Every device runs the same pull rules: ask each peer for a manifest of the
// configured sets, compare against the local index and the last agreed base,
// then pull/merge/keep/conflict. Sessions additionally travel by push when the
// peer cannot open a connection back to this device. There is no coordinator.
import fs from 'node:fs/promises'
import { absFor, setAllowsDelete, setAllowsRel } from './sets.js'
import {
  applyRemoteFile,
  applyTombstone,
  addTombstone,
  listSetFiles,
  scanSet,
  sessionMetaFromEntry,
} from './filesync.js'
import { isSessionRel, sessionIdFromRel, isLiveSession, findSessionRel, attachSession, isSemanticPrefix, localIsPrefix } from './session-files.js'
import { decide } from './merge.js'
import { originKey } from './state.js'

const MAX_PUSH_ITEMS = 3
const MAX_PUSH_BYTES = 96 * 1024 * 1024

function peerJournal(state, peerId) {
  if (!state.journals || typeof state.journals !== 'object') state.journals = {}
  const entry = state.journals[peerId]
  if (!entry || typeof entry !== 'object') state.journals[peerId] = { sets: {} }
  if (!state.journals[peerId].sets) state.journals[peerId].sets = {}
  return state.journals[peerId]
}

function journalFor(state, peerId, setId) {
  const journal = peerJournal(state, peerId)
  if (!journal.sets[setId] || typeof journal.sets[setId] !== 'object') journal.sets[setId] = {}
  return journal.sets[setId]
}

function recordBase(state, peerId, setId, rel, value) {
  journalFor(state, peerId, setId)[rel] = value
}

function localIndexFor(state, setId) {
  if (!state.indexes || typeof state.indexes !== 'object') state.indexes = {}
  if (!state.indexes[setId] || typeof state.indexes[setId] !== 'object') state.indexes[setId] = {}
  return state.indexes[setId]
}

/** Resolve which local file should receive a remote session log. */
function resolveSessionTarget({ state, localEntries, remoteRel, remoteMeta }) {
  const remoteId = remoteMeta?.id || sessionIdFromRel(remoteRel)
  if (!remoteId) return { rel: remoteRel, id: null, alias: false }
  const byId = new Map()
  for (const [rel, entry] of Object.entries(localEntries)) {
    const id = entry?.meta?.id || sessionIdFromRel(rel)
    if (id) byId.set(id, rel)
  }
  if (byId.has(remoteId)) return { rel: byId.get(remoteId), id: remoteId, alias: false }
  const aliasId = state.aliases && typeof state.aliases === 'object' ? state.aliases[remoteId] : null
  if (aliasId && byId.has(aliasId)) return { rel: byId.get(aliasId), id: aliasId, alias: true, aliasMismatch: true }
  // Content-level identity for copies created by older builds: same creation
  // time and cwd in an attached local session.
  if (remoteMeta?.createdAt && remoteMeta?.cwd) {
    for (const [rel, entry] of Object.entries(localEntries)) {
      const meta = entry?.meta
      if (!meta) continue
      if (meta.createdAt === remoteMeta.createdAt && meta.cwd === remoteMeta.cwd) {
        if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}
        state.aliases[remoteId] = meta.id
        return { rel, id: meta.id, alias: true, aliasMismatch: true }
      }
    }
  }
  return { rel: remoteRel, id: remoteId, alias: false }
}

function remoteById(remoteEntries) {
  const map = new Map()
  for (const [rel, entry] of Object.entries(remoteEntries || {})) {
    const id = entry?.meta?.id || sessionIdFromRel(rel)
    if (id) map.set(id, { rel, entry })
  }
  return map
}

export function createMesh(options) {
  const {
    state,
    sets,
    listPeers,
    fetchManifest,
    fetchSetFile,
    pushSetFile,
    selfDeviceId,
    ctx = null,
    home,
    onResult = null,
    onSave = null,
    now = Date.now,
    logger = console,
    getSets = null,
  } = options
  const currentSets = () => (typeof getSets === 'function' ? getSets() : sets)
  let running = false
  let last = null
  let pending = Promise.resolve()

  async function save() {
    if (!onSave) return
    pending = pending.then(() => onSave()).catch(() => {})
    await pending
  }

  async function localEntries(set, force = false) {
    const index = localIndexFor(state, set.id)
    if (!force && index.__scannedAt && now() - index.__scannedAt < 10_000) return index
    const previous = Object.fromEntries(Object.entries(index).filter(([rel]) => rel !== '__scannedAt'))
    const entries = await scanSet(set, { cache: previous })
    for (const key of Object.keys(index)) delete index[key]
    Object.assign(index, entries)
    index.__scannedAt = now()
    // Remember deletions of ordinary files as tombstones for peers.
    if (setAllowsDelete(set)) {
      for (const [rel, old] of Object.entries(previous)) {
        if (!entries[rel] && old?.h) addTombstone(state, { set: set.id, rel, hash: old.h, at: now() })
      }
    }
    return index
  }

  async function attachNewSession(set, rel, ctxRef) {
    if (!ctxRef) return { attached: false }
    const abs = absFor(set, rel)
    if (!abs) return { attached: false }
    const header = await import('./session-files.js').then((mod) => mod.readLocalSessionHeader(abs)).catch(() => null)
    if (!header) return { attached: false }
    if (!header.cwd) return { attached: false, reason: 'no-cwd' }
    const result = await attachSession(ctxRef, header.id, header.cwd)
    return { ...result, id: header.id, header }
  }

  async function archiveLocalSession(set, rel, id) {
    const abs = absFor(set, rel)
    if (!abs) return null
    const replacedRoot = `${options.archiveRoot || home}/replaced-sessions`
    const { ensureDir } = await import('./fsutil.js')
    await ensureDir(replacedRoot)
    const { rename } = await import('node:fs/promises')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${replacedRoot}/${id || sessionIdFromRel(rel) || 'session'}-${stamp}`
    await rename(abs.slice(0, abs.lastIndexOf('/')), target)
    return target
  }

  async function adoptRemoteSession({ peer, set, remoteRel, remoteEntry, localRel, localId, data, reason }) {
    const remoteAbs = absFor(set, remoteRel)
    if (!remoteAbs) return null
    const { ensureDir, writeAtomic } = await import('./fsutil.js')
    let archived = null
    if (localRel) {
      await archiveLocalSession(set, localRel, localId || sessionIdFromRel(localRel)).catch((error) => {
        try { logger?.warn?.(`could not archive ${localRel}: ${error?.message || error}`) } catch {}
      })
    }
    await ensureDir(remoteAbs.slice(0, remoteAbs.lastIndexOf('/')))
    await writeAtomic(remoteAbs, data, { mtimeMs: remoteEntry?.m })
    const remoteId = sessionIdFromRel(remoteRel)
    const cwd = remoteEntry?.meta?.cwd
    if (cwd) await attachSession(ctx, remoteId, cwd).catch(() => null)
    if (localId && localId !== remoteId) {
      try {
        const list = await ctx?.workspaceRegistry?.list?.() || []
        for (const workspace of list) {
          if (!workspace?.sessionIds?.includes(localId)) continue
          await workspace.detachSession?.(localId)
        }
      } catch {}
    }
    if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}
    state.aliases[remoteId] = remoteId
    recordBase(state, peer.deviceId, set.id, remoteRel, {
      h: remoteEntry?.h || null, size: data.length, m: remoteEntry?.m ?? now(), divergedH: null, parked: false,
    })
    try { logger?.info?.(`adopted peer session ${remoteId} (${reason})`) } catch {}
    return { imported: 1, adopted: reason, rel: remoteRel }
  }

  async function adoptAlias({ peer, set, remoteRel, remoteEntry, resolved }) {
    if (!ctx?.workspaceRegistry) return null
    const localAbs = absFor(set, resolved.rel)
    if (!localAbs) return null
    const { readFile } = await import('node:fs/promises')
    let localBytes
    try { localBytes = await readFile(localAbs) } catch { return null }
    const data = await fetchSetFile(peer, { set: set.id, rel: remoteRel }).catch(() => null)
    if (!data || !data.length) return null
    const prefix = isSemanticPrefix(localBytes, data)
    if (!prefix) {
      const { statSafe } = await import('./fsutil.js')
      const localStat = await statSafe(localAbs)
      const remoteMtime = Number(remoteEntry?.m || 0)
      if (!localStat || !(remoteMtime > localStat.mtimeMs + 1000)) return null
      return adoptRemoteSession({
        peer, set, remoteRel, remoteEntry, localRel: resolved.rel, localId: resolved.id, data, reason: 'newer',
      })
    }
    return adoptRemoteSession({
      peer, set, remoteRel, remoteEntry, localRel: resolved.rel, localId: resolved.id, data, reason: 'alias',
    })
  }

  async function pullOne({ peer, set, remoteRel, remoteEntry }) {
    const local = localIndexFor(state, set.id)
    let targetRel = remoteRel
    let targetEntry = local[remoteRel] || null
    let resolved = { rel: remoteRel, id: sessionMetaFromEntry(remoteEntry, remoteRel).id, alias: false }
    if (set.mode === 'append') {
      resolved = resolveSessionTarget({
        state,
        localEntries: Object.fromEntries(Object.entries(local).filter(([rel]) => rel !== '__scannedAt')),
        remoteRel,
        remoteMeta: remoteEntry?.meta,
      })
      targetRel = resolved.rel
      targetEntry = local[targetRel] || null
      if (resolved.aliasMismatch) {
        // A snapshot copy made by an older build has a different local id; its
        // bytes must never be appended (delivery markers name the source id).
        // If the local copy is a prefix of the peer log, adopt the peer id once
        // so both machines converge on one session file.
        if (isLiveSession(ctx, resolved.id)) return { skipped: 'live', rel: targetRel }
        const adopted = await adoptAlias({ peer, set, remoteRel, remoteEntry, resolved })
        if (adopted) return adopted
        return { skipped: 'alias-mismatch', rel: targetRel }
      }
      if (isLiveSession(ctx, resolved.id || sessionIdFromRel(remoteRel))) {
        return { skipped: 'live', rel: targetRel }
      }
    }
    const base = journalFor(state, peer.deviceId, set.id)[targetRel] || null
    const decision = decide({
      local: targetEntry,
      remote: remoteEntry,
      base,
      mode: set.mode,
      localDevice: selfDeviceId,
      remoteDevice: peer.deviceId,
    })
    if (decision.action !== 'pull') {
      return { skipped: decision.reason, rel: targetRel, decision: decision.action }
    }
    const data = await fetchSetFile(peer, { set: set.id, rel: remoteRel })
    if (!data || !data.length) return { skipped: 'empty', rel: targetRel }
    if (set.mode === 'append' && targetEntry && targetRel === remoteRel) {
      const abs = absFor(set, targetRel)
      const prefix = abs ? await localIsPrefix(abs, data).catch(() => true) : true
      if (!prefix) {
        const { statSafe } = await import('./fsutil.js')
        const localStat = abs ? await statSafe(abs) : null
        const remoteMtime = Number(remoteEntry?.m || 0)
        if (localStat && remoteMtime > localStat.mtimeMs + 1000) {
          return adoptRemoteSession({
            peer, set, remoteRel, remoteEntry, localRel: targetRel, localId: sessionIdFromRel(targetRel), data, reason: 'newer',
          })
        }
        return { skipped: 'local-newer', rel: targetRel }
      }
    }
    const applied = await applyRemoteFile({
      set,
      rel: targetRel,
      data,
      entry: remoteEntry,
      peer: peer.deviceId,
      base,
      localEntry: targetEntry,
      resolveBundle: options.resolveBundle,
      linkTargetExists: options.linkTargetExists,
      selfDeviceId,
      logger,
    })
    if (set.mode === 'append' && resolved.id && resolved.id !== sessionIdFromRel(targetRel)) {
      if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}
      state.aliases[resolved.id] = sessionIdFromRel(targetRel)
    }
    if (applied.applied === 'written' && set.mode === 'append') {
      await attachNewSession(set, targetRel, ctx)
    }
    if (applied.applied === 'conflict') {
      // Park the peer copy exactly once: remember both sides so the next cycle
      // sees a permanently parked divergence instead of re-writing conflicts.
      const abs = absFor(set, targetRel)
      const { statSafe, hashFileStream } = await import('./fsutil.js')
      const stat = await statSafe(abs)
      const hash = stat ? await hashFileStream(abs).catch(() => null) : null
      if (stat && hash) {
        recordBase(state, peer.deviceId, set.id, targetRel, {
          h: hash,
          size: stat.size,
          m: stat.mtimeMs,
          divergedH: remoteEntry?.h || null,
          parked: true,
        })
      }
    }
    // Refresh the index entry from disk after any write.
    if (applied.applied !== 'unchanged' && applied.applied !== 'conflict') {
      const abs = absFor(set, targetRel)
      const { statSafe, hashFileStream } = await import('./fsutil.js')
      const stat = await statSafe(abs)
      if (stat) {
        const hash = await hashFileStream(abs).catch(() => null)
        const entry = { s: stat.size, m: Math.round(stat.mtimeMs), h: hash }
        if (set.mode === 'append') {
          entry.meta = await import('./session-files.js').then((mod) => mod.readLocalSessionHeader(abs)).catch(() => null)
        }
        localIndexFor(state, set.id)[targetRel] = entry
        recordBase(state, peer.deviceId, set.id, targetRel, {
          h: hash,
          size: stat.size,
          m: stat.mtimeMs,
          modelBases: applied.modelBases,
        })
      }
    }
    const conflicts = applied.conflicts || (applied.conflictFile ? [applied.conflictFile] : [])
    return { applied: applied.applied, rel: targetRel, bytes: applied.bytes, conflicts }
  }

  async function pullPeer(peer, report, seenDevices) {
    let manifest
    try {
      manifest = await fetchManifest(peer, { sets: currentSets().map((set) => set.id) })
    } catch (error) {
      report.errors.push({ stage: 'manifest', deviceId: peer.deviceId, code: error?.code || 'manifest-failed', message: String(error?.message || error) })
      return
    }
    const remoteDeviceId = manifest?.peer?.deviceId || peer.deviceId
    if (remoteDeviceId === selfDeviceId) {
      report.skipped.push({ reason: 'self', deviceId: remoteDeviceId, sessionId: null })
      return
    }
    if (seenDevices && seenDevices.has(remoteDeviceId)) {
      report.skipped.push({ reason: 'duplicate-peer', deviceId: remoteDeviceId, sessionId: null })
      return false
    }
    seenDevices?.add(remoteDeviceId)
    peer.deviceId = remoteDeviceId
    for (const set of currentSets()) {
      const remote = manifest?.sets?.[set.id]
      if (!remote) continue
      const local = await localEntries(set)
      const remoteEntries = remote.entries && typeof remote.entries === 'object' ? remote.entries : {}
      for (const [rel, entry] of Object.entries(remoteEntries)) {
        if (!setAllowsRel(set, rel)) continue
        try {
          const result = await pullOne({ peer, set, remoteRel: rel, remoteEntry: entry })
          if (result?.applied) {
            if (set.mode === 'append' && result.applied === 'written') report.imported += 1
            else if (result.applied === 'appended') report.imported += 1
          }
          if (result?.conflicts?.length) report.conflicts += result.conflicts.length
          if (result?.skipped) report.skipped.push({ reason: result.skipped, deviceId: peer.deviceId, sessionId: result.rel || null, set: set.id })
        } catch (error) {
          report.errors.push({ stage: 'pull', set: set.id, deviceId: peer.deviceId, rel, code: error?.code || 'pull-failed', message: String(error?.message || error) })
        }
      }
      if (setAllowsDelete(set) && remote.deletes && typeof remote.deletes === 'object') {
        for (const [rel, tomb] of Object.entries(remote.deletes)) {
          if (!setAllowsRel(set, rel)) continue
          const result = await applyTombstone({
            set,
            rel,
            tomb,
            localEntry: local[rel],
            state,
            archiveRoot: options.archiveRoot,
          }).catch((error) => ({ applied: 'error', error: String(error?.message || error) }))
          if (result.applied === 'deleted') {
            delete local[rel]
            report.deleted += 1
          }
        }
      }
    }
    report.items = Object.values(manifest?.sets || {}).reduce((sum, entry) => sum + Object.keys(entry.entries || {}).length, 0)
  }

  function pushAttemptsFor(peerId) {
    if (!state.pushAttempts || typeof state.pushAttempts !== 'object') state.pushAttempts = {}
    if (!state.pushAttempts[peerId] || typeof state.pushAttempts[peerId] !== 'object') state.pushAttempts[peerId] = {}
    return state.pushAttempts[peerId]
  }

  async function pushSessions(peer, report) {
    if (state.settings?.push === false) return
    const set = currentSets().find((candidate) => candidate.id === 'sessions')
    if (!set) return
    const local = await localEntries(set)
    let manifest
    try {
      manifest = await fetchManifest(peer, { sets: ['sessions'] })
    } catch {
      return
    }
    const remote = manifest?.sets?.sessions?.entries || {}
    const byId = remoteById(remote)
    const remoteCreated = new Set(
      Object.values(remote)
        .map((entry) => entry?.meta?.createdAt)
        .filter((value) => Number.isSafeInteger(value)),
    )
    const attempts = pushAttemptsFor(peer.deviceId)
    let pushed = 0
    let bytes = 0
    const entries = Object.entries(local)
      .filter(([rel]) => rel !== '__scannedAt' && isSessionRel(rel))
      .sort((a, b) => (b[1].meta?.createdAt || 0) - (a[1].meta?.createdAt || 0))
    for (const [rel, entry] of entries) {
      if (pushed >= MAX_PUSH_ITEMS || bytes >= MAX_PUSH_BYTES) break
      const id = entry?.meta?.id || sessionIdFromRel(rel)
      if (!id) continue
      if (byId.has(id)) continue
      const createdAt = entry?.meta?.createdAt
      if (Number.isSafeInteger(createdAt) && remoteCreated.has(createdAt)) continue
      const attempted = attempts[id]
      if (attempted && attempted.h === entry.h) continue
      const abs = absFor(set, rel)
      if (!abs) continue
      const stat = await fs.stat(abs).catch(() => null)
      if (!stat || stat.size > MAX_PUSH_BYTES) continue
      const data = await fs.readFile(abs).catch(() => null)
      if (!data) continue
      try {
        const result = await pushSetFile(peer, { set: 'sessions', rel, data })
        if (result?.ok) {
          pushed += 1
          bytes += data.length
          report.pushedIds.push(id)
          attempts[id] = { h: entry.h || null, at: now() }
        }
        if (result?.applied === 'conflict') report.conflicts += 1
      } catch (error) {
        report.errors.push({ stage: 'push', set: 'sessions', deviceId: peer.deviceId, rel, code: error?.code || 'push-failed', message: String(error?.message || error) })
      }
    }
    report.pushed = pushed
  }

  async function runOnce() {
    const startedAt = now()
    const report = {
      startedAt,
      finishedAt: null,
      peers: [],
      items: 0,
      imported: 0,
      importedIds: [],
      pushed: 0,
      pushedIds: [],
      deleted: 0,
      conflicts: 0,
      skipped: [],
      errors: [],
      sets: currentSets().map((set) => set.id),
    }
    const peers = await Promise.resolve().then(() => listPeers()).catch(() => [])
    const seenDevices = new Set()
    for (const peer of peers) {
      const peerReport = {
        deviceId: peer.deviceId,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        ok: true,
        items: 0,
        imported: 0,
        pushed: 0,
        skipped: 0,
        error: null,
      }
      let proceed = true
      try {
        proceed = (await pullPeer(peer, report, seenDevices)) !== false
        if (proceed) await pushSessions(peer, report)
      } catch (error) {
        peerReport.ok = false
        peerReport.error = String(error?.message || error)
        report.errors.push({ stage: 'peer', deviceId: peer.deviceId, code: error?.code || 'peer-failed', message: peerReport.error })
      }
      peerReport.pushed = report.pushed
      report.peers.push(peerReport)
    }
    report.finishedAt = now()
    last = report
    await save()
    if (onResult) {
      try {
        onResult(report)
      } catch {}
    }
    return report
  }

  return {
    async syncNow() {
      if (running) return { busy: true }
      running = true
      try {
        return await runOnce()
      } finally {
        running = false
      }
    },
    getLastResult() {
      return last
    },
    isRunning() {
      return running
    },
    status() {
      return { running, paused: state.paused === true, push: state.settings?.push !== false, imported: Object.keys(state.imports || {}).length, last }
    },
    async scanAll() {
      for (const set of currentSets()) await localEntries(set, true)
      await save()
    },
    async refreshSet(setId) {
      const set = currentSets().find((candidate) => candidate.id === setId)
      if (!set) return null
      return await localEntries(set, true)
    },
    localIndex(setId) {
      return localIndexFor(state, setId)
    },
    /** Apply a file pushed by a peer (no journal base available). */
    async applyPushed({ set, rel, data, peerAddress }) {
      if (!set) throw new Error('unknown set')
      const { setAllowsRel } = await import('./sets.js')
      if (!setAllowsRel(set, rel)) throw new Error('invalid path')
      const index = localIndexFor(state, set.id)
      let localEntry = index[rel] || null
      let targetRel = rel
      if (set.mode === 'append') {
        const resolved = resolveSessionTarget({
          state,
          localEntries: Object.fromEntries(Object.entries(index).filter(([key]) => key !== '__scannedAt')),
          remoteRel: rel,
          remoteMeta: null,
        })
        targetRel = resolved.rel
        localEntry = index[targetRel] || null
      }
      const result = await applyRemoteFile({
        set,
        rel: targetRel,
        data,
        entry: { h: null, s: data.length, m: Date.now() },
        peer: peerAddress,
        base: null,
        localEntry,
        pushMode: true,
        selfDeviceId,
        logger,
      })
      return result
    },
  }
}
