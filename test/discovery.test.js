import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCOVERY_MAGIC,
  Discoverer,
  PeerTable,
  isValidHello,
} from '../lib/discovery.js';

function hello(overrides = {}) {
  return {
    magic: DISCOVERY_MAGIC,
    protocol: 1,
    type: 'hello',
    device: { id: 'device-b', name: 'MacBook B', platform: 'darwin' },
    servicePort: 47830,
    sentAt: 1,
    ...overrides,
  };
}

test('isValidHello accepts well-formed announcements and ignores self', () => {
  assert.equal(isValidHello(hello(), 'device-a'), true);
  assert.equal(isValidHello(hello({ type: 'hello-reply' }), 'device-a'), true);
  assert.equal(isValidHello(hello(), 'device-b'), false);
  assert.equal(isValidHello(hello({ magic: 'other' }), 'device-a'), false);
  assert.equal(isValidHello(hello({ protocol: 2 }), 'device-a'), false);
  assert.equal(isValidHello(hello({ servicePort: 0 }), 'device-a'), false);
  assert.equal(isValidHello(hello({ device: { id: '' } }), 'device-a'), false);
  assert.equal(isValidHello(null, 'device-a'), false);
});

test('PeerTable deduplicates by device and expires stale peers', () => {
  let clock = 1000;
  const table = new PeerTable({ ttlMs: 5000, now: () => clock });
  const first = table.upsert({ deviceId: 'device-b', name: 'B', address: '192.168.1.9', port: 47830 });
  assert.equal(first.isNew, true);
  const second = table.upsert({ deviceId: 'device-b', name: 'B renamed', address: '192.168.1.10', port: 47831 });
  assert.equal(second.isNew, false);
  assert.equal(second.peer.address, '192.168.1.10');
  assert.equal(second.peer.name, 'B renamed');
  assert.equal(table.list().length, 1);
  clock += 6000;
  assert.equal(table.list().length, 0);
});

test('PeerTable refuses public addresses and invalid ports', () => {
  const table = new PeerTable();
  assert.equal(table.upsert({ deviceId: 'x', address: '8.8.8.8', port: 47830 }).peer, null);
  assert.equal(table.upsert({ deviceId: 'x', address: '192.168.1.9', port: 0 }).peer, null);
  assert.equal(table.list().length, 0);
});

test('Discoverer starts and stops without leaving a socket open', async () => {
  const peers = [];
  const discoverer = new Discoverer({
    device: { id: 'device-a', name: 'A', platform: 'darwin' },
    servicePort: 47830,
    discoveryPort: 0,
    intervalMs: 60000,
    onPeer: (peer) => peers.push(peer),
    broadcasts: [],
  });
  discoverer.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  discoverer.setServicePort(47831);
  discoverer.stop();
  assert.equal(peers.length, 0);
});
