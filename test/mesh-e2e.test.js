import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerServer } from '../lib/server.js';
import { createMesh } from '../lib/mesh.js';
import { scanSet, applyRemoteFile } from '../lib/filesync.js';
import { fetchManifest, fetchSetFile, pushSetFile } from '../lib/transfer.js';

async function makeNode(id, root) {
  const set = { id: 'sessions', root, mode: 'append', include: null, exclude: null, deletesEnabled: false };
  const state = {
    deviceId: id,
    settings: { push: true },
    imports: {},
    indexes: {},
    journals: {},
    tombstones: [],
    aliases: {},
  };
  const server = createPeerServer({
    getDevice: () => ({ id, name: id, platform: 'test' }),
    listItems: async () => [],
    exportSession: async () => null,
    importSession: async () => ({ imported: false }),
    getManifest: async () => {
      const index = await scanSet(set);
      const entries = {};
      for (const [rel, entry] of Object.entries(index)) {
        entries[rel] = { s: entry.s, m: entry.m, h: entry.h, ...(entry.meta ? { meta: entry.meta } : {}) };
      }
      return { sessions: { entries, deletes: {} } };
    },
    readSetFile: async (setId, rel) => {
      if (setId !== 'sessions' || rel.includes('..')) return null;
      const data = await readFile(join(root, rel)).catch(() => null);
      return data ? { data } : null;
    },
    applySetFile: async ({ setId, rel, data, peerAddress }) => {
      const index = await scanSet(set);
      return await applyRemoteFile({
        set,
        rel,
        data,
        entry: { h: null, s: data.length, m: Date.now() },
        peer: peerAddress,
        localEntry: index[rel] ?? null,
        base: null,
        pushMode: true,
      });
    },
    getKey: () => null,
  });
  const port = await server.start(0);
  return { id, set, root, state, server, port };
}

function makeMesh(node, peers) {
  return createMesh({
    state: node.state,
    sets: [node.set],
    selfDeviceId: node.id,
    listPeers: () => peers,
    fetchManifest: (peer, options) => fetchManifest(peer, options),
    fetchSetFile: (peer, options) => fetchSetFile(peer, options),
    pushSetFile: (peer, options) => pushSetFile(peer, options),
    onSave: async () => {},
  });
}

test('two mesh nodes converge by appending session tails over real HTTP', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'mesh-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'mesh-b-'));
  try {
    const rel = 'session-abc/session.v4.jsonl.zstd';
    await mkdir(join(rootA, 'session-abc'), { recursive: true });
    await mkdir(join(rootB, 'session-abc'), { recursive: true });
    const prefix = Buffer.from('FRAME-1');
    const tail = Buffer.from('FRAME-2');
    await writeFile(join(rootA, rel), Buffer.concat([prefix, tail]));
    await writeFile(join(rootB, rel), prefix);

    const a = await makeNode('device-a', rootA);
    const b = await makeNode('device-b', rootB);
    try {
      const meshB = makeMesh(b, [{ deviceId: null, name: 'a', address: '127.0.0.1', port: a.port }]);
      const report = await meshB.syncNow();
      assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
      assert.equal(report.imported, 1);
      assert.deepEqual(await readFile(join(rootB, rel)), Buffer.concat([prefix, tail]));
    } finally {
      await a.server.close();
      await b.server.close();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test('mesh pushes a session the peer lacks instead of only waiting for pulls', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'mesh-push-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'mesh-push-b-'));
  try {
    const rel = 'session-new/session.v4.jsonl.zstd';
    await mkdir(join(rootB, rel.split('/')[0]), { recursive: true });
    await writeFile(join(rootB, rel), Buffer.from('ONLY-ON-B'));
    const a = await makeNode('device-a', rootA);
    const b = await makeNode('device-b', rootB);
    try {
      const meshB = makeMesh(b, [{ deviceId: null, name: 'a', address: '127.0.0.1', port: a.port }]);
      const report = await meshB.syncNow();
      assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
      assert.equal(report.pushed, 1);
      assert.deepEqual(await readFile(join(rootA, rel)), Buffer.from('ONLY-ON-B'));
    } finally {
      await a.server.close();
      await b.server.close();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});
