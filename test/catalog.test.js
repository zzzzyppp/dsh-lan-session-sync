import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CATALOG_ITEMS, MAX_SESSION_BYTES, buildCatalog, filterSnapshot, withProvenance } from '../lib/catalog.js';

function snapshot(overrides = {}) {
  return {
    header: {
      version: 4,
      id: 'session-a',
      createdAt: 1000,
      cwd: '/Users/ypz/project',
      isSeeded: false,
    },
    formatStatus: 'current',
    revision: 7,
    eventCount: 3,
    sizeBytes: 1024,
    ...overrides,
  };
}

test('filterSnapshot accepts a normal finished session', () => {
  const result = filterSnapshot(snapshot());
  assert.equal(result.ok, true);
  assert.deepEqual(result.item, {
    id: 'session-a',
    createdAt: 1000,
    cwd: '/Users/ypz/project',
    isSeeded: false,
    eventCount: 3,
    sizeBytes: 1024,
    updatedAt: 7,
  });
});

test('filterSnapshot accepts a snapshot without eventCount (list/stat omit it)', () => {
  const result = filterSnapshot(snapshot({ eventCount: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.item.eventCount, null);
  assert.equal(result.item.id, 'session-a');
});

test('filterSnapshot keeps sessions whose compressed log exceeds the old 32 MiB ceiling', () => {
  // Regression: a 15 MB zstd log expands to ~53 MB of event JSON. The catalog
  // only sees the compressed size, so the export ceiling must not be mirrored
  // back into a 32 MiB admission check that hides the session from peers.
  const result = filterSnapshot(snapshot({ eventCount: undefined, sizeBytes: 40 * 1024 * 1024 }));
  assert.equal(result.ok, true);
  assert.equal(result.item.sizeBytes, 40 * 1024 * 1024);
  assert.ok(MAX_SESSION_BYTES >= 128 * 1024 * 1024);
});

test('filterSnapshot refuses sessions that cannot be replayed locally', () => {
  const cases = [
    [snapshot({ header: { ...snapshot().header, id: undefined } }), 'no-id'],
    [snapshot({ formatStatus: 'migration-required' }), 'migration-required'],
    [snapshot({ header: { ...snapshot().header, version: 3 } }), 'unsupported-version'],
    [snapshot({ header: { ...snapshot().header, isSeeded: true } }), 'seeded'],
    [snapshot({ header: { ...snapshot().header, origin: 'subagent' } }), 'subagent'],
    [snapshot({ header: { ...snapshot().header, delegationDepth: 2 } }), 'delegated'],
    [snapshot({ header: { ...snapshot().header, cwd: undefined } }), 'no-cwd'],
    [snapshot({ eventCount: 0 }), 'empty'],
    [snapshot({ sizeBytes: MAX_SESSION_BYTES + 1 }), 'too-large'],
    [snapshot({ header: { ...snapshot().header, createdAt: undefined } }), 'no-created-at'],
    [undefined, 'no-snapshot'],
  ];
  for (const [value, reason] of cases) {
    const result = filterSnapshot(value);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('buildCatalog returns newest first and obeys the cap', () => {
  const snapshots = [];
  for (let index = 0; index < MAX_CATALOG_ITEMS + 5; index += 1) {
    snapshots.push(
      snapshot({
        header: { ...snapshot().header, id: `session-${index}`, createdAt: 1000 + (index % 50) },
      }),
    );
  }
  const items = buildCatalog(snapshots);
  assert.equal(items.length, MAX_CATALOG_ITEMS);
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(items[index - 1].createdAt >= items[index].createdAt);
  }
  assert.equal(buildCatalog(snapshots, { limit: 40 }).length, 40);
});

test('withProvenance exposes the root origin and leaves local sessions untouched', () => {
  const imports = new Map([
    ['session-imported', { localId: 'session-imported', deviceId: 'device-b', sessionId: 'session-b-1', originDeviceId: 'device-a', originSessionId: 'session-a-1' }],
    ['session-legacy', { localId: 'session-legacy', deviceId: 'device-b', sessionId: 'session-b-2' }],
  ]);
  const decorated = withProvenance(
    [{ id: 'session-local' }, { id: 'session-imported' }, { id: 'session-legacy' }],
    imports,
  );
  assert.equal(decorated[0].importedFrom, undefined);
  assert.deepEqual(decorated[1].importedFrom, { deviceId: 'device-a', sessionId: 'session-a-1' });
  assert.deepEqual(decorated[2].importedFrom, { deviceId: 'device-b', sessionId: 'session-b-2' });
  assert.deepEqual(withProvenance(null, imports), []);
});
