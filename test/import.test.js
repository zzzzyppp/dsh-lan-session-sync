import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contentDigest, localSessionIdForDigest } from '../lib/digest.js';
import { SyncImportError, importSession } from '../lib/import.js';
import { defaultState, hasImport, originKey, recordImport } from '../lib/state.js';

const EVENTS = [
  { seq: 0, type: 'session/start', version: 4 },
  { seq: 1, type: 'user/message', text: 'hello from the other mac' },
];
const HEADER = { version: 4, id: 'session-remote', createdAt: 1234, cwd: '/definitely/not/here', isSeeded: false };

function fakes(options = {}) {
  const calls = { created: [], appended: [], flushed: 0, closed: 0, prepared: [] };
  const persistence = {
    async stat() {
      if (options.statExists) return { header: { id: 'session-x' } };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async create(header) {
      calls.created.push(header);
      return {
        id: header.id,
        async append(events) {
          calls.appended.push(events);
          if (options.appendError) throw options.appendError;
        },
        async flush() {
          calls.flushed += 1;
        },
        async close() {
          calls.closed += 1;
        },
      };
    },
  };
  const sessions = {
    prepare(id, prepareOptions) {
      calls.prepared.push({ id, options: prepareOptions });
      if (options.prepareError) throw options.prepareError;
      return { id };
    },
  };
  const workspaces = new Map();
  const workspaceRegistry = {
    resolveByPath(target) {
      return workspaces.get(target) ?? null;
    },
    create(target, title) {
      const workspace = {
        path: target,
        title,
        attached: [],
        async attachSession(id) {
          workspace.attached.push(id);
          if (options.attachError) throw options.attachError;
        },
      };
      workspaces.set(target, workspace);
      return workspace;
    },
  };
  return { calls, persistence, sessions, workspaceRegistry, workspaces };
}

async function landing() {
  return mkdtemp(path.join(os.tmpdir(), 'lan-sync-landing-'));
}

function baseOptions(extra) {
  const digest = contentDigest(EVENTS);
  return {
    sourceDeviceId: 'device-b',
    sourceSessionId: 'session-remote',
    sourceHeader: HEADER,
    events: EVENTS,
    digest,
    state: defaultState(),
    ...extra,
  };
}

test('importSession writes a new local session and attaches it', async () => {
  const { calls, persistence, sessions, workspaceRegistry, workspaces } = fakes();
  const cwd = await landing();
  const options = baseOptions({ persistence, sessions, workspaceRegistry, landingDir: cwd, now: 999 });
  const result = await importSession(options);

  const digest = contentDigest(EVENTS);
  const expectedId = localSessionIdForDigest(digest);
  assert.equal(result.imported, true);
  assert.equal(result.localId, expectedId);
  assert.equal(result.cwd, cwd);
  assert.equal(result.attached, true);
  assert.equal(result.attachError, null);
  assert.equal(result.eventCount, 2);

  assert.deepEqual(calls.created, [{ version: 4, id: expectedId, createdAt: 1234, cwd, isSeeded: false }]);
  assert.deepEqual(calls.appended, [EVENTS]);
  assert.equal(calls.flushed, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.prepared.length, 1);
  assert.equal(calls.prepared[0].id, expectedId);
  assert.deepEqual(calls.prepared[0].options.seed, EVENTS);
  assert.equal(calls.prepared[0].options.inheritedEventCount, 0);
  assert.equal(calls.prepared[0].options.eventState, 'detached');
  assert.equal(workspaces.get(cwd).attached[0], expectedId);
  assert.equal(hasImport(options.state, originKey('device-b', 'session-remote')), true);
  const record = options.state.imports[originKey('device-b', 'session-remote')];
  assert.equal(record.originDeviceId, 'device-b');
  assert.equal(record.originSessionId, 'session-remote');
});

test('importSession keeps the root provenance of a re-imported session', async () => {
  const { persistence, sessions, workspaceRegistry } = fakes();
  const options = baseOptions({
    persistence,
    sessions,
    workspaceRegistry,
    landingDir: await landing(),
    provenance: { deviceId: 'device-a', sessionId: 'session-original' },
  });
  const result = await importSession(options);
  assert.equal(result.imported, true);
  const record = options.state.imports[originKey('device-b', 'session-remote')];
  assert.equal(record.originDeviceId, 'device-a');
  assert.equal(record.originSessionId, 'session-original');
});

test('importSession refuses a session whose root provenance is this device', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  const result = await importSession(
    baseOptions({
      persistence,
      sessions,
      workspaceRegistry,
      landingDir: await landing(),
      provenance: { deviceId: 'device-self', sessionId: 'session-remote' },
      selfDeviceId: 'device-self',
    }),
  );
  assert.deepEqual(result, { imported: false, reason: 'provenance' });
  assert.equal(calls.created.length, 0);
});

