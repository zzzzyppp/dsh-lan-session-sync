// File-set scanning, manifests, and application of peer files.
//
// Each set is an independent unit: entries carry size/mtime/sha256, sessions
// also carry their parsed header (id/createdAt/cwd) so the peer can resolve
// append targets without downloading the log first. Application follows the
// reference rules: append-only for session logs, structured merge for the
// workspace index / profile manifest / credentials, last-writer-wins otherwise.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDir, hashFileStream, readTail, statSafe, writeAtomic } from './fsutil.js'
import { absFor, normalizeRel, setAllowsRel } from './sets.js'
import { decide, mergeWorkspace, mergePackageJson, conflictName } from './merge.js'
import { mergeCredentialRefs } from './credentials.js'
import { mergeModelBlocks } from './modelconfig.js'
import { isSessionRel, parseSessionHeader, readLocalSessionHeader } from './session-files.js'

export const MAX_SET_FILES = 20000
export const MAX_BLOB_BYTES = 160 * 1024 * 1024

/** Walk one set, applying set-relative ignore/include/exclude rules. */
export async function listSetFiles(set, { maxFiles = MAX_SET_FILES } = {}) {
  const out = []
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!setAllowsRel(set, rel)) continue
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (!setAllowsRel(set, rel)) continue
        out.push(rel)
      }
    }
  }
  await walk(set.root, '')
  return out
}

/** Scan one set into an index: rel -> {s, m, h, meta?}. */
export async function scanSet(set, { cache = null, maxFiles = MAX_SET_FILES } = {}) {
  const files = await listSetFiles(set, { maxFiles })
  const entries = {}
  for (const rel of files) {
    const abs = absFor(set, rel)
    if (!abs) continue
    const stat = await statSafe(abs)
    if (!stat) continue
    const previous = cache?.[rel]
    let hash = null
    let meta = previous?.meta ?? null
    if (previous && previous.s === stat.size && previous.m === Math.round(stat.mtimeMs) && previous.h) {
      hash = previous.h
    } else {
      try {
        hash = await hashFileStream(abs)
      } catch {
        continue
      }
      if (set.mode === 'append') meta = await readLocalSessionHeader(abs).catch(() => null)
    }
    entries[rel] = { s: stat.size, m: Math.round(stat.mtimeMs), h: hash }
    if (meta) entries[rel].meta = meta
  }
  return entries
}

export function sha256buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function isProfilePackageJson(set, rel) {
  return set.id === 'profile' && rel === 'package.json'
}

function isModelPatch(set, rel) {
  return set.id === 'profile' && rel === 'cordis.patch.yml'
}

/** Write a pulled file with a conflict-safe backup and update metadata. */
async function applyLww({ set, rel, data, entry, peer, localEntry, backups = true }) {
  const abs = absFor(set, rel)
  if (!abs) throw new Error('invalid path')
  await ensureDir(dirname(abs))
  const existed = await fs.readFile(abs).catch(() => null)
  if (existed && existed.equals(data)) {
    return { applied: 'unchanged', bytes: 0, hash: entry.h }
  }
  if (existed && backups && set.id !== 'modules') {
    const backup = join(dirname(abs), `${rel.split('/').pop()}.bak-sync-${String(peer).slice(0, 6)}-${Date.now()}`)
    await fs.copyFile(abs, backup).catch(() => {})
  }
  await writeAtomic(abs, data, { mtimeMs: Number(entry.m) || 0, mode: 0o600 })
  const hash = sha256buffer(data)
  return { applied: 'written', bytes: data.length, hash }
}

/** Remember the losing peer copy instead of overwriting local data. */
async function parkConflict({ set, rel, data, peer, name = null }) {
  const abs = absFor(set, rel)
  if (!abs) throw new Error('invalid path')
  const target = name
    ? join(dirname(abs), name)
    : `${abs}${conflictName('', peer).replace(/^\//, '')}`
  await ensureDir(dirname(target))
  await writeAtomic(target, data, { mode: 0o600 })
  return target
}

/**
 * Apply one pulled/pushed file according to the set's merge mode.
 * `base` is the last agreed entry for this peer (hash), used for LWW checks.
 */
