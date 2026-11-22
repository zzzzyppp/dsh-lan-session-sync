#!/usr/bin/env node
/**
 * Standalone fake LAN peer for testing dsh-lan-session-sync without a second
 * machine. It serves the plugin's /v1 protocol and broadcasts UDP discovery
 * announcements so a running DeepSeek Harness with the plugin discovers it.
 *
 * Usage:
 *   node scripts/fake-peer.mjs [--port 48930] [--discovery-port 47829]
 *                              [--name "Fake peer"] [--device-id fake-peer-001]
 *                              [--key <shared key>] [--no-broadcast]
 *                              [--empty] [--push-log <path>]
 */
import { createHash, randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const PROTOCOL = 1;
const MAGIC = 'dsh-lan-session-sync/hello';
const HEADER = 'x-dsh-lan-session-sync';
const KEY_HEADER = 'x-dsh-lan-session-sync-key';
const EXPORT_FORMAT = 'dsh-lan-session-sync/1';

function parseArgs(argv) {
  const args = {
    port: 48930,
    discoveryPort: 47829,
    name: 'Fake LAN peer',
    deviceId: 'fake-peer-001',
    key: '',
    broadcast: true,
    empty: false,
    pushLog: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') args.port = Number(argv[++index]);
    else if (value === '--discovery-port') args.discoveryPort = Number(argv[++index]);
    else if (value === '--name') args.name = argv[++index];
    else if (value === '--device-id') args.deviceId = argv[++index];
    else if (value === '--key') args.key = argv[++index] ?? '';
    else if (value === '--no-broadcast') args.broadcast = false;
    else if (value === '--empty') args.empty = true;
    else if (value === '--push-log') args.pushLog = argv[++index] ?? '';
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function digest(events) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
      return out;
    }
    return value;
  }
  return createHash('sha256').update(JSON.stringify(canonical(events)), 'utf8').digest('hex');
}

function makeSession(index, cwd) {
  const id = `session-fake-${String(index).padStart(3, '0')}-${randomUUID().slice(0, 8)}`;
  const createdAt = Date.now() - index * 60000;
  // Real DSH v4 events use the fixed envelope { type, seq, time, data, surfaceOp }
  // with no extra keys; the importer validates this strictly.
  const events = [
    {
      type: 'user/message',
      seq: 0,
      time: createdAt + 1000,
      data: {
        content: [{ type: 'text', text: `Fake peer message #${index}` }],
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID(),
      },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: 1,
      time: createdAt + 2000,
      data: {
        content: [{ type: 'text', text: `Imported from ${args.name}.` }],
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID(),
      },
      surfaceOp: 'append',
    },
  ];
  return {
    header: { version: 4, id, createdAt, cwd, isSeeded: false },
    events,
  };
}

const sessions = new Map();
if (!args.empty) {
  for (let index = 1; index <= 2; index += 1) {
    const session = makeSession(index, os.homedir());
    sessions.set(session.header.id, session);
  }
}
const receivedDigests = new Map();

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function recordPush(body, events) {
  const entry = {
    at: new Date().toISOString(),
    from: body?.from ?? null,
    provenance: body?.provenance ?? null,
    sourceSessionId: body?.sourceSessionId ?? null,
    header: body?.header ?? null,
    digest: digest(events),
    events: events.length,
  };
  if (args.pushLog) {
    appendFileSync(args.pushLog, `${JSON.stringify(entry)}\n`);
  }
  console.log(`[fake-peer] push from=${entry.from?.deviceId ?? '?'} provenance=${entry.provenance?.deviceId ?? '-'} session=${entry.sourceSessionId ?? '?'} events=${entry.events}`);
  return entry;
}

