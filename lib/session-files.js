// Session-log files are append-only: every durable append is a new zstd frame
// concatenated to the log. Two copies of the same log therefore agree on a
// common byte prefix, and merging is a byte-prefix test followed by an append
// of the peer's tail. Diverged logs are never overwritten; the peer copy is
// parked under `conflicts/` for manual inspection.
import fs from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { appendBytes, ensureDir, writeAtomic } from './fsutil.js'
import { normalizeRel } from './sets.js'

const SESSION_FILE = /(^|\/)session\.v\d+\.jsonl(\.zstd)?$/
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function isSessionRel(relPath) {
  const rel = normalizeRel(relPath)
  if (!rel) return false
  if (rel.includes('/conflicts/') || rel.includes('/deleted/')) return false
  return SESSION_FILE.test(rel)
}

/** Session id from a canonical log path (`.../<sessionId>/session.vN...`). */
export function sessionIdFromRel(relPath) {
  const rel = normalizeRel(relPath)
  const parts = rel.split('/')
  if (parts.length < 2) return null
  return parts[parts.length - 2] || null
}

/** Decode the first (header-only) zstd frame and parse the session header. */
export function parseSessionHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null
  const start = buffer.indexOf(FRAME_MAGIC)
  if (start < 0) return null
  const next = buffer.indexOf(FRAME_MAGIC, start + 4)
  const frame = buffer.subarray(start, next < 0 ? buffer.length : next)
  let text
  try {
    text = zstdDecompressSync(frame).toString('utf8')
  } catch {
    return null
  }
  const line = text.split('\n').find((entry) => entry.trim())
  if (!line) return null
  try {
    const header = JSON.parse(line)
    if (!header || typeof header.id !== 'string') return null
    return {
      id: header.id,
      createdAt: Number.isFinite(Number(header.createdAt)) ? Number(header.createdAt) : null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      version: Number(header.version) || null,
      isSeeded: header.isSeeded === true,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
    }
  } catch {
    return null
  }
}

/** Read and parse the header of a local session log. */
export async function readLocalSessionHeader(absPath) {
  const handle = await fs.open(absPath, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return parseSessionHeader(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close().catch(() => {})
  }
}

export function isLiveSession(ctx, sessionId) {
  if (!sessionId || !ctx?.sessions?.get) return false
  try {
    return Boolean(ctx.sessions.get(sessionId))
  } catch {
    return false
  }
}

/** Stat a session file without throwing. */
export function statSafeFile(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/**
 * Merge one incoming log into the local file.
 * Returns `{ applied, bytes, conflictFile }` where applied is one of
 * `written | appended | unchanged | conflict`.
 */
export async function applySessionBytes({ absPath, data, peerId = 'peer', now = Date.now() }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('empty session payload')
  const existing = await fs.readFile(absPath).catch(() => null)
  if (!existing) {
    await ensureDir(dirname(absPath))
    await writeAtomic(absPath, data, { mode: 0o600 })
    return { applied: 'written', bytes: data.length }
  }
  if (existing.equals(data)) return { applied: 'unchanged', bytes: 0 }
  if (existing.length <= data.length && data.subarray(0, existing.length).equals(existing)) {
    const tail = data.subarray(existing.length)
    await appendBytes(absPath, tail)
    return { applied: 'appended', bytes: tail.length }
  }
  if (data.length < existing.length && existing.subarray(0, data.length).equals(data)) {
    return { applied: 'unchanged', bytes: 0 }
  }
  // The same peer copy can arrive twice (two addresses of one device): never
  // park an identical payload more than once.
  const conflictDir = join(dirname(absPath), 'conflicts')
  const names = await fs.readdir(conflictDir).catch(() => [])
  for (const name of names) {
    const parked = await fs.readFile(join(conflictDir, name)).catch(() => null)
    if (parked && parked.equals(data)) {
      return { applied: 'conflict', bytes: 0, conflictFile: join(conflictDir, name) }
    }
  }
  const short = String(peerId || 'peer').slice(0, 8)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const conflictFile = join(conflictDir, `${basename(absPath)}.${short}.${stamp}`)
  await ensureDir(dirname(conflictFile))
  await writeAtomic(conflictFile, data, { mode: 0o600 })
  return { applied: 'conflict', bytes: data.length, conflictFile }
}

/** True when the local file is a prefix of `data` (appendable). */
export async function localIsPrefix(absPath, data) {
  const local = await fs.readFile(absPath).catch(() => null)
  if (!local) return { exists: false, prefix: false }
  if (local.length > data.length) return { exists: true, prefix: false }
  return { exists: true, prefix: data.subarray(0, local.length).equals(local) }
}

/** Ensure a session log is attached to a workspace so the sidebar shows it. */
export async function attachSession(ctx, sessionId, cwd, title = 'LAN synced sessions') {
  if (!sessionId || !cwd || !ctx?.workspaceRegistry) return { attached: false, reason: 'unavailable' }
  try {
    const real = await fs.realpath(cwd).catch(() => null)
    if (!real) return { attached: false, reason: 'cwd-missing' }
    const stat = await fs.stat(real).catch(() => null)
    if (!stat?.isDirectory()) return { attached: false, reason: 'cwd-missing' }
    let workspace = await ctx.workspaceRegistry.resolveByPath(real)
    if (!workspace) workspace = await ctx.workspaceRegistry.create(real, title)
    if (!workspace) return { attached: false, reason: 'workspace-unavailable' }
    await workspace.attachSession(sessionId)
    return { attached: true }
  } catch (error) {
    return { attached: false, reason: String(error?.message || error) }
  }
}

/** Find the first existing session log for an id anywhere under a sessions root. */
export async function findSessionRel(root, sessionId) {
  if (!root || !sessionId) return null
  let dirs
  try {
    dirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = join(root, dir.name, sessionId)
    const stat = statSafeFile(join(candidate, 'session.v4.jsonl.zstd'))
    if (stat) return `${dir.name}/${sessionId}/session.v4.jsonl.zstd`
    try {
      const files = await fs.readdir(candidate)
      const found = files.find((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
      if (found) return `${dir.name}/${sessionId}/${found}`
    } catch {}
  }
  return null
}

export function sessionFileExists(absPath) {
  return existsSync(absPath)
}
