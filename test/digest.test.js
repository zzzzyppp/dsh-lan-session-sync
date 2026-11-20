import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  contentDigest,
  isDigestHex,
  isPrivateAddress,
  localSessionIdForDigest,
  normalizeRemoteAddress,
  safeEqual,
} from '../lib/digest.js';

test('canonicalJson sorts keys recursively', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 2], c: true } }), '{"a":{"c":true,"d":[3,2]},"b":1}');
  assert.equal(canonicalJson([{ y: 1, x: 2 }]), '[{"x":2,"y":1}]');
});

test('contentDigest ignores object key order but not content', () => {
  const left = [{ seq: 0, payload: { b: 2, a: 1 } }];
  const right = [{ payload: { a: 1, b: 2 }, seq: 0 }];
  assert.equal(contentDigest(left), contentDigest(right));
  assert.notEqual(contentDigest(left), contentDigest([{ seq: 0, payload: { a: 1, b: 3 } }]));
  assert.ok(isDigestHex(contentDigest(left)));
  assert.ok(isDigestHex(contentDigest([])));
});

test('localSessionIdForDigest is a deterministic v5 uuid', () => {
  const digest = 'a'.repeat(64);
  const id = localSessionIdForDigest(digest);
  assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, localSessionIdForDigest(digest));
  assert.notEqual(id, localSessionIdForDigest('b'.repeat(64)));
});

test('safeEqual compares secrets without length leaks', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
});

test('normalizeRemoteAddress unwraps mapped addresses and zones', () => {
  assert.equal(normalizeRemoteAddress('192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeRemoteAddress('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeRemoteAddress('::ffff:c0a8:0105'), '192.168.1.5');
  assert.equal(normalizeRemoteAddress('fe80::1%en0'), 'fe80::1');
  assert.equal(normalizeRemoteAddress(undefined), '');
});

test('isPrivateAddress allows LAN, loopback and link-local only', () => {
  for (const address of [
    '10.0.0.5',
    '127.0.0.1',
    '169.254.10.2',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '100.100.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:192.168.0.7',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860::8888', 'example.com', '']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});
