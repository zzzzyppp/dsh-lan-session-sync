import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  StateStore,
  countImports,
  defaultState,
  findImportByDigest,
  hasImport,
  normalizeState,
  originKey,
  recordImport,
} from '../lib/state.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'lan-sync-state-'));
}

test('StateStore creates defaults once and reloads the same device id', async () => {
  const dir = await tempDir();
  const store = new StateStore(dir);
  const state = await store.load();
  assert.equal(state.version, 1);
  assert.match(state.deviceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  assert.equal(state.paused, false);

  const file = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(file.deviceId, state.deviceId);

  const reloaded = new StateStore(dir);
  await reloaded.load();
  assert.equal(reloaded.state.deviceId, state.deviceId);
});

test('normalizeState clamps settings, ports and peers', () => {
  const state = normalizeState({
    version: 1,
    deviceId: 'device-a',
    deviceName: '  my\nmac  ',
    settings: { auto: false, autoSyncMs: 5, httpPort: 80, discoveryPort: 70000, keyEnabled: true },
    manualPeers: [
      { address: ' 192.168.1.9 ', port: 47830 },
      { address: '192.168.1.9', port: 47830 },
      { address: 'nope', port: 0 },
    ],
    imports: {
      'device-b/session-1': { localId: 'session-x', deviceId: 'device-b', sessionId: 'session-1', digest: 'd', importedAt: 12 },
      broken: { localId: '' },
    },
  });
  assert.equal(state.deviceName, 'my mac');
  assert.equal(state.settings.auto, false);
  assert.equal(state.settings.autoSyncMs, 10000);
  assert.equal(state.settings.httpPort, DEFAULT_SETTINGS.httpPort);
  assert.equal(state.settings.discoveryPort, DEFAULT_SETTINGS.discoveryPort);
  assert.equal(state.settings.keyEnabled, true);
  assert.deepEqual(state.manualPeers, [{ address: '192.168.1.9', port: 47830 }]);
  assert.equal(countImports(state), 1);
});

test('normalizeState rejects newer state versions', () => {
  assert.throws(() => normalizeState({ version: 99 }), /newer than supported/);
  assert.throws(() => normalizeState(null), /not an object/);
});

test('corrupt state is backed up and sync starts paused', async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'state.json'), '{ not json', 'utf8');
  const store = new StateStore(dir);
  const state = await store.load();
  assert.equal(state.paused, true);
  assert.ok(store.corruptBackup && store.corruptBackup.includes('.corrupt-'));
  const files = await readdir(dir);
  assert.equal(files.some((name) => name.includes('.corrupt-')), true);
  assert.equal(files.includes('state.json'), true);
});

test('import bookkeeping helpers stay consistent', () => {
  const state = defaultState();
  const key = originKey('device-b', 'session-1');
  assert.equal(hasImport(state, key), false);
  recordImport(state, key, {
    localId: 'session-x',
    deviceId: 'device-b',
    sessionId: 'session-1',
    digest: 'd',
    importedAt: 5,
    originDeviceId: 'device-a',
    originSessionId: 'session-original',
  });
  assert.equal(hasImport(state, key), true);
  assert.equal(findImportByDigest(state, 'd')?.localId, 'session-x');
  assert.equal(state.imports[key].originDeviceId, 'device-a');
  assert.equal(state.imports[key].originSessionId, 'session-original');
  recordImport(state, 'device-c/session-2', {
    localId: 'session-x',
    deviceId: 'device-c',
    sessionId: 'session-2',
    digest: 'd',
    importedAt: 6,
    alias: true,
  });
  assert.equal(findImportByDigest(state, 'd')?.sessionId, 'session-1');
  assert.equal(countImports(state), 2);

  const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(normalized.imports[key].originDeviceId, 'device-a');
  assert.equal(normalized.imports[key].originSessionId, 'session-original');
});
