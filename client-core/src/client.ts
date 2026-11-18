import dns from 'node:dns';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { HttpCache, conditionalHeaders, merge304 } from './cache.js';
import { basicAuthorization, CookieJar } from './cookies.js';
import { ResponseParser } from './parser.js';
import { getHeader, hasHeader, normalizeHeaders, removeHeader, setHeader, serializeRequest } from './serializer.js';
import type {
  AuthCredentials,
  CacheEntry,
  ConnectionInfo,
  Exchange,
  ExchangeAttempt,
  Header,
  HttpMethod,
  HttpVersion,
  ParsedResponse,
  ProxyOptions,
  RequestOptions,
  SerializedRequest,
  TimelineEvent,
  TunnelSession,
} from './types.js';

type EventSink = (event: TimelineEvent) => void;
type TimelineEmitter = (type: TimelineEvent['type'], message: string, details?: Record<string, unknown>, connectionId?: string) => void;

type PendingResponse = {
  method: string;
  parser: ResponseParser;
  resolve: (response: ParsedResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
  sentAt: number;
};

class RawConnection {
  readonly info: ConnectionInfo;
  private socket?: Socket;
  private connecting?: Promise<void>;
  private pending: PendingResponse[] = [];
  private rawDataListeners = new Set<(chunk: Buffer) => void>();
  private closed = false;
  private onEvent?: EventSink;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly version: HttpVersion,
    private readonly secure: boolean,
    onEvent?: EventSink,
  ) {
    this.info = { id: `tcp-${randomUUID().slice(0, 8)}`, host, port, version, reuseCount: 0, requestCount: 0, open: false };
    this.onEvent = onEvent;
  }

  get isOpen(): boolean {
    return Boolean(this.socket && !this.closed && !this.socket.destroyed);
  }

  get isActive(): boolean {
    return this.isOpen || Boolean(this.connecting);
  }

  async ready(): Promise<void> {
    if (this.isOpen) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const connected = (socket: Socket) => {
        this.socket = socket;
        this.info.socket = socket;
        this.info.open = true;
        this.closed = false;
        socket.setNoDelay(true);
        socket.setTimeout(15_000, () => this.close(new Error('client idle timeout')));
        socket.on('data', (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        socket.on('error', (error) => this.onError(error));
        socket.on('close', () => this.onClose());
        resolve();
      };
      const error = (reason: Error) => {
        this.connecting = undefined;
        reject(reason);
      };
      if (this.secure) {
        const socket = tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: false });
        socket.once('secureConnect', () => connected(socket));
        socket.once('error', error);
      } else {
        const socket = net.createConnection({ host: this.host, port: this.port });
        socket.once('connect', () => connected(socket));
        socket.once('error', error);
      }
    });
    try {
      await this.connecting;
      this.connecting = undefined;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
  }

  async send(request: SerializedRequest, method: string): Promise<ParsedResponse> {
    await this.ready();
    if (!this.socket || this.closed) throw new Error('connection is closed');
    const wasUsed = this.info.requestCount > 0;
    this.info.requestCount += 1;
    if (wasUsed) this.info.reuseCount += 1;
    this.onEvent?.({ id: randomUUID(), type: wasUsed ? 'connection-reused' : 'tcp-connect', at: new Date().toISOString(), elapsedMs: 0, connectionId: this.info.id, message: wasUsed ? `Reused ${this.info.id} (request ${this.info.requestCount})` : `TCP connected to ${this.host}:${this.port}`, details: { reuseCount: this.info.reuseCount, version: this.version } });
    const promise = new Promise<ParsedResponse>((resolve, reject) => {
      this.pending.push({ method, parser: new ResponseParser(method), resolve, reject, settled: false, sentAt: Date.now() });
    });
    this.socket.write(request.bytes);
    return promise;
  }

  writeRaw(data: string | Buffer): void {
    if (!this.socket || this.closed) throw new Error('connection is closed');
    this.socket.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  onRawData(listener: (chunk: Buffer) => void): () => void {
    this.rawDataListeners.add(listener);
    return () => this.rawDataListeners.delete(listener);
  }

  async sendPipeline(requests: Array<{ request: SerializedRequest; method: string }>): Promise<ParsedResponse[]> {
    await this.ready();
    if (!this.socket || this.closed) throw new Error('connection is closed');
    const wasUsed = this.info.requestCount > 0;
    for (const item of requests) {
      this.info.requestCount += 1;
      if (wasUsed || this.info.requestCount > 1) this.info.reuseCount += 1;
      this.pending.push({ method: item.method, parser: new ResponseParser(item.method), resolve: () => undefined, reject: () => undefined, settled: false, sentAt: Date.now() });
    }
    const promises = this.pending.slice(-requests.length).map((pending) => new Promise<ParsedResponse>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    }));
    this.socket.write(Buffer.concat(requests.map((item) => item.request.bytes)));
    return Promise.all(promises);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.info.open = false;
    if (reason) this.onError(reason);
    this.socket?.destroy();
  }

  private onData(chunk: Buffer): void {
    let incoming = chunk;
    while (incoming.length && this.pending.length) {
      const pending = this.pending[0];
      try {
        const response = pending.parser.feed(incoming);
        incoming = pending.parser.takeRemaining();
        if (!response) break;
        this.pending.shift();
        pending.settled = true;
        pending.resolve(response);
        if (response.connectionClose) this.close();
      } catch (error) {
        this.pending.shift();
        pending.settled = true;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (incoming.length && this.pending.length === 0) {
      for (const listener of this.rawDataListeners) listener(Buffer.from(incoming));
    }
  }

  private onError(error: Error): void {
    for (const pending of this.pending.splice(0)) {
      if (!pending.settled) pending.reject(error);
    }
  }

  private onClose(): void {
    this.info.open = false;
    this.closed = true;
    const pending = this.pending.shift();
    if (pending && !pending.settled) {
      try {
        const response = pending.parser.end();
        if (response) pending.resolve(response);
        else pending.reject(new Error('connection closed before response completed'));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const remaining of this.pending.splice(0)) remaining.reject(new Error('connection closed while pipelined responses were pending'));
    this.onEvent?.({ id: randomUUID(), type: 'connection-closed', at: new Date().toISOString(), elapsedMs: 0, connectionId: this.info.id, message: `TCP connection ${this.info.id} closed` });
  }
}

export class HttpClient {
  readonly cookies = new CookieJar();
  readonly cache = new HttpCache();
  private readonly connections = new Map<string, RawConnection>();
  private readonly eventSink?: EventSink;

  constructor(options: { onEvent?: EventSink } = {}) {
    this.eventSink = options.onEvent;
  }

  listConnections(): ConnectionInfo[] {
    return [...this.connections.values()].map((connection) => ({ ...connection.info, socket: undefined }));
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }

  async request(options: RequestOptions): Promise<Exchange> {
    const exchangeId = `exchange-${randomUUID().slice(0, 8)}`;
    const timeline: TimelineEvent[] = [];
    const startedAt = Date.now();
    const emit = (type: TimelineEvent['type'], message: string, details?: Record<string, unknown>, connectionId?: string) => {
      const event: TimelineEvent = { id: randomUUID(), type, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, message, details, connectionId };
      timeline.push(event);
      this.eventSink?.(event);
    };
    const method = (options.method ?? 'GET').toUpperCase() as HttpMethod | string;
    const version = options.version ?? 'HTTP/1.1';
    const attempts: ExchangeAttempt[] = [];
    const redirectChain = [options.url];
    let currentUrl = options.url;
    let currentMethod = method;
    let currentBody = options.body;
    let fromCache = false;
    let cacheRevalidated = false;
    let cacheResponse: ParsedResponse | undefined;
    let lastRequest: SerializedRequest | undefined;
    let lastResponse: ParsedResponse | undefined;
    let lastConnectionId: string | undefined;
    let lastReuseCount: number | undefined;
    const cachePolicy = requestCachePolicy(options.headers);
    let staleEntry = options.cache === true && currentMethod === 'GET' && !cachePolicy.noStore ? this.cache.lookup(currentUrl) : undefined;

    if (staleEntry?.state === 'fresh' && staleEntry.entry && !cachePolicy.revalidate) {
      fromCache = true;
      emit('cache-hit', `Fresh cache entry served without network access for ${currentUrl}`, { remainingMs: staleEntry.remainingMs });
      lastRequest = this.buildRequest({ ...options, url: currentUrl, method: currentMethod, version, body: currentBody }, [] ).request;
      lastResponse = responseFromCache(staleEntry.entry);
      return { id: exchangeId, request: lastRequest, response: lastResponse, attempts, timeline, redirectChain, fromCache, cacheRevalidated, connectionId: lastConnectionId, connectionReuseCount: lastReuseCount };
    }
    if (staleEntry?.entry && (staleEntry.state === 'stale' || cachePolicy.revalidate)) emit('cache-conditional', `${staleEntry.state === 'fresh' ? 'Cache revalidation requested' : 'Stale cache entry'}; conditional request will validate ${currentUrl}`, { etag: staleEntry.entry.etag, lastModified: staleEntry.entry.lastModified });

    const maxRedirects = options.maxRedirects ?? 5;
    let redirectHops = 0;
    let authHeader: string | undefined;
    let proxyAuthHeader: string | undefined;
    let referer: string | undefined;
    while (true) {
      let extraHeaders: Header[] = [];
      if (referer) extraHeaders.push({ name: 'Referer', value: referer });
      if (staleEntry?.entry && (staleEntry.state === 'stale' || cachePolicy.revalidate) && currentMethod === 'GET') extraHeaders = extraHeaders.concat(conditionalHeaders(staleEntry.entry));
      let response: ParsedResponse | undefined;
      let currentAttempt: ExchangeAttempt | undefined;
      for (let challenge = 0; challenge < 2; challenge += 1) {
        const built = this.buildRequest({ ...options, url: currentUrl, method: currentMethod, version, body: currentBody }, extraHeaders, authHeader, proxyAuthHeader);
        lastRequest = built.request;
        currentAttempt = { request: built.request };
        try {
          const result = await this.sendAttempt(built, currentMethod, emit);
          response = result.response;
          lastConnectionId = result.connectionId;
          lastReuseCount = result.reuseCount;
          currentAttempt.response = response;
          currentAttempt.connectionId = result.connectionId;
        } catch (error) {
          currentAttempt.error = error instanceof Error ? error.message : String(error);
          attempts.push(currentAttempt);
          emit('error', currentAttempt.error);
          return { id: exchangeId, request: lastRequest, attempts, timeline, redirectChain, fromCache, cacheRevalidated, connectionId: lastConnectionId, connectionReuseCount: lastReuseCount, error: currentAttempt.error };
        }
        attempts.push(currentAttempt);
        if (options.cookies) this.storeCookies(response, currentUrl, emit);
        if (response.statusCode === 407 && options.proxy?.credentials && !proxyAuthHeader) {
          emit('proxy-auth-challenge', 'Proxy requested Basic authentication (407)', { attempt: attempts.length }, lastConnectionId);
          proxyAuthHeader = basicAuthorization(options.proxy.credentials.username, options.proxy.credentials.password);
          emit('proxy-auth-retry', 'Retrying with Proxy-Authorization; it will not be sent to the origin');
          continue;
        }
        if (response.statusCode === 401 && options.auth && !authHeader) {
          emit('auth-challenge', 'Origin requested Basic authentication (401)', { attempt: attempts.length }, lastConnectionId);
          authHeader = basicAuthorization(options.auth.username, options.auth.password);
          emit('auth-retry', `Retrying with Authorization: Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`, undefined, lastConnectionId);
          continue;
        }
        break;
      }
      if (!response) break;
      lastResponse = response;
      if (response.statusCode === 304 && staleEntry?.entry) {
        const refreshed = this.cache.revalidate(currentUrl, currentMethod, response);
        cacheResponse = merge304(refreshed ?? staleEntry.entry, response);
        cacheRevalidated = true;
        staleEntry = refreshed ? this.cache.lookup(currentUrl, currentMethod) : staleEntry;
        emit('cache-304', `304 Not Modified; reused cached body for ${currentUrl}`, undefined, lastConnectionId);
      } else if (options.cache && !cachePolicy.noStore && currentMethod === 'GET' && response.statusCode === 200) {
        const stored = this.cache.store(currentUrl, currentMethod, response, Date.now(), lastRequest?.headers);
        if (stored) emit('cache-store', `Stored ${currentUrl} in the local cache`, { expiresAt: stored.expiresAt }, lastConnectionId);
      }
      if (!['GET', 'HEAD'].includes(currentMethod)) this.cache.remove(currentUrl, 'GET');
      const location = getHeader(response.headers, 'Location');
      const canRedirect = options.autoRedirect && [301, 302, 303].includes(response.statusCode) && location;
      if (canRedirect && redirectHops < maxRedirects) {
        const nextUrl = new URL(location!, currentUrl).toString();
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) authHeader = undefined;
        emit('redirect-followed', `${response.statusCode} followed to ${nextUrl}`, { from: currentUrl, to: nextUrl }, lastConnectionId);
        referer = currentUrl;
        currentUrl = nextUrl;
        redirectChain.push(nextUrl);
        redirectHops += 1;
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        staleEntry = options.cache && currentMethod === 'GET' && !cachePolicy.noStore ? this.cache.lookup(currentUrl) : undefined;
        continue;
      }
      if (canRedirect && redirectHops >= maxRedirects) emit('error', `Redirect limit of ${maxRedirects} reached`, { chain: redirectChain }, lastConnectionId);
      break;
    }
    return { id: exchangeId, request: lastRequest!, response: lastResponse, cacheResponse, attempts, timeline, redirectChain, fromCache, cacheRevalidated, connectionId: lastConnectionId, connectionReuseCount: lastReuseCount };
  }

  async pipeline(requests: RequestOptions[]): Promise<Exchange[]> {
    if (!requests.length) return [];
    const first = requests[0];
    const version = first.version ?? 'HTTP/1.1';
    if (version !== 'HTTP/1.1') throw new Error('HTTP pipelining requires HTTP/1.1 persistent connections');
    const firstUrl = new URL(first.url);
    const firstProxy = first.proxy?.enabled === false ? undefined : first.proxy;
    const endpointKey = (url: URL, proxy?: ProxyOptions) => `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}|${proxy ? `${proxy.host}:${proxy.port}` : 'direct'}`;
    const firstEndpoint = endpointKey(firstUrl, firstProxy);
    for (const options of requests) {
      if ((options.version ?? version) !== version) throw new Error('All pipelined requests must use the same HTTP version');
      const url = new URL(options.url);
      const proxy = options.proxy?.enabled === false ? undefined : options.proxy;
      if (endpointKey(url, proxy) !== firstEndpoint) throw new Error('All pipelined requests must target the same origin and proxy endpoint');
    }
    const built = requests.map((options) => this.buildRequest({ ...options, version }, []));
    if (built.some((item) => getHeader(item.request.headers, 'Connection')?.toLowerCase().split(',').map((value) => value.trim()).includes('close'))) throw new Error('Pipelined requests must keep the connection alive');
    const target = built[0].target;
    const proxy = first.proxy?.enabled === false ? undefined : first.proxy;
    const connection = await this.connectionFor(target, version, proxy, built[0].secure, built[0].host, built[0].port);
    const responses = await connection.sendPipeline(built.map((item, index) => ({ request: item.request, method: (requests[index].method ?? 'GET').toUpperCase() })));
    return responses.map((response, index) => {
      const timeline: TimelineEvent[] = [{ id: randomUUID(), type: 'request-sent', at: new Date().toISOString(), elapsedMs: 0, connectionId: connection.info.id, message: `Pipelined request ${index + 1} sent` }, { id: randomUUID(), type: 'headers-received', at: new Date().toISOString(), elapsedMs: 0, connectionId: connection.info.id, message: `Response ${index + 1}: ${response.statusCode} ${response.reason}` }, { id: randomUUID(), type: 'body-complete', at: new Date().toISOString(), elapsedMs: 0, connectionId: connection.info.id, message: `Response ${index + 1} body complete` }];
      return { id: `exchange-${randomUUID().slice(0, 8)}`, request: built[index].request, response, attempts: [{ request: built[index].request, response, connectionId: connection.info.id }], timeline, redirectChain: [requests[index].url], fromCache: false, cacheRevalidated: false, connectionId: connection.info.id, connectionReuseCount: connection.info.reuseCount };
    });
  }

  async openTunnel(options: RequestOptions): Promise<TunnelSession> {
    if ((options.method ?? 'CONNECT').toUpperCase() !== 'CONNECT') throw new Error('openTunnel requires method CONNECT');
    if (!options.proxy || options.proxy.enabled === false) throw new Error('CONNECT requires the proxy setting');
    const version = options.version ?? 'HTTP/1.1';
    let proxyAuthorization: string | undefined;
    let built = this.buildRequest({ ...options, method: 'CONNECT', version }, [], undefined, proxyAuthorization);
    let connection = await this.connectionFor(built.target, version, built.proxy, built.secure, built.host, built.port, undefined, false);
    let response = await connection.send(built.request, 'CONNECT');
    if (response.statusCode === 407 && options.proxy.credentials) {
      proxyAuthorization = basicAuthorization(options.proxy.credentials.username, options.proxy.credentials.password);
      built = this.buildRequest({ ...options, method: 'CONNECT', version }, [], undefined, proxyAuthorization);
      if (!connection.isOpen) connection = await this.connectionFor(built.target, version, built.proxy, built.secure, built.host, built.port, undefined, false);
      response = await connection.send(built.request, 'CONNECT');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`CONNECT failed: ${response.statusCode} ${response.reason}`);
    const tunnelId = `tunnel-${randomUUID().slice(0, 8)}`;
    return {
      id: tunnelId,
      connectionId: connection.info.id,
      response,
      send: (data) => connection.writeRaw(data),
      onData: (listener) => connection.onRawData(listener),
      close: () => connection.close(),
    };
  }

  private buildRequest(options: RequestOptions, extraHeaders: Header[], authHeader?: string, proxyAuthHeader?: string): { request: SerializedRequest; target: string; host: string; port: number; secure: boolean; proxy?: ProxyOptions } {
    const url = new URL(options.url);
    const version = options.version ?? 'HTTP/1.1';
    const headers = normalizeHeaders(options.headers);
    for (const header of extraHeaders) {
      if (!hasHeader(headers, header.name)) headers.push({ ...header });
    }
    const proxy = options.proxy?.enabled === false ? undefined : options.proxy;
    const usingProxy = Boolean(proxy && url.protocol === 'http:');
    const target = usingProxy ? url.toString() : `${url.pathname || '/'}${url.search}`;
    if (!hasHeader(headers, 'Host')) setHeader(headers, 'Host', url.host);
    if (!hasHeader(headers, 'Connection')) setHeader(headers, 'Connection', version === 'HTTP/1.1' ? 'keep-alive' : 'close');
    if (options.cookies) {
      const cookie = this.cookies.headerFor(options.url);
      if (cookie && !hasHeader(headers, 'Cookie')) {
        setHeader(headers, 'Cookie', cookie);
      }
    }
    if (authHeader) setHeader(headers, 'Authorization', authHeader);
    if (usingProxy && proxyAuthHeader) setHeader(headers, 'Proxy-Authorization', proxyAuthHeader);
    if (!usingProxy) removeHeader(headers, 'Proxy-Authorization');
    const request = serializeRequest((options.method ?? 'GET').toUpperCase(), options.method?.toUpperCase() === 'CONNECT' ? `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}` : target, version, headers, options.body);
    return { request, target, host: usingProxy ? proxy!.host : url.hostname, port: usingProxy ? proxy!.port : Number(url.port || (url.protocol === 'https:' ? 443 : 80)), secure: !usingProxy && url.protocol === 'https:', proxy };
  }

  private async sendAttempt(built: { request: SerializedRequest; target: string; host: string; port: number; secure: boolean; proxy?: ProxyOptions }, method: string, emit: TimelineEmitter): Promise<{ response: ParsedResponse; connectionId: string; reuseCount: number }> {
    const requestVersion = (built.request.requestLine.match(/(HTTP\/\d\.\d)$/)?.[1] ?? 'HTTP/1.1') as HttpVersion;
    const connectionHeader = (getHeader(built.request.headers, 'Connection') ?? '').toLowerCase();
    const reusable = requestVersion === 'HTTP/1.1' ? !connectionHeader.includes('close') : connectionHeader.includes('keep-alive');
    const connection = await this.connectionFor(built.target, requestVersion, built.proxy, built.secure, built.host, built.port, emit, reusable);
    const wasUsed = connection.info.requestCount > 0;
    emit(wasUsed ? 'connection-reused' : 'tcp-connect', wasUsed ? `Reused ${connection.info.id}` : `TCP connected to ${built.host}:${built.port}`, { reuseCount: connection.info.reuseCount, version: requestVersion }, connection.info.id);
    const cookie = getHeader(built.request.headers, 'Cookie');
    if (cookie) emit('cookie-sent', `Sent Cookie header (${cookie.split(';').length} cookie${cookie.includes(';') ? 's' : ''})`, undefined, connection.info.id);
    emit('request-sent', `Sent ${built.request.requestLine}`, { raw: built.request.raw }, connection.info.id);
    const response = await connection.send(built.request, method);
    emit('first-byte', `First response byte received from ${connection.info.id}`, undefined, connection.info.id);
    emit('headers-received', `Received ${response.version} ${response.statusCode} ${response.reason}`, { headers: response.headers }, connection.info.id);
    response.compressedBody = Buffer.from(response.body);
    response.decodedBody = this.decodeBody(response, emit, connection.info.id);
    emit('body-complete', `Response body complete (${response.decodedBody.length} decoded bytes)`, { compressedBytes: response.compressedBody.length, decodedBytes: response.decodedBody.length, chunks: response.chunks.length }, connection.info.id);
    if (!response.connectionClose && !getHeader(built.request.headers, 'Connection')?.toLowerCase().includes('close')) emit('connection-kept-alive', `${connection.info.id} remains available for reuse`, undefined, connection.info.id);
    else emit('connection-closed', `${connection.info.id} will close after this exchange`, undefined, connection.info.id);
    return { response, connectionId: connection.info.id, reuseCount: connection.info.reuseCount };
  }

  private async connectionFor(
    target: string,
    version: HttpVersion,
    proxy: ProxyOptions | undefined,
    secureOverride?: boolean,
    originHost?: string,
    originPort?: number,
    emitter?: TimelineEmitter,
    reusable = true,
  ): Promise<RawConnection> {
    const url = /^https?:\/\//i.test(target) ? new URL(target) : undefined;
    const direct = proxy?.enabled === false || !proxy;
    const host = direct ? (originHost ?? url?.hostname ?? this.hostFromTarget(target)) : proxy.host;
    const port = direct ? (originPort ?? (url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : this.portFromTarget(target))) : proxy.port;
    const secure = secureOverride ?? Boolean(url?.protocol === 'https:' && (!proxy || proxy.enabled === false));
    const key = `${secure ? 'tls' : 'tcp'}://${host}:${port}/${version}/${direct ? 'direct' : 'proxy'}`;
    let connection = reusable ? this.connections.get(key) : undefined;
    if (!connection || !connection.isActive) {
      connection = new RawConnection(host, port, version, secure, this.eventSink);
      if (reusable) this.connections.set(key, connection);
      try {
        const address = await dns.promises.lookup(host);
        const message = `Resolved ${host} to ${address.address}`;
        this.eventSink?.({ id: randomUUID(), type: 'dns-lookup', at: new Date().toISOString(), elapsedMs: 0, message, details: { host, address: address.address, family: address.family } });
        emitter?.('dns-lookup', message, { host, address: address.address, family: address.family });
      } catch {
        const message = `DNS lookup failed for ${host}`;
        this.eventSink?.({ id: randomUUID(), type: 'dns-lookup', at: new Date().toISOString(), elapsedMs: 0, message, details: { host } });
        emitter?.('dns-lookup', message, { host });
      }
    }
    return connection;
  }

  private hostFromTarget(target: string): string {
    const host = target.split('/')[0]?.split(':')[0];
    return host || '127.0.0.1';
  }

  private portFromTarget(target: string): number {
    const match = target.match(/:(\d+)/);
    return match ? Number(match[1]) : 80;
  }

  private decodeBody(response: ParsedResponse, emit: TimelineEmitter, connectionId: string): Buffer {
    const encoding = getHeader(response.headers, 'Content-Encoding')?.toLowerCase();
    if (encoding?.includes('gzip')) {
      try {
        return zlib.gunzipSync(response.body);
      } catch {
        emit('error', 'Content-Encoding gzip was advertised but decompression failed', undefined, connectionId);
      }
    }
    return Buffer.from(response.body);
  }

  private storeCookies(response: ParsedResponse, url: string, emit: TimelineEmitter): void {
    for (const cookie of this.cookies.store(response.headers, url)) emit('cookie-stored', `Stored cookie ${cookie.name}`, { cookie: { ...cookie, value: '[redacted in timeline]' } });
  }
}

function resultConnection(response: ParsedResponse): string | undefined {
  return response.headers.find((header) => header.name.toLowerCase() === 'connection')?.value;
}

function responseFromCache(entry: CacheEntry): ParsedResponse {
  const decodedBody = Buffer.from(entry.body);
  const compressedBody = Buffer.from(entry.compressedBody ?? entry.body);
  return { version: entry.version ?? 'HTTP/1.1', statusCode: entry.statusCode, reason: entry.reason, headers: entry.headers.map((header) => ({ ...header })), body: compressedBody, raw: Buffer.alloc(0), rawHeaders: Buffer.alloc(0), chunks: [], trailers: [], complete: true, connectionClose: false, usedChunked: false, compressedBody, decodedBody };
}

function requestCachePolicy(input?: Header[] | Record<string, string>): { revalidate: boolean; noStore: boolean } {
  const headers = normalizeHeaders(input);
  const cacheControl = getHeader(headers, 'Cache-Control') ?? '';
  const directives = cacheControl.split(',').map((value) => value.trim().toLowerCase());
  const pragma = (getHeader(headers, 'Pragma') ?? '').toLowerCase().split(',').map((value) => value.trim());
  return {
    revalidate: directives.some((value) => /^no-cache(?:\s*=|\s*;|$)/.test(value) || /^max-age\s*=\s*0(?:\s*;|$)/.test(value)) || pragma.includes('no-cache'),
    noStore: directives.some((value) => /^no-store(?:\s*;|$)/.test(value)),
  };
}

export function visibleWire(value: Buffer | string): string {
  const text = Buffer.isBuffer(value) ? value.toString('latin1') : value;
  return text.replace(/\r/g, '␍').replace(/\n/g, '␊\n');
}

export function formatBasicStep(credentials: AuthCredentials): { plain: string; base64: string; header: string; note: string } {
  const plain = `${credentials.username}:${credentials.password}`;
  const base64 = Buffer.from(plain, 'utf8').toString('base64');
  return { plain, base64, header: `Basic ${base64}`, note: 'Base64 is not encryption: no confidentiality' };
}
