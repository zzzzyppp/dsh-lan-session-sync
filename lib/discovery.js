import dgram from 'node:dgram';
import os from 'node:os';
import { isPrivateAddress, normalizeRemoteAddress } from './digest.js';

export const DISCOVERY_MAGIC = 'dsh-lan-session-sync/hello';
export const PROTOCOL_VERSION = 1;
export const DEFAULT_DISCOVERY_PORT = 47829;
export const DEFAULT_INTERVAL_MS = 10000;
export const PEER_TTL_MS = 45000;

function ipToInt(address) {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function intToIp(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function broadcastFor(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  return intToIp((ip & mask) | (~mask >>> 0));
}

/** IPv4 LAN interfaces with their directed broadcast addresses. */
export function lanInterfaces() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isPrivateAddress(entry.address)) continue;
      result.push({
        address: entry.address,
        netmask: entry.netmask,
        broadcast: broadcastFor(entry.address, entry.netmask),
      });
    }
  }
  return result;
}

export function isValidHello(value, selfDeviceId) {
  if (!value || typeof value !== 'object') return false;
  if (value.magic !== DISCOVERY_MAGIC) return false;
  if (value.protocol !== PROTOCOL_VERSION) return false;
  if (value.type !== 'hello' && value.type !== 'hello-reply') return false;
  const device = value.device;
  if (!device || typeof device.id !== 'string' || device.id.length === 0 || device.id.length > 128) return false;
  if (device.id === selfDeviceId) return false;
  const port = Number(value.servicePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return true;
}

/** Table of peers seen on the LAN, deduplicated by device id. */
export class PeerTable {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PEER_TTL_MS;
    this.now = options.now ?? Date.now;
    this.peers = new Map();
  }

  upsert(peer) {
    if (!peer || typeof peer.deviceId !== 'string' || peer.deviceId.length === 0) return { peer: null, isNew: false };
    const address = normalizeRemoteAddress(peer.address);
    const port = Number(peer.port);
    if (!isPrivateAddress(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { peer: null, isNew: false };
    }
    const previous = this.peers.get(peer.deviceId);
    const merged = {
      deviceId: peer.deviceId,
      name: typeof peer.name === 'string' && peer.name.length > 0 ? peer.name.slice(0, 64) : (previous?.name ?? null),
      platform: typeof peer.platform === 'string' ? peer.platform.slice(0, 32) : (previous?.platform ?? null),
      address,
      port,
      lastSeen: this.now(),
    };
    this.peers.set(peer.deviceId, merged);
    return { peer: merged, isNew: !previous };
  }

  remove(deviceId) {
    return this.peers.delete(deviceId);
  }

  list() {
    const now = this.now();
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeen > this.ttlMs) this.peers.delete(deviceId);
    }
    return [...this.peers.values()].sort((left, right) => right.lastSeen - left.lastSeen);
  }
}

/**
 * UDP broadcast discovery. Peers announce themselves on the discovery port and
 * answer unknown announcers with a unicast hello-reply so newly started DSH
 * instances find each other quickly instead of waiting for the next interval.
 */
export class Discoverer {
  constructor(options) {
    this.device = options.device;
    this.servicePort = Number(options.servicePort) || 0;
    const configuredDiscoveryPort = Number(options.discoveryPort);
    this.discoveryPort = Number.isInteger(configuredDiscoveryPort) && configuredDiscoveryPort >= 0 && configuredDiscoveryPort <= 65535
      ? configuredDiscoveryPort
      : DEFAULT_DISCOVERY_PORT;
    this.intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
    this.onPeer = options.onPeer;
    this.onLog = options.onLog;
    this.broadcasts = options.broadcasts ?? null;
    this.socket = null;
    this.timer = null;
    this.stopped = true;
  }

  #hello(type) {
    return {
      magic: DISCOVERY_MAGIC,
      protocol: PROTOCOL_VERSION,
      type,
      device: {
        id: this.device.id,
        name: this.device.name,
        platform: this.device.platform ?? null,
      },
      servicePort: this.servicePort,
      sentAt: Date.now(),
    };
  }

  #targets() {
    const targets = new Set(['255.255.255.255']);
    for (const entry of this.broadcasts ?? lanInterfaces()) targets.add(entry.broadcast);
    return [...targets];
  }

  #send(buffer, address) {
    if (!this.socket) return;
    this.socket.send(buffer, this.discoveryPort, address, (error) => {
      if (error) this.onLog?.('warn', `lan-session-sync: discovery send to ${address} failed: ${error.message}`);
    });
  }

  broadcast() {
    if (!this.socket || this.servicePort === 0 || this.discoveryPort === 0) return;
    const buffer = Buffer.from(JSON.stringify(this.#hello('hello')), 'utf8');
    for (const address of this.#targets()) this.#send(buffer, address);
  }

  #handleMessage(buffer, remote) {
    if (buffer.byteLength > 8192) return;
    let message;
    try {
      message = JSON.parse(buffer.toString('utf8'));
    } catch {
      return;
    }
    if (!isValidHello(message, this.device.id)) return;
    const address = normalizeRemoteAddress(remote.address);
    if (!isPrivateAddress(address)) return;
    const peer = {
      deviceId: message.device.id,
      name: message.device.name,
      platform: message.device.platform,
      address,
      port: message.servicePort,
    };
    try {
      this.onPeer?.(peer);
    } catch (error) {
      this.onLog?.('warn', `lan-session-sync: discovery callback failed: ${error?.message ?? error}`);
    }
    if (message.type === 'hello') {
      const reply = Buffer.from(JSON.stringify(this.#hello('hello-reply')), 'utf8');
      this.#send(reply, address);
    }
  }

  setServicePort(port) {
    this.servicePort = Number(port) || 0;
    if (this.timer) this.broadcast();
  }

  start() {
    if (this.socket) return;
    this.stopped = false;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (error) => {
      this.onLog?.('warn', `lan-session-sync: discovery socket error: ${error.message}`);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (this.socket === socket) this.socket = null;
    });
    socket.on('message', (buffer, remote) => this.#handleMessage(buffer, remote));
    socket.bind(this.discoveryPort, '0.0.0.0', () => {
      if (this.stopped) return;
      try {
        socket.setBroadcast(true);
      } catch (error) {
        this.onLog?.('warn', `lan-session-sync: could not enable broadcast: ${error.message}`);
      }
      this.broadcast();
      this.timer = setInterval(() => this.broadcast(), this.intervalMs);
      this.timer.unref?.();
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }
}
