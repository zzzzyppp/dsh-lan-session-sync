import { createHash, timingSafeEqual } from 'node:crypto';

/** Fixed name-based UUID namespace for deterministic local session ids. */
const SESSION_NAMESPACE = '6f2f0c9e-3b5a-4d0e-9a1e-8f6d3c2b1a90';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Digest of a full session event list; used both as checksum and as content identity. */
export function contentDigest(events) {
  return sha256Hex(canonicalJson(events));
}

function namespaceBytes(namespace) {
  const hex = namespace.replace(/-/g, '');
  if (hex.length !== 32) throw new Error('invalid uuid namespace');
  return Buffer.from(hex, 'hex');
}

/** RFC 4122 version 5 UUID for a string name. */
export function uuidV5(name, namespace = SESSION_NAMESPACE) {
  const hash = createHash('sha1')
    .update(namespaceBytes(namespace))
    .update(Buffer.from(String(name), 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic local id for a remote session, keyed by its content digest. */
export function localSessionIdForDigest(digest) {
  return `session-${uuidV5(digest)}`;
}

export function safeEqual(left, right) {
  const a = createHash('sha256').update(String(left), 'utf8').digest();
  const b = createHash('sha256').update(String(right), 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function isDigestHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Normalize a peer socket address for policy checks: drop IPv6 zone, unwrap
 * IPv4-mapped IPv6, lower-case.
 */
export function normalizeRemoteAddress(value) {
  if (typeof value !== 'string') return '';
  let address = value.trim();
  const zone = address.indexOf('%');
  if (zone >= 0 && address.includes(':')) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) address = mapped[1];
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    address = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return address.toLowerCase();
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

/** True only for LAN/loopback/link-local addresses; public addresses are refused. */
export function isPrivateAddress(value) {
  const address = normalizeRemoteAddress(value);
  if (!address) return false;
  if (address === '::1' || address === '::') return true;
  if (address.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return isPrivateIpv4(address);
  return false;
}
