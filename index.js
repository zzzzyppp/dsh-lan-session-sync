import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { StateStore, LOCAL_ROOT, importsByLocalId, newSharedKey, normalizeState, resolveDshHome } from './lib/state.js';
import { buildCatalog, withProvenance, MAX_SESSION_BYTES } from './lib/catalog.js';
import { contentDigest, isPrivateAddress } from './lib/digest.js';
import { importSession, DEFAULT_WORKSPACE_TITLE } from './lib/import.js';
import { createEngine } from './lib/engine.js';
import { createPeerServer } from './lib/server.js';
import { Discoverer, PeerTable } from './lib/discovery.js';
import { fetchPeerCatalog, fetchPeerSession, verifyExport } from './lib/transfer.js';

const API_PREFIX = '/lan-session-sync/api';
const CREDENTIAL_KEY = 'lan-session-sync/key';
const DISCOVERY_INTERVAL_MS = 10000;
const NEW_PEER_DEBOUNCE_MS = 3000;
const LOG_PREFIX = 'lan-session-sync:';

export const inject = ['sessions', 'sessionPersistence', 'workspaceRegistry', 'webServer', 'connection', 'credentials', 'tools'];

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > limit) {
      const error = new Error('body too large');
      error.code = 'body-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
  return parsed;
}

function summarizeReport(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    startedAt: report.startedAt ?? null,
    finishedAt: report.finishedAt ?? null,
    peers: Array.isArray(report.peers) ? report.peers.length : 0,
    imported: report.imported ?? 0,
    importedIds: Array.isArray(report.importedIds) ? report.importedIds.slice(0, 20) : [],
    skipped: Array.isArray(report.skipped) ? report.skipped.length : 0,
    errors: Array.isArray(report.errors) ? report.errors.slice(0, 10) : [],
  };
}

class LanSessionSync {
  constructor(ctx) {
    this.ctx = ctx;
    this.rootDir = path.join(resolveDshHome(), LOCAL_ROOT);
    this.landingDir = path.join(this.rootDir, 'synced');
    this.store = new StateStore(this.rootDir);
    this.state = null;
    this.sharedKey = null;
    this.error = null;
    this.server = null;
    this.port = 0;
    this.discoverer = null;
    this.peerTable = null;
    this.manualPeers = [];
    this.engine = null;
    this.autoTimer = null;
    this.debounceTimer = null;
    this.disposers = [];
    this.stopping = false;
    this.ready = this.start();
  }

  log(level, ...args) {
    const method = level === 'error' ? 'error' : 'warn';
    console[method](LOG_PREFIX, ...args);
  }

