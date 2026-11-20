import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const HTTP_PORT = 47831;
const DISCOVERY_PORT = 47828;
const RPC_PORT = 47833;

function request(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        timeout: 2000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForStatus(attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await request(RPC_PORT, '/lan-session-sync/api/status');
      if (response.status === 200) return response.json;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('host service did not start listening in time');
}

test('host plugin starts, serves the local API and registers tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sync-host-'));
  const stateDir = path.join(home, 'lan-session-sync');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify(
      {
        version: 1,
        deviceId: 'device-test-1',
        deviceName: 'test device',
        settings: { auto: false, autoSyncMs: 30000, httpPort: HTTP_PORT, discoveryPort: DISCOVERY_PORT },
        manualPeers: [],
        imports: {},
      },
      null,
      2,
    ),
  );
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const registeredTools = [];
  const registeredRoutes = [];
  let disposeService = null;
  const workspace = {
    async attachSession() {
      throw new Error('not used');
    },
    async detachSession() {
      throw new Error('not used');
    },
  };
  const ctx = {
    credentials: {
      async readRecord() {
        return undefined;
      },
      async modifyRecord() {
        return { kind: 'api-key', key: 'x' };
      },
      async deleteRecord() {},
    },
    sessionPersistence: {
      async list() {
        return [];
      },
      async stat() {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      async open() {
        throw new Error('not used');
      },
    },
    sessions: {
      async prepare() {
        return {};
      },
    },
    workspaceRegistry: {
      list() {
        return [];
      },
      resolveByPath() {
        return null;
      },
      async create() {
        return workspace;
      },
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route);
        const server = http.createServer((req, res) => route.handler(req, res));
        server.listen(RPC_PORT, '127.0.0.1');
        return () => server.close();
      },
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
    tools: {
      register(definition) {
        registeredTools.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      disposeService = callback();
      return () => {};
    },
  };

  const { apply } = await import('../index.js');
  apply(ctx);

  try {
    const status = await waitForStatus();
    assert.equal(status.ok, true);
    assert.equal(status.device.id, 'device-test-1');
    assert.equal(status.service.running, true);
    assert.equal(status.device.name, 'test device');
    assert.equal(registeredRoutes.length, 1);
    assert.equal(registeredRoutes[0].path, '/lan-session-sync/api');
    assert.deepEqual(
      registeredTools.map((tool) => tool.name).sort(),
      ['lan_sync_now', 'lan_sync_status'],
    );

    const renamed = await request(RPC_PORT, '/lan-session-sync/api/config', {
      method: 'POST',
      body: { deviceName: 'renamed device' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.deviceName, 'renamed device');
    assert.equal(renamed.json.deviceName, 'renamed device');

    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.equal(saved.deviceName, 'renamed device');

    const sync = await request(RPC_PORT, '/lan-session-sync/api/sync', { method: 'POST' });
    assert.equal(sync.status, 200);
    assert.equal(sync.json.ok, true);
    assert.equal(sync.json.last.imported, 0);

    const invalidPeer = await request(RPC_PORT, '/lan-session-sync/api/peer', {
      method: 'POST',
      body: { action: 'add', address: '8.8.8.8', port: 47830 },
    });
    assert.equal(invalidPeer.status, 400);

    const generated = await request(RPC_PORT, '/lan-session-sync/api/key', {
      method: 'POST',
      body: { mode: 'generate' },
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.json.keyEnabled, true);
    assert.equal(typeof generated.json.key, 'string');
    assert.ok(generated.json.key.length >= 16);
    const keyedStatus = await request(RPC_PORT, '/lan-session-sync/api/status');
    assert.equal(keyedStatus.json.service.keyEnabled, true);

    const wrongType = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: RPC_PORT,
          path: '/lan-session-sync/api/config',
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'content-length': 2 },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(wrongType, 415);
  } finally {
    if (typeof disposeService === 'function') disposeService();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
