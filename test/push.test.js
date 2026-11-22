import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDigest } from '../lib/digest.js';
import { createEngine } from '../lib/engine.js';
import { createPeerServer } from '../lib/server.js';
import { defaultState } from '../lib/state.js';
import { EXPORT_FORMAT, MAGIC_HEADER, TransferError, pushPeerSession } from '../lib/transfer.js';

function engineWith(overrides = {}) {
  const state = overrides.state ?? defaultState();
  const peers = overrides.peers ?? [{ deviceId: 'device-b', address: '192.168.1.9', port: 47830, name: 'MacBook B' }];
  return createEngine({
    state,
    selfDeviceId: 'device-a',
    listPeers: () => peers,
    fetchCatalog: async () => ({ peer: { deviceId: 'device-b', name: 'MacBook B' }, items: [] }),
    fetchSession: async () => {
      throw new Error('push-only test must not fetch peer sessions');
    },
    importCandidate: async () => ({ imported: false }),
    listLocalSessions: async () => [],
    pushSession: async () => ({ pushed: true }),
    ...overrides,
  });
}

test('engine pushes local sessions the peer does not have', async () => {
  const pushed = [];
  const engine = engineWith({
    listLocalSessions: async () => [
      { id: 'session-local-new', createdAt: 3000, cwd: '/Users/ypz/project', sizeBytes: 100 },
      { id: 'session-local-shared', createdAt: 2000, cwd: '/Users/ypz/project', sizeBytes: 100 },
      { id: 'session-seeded', createdAt: 4000, cwd: '/Users/ypz/project', isSeeded: true },
    ],
    fetchCatalog: async () => ({
      peer: { deviceId: 'device-b', name: 'MacBook B' },
      items: [{ id: 'session-peer-own', createdAt: 2000, cwd: '/Users/ypz/project' }],
    }),
    pushSession: async (peer, item) => {
      pushed.push(item.id);
      return { pushed: true, imported: true };
    },
  });

  const report = await engine.syncNow();
  assert.deepEqual(pushed, ['session-local-new']);
  assert.equal(report.pushed, 1);
  assert.deepEqual(report.pushedIds, ['session-local-new']);
  assert.equal(report.peers[0].pushed, 1);
});

test('engine never pushes a session back to the device it came from', async () => {
  const pushed = [];
  const engine = engineWith({
    listLocalSessions: async () => [
      { id: 'session-from-b', createdAt: 2000, importedFrom: { deviceId: 'device-b', sessionId: 'session-b-original' } },
    ],
    pushSession: async (peer, item) => {
      pushed.push(item.id);
      return { pushed: true };
    },
  });

  const report = await engine.syncNow();
  assert.deepEqual(pushed, []);
  assert.equal(report.pushed, 0);
});

test('engine skips pushing when the push setting is off', async () => {
  const state = defaultState();
  state.settings.push = false;
  let called = false;
  const engine = engineWith({
    state,
    listLocalSessions: async () => [{ id: 'session-local', createdAt: 2000 }],
    pushSession: async () => {
      called = true;
      return { pushed: true };
    },
  });

  const report = await engine.syncNow();
  assert.equal(called, false);
  assert.equal(report.pushed, 0);
});

test('engine records a push failure without failing the run', async () => {
  const engine = engineWith({
    listLocalSessions: async () => [{ id: 'session-local', createdAt: 2000, sizeBytes: 10 }],
    pushSession: async () => {
      throw new TransferError('push-failed', 'peer refused');
    },
  });

  const report = await engine.syncNow();
  assert.equal(report.pushed, 0);
  assert.equal(report.peers[0].ok, true);
  const pushError = report.errors.find((entry) => entry.stage === 'push');
  assert.equal(pushError.code, 'push-failed');
});

test('pushPeerSession delivers sender identity and provenance to the peer', async (t) => {
  const header = { version: 4, id: 'session-a', createdAt: 1000, cwd: '/Users/ypz/project', isSeeded: false };
  const events = [{ seq: 0, type: 'user/message' }];
  const imports = [];
  const server = createPeerServer({
    getDevice: () => ({ id: 'device-b', name: 'MacBook B', platform: 'darwin' }),
    listItems: async () => [],
    exportSession: async () => null,
    importSession: async (input) => {
      imports.push(input);
      return { imported: false, reason: 'already-local', localId: 'session-a' };
    },
    getKey: async () => null,
  });
  const port = await server.start(0);
  t.after(() => server.close());

  const response = await pushPeerSession(
    { address: '127.0.0.1', port },
    {
      format: EXPORT_FORMAT,
      digest: contentDigest(events),
      header,
      events,
      sourceSessionId: 'session-a',
      from: { deviceId: 'device-a', name: 'Mac mini' },
      provenance: { deviceId: 'device-c', sessionId: 'session-origin' },
    },
    { headers: { [MAGIC_HEADER]: '1' } },
  );

  assert.equal(response.ok, true);
  assert.equal(response.imported, false);
  assert.equal(imports[0].from.deviceId, 'device-a');
  assert.deepEqual(imports[0].provenance, { deviceId: 'device-c', sessionId: 'session-origin' });
  assert.equal(imports[0].sourceSessionId, 'session-a');
});
