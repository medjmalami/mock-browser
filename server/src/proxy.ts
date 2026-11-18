import { randomUUID } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';
import { parseCompleteResponse, parseHttpRequest, ProtocolError, reasonPhrase, cloneHeaders, getHeader, header, removeHeaders, setHeader, serializeChunkedResponse, serializeResponse } from './protocol.js';
import type { Header, ParsedRequest, ParsedWireResponse, ProxyOptions, ResponseSpec, ServerEvent, ServerEventSink } from './types.js';

type ProxyCacheEntry = {
  url: string;
  statusCode: number;
  reason: string;
  headers: Header[];
  body: Buffer;
  storedAt: number;
  expiresAt?: number;
  etag?: string;
  lastModified?: string;
};

type ProxyRequestTarget = { url: URL; host: string; port: number; path: string };

const HOP_BY_HOP = ['Connection', 'Proxy-Connection', 'Proxy-Authorization', 'Keep-Alive', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade'];

function removeHopByHopHeaders(headers: Header[]): Header[] {
  const connectionTokens = (getHeader(headers, 'Connection') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return removeHeaders(headers, [...HOP_BY_HOP, ...connectionTokens]);
}

function requestCachePolicy(headers: Header[]): { revalidate: boolean; noStore: boolean } {
  const directives = (getHeader(headers, 'Cache-Control') ?? '').split(',').map((value) => value.trim().toLowerCase());
  const pragma = (getHeader(headers, 'Pragma') ?? '').toLowerCase().split(',').map((value) => value.trim());
  return {
    revalidate: directives.some((value) => /^no-cache(?:\s*=|\s*;|$)/.test(value) || /^max-age\s*=\s*0(?:\s*;|$)/.test(value)) || pragma.includes('no-cache'),
    noStore: directives.some((value) => /^no-store(?:\s*;|$)/.test(value)),
  };
}

function basicToken(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function sameCredential(headerValue: string | undefined, credentials: { username: string; password: string }): boolean {
  return headerValue === basicToken(credentials.username, credentials.password);
}

function cacheExpiry(headers: Header[], now: number): number | undefined {
  const cacheControl = getHeader(headers, 'Cache-Control') ?? '';
  const match = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (match) return now + Number(match[1]) * 1000;
  const expires = getHeader(headers, 'Expires');
  if (!expires) return undefined;
  const parsed = Date.parse(expires);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function cacheable(response: ParsedWireResponse, request: ParsedRequest): boolean {
  const control = getHeader(response.headers, 'Cache-Control') ?? '';
  if (response.statusCode !== 200 || /\b(no-store|private)\b/i.test(control)) return false;
  if (getHeader(response.headers, 'Set-Cookie') || getHeader(response.headers, 'Vary')?.trim() === '*') return false;
  if ((getHeader(request.headers, 'Authorization') || getHeader(request.headers, 'Cookie')) && !/\bpublic\b/i.test(control)) return false;
  return true;
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = authority.match(/^\[([^\]]+)\]:(\d+)$/) ?? authority.match(/^([^:]+):(\d+)$/);
  if (!match) return undefined;
  const host = match[1];
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function requestVersion(request: ParsedRequest): 'HTTP/1.0' | 'HTTP/1.1' {
  return request.version === 'HTTP/1.0' ? 'HTTP/1.0' : 'HTTP/1.1';
}

export class ProxyApplication {
  private readonly host: string;
  private readonly originHost: string;
  private readonly originPort: number;
  private readonly echoHost: string;
  private readonly echoPort: number;
  private readonly credentials?: { username: string; password: string };
  private readonly upstreamTimeoutMs: number;
  private readonly onEvent?: ServerEventSink;
  private readonly cache = new Map<string, ProxyCacheEntry>();

  constructor(options: ProxyOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.originHost = options.originHost ?? '127.0.0.1';
    this.originPort = options.originPort ?? 8080;
    this.echoHost = options.echoHost ?? '127.0.0.1';
    this.echoPort = options.echoPort ?? 9000;
    this.credentials = options.auth;
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 5_000;
    this.onEvent = options.onEvent;
  }

  createServer(): Server {
    return net.createServer((socket) => this.attach(socket));
  }

  private emit(type: string, message: string, connectionId?: string, details?: Record<string, unknown>): void {
    const event: ServerEvent = { id: randomUUID(), at: new Date().toISOString(), service: 'proxy', type, connectionId, message, details };
    this.onEvent?.(event);
  }

  private attach(socket: Socket): void {
    const connectionId = `proxy-${randomUUID().slice(0, 8)}`;
    let buffer = Buffer.alloc(0);
    let processing = false;
    let closed = false;
    let requestCount = 0;
    const close = () => {
      if (closed) return;
      closed = true;
      this.emit('connection-closed', `Proxy connection ${connectionId} closed`, connectionId, { requestCount });
    };
    socket.setTimeout(this.upstreamTimeoutMs + 5_000, () => {
      if (buffer.length) {
        const response = this.errorResponse('HTTP/1.1', 408, 'Proxy request timeout', true);
        socket.end(response);
        this.emit('response-sent', '408 Request Timeout from proxy', connectionId, { rawResponse: response.toString('latin1') });
      } else socket.destroy();
    });
    socket.on('data', (chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      void processBuffer();
    });
    socket.on('error', (error) => this.emit('socket-error', error.message, connectionId));
    socket.on('close', close);

    const processBuffer = async (): Promise<void> => {
      if (processing || closed) return;
      processing = true;
      try {
        while (!closed && buffer.length) {
          let request: ParsedRequest | null;
          try {
            request = parseHttpRequest(buffer);
          } catch (error) {
            const protocolError = error instanceof ProtocolError ? error : new ProtocolError(String(error));
            const response = this.errorResponse('HTTP/1.1', protocolError.code === 'UNSUPPORTED_VERSION' ? 505 : 400, protocolError.message, true);
            socket.end(response);
            this.emit('response-sent', `Proxy rejected malformed request with ${protocolError.code}`, connectionId, { rawResponse: response.toString('latin1') });
            closed = true;
            break;
          }
          if (!request) break;
          buffer = buffer.subarray(request.consumed);
          requestCount += 1;
          this.emit('request-received', `${request.method} ${request.target}`, connectionId, { rawRequest: request.raw.toString('latin1'), requestCount });
          if (!/^HTTP\/(1\.0|1\.1)$/.test(request.version)) {
            const response = this.errorResponse('HTTP/1.1', 505, 'HTTP Version Not Supported', true);
            socket.end(response);
            this.emit('response-sent', '505 HTTP Version Not Supported from proxy', connectionId, { rawResponse: response.toString('latin1') });
            closed = true;
            break;
          }
          const connectionDirective = (getHeader(request.headers, 'Connection') ?? '').toLowerCase();
          const keepAlive = request.version === 'HTTP/1.1'
            ? !connectionDirective.split(',').map((value) => value.trim()).includes('close')
            : connectionDirective.split(',').map((value) => value.trim()).includes('keep-alive');
          if (this.credentials && !sameCredential(getHeader(request.headers, 'Proxy-Authorization'), this.credentials)) {
            const response = this.errorResponse(requestVersion(request), 407, 'Proxy Authentication Required', !keepAlive, [header('Proxy-Authenticate', 'Basic realm="isims"')]);
            socket.write(response);
            this.emit('proxy-auth-challenge', '407 Proxy Authentication Required', connectionId, { rawResponse: response.toString('latin1') });
            if (!keepAlive) {
              socket.end();
              closed = true;
              break;
            }
            continue;
          }
          if (request.method === 'CONNECT') {
            const initialTunnelData = buffer;
            buffer = Buffer.alloc(0);
            const keepTunnelSocket = await this.handleConnect(socket, request, connectionId, initialTunnelData);
            closed = !keepTunnelSocket;
            break;
          }
          const response = await this.forward(request, connectionId, keepAlive);
          socket.write(response.bytes);
          this.emit('response-sent', `${request.method} ${request.target} -> ${response.statusCode}`, connectionId, { rawResponse: response.bytes.toString('latin1'), cache: response.cacheState, upstream: response.upstream });
          if (!keepAlive || response.close) {
            socket.end();
            closed = true;
            break;
          }
        }
      } finally {
        processing = false;
      }
    };
  }

  private targetFor(request: ParsedRequest): ProxyRequestTarget | undefined {
    try {
      const url = new URL(request.target);
      if (url.protocol !== 'http:') return undefined;
      const port = Number(url.port || 80);
      return { url, host: url.hostname, port, path: `${url.pathname || '/'}${url.search}` };
    } catch {
      return undefined;
    }
  }

  private isAllowed(host: string, port: number, forConnect: boolean): boolean {
    if (!isLoopbackHost(host)) return false;
    if (forConnect) return (port === this.originPort && (host === this.originHost || host === 'localhost' || host === '127.0.0.1')) || (port === this.echoPort && (host === this.echoHost || host === 'localhost' || host === '127.0.0.1'));
    return port === this.originPort && (host === this.originHost || host === 'localhost' || host === '127.0.0.1');
  }

  private async forward(request: ParsedRequest, connectionId: string, keepAlive: boolean): Promise<{ bytes: Buffer; statusCode: number; close: boolean; cacheState: string; upstream: string }> {
    const target = this.targetFor(request);
    if (!target || !this.isAllowed(target.host, target.port, false)) {
      const response = this.errorResponse(requestVersion(request), 403, 'Proxy target is not on the local allow-list', !keepAlive);
      return { bytes: response, statusCode: 403, close: !keepAlive, cacheState: 'blocked', upstream: 'none' };
    }
    const key = `${request.method.toUpperCase()} ${target.url.toString()}`;
    const cachePolicy = requestCachePolicy(request.headers);
    const cacheEligible = request.method === 'GET' && !cachePolicy.noStore && !getHeader(request.headers, 'Authorization') && !getHeader(request.headers, 'Cookie');
    const cached = cacheEligible ? this.cache.get(key) : undefined;
    const now = Date.now();
    if (cached && cached.expiresAt !== undefined && cached.expiresAt > now && !cachePolicy.revalidate) {
      this.emit('cache-hit', `Proxy cache HIT for ${target.url}`, connectionId, { url: target.url.toString(), age: Math.floor((now - cached.storedAt) / 1000) });
      const response = this.cachedResponse(requestVersion(request), cached, Math.floor((now - cached.storedAt) / 1000), keepAlive);
      return { bytes: response, statusCode: cached.statusCode, close: !keepAlive, cacheState: 'HIT', upstream: 'cache' };
    }

    const upstreamHeaders = removeHopByHopHeaders(cloneHeaders(request.headers));
    setHeader(upstreamHeaders, 'Host', target.url.host);
    setHeader(upstreamHeaders, 'Connection', 'close');
    if (request.body.length && !getHeader(upstreamHeaders, 'Content-Length')) setHeader(upstreamHeaders, 'Content-Length', String(request.body.length));
    if (cached) {
      if (cached.etag) setHeader(upstreamHeaders, 'If-None-Match', cached.etag);
      if (cached.lastModified) setHeader(upstreamHeaders, 'If-Modified-Since', cached.lastModified);
      this.emit('cache-revalidate', `Proxy revalidating stale entry for ${target.url}`, connectionId, { etag: cached.etag, lastModified: cached.lastModified });
    }
    const upstreamRequest = Buffer.concat([
      Buffer.from(`${request.method} ${target.path} ${request.version}\r\n${upstreamHeaders.map((item) => `${item.name}: ${item.value}\r\n`).join('')}\r\n`, 'latin1'),
      request.body,
    ]);
    const upstream = await this.exchangeUpstream(target.host, target.port, upstreamRequest, request.method, connectionId);
    if (!upstream.response) {
      const response = this.errorResponse(requestVersion(request), upstream.statusCode, upstream.error ?? 'upstream error', !keepAlive);
      return { bytes: response, statusCode: upstream.statusCode, close: !keepAlive, cacheState: 'ERROR', upstream: `${target.host}:${target.port}` };
    }
    let parsed = upstream.response;
    let cacheState = cached ? 'REVALIDATED' : 'MISS';
    if (parsed.statusCode === 304 && cached) {
      parsed = { ...parsed, statusCode: cached.statusCode, reason: cached.reason, headers: mergeHeaders(cached.headers, parsed.headers), body: Buffer.from(cached.body), chunks: [], trailers: [], usedChunked: false, connectionClose: false };
      cacheState = 'HIT-304';
      this.emit('cache-304', `Proxy reused cached body after 304 for ${target.url}`, connectionId);
    } else if (cacheEligible && cacheable(parsed, request)) {
      const entry: ProxyCacheEntry = { url: target.url.toString(), statusCode: parsed.statusCode, reason: parsed.reason, headers: cloneHeaders(parsed.headers), body: Buffer.from(parsed.body), storedAt: now, expiresAt: cacheExpiry(parsed.headers, now), etag: getHeader(parsed.headers, 'ETag'), lastModified: getHeader(parsed.headers, 'Last-Modified') };
      this.cache.set(key, entry);
      this.emit('cache-store', `Proxy stored ${target.url}`, connectionId, { expiresAt: entry.expiresAt });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') this.cache.delete(`GET ${target.url.toString()}`);
    const bytes = this.serializeProxyResponse(requestVersion(request), parsed, keepAlive, cacheState === 'MISS' ? 'MISS' : 'HIT', cacheState === 'HIT-304' || cacheState === 'REVALIDATED' ? Math.floor((now - (cached?.storedAt ?? now)) / 1000) : 0, request.method);
    return { bytes, statusCode: parsed.statusCode, close: !keepAlive, cacheState, upstream: `${target.host}:${target.port}` };
  }

  private async exchangeUpstream(host: string, port: number, request: Buffer, method: string, connectionId: string): Promise<{ response?: ParsedWireResponse; statusCode: number; error?: string }> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (value: { response?: ParsedWireResponse; statusCode: number; error?: string }) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(this.upstreamTimeoutMs, () => finish({ statusCode: 504, error: `upstream timeout after ${this.upstreamTimeoutMs} ms` }));
      socket.once('connect', () => {
        this.emit('upstream-connect', `Connected to upstream ${host}:${port}`, connectionId, { host, port });
        socket.write(request);
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          const response = parseCompleteResponse(buffer, method, false);
          finish({ response, statusCode: response.statusCode });
        } catch (error) {
          if (error instanceof ProtocolError && error.code === 'INCOMPLETE') return;
          finish({ statusCode: 502, error: error instanceof Error ? error.message : String(error) });
        }
      });
      socket.on('error', (error) => finish({ statusCode: 502, error: error.message }));
      socket.on('close', () => {
        if (settled) return;
        try {
          const response = parseCompleteResponse(buffer, method, true);
          finish({ response, statusCode: response.statusCode });
        } catch (error) {
          finish({ statusCode: 502, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  }

  private serializeProxyResponse(version: 'HTTP/1.0' | 'HTTP/1.1', response: ParsedWireResponse, keepAlive: boolean, cacheStatus: 'HIT' | 'MISS', age: number, requestMethod = 'GET'): Buffer {
    const originalContentLength = getHeader(response.headers, 'Content-Length');
    const headers = removeHeaders(cloneHeaders(response.headers), ['Connection', 'Content-Length', 'Transfer-Encoding', 'Via', 'X-Cache', 'Age']);
    const interim = response.interim?.length
      ? Buffer.concat(response.interim.map((item) => Buffer.from(`${item.version} ${item.statusCode} ${item.reason}\r\n${item.headers.map((headerItem) => `${headerItem.name}: ${headerItem.value}\r\n`).join('')}\r\n`, 'latin1')))
      : Buffer.alloc(0);
    headers.push(header('Via', '1.1 HTTP-Lab-Proxy'));
    headers.push(header('X-Cache', cacheStatus));
    headers.push(header('Age', String(Math.max(0, age))));
    headers.push(header('Connection', keepAlive ? 'keep-alive' : 'close'));
    if (keepAlive) headers.push(header('Keep-Alive', 'timeout=5, max=100'));
    if (response.usedChunked && response.chunks.length) return Buffer.concat([interim, serializeChunkedResponse(version, { statusCode: response.statusCode, reason: response.reason, headers, chunks: response.chunks.filter((chunk) => chunk.sizeDecimal > 0), trailers: response.trailers })]);
    const noBodyStatus = (response.statusCode >= 100 && response.statusCode < 200) || response.statusCode === 204 || response.statusCode === 304;
    if (requestMethod.toUpperCase() === 'HEAD' && originalContentLength !== undefined) headers.push(header('Content-Length', originalContentLength));
    else if (!noBodyStatus) headers.push(header('Content-Length', String(response.body.length)));
    return Buffer.concat([interim, serializeResponse(version, { statusCode: response.statusCode, reason: response.reason, headers, body: response.body })]);
  }

  private cachedResponse(version: 'HTTP/1.0' | 'HTTP/1.1', entry: ProxyCacheEntry, age: number, keepAlive: boolean): Buffer {
    const parsed: ParsedWireResponse = { version, statusCode: entry.statusCode, reason: entry.reason, headers: entry.headers, body: entry.body, raw: Buffer.alloc(0), chunks: [], trailers: [], usedChunked: false, connectionClose: false };
    return this.serializeProxyResponse(version, parsed, keepAlive, 'HIT', age);
  }

  private errorResponse(version: string, statusCode: number, message: string, close: boolean, extraHeaders: Header[] = []): Buffer {
    const headers = [header('Date', new Date().toUTCString()), header('Server', 'HTTP-Lab-Proxy/0.1'), ...extraHeaders, header('Connection', close ? 'close' : 'keep-alive')];
    if (!close) headers.push(header('Keep-Alive', 'timeout=5, max=100'));
    return serializeResponse(version, { statusCode, reason: reasonPhrase(statusCode), headers, body: Buffer.from(`${statusCode} ${reasonPhrase(statusCode)}: ${message}\n`, 'utf8') });
  }

  private async handleConnect(socket: Socket, request: ParsedRequest, connectionId: string, initialData: Buffer): Promise<boolean> {
    const authority = parseAuthority(request.target);
    if (!authority || !this.isAllowed(authority.host, authority.port, true)) {
      const response = this.errorResponse(requestVersion(request), 403, 'CONNECT target is not on the local allow-list', true);
      socket.end(response);
      this.emit('tunnel-rejected', `CONNECT ${request.target} rejected`, connectionId, { rawResponse: response.toString('latin1') });
      return false;
    }
    const upstream = net.createConnection({ host: authority.host, port: authority.port });
    let connected = false;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), this.upstreamTimeoutMs);
      upstream.once('connect', () => {
        connected = true;
        clearTimeout(timeout);
        resolve();
      });
      upstream.once('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (!connected) {
      const response = this.errorResponse(requestVersion(request), 502, 'CONNECT upstream could not be opened', true);
      socket.end(response);
      this.emit('tunnel-error', `CONNECT ${request.target} failed`, connectionId, { rawResponse: response.toString('latin1') });
      upstream.destroy();
      return false;
    }
    const response = Buffer.from(`${request.version} 200 Connection Established\r\nDate: ${new Date().toUTCString()}\r\nServer: HTTP-Lab-Proxy/0.1\r\nConnection: keep-alive\r\n\r\n`, 'latin1');
    socket.write(response);
    this.emit('tunnel-open', `CONNECT tunnel open to ${authority.host}:${authority.port}`, connectionId, { target: request.target, rawResponse: response.toString('latin1') });
    socket.setTimeout(0);
    upstream.setTimeout(0);
    socket.pipe(upstream);
    upstream.pipe(socket);
    if (initialData.length) upstream.write(initialData);
    const end = () => {
      socket.unpipe(upstream);
      upstream.unpipe(socket);
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', end);
    upstream.on('error', end);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('data', (chunk) => this.emit('tunnel-data', `Tunnel sent ${chunk.length} bytes`, connectionId, { direction: 'client-to-upstream', bytes: chunk.length, data: chunk.toString('latin1') }));
    upstream.on('data', (chunk) => this.emit('tunnel-data', `Tunnel received ${chunk.length} bytes`, connectionId, { direction: 'upstream-to-client', bytes: chunk.length, data: chunk.toString('latin1') }));
    return true;
  }
}

function mergeHeaders(oldHeaders: Header[], newHeaders: Header[]): Header[] {
  const result = cloneHeaders(oldHeaders);
  for (const item of newHeaders) {
    const previous = result.find((candidate) => candidate.name.toLowerCase() === item.name.toLowerCase());
    if (previous) previous.value = item.value;
    else result.push({ ...item });
  }
  return result;
}

export function createProxyServer(options: ProxyOptions = {}): Server {
  return new ProxyApplication(options).createServer();
}

