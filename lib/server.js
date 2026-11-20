import http from 'node:http';
import { MAX_SESSION_BYTES } from './catalog.js';
import { contentDigest } from './digest.js';
import {
  EXPORT_FORMAT,
  PROTOCOL_VERSION,
  authorizePeerRequest,
} from './transfer.js';

const PORT_ATTEMPTS = 16;
// Import bodies carry the uncompressed event JSON of one session; keep the cap
// aligned with the export ceiling plus envelope overhead.
const MAX_BODY_BYTES = 160 * 1024 * 1024;

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.code = 'body-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is not JSON');
    error.code = 'bad-json';
    throw error;
  }
}

function importStatusCode(error) {
  switch (error?.code) {
    case 'digest-mismatch':
      return 409;
    case 'invalid-session':
    case 'invalid-state':
    case 'invalid-landing':
      return 400;
    case 'prepare-failed':
      return 422;
    default:
      return 500;
  }
}

/**
 * The LAN-facing HTTP endpoint of this plugin. Only /v1/health answers without
 * the protocol marker; every other route requires a LAN source address, the
 * marker header and (when configured) the shared key.
 */
export function createPeerServer(options) {
  const {
    getDevice,
    listItems,
    exportSession,
    importSession,
    getKey,
    log,
  } = options;
  let server = null;
  let port = 0;
  let starting = null;

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/v1/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION });
      return;
    }
    if (!pathname.startsWith('/v1/')) {
      sendJson(response, 404, { ok: false, error: 'not-found' });
      return;
    }

    const key = typeof getKey === 'function' ? await getKey() : null;
    const auth = authorizePeerRequest(request, { key });
    if (!auth.ok) {
      sendJson(response, auth.status, { ok: false, error: auth.error });
      return;
    }

    if (pathname === '/v1/info' && request.method === 'GET') {
      const items = await listItems();
      sendJson(response, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        device: getDevice(),
        sessions: items.length,
      });
      return;
    }

    if (pathname === '/v1/sessions' && request.method === 'GET') {
      const items = await listItems();
      sendJson(response, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        peer: { deviceId: getDevice().id, name: getDevice().name },
        items,
      });
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionMatch && request.method === 'GET') {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      if (sessionId.length === 0 || sessionId.length > 200) {
        sendJson(response, 400, { ok: false, error: 'bad-session-id' });
        return;
      }
      const exported = await exportSession(sessionId);
      if (!exported) {
        sendJson(response, 404, { ok: false, error: 'session-not-found' });
        return;
      }
      if (exported.tooLarge === true) {
        // The snapshot was listed but its event JSON exceeds the export ceiling.
        // A dedicated status keeps the peer from reporting a phantom missing
        // session (and from retrying it forever as a plain 404).
        sendJson(response, 413, { ok: false, error: 'session-too-large', sizeBytes: exported.sizeBytes ?? null });
        return;
      }
      const payload = {
        format: EXPORT_FORMAT,
        digest: exported.digest,
        header: exported.header,
        events: exported.events,
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SESSION_BYTES * 1.5) {
        sendJson(response, 413, { ok: false, error: 'session-too-large' });
        return;
      }
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === '/v1/sessions' && request.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.code === 'body-too-large' ? 'body-too-large' : 'bad-json' });
        return;
      }
      if (!body || typeof body !== 'object') {
        sendJson(response, 400, { ok: false, error: 'bad-body' });
        return;
      }
      if (body.format !== undefined && body.format !== EXPORT_FORMAT) {
        sendJson(response, 400, { ok: false, error: 'bad-format' });
        return;
      }
      const header = body.header ?? body.session?.header;
      const events = body.events ?? body.session?.events;
      try {
        const result = await importSession({
          header,
          events,
          digest: typeof body.digest === 'string' ? body.digest : contentDigest(Array.isArray(events) ? events : []),
          peerAddress: auth.address,
        });
        sendJson(response, 200, { ok: true, imported: true, result });
      } catch (error) {
        if (importStatusCode(error) >= 500) log?.warn?.('lan-session-sync: import failed', error);
        sendJson(response, importStatusCode(error), { ok: false, error: error?.code ?? 'import-failed' });
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not-found' });
  }

  function listenOnce(attemptPort) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer((request, response) => {
        Promise.resolve(handle(request, response)).catch((error) => {
          log?.warn?.('lan-session-sync: request failed', error);
          sendJson(response, 500, { ok: false, error: 'internal' });
        });
      });
      candidate.on('clientError', (error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
      candidate.once('error', (error) => {
        reject(error);
      });
      candidate.listen({ port: attemptPort, host: '0.0.0.0', exclusive: true }, () => {
        resolve(candidate);
      });
    });
  }

  async function start(basePort) {
    if (server) return port;
    if (starting) return starting;
    starting = (async () => {
      const requested = Number(basePort);
      if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
        throw new Error('invalid LAN port');
      }
      if (requested === 0) {
        server = await listenOnce(0);
        port = server.address().port;
        return port;
      }
      let lastError = null;
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const candidatePort = requested + attempt;
        if (candidatePort > 65535) break;
        try {
          server = await listenOnce(candidatePort);
          port = candidatePort;
          return port;
        } catch (error) {
          lastError = error;
          if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') break;
        }
      }
      throw lastError ?? new Error('no free LAN port');
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function close() {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise((resolve) => closing.close(() => resolve()));
    port = 0;
  }

  return {
    start,
    close,
    get port() {
      return port;
    },
    get running() {
      return Boolean(server);
    },
  };
}