test('importSession skips an origin that was already imported', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  const options = baseOptions({ persistence, sessions, workspaceRegistry, landingDir: await landing() });
  recordImport(options.state, originKey('device-b', 'session-remote'), {
    localId: 'session-old',
    deviceId: 'device-b',
    sessionId: 'session-remote',
    digest: 'd',
    importedAt: 1,
  });
  const result = await importSession(options);
  assert.deepEqual(result, { imported: false, reason: 'known-origin' });
  assert.equal(calls.created.length, 0);
});

test('importSession aliases identical content under a different origin', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  const options = baseOptions({ persistence, sessions, workspaceRegistry, landingDir: await landing() });
  const existingId = localSessionIdForDigest(contentDigest(EVENTS));
  recordImport(options.state, originKey('device-c', 'session-other'), {
    localId: existingId,
    deviceId: 'device-c',
    sessionId: 'session-other',
    digest: contentDigest(EVENTS),
    importedAt: 1,
  });
  const result = await importSession(options);
  assert.equal(result.imported, false);
  assert.equal(result.reason, 'already-imported');
  assert.equal(result.localId, existingId);
  assert.equal(calls.created.length, 0);
});

test('importSession skips a local session that already exists', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes({ statExists: true });
  const result = await importSession(
    baseOptions({ persistence, sessions, workspaceRegistry, landingDir: await landing() }),
  );
  assert.equal(result.imported, false);
  assert.equal(result.reason, 'already-present');
  assert.equal(calls.created.length, 0);
});

test('importSession keeps a source cwd that exists under an allowed prefix', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'lan-sync-cwd-'));
  const { persistence, sessions, workspaceRegistry } = fakes();
  const result = await importSession(
    baseOptions({
      persistence,
      sessions,
      workspaceRegistry,
      landingDir: await landing(),
      sourceHeader: { ...HEADER, cwd: sourceDir },
      prefixes: [os.tmpdir()],
    }),
  );
  assert.equal(result.imported, true);
  assert.equal(result.cwd, sourceDir);
});

test('importSession rejects tampered content, bad events and failed validation', async () => {
  const { persistence, sessions, workspaceRegistry } = fakes();
  const common = { persistence, sessions, workspaceRegistry, landingDir: await landing() };

  await assert.rejects(
    importSession(baseOptions({ ...common, digest: 'f'.repeat(64) })),
    (error) => error instanceof SyncImportError && error.code === 'digest-mismatch',
  );
  await assert.rejects(
    importSession(baseOptions({ ...common, events: [{ seq: 1, type: 'session/start' }], digest: contentDigest([{ seq: 1, type: 'session/start' }]) })),
    (error) => error instanceof SyncImportError && error.code === 'invalid-session',
  );

  const failing = fakes({ prepareError: new Error('host said no') });
  await assert.rejects(
    importSession(
      baseOptions({ persistence: failing.persistence, sessions: failing.sessions, workspaceRegistry: failing.workspaceRegistry, landingDir: await landing() }),
    ),
    (error) => error instanceof SyncImportError && error.code === 'prepare-failed',
  );
  assert.equal(failing.calls.created.length, 0);
});

test('importSession reports attach failures without failing the import', async () => {
  const { persistence, sessions, workspaceRegistry } = fakes({ attachError: new Error('workspace busy') });
  const result = await importSession(
    baseOptions({ persistence, sessions, workspaceRegistry, landingDir: await landing() }),
  );
  assert.equal(result.imported, true);
  assert.equal(result.attached, false);
  assert.match(result.attachError, /workspace busy/);
});