  /**
   * Keep the last sync report on disk so a failed import can be diagnosed from
   * the filesystem (the in-memory report is only reachable from the UI).
   */
  async persistReport() {
    const last = this.engine?.getLastResult?.();
    if (!last) return;
    try {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.rootDir, 'last-report.json'), `${JSON.stringify(last, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      this.log('warn', 'could not persist the last sync report', error);
    }
  }

  async start() {
    await this.store.load();
    this.state = this.store.state;
    this.manualPeers = this.state.manualPeers.map((entry) => ({ address: entry.address, port: entry.port }));
    this.peerTable = new PeerTable();
    await this.loadKey();

    this.server = createPeerServer({
      getDevice: () => this.deviceInfo(),
      listItems: () => this.catalogItems(),
      exportSession: (id) => this.exportSession(id),
      importSession: (input) => this.importPushedSession(input),
      getKey: () => this.sharedKey,
      log: { warn: (...args) => this.log('warn', ...args) },
    });
    this.port = await this.server.start(this.state.settings.httpPort);

    this.engine = createEngine({
      state: this.state,
      selfDeviceId: this.state.deviceId,
      listPeers: () => this.listPeers(),
      fetchCatalog: (peer) => this.fetchCatalog(peer),
      fetchSession: (peer, item) => fetchPeerSession(peer, item.id, { key: this.sharedKey }),
      importCandidate: (input) => this.importCandidate(input),
      onResult: () => {
        void this.store.save().catch((error) => this.log('warn', 'could not save sync state', error));
        void this.persistReport();
        this.notify();
      },
    });

    this.discoverer = new Discoverer({
      device: { id: this.state.deviceId, name: this.state.deviceName, platform: process.platform },
      servicePort: this.port,
      discoveryPort: this.state.settings.discoveryPort,
      intervalMs: DISCOVERY_INTERVAL_MS,
      onPeer: (peer) => this.onPeerSeen(peer),
      onLog: (level, message) => this.log(level, message),
    });
    this.discoverer.start();

    this.registerWebRoute();
    this.registerTools();
    this.applySchedule();
    void this.pruneMissingAttachments().then(() => this.reconcileAttachments());
  }

  /**
   * Best-effort repair: detach Workspace entries whose session log is gone
   * (for example a session file removed outside the app). Workspace records are
   * user data, so entries are only detached, never deleted.
   */
  async pruneMissingAttachments() {
    let workspaces;
    try {
      workspaces = this.ctx.workspaceRegistry.list();
    } catch (error) {
      this.log('warn', 'could not list workspaces', error);
      return;
    }
    for (const workspace of workspaces) {
      let ids;
      try {
        ids = Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : [];
      } catch {
        continue;
      }
      for (const id of ids) {
        let present = false;
        try {
          present = Boolean(await this.ctx.sessionPersistence.stat(id));
        } catch {
          present = false;
        }
        if (present) continue;
        try {
          await workspace.detachSession(id);
        } catch (error) {
          this.log('warn', 'could not detach a missing session', id, error);
        }
      }
    }
  }

  /**
   * Best-effort repair: attach already-imported sessions that were written
   * before the workspace attach step succeeded (or after a crash between them).
   * `attachSession` is idempotent for an already-accounted id.
   */
  async reconcileAttachments() {
    const imports = Object.values(this.state?.imports ?? {});
    for (const entry of imports) {
      if (!entry || typeof entry.localId !== 'string') continue;
      try {
        const snapshot = await this.ctx.sessionPersistence.stat(entry.localId);
        const cwd = snapshot?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0) continue;
        let workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd);
        if (!workspace) workspace = await this.ctx.workspaceRegistry.create(cwd, DEFAULT_WORKSPACE_TITLE);
        if (workspace) await workspace.attachSession(entry.localId);
      } catch (error) {
        this.log('warn', 'could not attach an imported session', entry.localId, error);
      }
    }
  }

  deviceInfo() {
    return {
      id: this.state.deviceId,
      name: this.state.deviceName,
      platform: process.platform,
    };
  }

  async loadKey() {
    try {
      const record = await this.ctx.credentials.readRecord(CREDENTIAL_KEY);
      const key = record && record.kind === 'api-key' && typeof record.key === 'string' ? record.key : '';
      this.sharedKey = key.length > 0 ? key : null;
    } catch {
      this.sharedKey = null;
    }
    if (this.state.settings.keyEnabled !== Boolean(this.sharedKey)) {
      this.state.settings.keyEnabled = Boolean(this.sharedKey);
      await this.store.save();
    }
  }

  async catalogItems() {
    const snapshots = await this.ctx.sessionPersistence.list();
    return withProvenance(buildCatalog(snapshots), importsByLocalId(this.state));
  }

  async exportSession(sessionId) {
    const snapshot = await this.ctx.sessionPersistence.stat(sessionId);
    const filtered = buildCatalog([snapshot]);
    if (filtered.length === 0) return null;
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const { events } = await handle.read();
      if (!Array.isArray(events) || events.length === 0) return null;
      const sizeBytes = Buffer.byteLength(JSON.stringify(events));
      if (sizeBytes > MAX_SESSION_BYTES) return { tooLarge: true, sizeBytes };
      return { header: snapshot.header, events, digest: contentDigest(events) };
    } finally {
      await Promise.resolve(handle.close()).catch(() => {});
    }
  }

  listPeers() {
    // Manual peers come first: a user-configured address (for example a
    // Thunderbolt/USB link-local cable peer) is usually more reliable than a
    // UDP-discovered address, and syncing it first lets the engine skip other
    // addresses for the same device.
    const peers = [];
    const seen = new Set();
    for (const entry of this.manualPeers) {
      const key = `${entry.address}:${entry.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      peers.push({ deviceId: null, name: entry.address, address: entry.address, port: entry.port, manual: true });
    }
    for (const peer of this.peerTable.list()) {
      const key = `${peer.address}:${peer.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      peers.push({ deviceId: peer.deviceId, name: peer.name, address: peer.address, port: peer.port, manual: false });
    }
    return peers;
  }

  async fetchCatalog(peer) {
    const catalog = await fetchPeerCatalog(peer, { key: this.sharedKey });
    if (catalog.peer.deviceId === this.state.deviceId) {
      // We reached ourselves — usually a stale discovery/manual entry pointing
      // at our own port. Drop the entry so the engine does not walk it again.
      if (peer.deviceId) this.peerTable.remove(peer.deviceId);
      this.notify();
      return catalog;
    }
    peer.deviceId = catalog.peer.deviceId;
    const stored = this.peerTable.upsert({
      deviceId: catalog.peer.deviceId,
      name: catalog.peer.name,
      address: peer.address,
      port: peer.port,
    });
    if (stored.isNew) this.notify();
    return catalog;
  }

  async importCandidate({ peer, item, payload }) {
    // `fetchPeerSession` already verified the export and returns it without the
    // wire-only `format` field; fall back to raw only for other callers.
    const exported = verifyExport(payload?.raw ?? payload);
    const result = await importSession({
      sourceDeviceId: peer.deviceId,
      sourceSessionId: item.id,
      sourceHeader: exported.header,
      events: exported.events,
      digest: exported.digest,
      persistence: this.ctx.sessionPersistence,
      workspaceRegistry: this.ctx.workspaceRegistry,
      sessions: this.ctx.sessions,
      state: this.state,
      landingDir: this.landingDir,
      provenance: item.importedFrom ?? null,
      selfDeviceId: this.state.deviceId,
    });
    if (result.imported) {
      await this.store.save();
      this.notify();
    }
    return result;
  }

  async importPushedSession(input) {
    const header = input?.header;
    const events = input?.events;
    const sourceDeviceId = typeof input?.peerAddress === 'string' && input.peerAddress.length > 0 ? `push:${input.peerAddress}` : 'push:unknown';
    const sourceSessionId = header && typeof header.id === 'string' && header.id.length > 0 ? header.id : 'unknown';
    const result = await importSession({
      sourceDeviceId,
      sourceSessionId,
      sourceHeader: header,
      events,
      digest: typeof input?.digest === 'string' ? input.digest : undefined,
      persistence: this.ctx.sessionPersistence,
      workspaceRegistry: this.ctx.workspaceRegistry,
      sessions: this.ctx.sessions,
      state: this.state,
      landingDir: this.landingDir,
      selfDeviceId: this.state.deviceId,
    });
    if (result.imported) await this.store.save();
    return result;
  }

  onPeerSeen(peer) {
    const { isNew } = this.peerTable.upsert(peer);
    if (!isNew) return;
    this.notify();
    if (!this.state.settings.auto || this.state.paused) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.state.settings.auto || this.state.paused) return;
      void this.engine.syncNow().catch((error) => this.log('warn', 'automatic sync failed', error));
    }, NEW_PEER_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  applySchedule() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    if (!this.state.settings.auto || this.state.paused) return;
    const interval = this.state.settings.autoSyncMs;
    this.autoTimer = setInterval(() => {
      void this.engine.syncNow().catch((error) => this.log('warn', 'automatic sync failed', error));
    }, interval);
    this.autoTimer.unref?.();
  }

  notify() {
    // The settings panel polls /status; notifying is a no-op hook for future streams.
  }

  statusPayload() {
    return {
      device: {
        id: this.state.deviceId,
        name: this.state.deviceName,
        platform: process.platform,
      },
      service: {
        running: Boolean(this.server?.running),
        port: this.port,
        discoveryPort: this.state.settings.discoveryPort,
        auto: this.state.settings.auto,
        autoSyncMs: this.state.settings.autoSyncMs,
        paused: this.state.paused,
        keyEnabled: Boolean(this.sharedKey),
        error: this.error ? String(this.error.message ?? this.error) : null,
      },
      peers: this.listPeers().slice(0, 50).map((peer) => ({
        deviceId: peer.deviceId,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        manual: peer.manual === true,
      })),
      imports: Object.keys(this.state.imports ?? {}).length,
      last: summarizeReport(this.engine?.getLastResult()),
    };
  }

  configPayload() {
    return {
      deviceName: this.state.deviceName,
      paused: this.state.paused,
      auto: this.state.settings.auto,
      autoSyncMs: this.state.settings.autoSyncMs,
      httpPort: this.port || this.state.settings.httpPort,
      discoveryPort: this.state.settings.discoveryPort,
      keyEnabled: Boolean(this.sharedKey),
      manualPeers: this.manualPeers.map((entry) => ({ address: entry.address, port: entry.port })),
    };
  }

  activityPayload() {
    const entries = Object.entries(this.state.imports ?? {})
      .map(([key, entry]) => ({
        origin: key,
        localId: entry.localId,
        deviceId: entry.deviceId,
        sessionId: entry.sessionId,
        importedAt: entry.importedAt,
        alias: entry.alias === true,
      }))
      .sort((left, right) => right.importedAt - left.importedAt)
      .slice(0, 20);
    return { imports: entries, last: summarizeReport(this.engine?.getLastResult()) };
  }

  async updateConfig(body) {
    const draft = JSON.parse(JSON.stringify(this.state));
    if (typeof body.deviceName === 'string') {
      const name = body.deviceName.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64);
      if (name.length === 0) throw new Error('device name cannot be empty');
      draft.deviceName = name;
    }
    if (typeof body.paused === 'boolean') draft.paused = body.paused;
    if (typeof body.auto === 'boolean') draft.settings.auto = body.auto;
    if (body.autoSyncMs !== undefined) draft.settings.autoSyncMs = body.autoSyncMs;
    const next = normalizeState(draft);
    this.state.deviceName = next.deviceName;
    this.state.paused = next.paused;
    this.state.settings.auto = next.settings.auto;
    this.state.settings.autoSyncMs = next.settings.autoSyncMs;
    await this.store.save();
    this.applySchedule();
    return this.configPayload();
  }

  async updatePeer(body) {
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const port = Number(body.port);
    if (!isPrivateAddress(address)) throw new Error('peer address must be a LAN address');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('peer port is invalid');
    if (body.action === 'remove') {
      this.manualPeers = this.manualPeers.filter((entry) => !(entry.address === address && entry.port === port));
    } else {
      if (!this.manualPeers.some((entry) => entry.address === address && entry.port === port)) {
        this.manualPeers.push({ address, port });
      }
    }
    this.state.manualPeers = this.manualPeers.map((entry) => ({ ...entry }));
    await this.store.save();
    return this.configPayload();
  }

  async updateKey(body) {
    const mode = body.mode;
    if (mode === 'clear') {
      try {
        await this.ctx.credentials.deleteRecord(CREDENTIAL_KEY);
      } catch {
        // Already absent.
      }
      this.sharedKey = null;
    } else {
      let secret = '';
      if (mode === 'generate') secret = newSharedKey();
      else if (mode === 'set' && typeof body.value === 'string') secret = body.value.trim();
      if (secret.length < 16 || secret.length > 128) throw new Error('shared key must be 16 to 128 characters');
      await this.ctx.credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
        kind: 'api-key',
        key: secret,
      }));
      this.sharedKey = secret;
    }
    this.state.settings.keyEnabled = Boolean(this.sharedKey);
    await this.store.save();
    return { keyEnabled: Boolean(this.sharedKey), key: mode === 'generate' ? this.sharedKey : undefined };
  }

  registerWebRoute() {
    const handler = (request, response) => {
      void this.handleApi(request, response).catch((error) => {
        this.log('warn', 'local API failed', error);
        sendJson(response, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
      });
    };
    this.disposers.push(this.ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }));
  }

  async readApiBody(request, response) {
    const contentType = String(request.headers?.['content-type'] ?? '');
    if (contentType.length > 0 && !/^application\/json\b/i.test(contentType)) {
      sendJson(response, 415, { ok: false, error: 'unsupported-media-type' });
      return { ok: false };
    }
    try {
      return { ok: true, body: await readBody(request) };
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error?.code === 'body-too-large' ? 'body-too-large' : 'bad-json' });
      return { ok: false };
    }
  }

  async handleApi(request, response) {
    const rejection = this.ctx.connection.requestRejection(request);
    if (rejection) {
      sendJson(response, rejection, { ok: false, error: 'forbidden' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(API_PREFIX.length) || '/';
    const method = request.method ?? 'GET';

    if (method === 'GET' && route === '/status') {
      sendJson(response, 200, { ok: true, ...this.statusPayload() });
      return;
    }
    if (method === 'GET' && route === '/config') {
      sendJson(response, 200, { ok: true, ...this.configPayload() });
      return;
    }
    if (method === 'GET' && route === '/activity') {
      sendJson(response, 200, { ok: true, ...this.activityPayload() });
      return;
    }
    if (method === 'POST' && route === '/sync') {
      if (this.state.paused) {
        sendJson(response, 409, { ok: false, error: 'paused' });
        return;
      }
      const report = await this.engine.syncNow();
      if (report && report.busy) {
        sendJson(response, 202, { ok: true, busy: true });
        return;
      }
      sendJson(response, 200, { ok: true, last: summarizeReport(report) });
      return;
    }
    if (method === 'POST' && route === '/config') {
      const parsed = await this.readApiBody(request, response);
      if (!parsed.ok) return;
      try {
        const config = await this.updateConfig(parsed.body);
        sendJson(response, 200, { ok: true, ...config });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (method === 'POST' && route === '/peer') {
      const parsed = await this.readApiBody(request, response);
      if (!parsed.ok) return;
      try {
        const config = await this.updatePeer(parsed.body);
        sendJson(response, 200, { ok: true, ...config });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (method === 'POST' && route === '/key') {
      const parsed = await this.readApiBody(request, response);
      if (!parsed.ok) return;
      try {
        const result = await this.updateKey(parsed.body);
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not-found' });
  }

  registerTools() {
    const statusTool = {
      name: 'lan_sync_status',
      description:
        'Report LAN session sync state for this DeepSeek Harness: device name, LAN port, discovered peers, paused/auto settings, and the last sync result.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => this.statusPayload(),
    };
    const syncTool = {
      name: 'lan_sync_now',
      description:
        'Run one pull-only LAN session sync now: fetch sessions from discovered LAN peers and import only sessions this machine does not already have. Never pushes or overwrites.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => {
        if (this.state.paused) return { ok: false, error: 'paused', hint: 'Resume LAN session sync in Settings, then retry.' };
        const report = await this.engine.syncNow();
        if (report && report.busy) return { ok: true, busy: true };
        return { ok: true, last: summarizeReport(report) };
      },
    };
    this.disposers.push(this.ctx.tools.register(statusTool));
    this.disposers.push(this.ctx.tools.register(syncTool));
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.discoverer?.stop();
    this.discoverer = null;
    for (const dispose of this.disposers.splice(0, this.disposers.length)) {
      try {
        dispose();
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      await this.server?.close();
    } catch (error) {
      this.log('warn', 'could not close LAN server', error);
    }
    this.server = null;
    try {
      await this.store.save();
    } catch {
      // Nothing else to flush.
    }
  }
}

export function apply(ctx) {
  const service = new LanSessionSync(ctx);
  service.ready.catch((error) => {
    service.error = error;
    console.error(`${LOG_PREFIX} failed to start`, error);
  });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void service.stop();
    });
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      void service.stop();
    });
  }
}
