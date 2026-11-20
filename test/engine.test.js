import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../lib/engine.js';
import { defaultState, originKey, recordImport } from '../lib/state.js';

function engineFor(overrides = {}) {
  const state = overrides.state ?? defaultState();
  const peers = overrides.peers ?? [{ deviceId: 'device-b', address: '192.168.1.9', port: 47830, name: 'MacBook B' }];
  return createEngine({
    state,
    selfDeviceId: 'device-a',
    listPeers: () => peers,
    fetchCatalog: async () => ({ peer: { deviceId: 'device-b', name: 'MacBook B' }, items: [] }),
    fetchSession: async (peer, item) => ({ session: { id: item.id }, events: [], digest: 'x' }),
    importCandidate: async ({ item }) => ({ imported: true, localId: `session-${item.id}` }),
    ...overrides,
  });
}

test('engine imports only sessions that are missing locally', async () => {
  const state = defaultState();
  recordImport(state, originKey('device-b', 'session-known'), {
    localId: 'session-imported-before',
    deviceId: 'device-b',
    sessionId: 'session-known',
    digest: 'd',
    importedAt: 1,
  });
  const imported = [];
  const engine = engineFor({
    state,
    fetchCatalog: async () => ({
      peer: { deviceId: 'device-b', name: 'MacBook B' },
      items: [
        { id: 'session-known' },
        { id: 'session-new' },
        { id: 'session-from-self', importedFrom: { deviceId: 'device-a' } },
        { id: 'session-seeded', isSeeded: true },
      ],
    }),
    importCandidate: async ({ item }) => {
      imported.push(item.id);
      return { imported: true, localId: `session-${item.id}` };
    },
  });

  const report = await engine.syncNow();
  assert.deepEqual(imported, ['session-new']);
  assert.equal(report.imported, 1);
  assert.deepEqual(report.importedIds, ['session-session-new']);
  assert.equal(report.peers.length, 1);
  assert.equal(report.peers[0].ok, true);
  assert.equal(report.peers[0].items, 4);
  assert.equal(report.peers[0].skipped, 3);
  assert.deepEqual(
    report.skipped.map((entry) => entry.reason).sort(),
    ['provenance', 'restricted'],
  );
  assert.equal(engine.status().imported, 1);
  assert.equal(engine.getLastResult(), report);
});

test('engine reports one sync in flight and rejects concurrent runs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = engineFor({
    fetchCatalog: async () => {
      await gate;
      return { peer: { deviceId: 'device-b' }, items: [] };
    },
  });
  const first = engine.syncNow();
  const second = await engine.syncNow();
  assert.deepEqual(second, { busy: true });
  release();
  const report = await first;
  assert.equal(report.imported, 0);
});

test('engine records peer and import failures and keeps going', async () => {
  const engine = engineFor({
    peers: [
      { deviceId: 'device-b', address: '192.168.1.9', port: 47830 },
      { deviceId: 'device-c', address: '192.168.1.10', port: 47830 },
    ],
    fetchCatalog: async (peer) => {
      if (peer.deviceId === 'device-b') throw new Error('connection refused');
      return { peer: { deviceId: 'device-c' }, items: [{ id: 'session-1' }] };
    },
    fetchSession: async () => {
      throw new Error('checksum mismatch');
    },
  });
  const report = await engine.syncNow();
  assert.equal(report.peers.length, 2);
  assert.equal(report.errors.length, 2);
  assert.equal(report.errors[0].stage, 'peer');
  assert.equal(report.errors[1].stage, 'import');
  assert.match(report.errors[1].message, /checksum mismatch/);
});

test('engine is idle when the state is paused', async () => {
  const state = defaultState();
  state.paused = true;
  const engine = engineFor({ state });
  const report = await engine.syncNow();
  assert.equal(report.imported, 0);
  assert.equal(report.peers.length, 0);
});

test('engine never imports from a peer that identifies as this device', async () => {
  let fetched = false;
  const engine = engineFor({
    peers: [{ deviceId: 'device-a', address: '192.168.1.9', port: 47830, name: 'stale self entry' }],
    fetchCatalog: async () => ({
      peer: { deviceId: 'device-a', name: 'this device' },
      items: [{ id: 'session-local-1' }, { id: 'session-local-2' }],
    }),
    fetchSession: async () => {
      fetched = true;
      return {};
    },
  });

  const report = await engine.syncNow();
  assert.equal(fetched, false);
  assert.equal(report.imported, 0);
  assert.equal(report.peers.length, 1);
  assert.equal(report.peers[0].skipped, 2);
  assert.deepEqual(report.skipped, [{ reason: 'self', deviceId: 'device-a', sessionId: null }]);
});
