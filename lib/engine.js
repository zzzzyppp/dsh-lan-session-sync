import { countImports, hasImport, originKey } from './state.js';

const MAX_REPORT_ENTRIES = 50;

function reasonCount(reason, entry) {
  return { reason, deviceId: entry.deviceId ?? null, sessionId: entry.sessionId ?? null };
}

const MAX_PUSH_ITEMS_PER_PEER = 3;
const MAX_PUSH_ITEM_BYTES = 96 * 1024 * 1024;

function peerHasSession(peerItems, item) {
  for (const other of peerItems) {
    if (!other || typeof other.id !== 'string') continue;
    if (other.id === item.id) return true;
    if (Number.isSafeInteger(other.createdAt) && other.createdAt === item.createdAt) return true;
  }
  return false;
}

/**
 * Mesh sync engine. Each device is an equal peer:
 *  - pull: import sessions the peer has and this device is missing;
 *  - push: send sessions this device has and the peer is missing, so a session
 *    can travel from any device to any other even when reachability between two
 *    devices is one-way (A can reach B but B cannot reach A), and through a
 *    third device (relay) without central coordination.
 */
export function createEngine(options) {
  const { state, listPeers, fetchCatalog, fetchSession, importCandidate, selfDeviceId, onResult } = options;
  const pushSession = typeof options.pushSession === 'function' ? options.pushSession : null;
  const listLocalSessions = typeof options.listLocalSessions === 'function' ? options.listLocalSessions : null;
  const now = options.now ?? Date.now;
  let running = null;
  let lastResult = null;
  let localItemsCache = null;

  async function localItems() {
    if (!listLocalSessions) return [];
    if (!localItemsCache) {
      localItemsCache = Promise.resolve()
        .then(() => listLocalSessions())
        .then((items) => (Array.isArray(items) ? items : []))
        .catch(() => []);
    }
    return localItemsCache;
  }

  async function pushMissing(peerId, peer, items, peerReport, report) {
    if (state.settings?.push === false || !pushSession || !peerId) return;
    const local = await localItems();
    const candidates = local
      .filter((item) => item && typeof item.id === 'string' && item.id.length > 0)
      .filter((item) => item.isSeeded !== true && !item.parentSession)
      .filter((item) => Number.isSafeInteger(item.createdAt))
      .filter((item) => !(Number.isFinite(item.sizeBytes) && item.sizeBytes > MAX_PUSH_ITEM_BYTES))
      .filter((item) => !(item.importedFrom && item.importedFrom.deviceId === peerId))
      .filter((item) => !peerHasSession(items, item))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PUSH_ITEMS_PER_PEER);
    for (const item of candidates) {
      if (state.paused) break;
      try {
        const result = await pushSession(peer, item);
        if (result?.pushed) {
          peerReport.pushed += 1;
          report.pushed += 1;
          report.pushedIds.push(item.id);
        }
      } catch (error) {
        if (report.errors.length < MAX_REPORT_ENTRIES) {
          report.errors.push({
            stage: 'push',
            deviceId: peerId,
            sessionId: item.id,
            code: error?.code ?? error?.name ?? 'error',
            message: String(error?.message ?? error),
          });
        }
      }
    }
  }

  async function run() {
    localItemsCache = null;
    const report = {
      startedAt: now(),
      finishedAt: 0,
      peers: [],
      imported: 0,
      importedIds: [],
      pushed: 0,
      pushedIds: [],
      skipped: [],
      errors: [],
    };
    const peers = typeof listPeers === 'function' ? listPeers() : [];
    const syncedDevices = new Set();
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (state.paused) break;
      let peerId = typeof peer.deviceId === 'string' && peer.deviceId.length > 0 ? peer.deviceId : null;
      if (peerId && syncedDevices.has(peerId)) {
        // Another address for a device that was already synced in this run.
        if (report.skipped.length < MAX_REPORT_ENTRIES) {
          report.skipped.push({ reason: 'duplicate-peer', deviceId: peerId, sessionId: null });
        }
        report.peers.push({
          deviceId: peerId,
          address: peer.address ?? null,
          port: peer.port ?? null,
          name: peer.name ?? null,
          ok: true,
          items: 0,
          imported: 0,
          pushed: 0,
          skipped: 0,
        });
        continue;
      }
      const peerReport = {
        deviceId: peerId,
        address: peer.address ?? null,
        port: peer.port ?? null,
        name: peer.name ?? null,
        ok: false,
        items: 0,
        imported: 0,
        pushed: 0,
        skipped: 0,
      };
      try {
        const catalog = await fetchCatalog(peer);
        if (catalog?.peer?.deviceId) {
          peerId = catalog.peer.deviceId;
          peerReport.deviceId = peerId;
        }
        if (catalog?.peer?.name && !peerReport.name) peerReport.name = catalog.peer.name;
        const items = Array.isArray(catalog?.items) ? catalog.items : [];
        peerReport.items = items.length;
        if (peerId === selfDeviceId) {
          // A peer that identifies itself as this device is our own HTTP server
          // reached through a stale discovery entry. Importing from it would
          // copy every local session back onto itself.
          peerReport.skipped += items.length;
          peerReport.ok = true;
          if (report.skipped.length < MAX_REPORT_ENTRIES) {
            report.skipped.push({ reason: 'self', deviceId: selfDeviceId, sessionId: null });
          }
          report.peers.push(peerReport);
          continue;
        }
        if (peerId && syncedDevices.has(peerId)) {
          peerReport.skipped += items.length;
          peerReport.ok = true;
          if (report.skipped.length < MAX_REPORT_ENTRIES) {
            report.skipped.push({ reason: 'duplicate-peer', deviceId: peerId, sessionId: null });
          }
          report.peers.push(peerReport);
          continue;
        }
        if (peerId) syncedDevices.add(peerId);
        for (const item of items) {
          if (state.paused) break;
          if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
          if (item.isSeeded === true || item.parentSession) {
            peerReport.skipped += 1;
            if (report.skipped.length < MAX_REPORT_ENTRIES) report.skipped.push(reasonCount('restricted', { ...peerReport, sessionId: item.id }));
            continue;
          }
          if (item.importedFrom && item.importedFrom.deviceId === selfDeviceId) {
            peerReport.skipped += 1;
            if (report.skipped.length < MAX_REPORT_ENTRIES) report.skipped.push(reasonCount('provenance', { ...peerReport, sessionId: item.id }));
            continue;
          }
          if (!peerId) {
            report.errors.push({ stage: 'peer', message: 'peer did not report a device id', address: peer.address ?? null });
            break;
          }
          if (hasImport(state, originKey(peerId, item.id))) {
            peerReport.skipped += 1;
            continue;
          }
          try {
            const payload = await fetchSession(peer, item);
            const result = await importCandidate({
              peer: { deviceId: peerId, name: peer.name ?? null, address: peer.address ?? null, port: peer.port ?? null },
              item,
              payload,
            });
            if (result?.imported) {
              peerReport.imported += 1;
              report.imported += 1;
              if (typeof result.localId === 'string') report.importedIds.push(result.localId);
              if (result.attachError && report.errors.length < MAX_REPORT_ENTRIES) {
                report.errors.push({
                  stage: 'attach',
                  deviceId: peerId,
                  sessionId: item.id,
                  localId: result.localId ?? null,
                  code: 'attach-failed',
                  message: String(result.attachError),
                });
              }
            } else {
              peerReport.skipped += 1;
              if (report.skipped.length < MAX_REPORT_ENTRIES) {
                report.skipped.push({
                  reason: result?.reason ?? 'skipped',
                  deviceId: peerId,
                  sessionId: item.id,
                });
              }
            }
          } catch (error) {
            if (report.errors.length < MAX_REPORT_ENTRIES) {
              report.errors.push({
                stage: 'import',
                deviceId: peerId,
                sessionId: item.id,
                code: error?.code ?? error?.name ?? 'error',
                message: String(error?.message ?? error),
              });
            }
          }
        }
        await pushMissing(peerId, peer, items, peerReport, report);
        peerReport.ok = true;
      } catch (error) {
        if (report.errors.length < MAX_REPORT_ENTRIES) {
          report.errors.push({
            stage: 'peer',
            deviceId: peerId,
            address: peer.address ?? null,
            port: peer.port ?? null,
            code: error?.code ?? error?.name ?? 'error',
            message: String(error?.message ?? error),
          });
        }
      }
      report.peers.push(peerReport);
    }
    report.finishedAt = now();
    lastResult = report;
    if (typeof onResult === 'function') {
      try {
        onResult(report);
      } catch {
        // Reporting failures must never break a sync run.
      }
    }
    return report;
  }

  function syncNow() {
    if (running) return Promise.resolve({ busy: true });
    running = run();
    const finish = () => {
      running = null;
    };
    running.then(finish, finish);
    return running;
  }

  return {
    syncNow,
    getLastResult: () => lastResult,
    isRunning: () => Boolean(running),
    status: () => ({
      running: Boolean(running),
      paused: state.paused === true,
      imported: countImports(state),
      last: lastResult,
    }),
  };
}