test('importSession treats a peer copy of a local session as already-local', async () => {
  const created = [];
  const persistence = {
    async stat(id) {
      if (id === 'session-remote') return { header: { id: 'session-remote', createdAt: 1234 } };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async create(header) {
      created.push(header);
      throw new Error('must not create');
    },
  };
  const options = baseOptions({ persistence, landingDir: await landing(), now: 77 });
  const result = await importSession(options);

  assert.equal(result.imported, false);
  assert.equal(result.reason, 'already-local');
  assert.equal(result.localId, 'session-remote');
  assert.equal(created.length, 0);
  const key = originKey('device-b', 'session-remote');
  assert.equal(hasImport(options.state, key), true);
  assert.equal(options.state.imports[key].alias, true);
  assert.equal(options.state.imports[key].localId, 'session-remote');
});

test('importSession still imports when a same-id local session has a different creation time', async () => {
  const { persistence, sessions, workspaceRegistry } = fakes();
  const originalStat = persistence.stat;
  persistence.stat = async (id) => {
    if (id === 'session-remote') return { header: { id: 'session-remote', createdAt: 999 } };
    return originalStat(id);
  };
  const options = baseOptions({
    persistence,
    sessions,
    workspaceRegistry,
    landingDir: await landing(),
    now: 78,
  });
  const result = await importSession(options);

  assert.equal(result.imported, true);
  assert.equal(result.localId, localSessionIdForDigest(contentDigest(EVENTS)));
});

test('importSession rewrites delivery markers to the imported session id', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { text: 'hi' } },
    {
      seq: 1,
      type: 'session-log-deepseek/delivery-accepted',
      data: { sessionId: 'session-remote', sessionFormatVersion: 4, throughSeq: 0 },
    },
  ];
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  const cwd = await landing();
  const result = await importSession({
    ...baseOptions({ persistence, sessions, workspaceRegistry, landingDir: cwd, now: 999 }),
    events,
    digest: contentDigest(events),
  });

  assert.equal(result.imported, true);
  const appended = calls.appended[0];
  assert.equal(appended.length, 2);
  assert.deepEqual(appended[0], events[0]);
  assert.equal(appended[1].data.sessionId, result.localId);
  assert.equal(appended[1].data.sessionFormatVersion, 4);
  assert.equal(appended[1].data.throughSeq, 0);
  assert.equal(calls.prepared[0].options.seed[1].data.sessionId, result.localId);
});

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

test('importSession imports when a same-id local log is not attached to any workspace', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  persistence.stat = async (id) => {
    if (id === 'session-remote') return { header: { id: 'session-remote', createdAt: 1234 } };
    throw enoent();
  };
  workspaceRegistry.list = async () => [];
  const cwd = await landing();
  const result = await importSession({
    ...baseOptions({ persistence, sessions, workspaceRegistry, landingDir: cwd, now: 999 }),
  });
  assert.equal(result.imported, true);
  assert.equal(calls.created.length, 1);
});

test('importSession aliases a same-id local log that is already visible', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  persistence.stat = async (id) => {
    if (id === 'session-remote') return { header: { id: 'session-remote', createdAt: 1234 } };
    throw enoent();
  };
  workspaceRegistry.list = async () => [{ sessionIds: ['session-remote'] }];
  const cwd = await landing();
  const result = await importSession({
    ...baseOptions({ persistence, sessions, workspaceRegistry, landingDir: cwd, now: 999 }),
  });
  assert.equal(result.imported, false);
  assert.equal(result.reason, 'already-local');
  assert.equal(calls.created.length, 0);
});

test('importSession aliases an attached session with the same creation time', async () => {
  const { calls, persistence, sessions, workspaceRegistry } = fakes();
  const existingId = 'session-local-copy';
  persistence.list = async () => [
    { header: { version: 4, id: existingId, createdAt: HEADER.createdAt, cwd: HEADER.cwd } },
  ];
  workspaceRegistry.list = () => [{ sessionIds: [existingId] }];
  const cwd = await landing();
  const options = baseOptions({ persistence, sessions, workspaceRegistry, landingDir: cwd, now: 999 });

  const result = await importSession(options);

  assert.equal(result.imported, false);
  assert.equal(result.reason, 'duplicate-created-at');
  assert.equal(result.localId, existingId);
  assert.equal(calls.created.length, 0);
  const record = options.state.imports[originKey('device-b', 'session-remote')];
  assert.equal(record.alias, true);
  assert.equal(record.localId, existingId);
});
