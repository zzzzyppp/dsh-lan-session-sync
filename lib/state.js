import { mkdir, open, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const STATE_VERSION = 1;
export const STATE_FILE = 'state.json';
export const LOCAL_ROOT = 'lan-session-sync';

export const DEFAULT_SETTINGS = Object.freeze({
  auto: true,
  autoSyncMs: 30000,
  httpPort: 47830,
  discoveryPort: 47829,
  keyEnabled: false,
  push: true,
  sets: Object.freeze({
    workspace: true,
    storages: true,
    profile: true,
    modules: true,
    credentials: true,
    attachments: true,
    cache: false,
  }),
});

export const SET_IDS = Object.freeze(['workspace', 'storages', 'profile', 'modules', 'credentials', 'attachments', 'cache']);

export const MIN_SYNC_INTERVAL_MS = 10000;
export const MAX_SYNC_INTERVAL_MS = 3600000;

export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.length > 0 && path.isAbsolute(configured)) return configured;
  return path.join(os.homedir(), '.dsh');
}

export function originKey(deviceId, sessionId) {
  return `${deviceId}/${sessionId}`;
}

export function newSharedKey() {
  return randomBytes(24).toString('base64url');
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    deviceId: randomUUID(),
    deviceName: defaultDeviceName(),
    paused: false,
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, sets: { ...DEFAULT_SETTINGS.sets } },
    manualPeers: [],
    imports: {},
    indexes: {},
    journals: {},
    tombstones: [],
    aliases: {},
  };
}

function cleanSets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sets = {};
  for (const id of SET_IDS) sets[id] = source[id] === undefined ? DEFAULT_SETTINGS.sets[id] : source[id] === true;
  return sets;
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function defaultDeviceName() {
  const host = typeof os.hostname === 'function' ? os.hostname() : 'dsh';
  return String(host || 'dsh').slice(0, 48);
}

function cleanName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64);
  return name.length > 0 ? name : fallback;
}

function cleanPort(value, fallback) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return fallback;
  return port;
}

function cleanInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) return DEFAULT_SETTINGS.autoSyncMs;
  return Math.min(MAX_SYNC_INTERVAL_MS, Math.max(MIN_SYNC_INTERVAL_MS, Math.round(interval)));
}

function cleanManualPeers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const peers = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.address !== 'string' || entry.address.length === 0 || entry.address.length > 255) continue;
    const port = cleanPort(entry.port, 0);
    if (port === 0) continue;
    const address = entry.address.trim().toLowerCase();
    const dedupe = `${address}:${port}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    peers.push({ address, port });
    if (peers.length >= 32) break;
  }
  return peers;
}

function cleanImports(value) {
  const imports = {};
  if (!value || typeof value !== 'object') return imports;
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.localId !== 'string' || entry.localId.length === 0 || entry.localId.length > 200) continue;
    if (typeof entry.deviceId !== 'string' || typeof entry.sessionId !== 'string') continue;
    imports[key] = {
      localId: entry.localId,
      deviceId: entry.deviceId,
      sessionId: entry.sessionId,
      digest: typeof entry.digest === 'string' ? entry.digest : '',
      importedAt: Number.isFinite(entry.importedAt) ? entry.importedAt : Date.now(),
      alias: entry.alias === true,
    };
    if (typeof entry.originDeviceId === 'string' && entry.originDeviceId.length > 0 && entry.originDeviceId.length <= 128) {
      imports[key].originDeviceId = entry.originDeviceId;
    }
    if (typeof entry.originSessionId === 'string' && entry.originSessionId.length > 0 && entry.originSessionId.length <= 200) {
      imports[key].originSessionId = entry.originSessionId;
    }
  }
  return imports;
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) throw new Error(`unsupported state version: ${String(raw.version)}`);
  if (version > STATE_VERSION) throw new Error(`state version ${version} is newer than supported ${STATE_VERSION}`);
  const base = defaultState();
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  return {
    version: STATE_VERSION,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.length > 0 && raw.deviceId.length <= 128 ? raw.deviceId : base.deviceId,
    deviceName: cleanName(raw.deviceName, base.deviceName),
    paused: raw.paused === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : base.createdAt,
    settings: {
      auto: settings.auto !== false,
      autoSyncMs: cleanInterval(settings.autoSyncMs),
      httpPort: cleanPort(settings.httpPort, DEFAULT_SETTINGS.httpPort),
      discoveryPort: cleanPort(settings.discoveryPort, DEFAULT_SETTINGS.discoveryPort),
      keyEnabled: settings.keyEnabled === true,
      push: settings.push !== false,
      sets: cleanSets(settings.sets),
    },
    manualPeers: cleanManualPeers(raw.manualPeers),
    imports: cleanImports(raw.imports),
    indexes: cleanObject(raw.indexes),
    journals: cleanObject(raw.journals),
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.filter((item) => item && typeof item === 'object').slice(-5000) : [],
    aliases: cleanObject(raw.aliases),
  };
}

export function hasImport(state, key) {
  return Object.prototype.hasOwnProperty.call(state.imports ?? {}, key);
}

export function getImport(state, key) {
  return state.imports?.[key] ?? null;
}

export function recordImport(state, key, entry) {
  const record = {
    localId: entry.localId,
    deviceId: entry.deviceId,
    sessionId: entry.sessionId,
    digest: entry.digest ?? '',
    importedAt: Number.isFinite(entry.importedAt) ? entry.importedAt : Date.now(),
    alias: entry.alias === true,
  };
  if (typeof entry.originDeviceId === 'string' && entry.originDeviceId.length > 0) {
    record.originDeviceId = entry.originDeviceId;
  }
  if (typeof entry.originSessionId === 'string' && entry.originSessionId.length > 0) {
    record.originSessionId = entry.originSessionId;
  }
  state.imports[key] = record;
}

export function countImports(state) {
  return Object.keys(state.imports ?? {}).length;
}

export function importsByLocalId(state) {
  const map = new Map();
  for (const entry of Object.values(state.imports ?? {})) {
    if (entry && typeof entry.localId === 'string') map.set(entry.localId, entry);
  }
  return map;
}

export function findImportByDigest(state, digest) {
  if (typeof digest !== 'string' || digest.length === 0) return null;
  for (const entry of Object.values(state.imports ?? {})) {
    if (entry.digest === digest && entry.alias !== true) return entry;
  }
  return null;
}

export class StateStore {
  constructor(rootDir) {
    this.dir = rootDir;
    this.file = path.join(rootDir, STATE_FILE);
    this.state = null;
    this.loading = null;
    this.saving = Promise.resolve();
    this.corruptBackup = null;
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = this.#load();
    return this.loading;
  }

  async #load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let text = null;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (text === null) {
      this.state = defaultState();
    } else {
      try {
        this.state = normalizeState(JSON.parse(text));
      } catch {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, backup).catch(() => {});
        this.corruptBackup = backup;
        this.state = defaultState();
        this.state.paused = true;
      }
    }
    await this.save();
    return this.state;
  }

  async save() {
    if (!this.state) throw new Error('state is not loaded');
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saving = this.saving.then(async () => {
      const temp = `${this.file}.tmp-${process.pid}`;
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(snapshot, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
      try {
        const dir = await open(this.dir, 'r');
        await dir.sync();
        await dir.close();
      } catch {
        // Directory fsync is best-effort on platforms that disallow it.
      }
    });
    return this.saving;
  }
}