export async function applyRemoteFile(options) {
  const { set, rel: rawRel, data, entry, peer, base = null, localEntry = null, logger = null } = options
  const rel = normalizeRel(rawRel)
  if (!rel || !setAllowsRel(set, rel)) throw new Error('invalid path')
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('empty payload')
  if (data.length > MAX_BLOB_BYTES) throw new Error('file too large')

  if (set.mode === 'append' && isSessionRel(rel)) {
    const { applySessionBytes } = await import('./session-files.js')
    const abs = absFor(set, rel)
    if (!abs) throw new Error('invalid path')
    const result = await applySessionBytes({ absPath: abs, data, peerId: peer })
    const hash = result.applied === 'unchanged' ? localEntry?.h ?? sha256buffer(data) : sha256buffer(await fs.readFile(abs))
    return { ...result, hash, rel }
  }

  if (set.mode === 'merge-workspace' && rel === 'workspace.json') {
    const abs = absFor(set, rel)
    const localBuf = await fs.readFile(abs).catch(() => null)
    let localValue = null
    try {
      if (localBuf) localValue = JSON.parse(localBuf.toString('utf8'))
    } catch {
      const parked = await parkConflict({ set, rel, data, peer })
      return { applied: 'conflict', bytes: 0, hash: entry.h, conflictFile: parked }
    }
    let remoteValue
    try {
      remoteValue = JSON.parse(data.toString('utf8'))
    } catch {
      throw new Error('invalid workspace JSON')
    }
    const merged = mergeWorkspace(localValue || {}, remoteValue)
    if (!merged.changed) return { applied: 'unchanged', bytes: 0, hash: localEntry?.h ?? entry.h }
    await writeAtomic(abs, JSON.stringify(merged.value, null, 2) + '\n', { mode: 0o600 })
    return { applied: 'merged', bytes: 0, hash: sha256buffer(await fs.readFile(abs)) }
  }

  if (isProfilePackageJson(set, rel)) {
    const abs = absFor(set, rel)
    const localBuf = await fs.readFile(abs).catch(() => null)
    let localValue = null
    try {
      if (localBuf) localValue = JSON.parse(localBuf.toString('utf8'))
    } catch {
      const parked = await parkConflict({ set, rel, data, peer })
      return { applied: 'conflict', bytes: 0, hash: entry.h, conflictFile: parked }
    }
    let remoteValue
    try {
      remoteValue = JSON.parse(data.toString('utf8'))
    } catch {
      throw new Error('invalid profile JSON')
    }
    const resolver = options.resolveBundle
    const merged = mergePackageJson(localValue || {}, remoteValue, {
      resolveBundle: resolver || null,
      linkTargetExists: options.linkTargetExists || null,
    })
    if (!merged.changed) return { applied: 'unchanged', bytes: 0, hash: localEntry?.h ?? entry.h }
    await writeAtomic(abs, JSON.stringify(merged.value, null, 2) + '\n', { mode: 0o600 })
    return { applied: 'merged', bytes: 0, hash: sha256buffer(await fs.readFile(abs)), conflicts: merged.skipped }
  }

  if (isModelPatch(set, rel)) {
    const abs = absFor(set, rel)
    const localText = await fs.readFile(abs, 'utf8').catch(() => '')
    const remoteText = data.toString('utf8')
    const merged = mergeModelBlocks(localText, remoteText, base?.modelBases || {}, {
      localUpdatedAt: localEntry?.m || 0,
      remoteUpdatedAt: entry.m || 0,
    })
    if (!merged.changed) {
      return { applied: 'unchanged', bytes: 0, hash: localEntry?.h ?? entry.h, modelBases: merged.bases }
    }
    await ensureDir(dirname(abs))
    await fs.copyFile(abs, `${abs}.bak-model-${Date.now()}`).catch(() => {})
    await writeAtomic(abs, merged.text, { mode: 0o600 })
    return { applied: 'merged', bytes: 0, hash: sha256buffer(Buffer.from(merged.text, 'utf8')), modelBases: merged.bases }
  }

  if (set.mode === 'merge-credentials' && rel === '.credentials.yaml') {
    const abs = absFor(set, rel)
    const localText = await fs.readFile(abs, 'utf8').catch(() => '')
    const merged = mergeCredentialRefs(localText, data.toString('utf8'))
    if (!merged.changed) return { applied: 'unchanged', bytes: 0, hash: localEntry?.h ?? entry.h }
    await ensureDir(dirname(abs))
    await fs.copyFile(abs, `${abs}.bak-sync-${Date.now()}`).catch(() => {})
    await writeAtomic(abs, merged.text, { mode: 0o600 })
    return {
      applied: 'merged',
      bytes: 0,
      hash: sha256buffer(Buffer.from(merged.text, 'utf8')),
      conflicts: merged.conflicts,
      added: merged.added,
    }
  }

  // A pushed file arrives without a journal base. Never overwrite a differing
  // local copy on a plain last-writer-wins set — park the peer copy instead.
  if (options.pushMode && localEntry && entry.h && localEntry.h !== entry.h) {
    const parked = await parkConflict({ set, rel, data, peer })
    return { applied: 'conflict', bytes: 0, hash: localEntry.h, conflictFile: parked }
  }

  // Conflict-aware last-writer-wins for ordinary files.
  const localHash = localEntry?.h ?? null
  const baseHash = base?.h ?? null
  const localChanged = localHash ? localHash !== baseHash : false
  const remoteChanged = entry.h !== baseHash
  if (localEntry && localChanged && !remoteChanged) {
    return { applied: 'unchanged', bytes: 0, hash: localHash }
  }
  if (localEntry && localChanged && remoteChanged) {
    const decision = decide({ local: localEntry, remote: entry, base, mode: set.mode, localDevice: options.selfDeviceId, remoteDevice: peer })
    if (decision.action !== 'pull') {
      const parked = await parkConflict({ set, rel, data, peer })
      return { applied: 'conflict', bytes: 0, hash: localEntry.h, conflictFile: parked }
    }
  }
  return await applyLww({ set, rel, data, entry, peer, localEntry })
}

