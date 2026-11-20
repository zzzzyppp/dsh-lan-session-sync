import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentDigest, localSessionIdForDigest } from './digest.js';
import { findImportByDigest, hasImport, originKey, recordImport } from './state.js';

export const MAX_SESSION_EVENTS = 100000;
export const DEFAULT_WORKSPACE_TITLE = 'LAN synced sessions';

export class SyncImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SyncImportError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** Lexical prefix check; source paths come from a peer, so never require they exist. */
export function pathInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false;
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

export function defaultCwdPrefixes(extra = []) {
  const prefixes = [os.homedir(), '/Applications', '/Volumes', '/tmp'];
  for (const entry of extra) {
    if (typeof entry === 'string' && path.isAbsolute(entry)) prefixes.push(entry);
  }
  return [...new Set(prefixes)];
}

export async function chooseLocalCwd(sourceCwd, options) {
  const prefixes = options.prefixes ?? defaultCwdPrefixes();
  const landingDir = options.landingDir;
  if (typeof sourceCwd === 'string' && path.isAbsolute(sourceCwd) && prefixes.some((prefix) => pathInside(sourceCwd, prefix))) {
    try {
      const info = await stat(sourceCwd);
      if (info.isDirectory()) return path.resolve(sourceCwd);
    } catch {
      // Fall through to the landing directory.
    }
  }
  await mkdir(landingDir, { recursive: true, mode: 0o700 });
  return landingDir;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Validate and copy an event list. Only plain contiguous sequences are accepted. */
export function validateEvents(events) {
  if (!Array.isArray(events)) throw new SyncImportError('invalid-session', 'session events are not an array');
  if (events.length === 0) throw new SyncImportError('invalid-session', 'session has no events');
  if (events.length > MAX_SESSION_EVENTS) throw new SyncImportError('invalid-session', 'session has too many events');
  const copy = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new SyncImportError('invalid-session', `event ${index} is not an object`);
    }
    if (event.seq !== index) {
      throw new SyncImportError('invalid-session', `event ${index} has non-contiguous seq ${String(event.seq)}`);
    }
    copy.push(event);
  }
  return copy;
}

export function normalizeImportedHeader(sourceHeader, options) {
  const header = {
    version: 4,
    id: options.localId,
    createdAt: isPositiveNumber(sourceHeader?.createdAt) ? sourceHeader.createdAt : options.now,
    cwd: options.cwd,
    isSeeded: false,
  };
  const preset = sourceHeader?.agentPreset;
  if (typeof preset === 'string' && preset.length > 0 && preset.length <= 128) header.agentPreset = preset;
  return header;
}

function looksLikeAlreadyExists(error) {
  return (
    error?.code === 'EEXIST' ||
    error?.name === 'SessionAlreadyExistsError' ||
    /already owned|already exists/i.test(String(error?.message ?? ''))
  );
}

function rememberAlias(state, key, options) {
  recordImport(state, key, {
    localId: options.localId,
    deviceId: options.sourceDeviceId,
    sessionId: options.sourceSessionId,
    digest: options.digest,
    importedAt: options.now,
    alias: true,
    ...originFields(options),
  });
}

/** Root provenance: the device/session this content originally came from. */
function originFields(options) {
  const explicit = options.provenance;
  return {
    originDeviceId: typeof explicit?.deviceId === 'string' ? explicit.deviceId : options.sourceDeviceId,
    originSessionId: typeof explicit?.sessionId === 'string' ? explicit.sessionId : options.sourceSessionId,
  };
}

/**
 * Import one remote session as a NEW local session. Never overwrites anything:
 * a session that is already known (by origin or by identical content) is skipped.
 */
