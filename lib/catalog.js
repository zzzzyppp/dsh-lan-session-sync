// Ceiling for both the compressed snapshot size (catalog admission) and the
// uncompressed event JSON (export). Real sessions compress ~3.2-3.6x, so 128 MiB
// uncompressed covers ~35 MB of zstd log; a lower bound silently refused to
// export sessions that the catalog still advertised.
export const MAX_SESSION_BYTES = 128 * 1024 * 1024;
export const MAX_CATALOG_ITEMS = 500;

/**
 * Decide whether a persistence snapshot can be exported as a standalone session.
 * Returns {ok:true, item} or {ok:false, reason}.
 */
export function filterSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'no-snapshot' };
  const header = snapshot.header;
  if (!header || typeof header !== 'object') return { ok: false, reason: 'no-header' };
  if (typeof header.id !== 'string' || header.id.length === 0) return { ok: false, reason: 'no-id' };
  if (snapshot.formatStatus === 'migration-required') return { ok: false, reason: 'migration-required' };
  if (header.version !== 4) return { ok: false, reason: 'unsupported-version' };
  if (header.isSeeded === true) return { ok: false, reason: 'seeded' };
  if (header.origin === 'subagent') return { ok: false, reason: 'subagent' };
  if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return { ok: false, reason: 'delegated' };
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) return { ok: false, reason: 'no-cwd' };
  // `list()` and `stat()` snapshots omit eventCount (only live/created handles
  // know it), so an absent count is not evidence of an empty session. An
  // explicit zero is: exportSession still re-checks the events it reads.
  if (Number.isSafeInteger(snapshot.eventCount) && snapshot.eventCount <= 0) return { ok: false, reason: 'empty' };
  if (Number.isSafeInteger(snapshot.sizeBytes) && snapshot.sizeBytes > MAX_SESSION_BYTES) return { ok: false, reason: 'too-large' };
  if (typeof header.createdAt !== 'number' || !Number.isFinite(header.createdAt)) {
    return { ok: false, reason: 'no-created-at' };
  }
  return {
    ok: true,
    item: {
      id: header.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      isSeeded: false,
      eventCount: Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : null,
      sizeBytes: snapshot.sizeBytes ?? null,
      updatedAt: snapshot.revision > 0 ? snapshot.revision : header.createdAt,
    },
  };
}

/** Build a bounded, newest-first catalog from persistence snapshots. */
export function buildCatalog(snapshots, options = {}) {
  const limit = Math.min(MAX_CATALOG_ITEMS, Math.max(1, Number(options.limit) || MAX_CATALOG_ITEMS));
  const items = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const result = filterSnapshot(snapshot);
    if (result.ok) items.push(result.item);
  }
  items.sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)));
  return items.slice(0, limit);
}

/**
 * Attach root provenance to catalog items so a peer can recognize content that
 * originally came from itself and never import its own session back.
 */
export function withProvenance(items, importsByLocalId) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const entry = typeof importsByLocalId?.get === 'function' ? importsByLocalId.get(item.id) : null;
    if (!entry) return item;
    const deviceId = entry.originDeviceId ?? entry.deviceId;
    const sessionId = entry.originSessionId ?? entry.sessionId;
    if (typeof deviceId !== 'string' || typeof sessionId !== 'string') return item;
    return { ...item, importedFrom: { deviceId, sessionId } };
  });
}
