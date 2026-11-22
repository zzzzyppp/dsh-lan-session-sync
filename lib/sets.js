// Sync-set construction and path safety.
//
// A set is one coherent slice of $DSH_HOME with its own merge mode. Every
// remote path is validated against the same rules that built the local index,
// so a peer can never address a file outside its set root.
import { buildSets, isIgnoredForSet, joinInside, resolveDshHome, displayHome, toRelative } from './paths.js'
import { matchesAny, matchesInclude } from './glob.js'

export { resolveDshHome, displayHome, joinInside, toRelative }

/** Default profile name for this install. */
export function currentProfile(env = process.env) {
  const name = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  return name || 'desktop'
}

/**
 * Build the sync sets. `enabled` is the configured object of set-id booleans;
 * unspecified sets use their default.
 */
export function syncSets({ home, profile = currentProfile(), enabled = null } = {}) {
  const ids = enabled && typeof enabled === 'object'
    ? ['sessions', ...Object.keys(enabled).filter((id) => enabled[id] === true)]
    : null
  const sets = buildSets({ home, profile, sets: ids })
  const result = sets.filter((set) => set.enabled)
  for (const set of result) {
    // The plugin's own state must never enter a set, regardless of root.
    if (set.id === 'credentials') continue
  }
  return result
}

/** True when a set-relative path may be read/written by a peer. */
export function setAllowsRel(set, relPath) {
  const rel = normalizeRel(relPath)
  if (!rel) return false
  if (isIgnoredForSet(rel, set)) return false
  if (Array.isArray(set.include) && set.include.length && !matchesInclude(rel, set.include)) return false
  if (Array.isArray(set.exclude) && set.exclude.length && matchesAny(rel, set.exclude)) return false
  return true
}

export function normalizeRel(relPath) {
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return ''
  const parts = rel.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) return ''
  return parts.join('/')
}

/** Absolute path for a set-relative path, or null when it escapes. */
export function absFor(set, relPath) {
  const rel = normalizeRel(relPath)
  if (!rel) return null
  return joinInside(set, rel)
}

/** Whether a set may propagate deletions from peers. */
export function setAllowsDelete(set) {
  return set.deletesEnabled !== false && set.id !== 'sessions' && set.id !== 'workspace' && set.id !== 'modules'
}
