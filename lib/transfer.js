import { contentDigest, isPrivateAddress, normalizeRemoteAddress, safeEqual } from './digest.js';

export const PROTOCOL_VERSION = 1;
export const EXPORT_FORMAT = 'dsh-lan-session-sync/1';
export const MAGIC_HEADER = 'x-dsh-lan-session-sync';
export const KEY_HEADER = 'x-dsh-lan-session-sync-key';
export const MAGIC_VALUE = '1';
export const DEFAULT_TIMEOUT_MS = 8000;
export const SESSION_TIMEOUT_MS = 180000;
export const MAX_RESPONSE_BYTES = 160 * 1024 * 1024;

export class TransferError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function peerBaseUrl(address, port) {
  const host = String(address ?? '');
  const numericPort = Number(port);
  if (host.length === 0) throw new TransferError('bad-peer', 'peer address is missing');
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new TransferError('bad-peer', 'peer port is invalid');
  }
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${numericPort}`;
}

async function readBounded(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TransferError('response-too-large', 'peer response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestJson(peer, options = {}) {
  if (!isPrivateAddress(peer?.address)) {
    throw new TransferError('peer-not-private', 'refusing to contact a non-LAN peer address');
  }
  const key = typeof options.key === 'string' ? options.key : '';
  const headers = {
    accept: 'application/json',
    [MAGIC_HEADER]: MAGIC_VALUE,
    ...(key.length > 0 ? { [KEY_HEADER]: key } : {}),
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${peerBaseUrl(peer.address, peer.port)}${options.path ?? '/'}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await readBounded(response, Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_RESPONSE_BYTES);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    if (error?.name === 'AbortError') throw new TransferError('timeout', `peer did not answer within ${timeoutMs} ms`);
    throw new TransferError('network', error?.message ?? String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Validate an export payload and re-compute its checksum before importing. */
export function verifyExport(payload) {
  if (!payload || typeof payload !== 'object') throw new TransferError('bad-export', 'peer returned no session payload');
  if (payload.format !== EXPORT_FORMAT) throw new TransferError('bad-export', 'peer returned an unsupported export format');
  const header = payload.header ?? payload.session?.header;
  const events = payload.events ?? payload.session?.events;
  if (!header || typeof header !== 'object') throw new TransferError('bad-export', 'peer returned no session header');
  if (!Array.isArray(events)) throw new TransferError('bad-export', 'peer returned no session events');
  const digest = contentDigest(events);
  if (typeof payload.digest === 'string' && payload.digest.length > 0 && payload.digest !== digest) {
    throw new TransferError('digest-mismatch', 'peer session checksum does not match its content');
  }
  return { header, events, digest };
}

export async function fetchPeerCatalog(peer, options = {}) {
  const response = await requestJson(peer, { ...options, path: '/v1/sessions', timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (response.status !== 200 || !response.json || response.json.ok !== true) {
    throw new TransferError('catalog-failed', `peer catalog request failed with HTTP ${response.status}`);
  }
  const peerInfo = response.json.peer;
  if (!peerInfo || typeof peerInfo.deviceId !== 'string' || peerInfo.deviceId.length === 0) {
    throw new TransferError('catalog-failed', 'peer catalog did not identify the device');
  }
  return {
    peer: { deviceId: peerInfo.deviceId, name: typeof peerInfo.name === 'string' ? peerInfo.name : null },
    items: Array.isArray(response.json.items) ? response.json.items : [],
  };
}

export async function fetchPeerSession(peer, sessionId, options = {}) {
  const response = await requestJson(peer, {
    ...options,
    path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
    timeoutMs: options.timeoutMs ?? SESSION_TIMEOUT_MS,
  });
  if (response.status === 404) throw new TransferError('session-not-found', 'peer no longer has that session');
  if (response.status === 413) {
    throw new TransferError('session-too-large', 'peer session exceeds its export size limit', {
      sizeBytes: response.json?.sizeBytes ?? null,
    });
  }
  if (response.status !== 200 || !response.json) {
    throw new TransferError('session-failed', `peer session request failed with HTTP ${response.status}`);
  }
  return { ...verifyExport(response.json), raw: response.json };
}

export async function fetchPeerInfo(peer, options = {}) {
  const response = await requestJson(peer, { ...options, path: '/v1/info' });
  if (response.status !== 200 || !response.json?.ok) {
    throw new TransferError('info-failed', `peer info request failed with HTTP ${response.status}`);
  }
  return response.json;
}

/**
 * Fence an incoming peer request: LAN-only source, protocol marker, optional
 * shared key. Returns {ok:true} or {ok:false,status,error}.
 */
export function authorizePeerRequest(request, options = {}) {
  const address = normalizeRemoteAddress(request?.socket?.remoteAddress ?? '');
  if (!isPrivateAddress(address)) return { ok: false, status: 403, error: 'not-private' };
  const header = request?.headers?.[MAGIC_HEADER];
  const marker = Array.isArray(header) ? header[0] : header;
  if (marker !== MAGIC_VALUE) return { ok: false, status: 401, error: 'missing-header' };
  const expectedKey = typeof options.key === 'string' ? options.key : '';
  if (expectedKey.length > 0) {
    const provided = request?.headers?.[KEY_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (typeof value !== 'string' || !safeEqual(value, expectedKey)) {
      return { ok: false, status: 403, error: 'bad-key' };
    }
  }
  return { ok: true, address };
}