export async function importSession(options) {
  const {
    sourceDeviceId,
    sourceSessionId,
    sourceHeader,
    events,
    digest,
    persistence,
    workspaceRegistry,
    sessions,
    state,
    landingDir,
    now = Date.now(),
    attach = true,
    workspaceTitle = DEFAULT_WORKSPACE_TITLE,
    prefixes,
    provenance = null,
    selfDeviceId = null,
  } = options;

  if (typeof sourceDeviceId !== 'string' || sourceDeviceId.length === 0 || sourceDeviceId.length > 128) {
    throw new SyncImportError('invalid-session', 'source device id is invalid');
  }
  if (typeof sourceSessionId !== 'string' || sourceSessionId.length === 0 || sourceSessionId.length > 200) {
    throw new SyncImportError('invalid-session', 'source session id is invalid');
  }
  if (!state || typeof state.imports !== 'object') throw new SyncImportError('invalid-state', 'plugin state is not loaded');
  if (typeof landingDir !== 'string' || !path.isAbsolute(landingDir)) {
    throw new SyncImportError('invalid-landing', 'landing directory must be absolute');
  }
  if (provenance && selfDeviceId && provenance.deviceId === selfDeviceId) {
    return { imported: false, reason: 'provenance' };
  }

  const key = originKey(sourceDeviceId, sourceSessionId);
  if (hasImport(state, key)) return { imported: false, reason: 'known-origin' };

  const accepted = validateEvents(events);
  const computed = contentDigest(accepted);
  if (typeof digest === 'string' && digest.length > 0 && digest !== computed) {
    throw new SyncImportError('digest-mismatch', 'session content does not match its digest');
  }

  const aliasOptions = { sourceDeviceId, sourceSessionId, digest: computed, now, provenance };
  const knownByDigest = findImportByDigest(state, computed);
  if (knownByDigest) {
    rememberAlias(state, key, { ...aliasOptions, localId: knownByDigest.localId });
    return { imported: false, reason: 'already-imported', localId: knownByDigest.localId };
  }

  const localId = localSessionIdForDigest(computed);
  if (typeof persistence?.stat === 'function') {
    try {
      const existing = await persistence.stat(localId);
      if (existing) {
        rememberAlias(state, key, { ...aliasOptions, localId });
        return { imported: false, reason: 'already-present', localId };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.name !== 'ENOENT') throw error;
    }
  }

  const cwd = await chooseLocalCwd(sourceHeader?.cwd, { landingDir, prefixes });
  const header = normalizeImportedHeader(sourceHeader, { localId, cwd, now });

  if (sessions && typeof sessions.prepare === 'function') {
    try {
      sessions.prepare(localId, { seed: accepted, meta: header, inheritedEventCount: 0, eventState: 'detached' });
    } catch (error) {
      throw new SyncImportError('prepare-failed', `DeepSeek Harness rejected the imported session: ${error?.message ?? error}`, {
        cause: error,
      });
    }
  }

  let handle;
  try {
    handle = await persistence.create(header);
  } catch (error) {
    if (looksLikeAlreadyExists(error)) {
      rememberAlias(state, key, { ...aliasOptions, localId });
      return { imported: false, reason: 'already-present', localId };
    }
    throw error;
  }

  try {
    await handle.append(accepted);
    await handle.flush();
  } finally {
    await Promise.resolve(handle.close()).catch(() => {});
  }

  let attached = false;
  let attachError = null;
  if (attach && workspaceRegistry) {
    try {
      let workspace = await workspaceRegistry.resolveByPath(cwd);
      if (!workspace) workspace = await workspaceRegistry.create(cwd, workspaceTitle);
      if (!workspace) throw new Error('workspace could not be created');
      await workspace.attachSession(localId);
      attached = true;
    } catch (error) {
      attachError = error?.message ?? String(error);
    }
  }

  recordImport(state, key, {
    localId,
    deviceId: sourceDeviceId,
    sessionId: sourceSessionId,
    digest: computed,
    importedAt: now,
    ...originFields({ sourceDeviceId, sourceSessionId, provenance }),
  });

  return {
    imported: true,
    localId,
    cwd,
    attached,
    attachError,
    digest: computed,
    eventCount: accepted.length,
  };
}
