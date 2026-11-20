import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDigest } from '../lib/digest.js';
import { createPeerServer } from '../lib/server.js';
import {
  EXPORT_FORMAT,
  MAGIC_HEADER,
  TransferError,
  fetchPeerCatalog,
  fetchPeerSession,
  requestJson,
} from '../lib/transfer.js';

const HEADER = { version: 4, id: 'session-a', createdAt: 1000, cwd: '/Users/ypz/project', isSeeded: false };
const EVENTS = [
  { seq: 0, type: 'session/start' },
  { seq: 1, type: 'user/message', text: 'hello' },
];

function makeServer(overrides = {}) {
  const imports = [];
  const items = [
    {
      id: 'session-a',
      createdAt: 1000,
      cwd: '/Users/ypz/project',
      isSeeded: false,
      eventCount: EVENTS.length,
      sizeBytes: 100,
      updatedAt: 2,
    },
  ];
  const server = createPeerServer({
    getDevice: () => ({ id: 'device-b', name: 'MacBook B', platform: 'darwin' }),
    listItems: async () => items,
    exportSession: async (id) =>
      id === 'session-a' ? { header: HEADER, events: EVENTS, digest: contentDigest(EVENTS) } : null,
    importSession: async (input) => {
      imports.push(input);
      return { imported: true, localId: 'session-local' };
    },
    getKey: async () => null,
    ...overrides,
  });
  return { server, imports };
}

const peer = (port) => ({ address: '127.0.0.1', port });

test('peer server opens health and fences the session catalog', async (t) => {
  const { server } = makeServer();
  const port = await server.start(0);
  t.after(() => server.close());

  const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, protocol: 1 });

  const unprotected = await fetch(`http://127.0.0.1:${port}/v1/sessions`);
  assert.equal(unprotected.status, 401);

  const catalog = await fetchPeerCatalog(peer(port));
  assert.deepEqual(catalog.peer, { deviceId: 'device-b', name: 'MacBook B' });
  assert.equal(catalog.items.length, 1);

  const exported = await fetchPeerSession(peer(port), 'session-a');
  assert.equal(exported.digest, contentDigest(EVENTS));
  assert.deepEqual(exported.events, EVENTS);
  assert.deepEqual(exported.header, HEADER);

  await assert.rejects(fetchPeerSession(peer(port), 'session-missing'), (error) => {
    assert.ok(error instanceof TransferError);
    return error.code === 'session-not-found';
  });
});

test('peer server refuses a wrong shared key and accepts the right one', async (t) => {
  const { server } = makeServer({ getKey: async () => 'correct-horse' });
  const port = await server.start(0);
  t.after(() => server.close());

  await assert.rejects(fetchPeerCatalog(peer(port)), (error) => error.code === 'catalog-failed');
  await assert.rejects(fetchPeerCatalog(peer(port), { key: 'wrong' }), (error) => error.code === 'catalog-failed');
  const catalog = await fetchPeerCatalog(peer(port), { key: 'correct-horse' });
  assert.equal(catalog.items.length, 1);
});

test('peer server imports pushed sessions and maps import errors', async (t) => {
  const imports = [];
  const { server } = makeServer({
    importSession: async (input) => {
      imports.push(input);
      if (input.header?.id === 'session-bad') {
        const error = new Error('tampered');
        error.code = 'digest-mismatch';
        throw error;
      }
      return { imported: true, localId: 'session-local' };
    },
  });
  const port = await server.start(0);
  t.after(() => server.close());

  const push = (payload) =>
    requestJson(peer(port), {
      method: 'POST',
      path: '/v1/sessions',
      body: payload,
    });

  const good = await push({
    format: EXPORT_FORMAT,
    digest: contentDigest(EVENTS),
    header: HEADER,
    events: EVENTS,
  });
  assert.equal(good.status, 200);
  assert.equal(good.json.imported, true);
  assert.equal(imports.length, 1);

  const bad = await push({
    format: EXPORT_FORMAT,
    digest: contentDigest(EVENTS),
    header: { ...HEADER, id: 'session-bad' },
    events: EVENTS,
  });
  assert.equal(bad.status, 409);

  const wrongFormat = await push({ format: 'nope', header: HEADER, events: EVENTS });
  assert.equal(wrongFormat.status, 400);
});

test('peer server falls back to the next port when one is taken', async (t) => {
  const first = createPeerServer({
    getDevice: () => ({ id: 'a', name: 'A' }),
    listItems: async () => [],
    exportSession: async () => null,
    importSession: async () => ({ imported: false }),
    getKey: async () => null,
  });
  const second = createPeerServer({
    getDevice: () => ({ id: 'b', name: 'B' }),
    listItems: async () => [],
    exportSession: async () => null,
    importSession: async () => ({ imported: false }),
    getKey: async () => null,
  });
  const port = await first.start(0);
  t.after(() => first.close());
  t.after(() => second.close());
  const fallback = await second.start(port);
  assert.equal(fallback === port, false);
  const info = await requestJson({ address: '127.0.0.1', port: fallback }, { path: '/v1/info' });
  assert.equal(info.json.device.id, 'b');
});

test('requestJson refuses public peer addresses', async () => {
  await assert.rejects(requestJson({ address: '8.8.8.8', port: 47830 }, { path: '/v1/health' }), (error) => {
    return error instanceof TransferError && error.code === 'peer-not-private';
  });
});

test('peer server reports an oversized export as 413 instead of a phantom 404', async (t) => {
  const { server } = makeServer({
    exportSession: async () => ({ tooLarge: true, sizeBytes: 4096 }),
  });
  const port = await server.start(0);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/session-a`, {
    headers: { [MAGIC_HEADER]: '1' },
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: 'session-too-large', sizeBytes: 4096 });
  await assert.rejects(fetchPeerSession(peer(port), 'session-a'), (error) => {
    return error instanceof TransferError && error.code === 'session-too-large';
  });
});