/** Record a deletion tombstone and remove the local copy into the archive. */
export function addTombstone(state, { set, rel, hash, at = Date.now() }) {
  if (!Array.isArray(state.tombstones)) state.tombstones = []
  const entry = { set, rel, h: hash, at }
  state.tombstones = state.tombstones.filter((item) => !(item.set === set && item.rel === rel))
  state.tombstones.push(entry)
  if (state.tombstones.length > 5000) state.tombstones.splice(0, state.tombstones.length - 5000)
  return entry
}

/** Apply a peer tombstone when it is older than the local copy and hashes match. */
export async function applyTombstone({ set, rel, tomb, localEntry, state, archiveRoot }) {
  if (!localEntry) return { applied: 'absent' }
  if (!tomb || tomb.h !== localEntry.h) return { applied: 'kept-hash' }
  if (Number(localEntry.m) > Number(tomb.at || 0)) return { applied: 'kept-newer' }
  const abs = absFor(set, rel)
  if (!abs) return { applied: 'invalid' }
  const archive = join(archiveRoot, String(tomb.at || Date.now()), set.id, rel)
  await ensureDir(dirname(archive))
  try {
    await fs.rename(abs, archive)
  } catch (error) {
    return { applied: 'error', error: String(error?.message || error) }
  }
  return { applied: 'deleted', archive }
}

/** Hash the first `length` bytes of a local file (for session tail pushes). */
export async function prefixHash(absPath, length) {
  if (!length) return null
  const handle = await fs.open(absPath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < length) return null
    const hash = createHash('sha256')
    const stream = createReadStream(absPath, { start: 0, end: length - 1 })
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Read the tail of a local file from a byte offset. */
export async function readTailBytes(absPath, from) {
  const stat = await statSafe(absPath)
  if (!stat) return null
  if (from >= stat.size) return null
  return readTail(absPath, from, stat.size)
}

/** Parse a session header from a peer manifest meta or raw bytes. */
export function sessionMetaFromEntry(entry, rel) {
  return entry?.meta || { id: (rel.split('/').slice(-2, -1)[0] || null) }
}

export { parseSessionHeader }