function catalog() {
  return [...sessions.values()]
    .map((session) => ({
      id: session.header.id,
      createdAt: session.header.createdAt,
      cwd: session.header.cwd,
      isSeeded: false,
      eventCount: session.events.length,
      sizeBytes: Buffer.byteLength(JSON.stringify(session.events)),
      updatedAt: session.header.createdAt,
      ...(session.importedFrom ? { importedFrom: session.importedFrom } : {}),
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  console.log(`[fake-peer] ${request.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/v1/health') {
    sendJson(response, 200, { ok: true, protocol: PROTOCOL });
    return;
  }
  if (request.headers[HEADER] !== '1') {
    sendJson(response, 401, { ok: false, error: 'missing-header' });
    return;
  }
  if (args.key && request.headers[KEY_HEADER] !== args.key) {
    sendJson(response, 403, { ok: false, error: 'bad-key' });
    return;
  }
  if (url.pathname === '/v1/info') {
    sendJson(response, 200, {
      ok: true,
      protocol: PROTOCOL,
      device: { id: args.deviceId, name: args.name, platform: process.platform },
      sessions: sessions.size,
    });
    return;
  }
  if (url.pathname === '/v1/sessions' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      protocol: PROTOCOL,
      peer: { deviceId: args.deviceId, name: args.name },
      items: catalog(),
    });
    return;
  }
  if (url.pathname === '/v1/sessions' && request.method === 'POST') {
    readJsonBody(request)
      .then((body) => {
        const events = body?.events ?? body?.session?.events;
        const header = body?.header ?? body?.session?.header;
        if (!Array.isArray(events) || !header || typeof header.id !== 'string') {
          sendJson(response, 400, { ok: false, error: 'bad-session' });
          return;
        }
        if (body?.digest && body.digest !== digest(events)) {
          sendJson(response, 409, { ok: false, error: 'digest-mismatch' });
          return;
        }
        recordPush(body, events);
        const contentKey = digest(events);
        if (receivedDigests.has(contentKey) || sessions.has(header.id)) {
          sendJson(response, 200, { ok: true, imported: false, result: { imported: false, reason: 'already-present' } });
          return;
        }
        const localId = `session-fake-rx-${randomUUID().slice(0, 8)}`;
        const importedFrom = body?.from && typeof body.from.deviceId === 'string' && typeof body?.sourceSessionId === 'string'
          ? { deviceId: body.from.deviceId, sessionId: body.sourceSessionId }
          : null;
        sessions.set(localId, { header: { ...header, id: localId }, events, importedFrom });
        receivedDigests.set(contentKey, localId);
        sendJson(response, 200, { ok: true, imported: true, result: { imported: true, localId } });
      })
      .catch(() => sendJson(response, 400, { ok: false, error: 'bad-json' }));
    return;
  }
  const match = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const session = sessions.get(id);
    if (!session) {
      sendJson(response, 404, { ok: false, error: 'session-not-found' });
      return;
    }
    sendJson(response, 200, {
      format: EXPORT_FORMAT,
      digest: digest(session.events),
      header: session.header,
      events: session.events,
    });
    return;
  }
  sendJson(response, 404, { ok: false, error: 'not-found' });
});

function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
      const mask = entry.netmask.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
      const broadcast = (ip & mask) | (~mask >>> 0);
      targets.add([broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.'));
    }
  }
  return [...targets];
}

server.listen(args.port, '0.0.0.0', () => {
  const port = server.address().port;
  console.log(`[fake-peer] serving ${sessions.size} sessions on 0.0.0.0:${port}`);
  console.log(`[fake-peer] device ${args.deviceId} (${args.name})`);
  for (const session of sessions.values()) console.log(`[fake-peer]   ${session.header.id}`);
  if (!args.broadcast) return;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const announce = () => {
    const message = Buffer.from(
      JSON.stringify({
        magic: MAGIC,
        protocol: PROTOCOL,
        type: 'hello',
        device: { id: args.deviceId, name: args.name, platform: process.platform },
        servicePort: port,
        sentAt: Date.now(),
      }),
      'utf8',
    );
    for (const target of broadcastTargets()) {
      socket.send(message, args.discoveryPort, target, () => {});
    }
  };
  socket.bind(0, '0.0.0.0', () => {
    socket.setBroadcast(true);
    announce();
    const timer = setInterval(announce, 3000);
    timer.unref?.();
  });
  socket.on('message', (buffer, remote) => {
    let hello;
    try {
      hello = JSON.parse(buffer.toString('utf8'));
    } catch {
      return;
    }
    if (hello?.magic !== MAGIC || hello.device?.id === args.deviceId) return;
    if (hello.type !== 'hello') return;
    console.log(`[fake-peer] saw ${hello.device?.name ?? hello.device?.id} at ${remote.address}`);
    const reply = Buffer.from(
      JSON.stringify({
        magic: MAGIC,
        protocol: PROTOCOL,
        type: 'hello-reply',
        device: { id: args.deviceId, name: args.name, platform: process.platform },
        servicePort: port,
        sentAt: Date.now(),
      }),
      'utf8',
    );
    socket.send(reply, args.discoveryPort, remote.address, () => {});
  });
  console.log(`[fake-peer] broadcasting discovery on UDP ${args.discoveryPort}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
