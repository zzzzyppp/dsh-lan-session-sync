import { countImports, hasImport, originKey } from './state.js';

const MAX_REPORT_ENTRIES = 50;

function reasonCount(reason, entry) {
  return { reason, deviceId: entry.deviceId ?? null, sessionId: entry.sessionId ?? null };
}

/**
 * Pull-only sync engine. Walks peers, lists their sessions, and imports only
 * sessions that are missing locally. It never pushes or overwrites.
 */
export function createEngine(options) {
  const { state, listPeers, fetchCatalog, fetchSession, importCandidate, selfDeviceId, onResult } = options;
  const now = options.now ?? Date.now;
  let running = null;
  let lastResult = null;

  async function run() {
    const report = {
      startedAt: now(),
      finishedAt: 0,
      peers: [],
      imported: 0,
      importedIds: [],
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
