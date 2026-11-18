import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import net, { type Server, type Socket } from 'node:net';
import { parseHttpRequest, ProtocolError, reasonPhrase, serializeChunkedResponse, serializeResponse, getHeader, header, cloneHeaders, requestKeepAlive, setHeader } from './protocol.js';
import type { Header, OriginOptions, ParsedRequest, ResponseSpec, ServerEvent, ServerEventSink } from './types.js';

type OriginResult = ResponseSpec & { chunkDelays?: number[] };
type Item = { id: string; title: string; body: string; updatedAt: string };

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'CONNECT', 'TRACE']);
const LOGIN_USERNAME = 'mohamed';
const LOGIN_PASSWORD = 'hkm4c';
const SESSION_COOKIE = 'SESSID';

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
};

const JPEG_1X1 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIAAwAAAB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIAAwAAAB//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8hP//Z', 'base64');
const SUNSET_JPEG = Buffer.from(JPEG_1X1);
SUNSET_JPEG[20] = 0x7a;

function nowDate(): Date {
  return new Date();
}

function httpDate(value: Date | number = nowDate()): string {
  return new Date(value).toUTCString();
}

function entityTag(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('hex').slice(0, 12)}"`;
}

function queryValue(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

function bytes(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function jsonBody(value: unknown): Buffer {
  return bytes(`${JSON.stringify(value, null, 2)}\n`);
}

function formBody(body: Buffer): URLSearchParams {
  return new URLSearchParams(body.toString('utf8'));
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function basicCredentials(value: string | undefined): { username: string; password: string } | undefined {
  if (!value || !/^Basic\s+/i.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return undefined;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return undefined;
  }
}

function cookieValue(headers: Header[], name: string): string | undefined {
  const cookie = getHeader(headers, 'Cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0 && part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return undefined;
}

function makePage(): Buffer {
  return bytes(`<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>HTTP Lab resource</title></head>
<body>
  <h1>HTTP Lab</h1>
  <p>Cette page est servie par le serveur HTTP écrit sur des sockets TCP.</p>
  <p>Observe la ligne de requête, les en-têtes, les octets et la réutilisation TCP.</p>
  <img src="/static/soleil.jpg" alt="soleil">
  <img src="/static/lune.jpg" alt="lune">
  <p><a href="/static/readme.txt">readme.txt</a> · <a href="/static/notes.txt">notes.txt</a></p>
</body>
</html>\n`);
}

function makeResourceHeaders(body: Buffer, type: string, lastModified: Date, etag: string, maxAge = 60): Header[] {
  return [
    header('Content-Type', type),
    header('Last-Modified', httpDate(lastModified)),
    header('ETag', etag),
    header('Cache-Control', `public, max-age=${maxAge}`),
    header('Expires', httpDate(Date.now() + maxAge * 1000)),
    header('Accept-Ranges', 'bytes'),
    header('Content-Length', String(body.length)),
  ];
}

function methodNotAllowed(allow: string): OriginResult {
  return { statusCode: 405, headers: [header('Allow', allow)], body: bytes('405 Method Not Allowed\n') };
}

function notFound(): OriginResult {
  return { statusCode: 404, body: bytes('404 Not Found\n') };
}

function representation(request: ParsedRequest, body: Buffer, type: string, modified: Date, etag: string, maxAge = 60): OriginResult {
  const headers = makeResourceHeaders(body, type, modified, etag, maxAge);
  const ifMatch = getHeader(request.headers, 'If-Match');
  if (ifMatch && ifMatch !== '*' && !ifMatch.split(',').map((item) => item.trim()).includes(etag)) {
    return { statusCode: 412, headers: [header('ETag', etag)], body: bytes('412 Precondition Failed\n') };
  }
  const noneMatch = getHeader(request.headers, 'If-None-Match');
  const matchesTag = noneMatch === '*' || Boolean(noneMatch?.split(',').map((item) => item.trim()).includes(etag));
  const since = getHeader(request.headers, 'If-Modified-Since');
  const matchesDate = since !== undefined && !Number.isNaN(Date.parse(since)) && Math.floor(modified.getTime() / 1000) <= Math.floor(Date.parse(since) / 1000);
  if (matchesTag || (!noneMatch && matchesDate)) {
    return { statusCode: 304, headers: headers.filter((item) => item.name.toLowerCase() !== 'content-length'), body: Buffer.alloc(0) };
  }
  const range = getHeader(request.headers, 'Range');
  if (range && request.method !== 'POST') {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return { statusCode: 416, headers: [header('Content-Range', `bytes */${body.length}`)], body: bytes('416 Range Not Satisfiable\n') };
    let start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
    let end = match[2] ? Number(match[2]) : body.length - 1;
    if (!match[1]) start = Math.max(0, body.length - Number(match[2]));
    if (start < 0 || start >= body.length || end < start) return { statusCode: 416, headers: [header('Content-Range', `bytes */${body.length}`)], body: bytes('416 Range Not Satisfiable\n') };
    end = Math.min(end, body.length - 1);
    const part = body.subarray(start, end + 1);
    return { statusCode: 206, headers: headers.map((item) => item.name.toLowerCase() === 'content-length' ? header('Content-Length', String(part.length)) : item).concat([header('Content-Range', `bytes ${start}-${end}/${body.length}`)]), body: part };
  }
  return { statusCode: 200, headers, body };
}

function responseText(statusCode: number, text: string, headers: Header[] = []): OriginResult {
  return { statusCode, headers, body: bytes(text) };
}

function allowedMethod(method: string, allowed: string): OriginResult | undefined {
  if (KNOWN_METHODS.has(method) && !allowed.split(',').map((item) => item.trim()).includes(method)) return methodNotAllowed(allowed);
  return undefined;
}

function routeUrl(target: string): URL {
  if (/^https?:\/\//i.test(target)) return new URL(target);
  return new URL(target, 'http://127.0.0.1');
}

function statusResult(code: number, request: ParsedRequest): OriginResult {
  if (code >= 100 && code < 200) {
    if (request.version !== 'HTTP/1.1') return responseText(200, `${code} informational responses are only sent for HTTP/1.1 requests\n`);
    return { statusCode: 200, body: bytes(`The server emitted an interim ${code} response for this HTTP/1.1 request.\n`), interim: [{ statusCode: code, reason: STATUS_TEXT[code] ?? reasonPhrase(code) }] };
  }
  const headers: Header[] = [];
  if (code >= 300 && code < 400) headers.push(header('Location', code === 300 ? '/?choice=one' : '/'));
  if (code === 401) headers.push(header('WWW-Authenticate', 'Basic realm="isims"'));
  if (code === 407) headers.push(header('Proxy-Authenticate', 'Basic realm="isims"'));
  if (code === 405) headers.push(header('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, TRACE'));
  if (code === 206) headers.push(header('Content-Range', 'bytes 0-4/5'));
  if (code === 503) headers.push(header('Retry-After', '5'));
  return { statusCode: code, headers, body: bytes(`${code} ${STATUS_TEXT[code] ?? reasonPhrase(code)}\n`) };
}

export class OriginApplication {
  private readonly serverName: string;
  private readonly keepAliveTimeoutMs: number;
  private readonly maxRequestsPerConnection: number;
  private readonly onEvent?: ServerEventSink;
  private readonly sessions = new Map<string, { username: string; createdAt: number }>();
  private readonly items = new Map<string, Item>();
  private readonly deletedItems = new Set<string>();
  private itemSequence = 3;
  private readonly pageBody = makePage();
  private readonly pageModified = new Date(Date.now() - 60_000);
  private readonly resources = new Map<string, { body: Buffer; type: string; modified: Date; etag: string; maxAge: number }>();

  constructor(options: OriginOptions = {}) {
    this.serverName = options.serverName ?? 'HTTP-Lab-Origin/0.1';
    this.keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? 5_000;
    this.maxRequestsPerConnection = options.maxRequestsPerConnection ?? 100;
    this.onEvent = options.onEvent;
    this.items.set('1', { id: '1', title: 'Premier item', body: 'Créé pour le cours HTTP', updatedAt: new Date().toISOString() });
    this.items.set('2', { id: '2', title: 'Deuxième item', body: 'PUT, PATCH et DELETE', updatedAt: new Date().toISOString() });
    this.resources.set('/', { body: this.pageBody, type: 'text/html; charset=utf-8', modified: this.pageModified, etag: entityTag(this.pageBody), maxAge: 30 });
    this.resources.set('/index.html', { body: this.pageBody, type: 'text/html; charset=utf-8', modified: this.pageModified, etag: entityTag(this.pageBody), maxAge: 30 });
    this.resources.set('/static/soleil.jpg', { body: JPEG_1X1, type: 'image/jpeg', modified: this.pageModified, etag: entityTag(JPEG_1X1), maxAge: 120 });
    this.resources.set('/static/lune.jpg', { body: SUNSET_JPEG, type: 'image/jpeg', modified: this.pageModified, etag: entityTag(SUNSET_JPEG), maxAge: 120 });
    this.resources.set('/static/readme.txt', { body: bytes('Ce fichier est servi comme une ressource statique.\n'), type: 'text/plain; charset=utf-8', modified: this.pageModified, etag: entityTag(bytes('Ce fichier est servi comme une ressource statique.\n')), maxAge: 120 });
    this.resources.set('/static/notes.txt', { body: bytes('Observe Last-Modified, ETag, Range et Cache-Control.\n'), type: 'text/plain; charset=utf-8', modified: this.pageModified, etag: entityTag(bytes('Observe Last-Modified, ETag, Range et Cache-Control.\n')), maxAge: 120 });
    const courseText = bytes('Chapitre II: Protocole HTTP\nObserve Last-Modified, ETag, Range et Cache-Control.\n');
    this.resources.set('/static/course.txt', { body: courseText, type: 'text/plain; charset=utf-8', modified: this.pageModified, etag: entityTag(courseText), maxAge: 60 });
    const etagText = bytes('This resource is intentionally stable so If-None-Match is easy to observe.\n');
    this.resources.set('/static/etag.txt', { body: etagText, type: 'text/plain; charset=utf-8', modified: this.pageModified, etag: entityTag(etagText), maxAge: 60 });
  }

  createServer(): Server {
    return net.createServer((socket) => this.attach(socket));
  }

  get portDefaults(): { keepAliveTimeoutMs: number; maxRequestsPerConnection: number } {
    return { keepAliveTimeoutMs: this.keepAliveTimeoutMs, maxRequestsPerConnection: this.maxRequestsPerConnection };
  }

  private emit(type: string, message: string, connectionId?: string, details?: Record<string, unknown>): void {
    const event: ServerEvent = { id: randomUUID(), at: new Date().toISOString(), service: 'origin', type, connectionId, message, details };
    this.onEvent?.(event);
  }

  private attach(socket: Socket): void {
    const connectionId = `origin-${randomUUID().slice(0, 8)}`;
    let buffer = Buffer.alloc(0);
    let requestCount = 0;
    let processing = false;
    let closed = false;
    const remotePort = socket.remotePort;
    const close = () => {
      if (closed) return;
      closed = true;
      this.emit('connection-closed', `Origin connection ${connectionId} closed`, connectionId, { requestCount, remotePort });
    };
    const sendTimeout = () => {
      if (closed || !buffer.length) {
        socket.destroy();
        return;
      }
      this.emit('request-timeout', `Partial request timed out on ${connectionId}`, connectionId, { bytesBuffered: buffer.length });
      const response = this.standardize('HTTP/1.1', { statusCode: 408, body: bytes('408 Request Timeout\n') }, true, false);
      socket.end(response);
      buffer = Buffer.alloc(0);
    };
    socket.setTimeout(this.keepAliveTimeoutMs, sendTimeout);
    socket.on('data', (chunk) => {
      if (closed) return;
      socket.setTimeout(this.keepAliveTimeoutMs, sendTimeout);
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
            const version = buffer.toString('latin1').match(/^\S+\s+\S+\s+(HTTP\/\d+\.\d+)/)?.[1] ?? 'HTTP/1.1';
            const status = protocolError.code === 'UNSUPPORTED_VERSION' ? 505 : 400;
            const response = this.standardize('HTTP/1.1', { statusCode: status, body: bytes(`${status} ${reasonPhrase(status)}: ${protocolError.message}\n`) }, true, false);
            this.emit('response-sent', `HTTP ${status} sent for malformed request`, connectionId, { rawResponse: response.toString('latin1'), error: protocolError.message, requestVersion: version });
            socket.end(response);
            closed = true;
            break;
          }
          if (!request) break;
          buffer = buffer.subarray(request.consumed);
          requestCount += 1;
          this.emit('request-received', `${request.method} ${request.target} on ${connectionId}`, connectionId, { rawRequest: request.raw.toString('latin1'), requestCount, remotePort });
          const result = await this.route(request);
          const mustClose = !requestKeepAlive(request.version, request.headers) || requestCount >= this.maxRequestsPerConnection;
          const rawResponse = await this.writeResponse(socket, request.version, request, result, mustClose);
          this.emit('response-sent', `${request.method} ${request.target} -> ${result.statusCode}`, connectionId, { rawResponse: rawResponse.toString('latin1'), requestCount, connectionReuseCount: Math.max(0, requestCount - 1), close: mustClose });
          if (mustClose) {
            closed = true;
            break;
          }
          socket.setTimeout(this.keepAliveTimeoutMs, sendTimeout);
        }
      } finally {
        processing = false;
      }
    };
  }

  private standardize(version: string, result: OriginResult, close: boolean, head: boolean): Buffer {
    const body = result.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(result.body) ? result.body : bytes(result.body);
    const headers = cloneHeaders(result.headers);
    const noBodyStatus = (result.statusCode >= 100 && result.statusCode < 200) || result.statusCode === 204 || result.statusCode === 304 || result.statusCode === 205;
    setHeader(headers, 'Date', httpDate());
    setHeader(headers, 'Server', this.serverName);
    if (!headers.some((item) => item.name.toLowerCase() === 'content-type')) setHeader(headers, 'Content-Type', 'text/plain; charset=utf-8');
    if (result.chunks) {
      if (head) {
        setHeader(headers, 'Content-Length', String(result.chunks.reduce((total, item) => total + (Buffer.isBuffer(item.data) ? item.data.length : Buffer.byteLength(item.data)), 0)));
        const transferIndex = headers.findIndex((item) => item.name.toLowerCase() === 'transfer-encoding');
        if (transferIndex >= 0) headers.splice(transferIndex, 1);
        setHeader(headers, 'Connection', close ? 'close' : 'keep-alive');
        if (!close) setHeader(headers, 'Keep-Alive', `timeout=${Math.floor(this.keepAliveTimeoutMs / 1000)}, max=${this.maxRequestsPerConnection}`);
        return serializeResponse(version, { ...result, headers, body: Buffer.alloc(0), chunks: undefined });
      }
      setHeader(headers, 'Connection', close ? 'close' : 'keep-alive');
      if (!close) setHeader(headers, 'Keep-Alive', `timeout=${Math.floor(this.keepAliveTimeoutMs / 1000)}, max=${this.maxRequestsPerConnection}`);
      return serializeChunkedResponse(version, { ...result, headers });
    }
    if (head) setHeader(headers, 'Content-Length', String(body.length));
    else if (noBodyStatus) setHeader(headers, 'Content-Length', '0');
    setHeader(headers, 'Connection', close ? 'close' : 'keep-alive');
    if (!close) setHeader(headers, 'Keep-Alive', `timeout=${Math.floor(this.keepAliveTimeoutMs / 1000)}, max=${this.maxRequestsPerConnection}`);
    return serializeResponse(version, { ...result, headers, body: head || noBodyStatus ? Buffer.alloc(0) : body });
  }

  private async writeResponse(socket: Socket, requestVersion: string, request: ParsedRequest, result: OriginResult, close: boolean): Promise<Buffer> {
    const version = requestVersion === 'HTTP/1.0' || requestVersion === 'HTTP/1.1' ? requestVersion : 'HTTP/1.1';
    const interim = result.interim ?? [];
    const interimBytes = interim.length && requestVersion === 'HTTP/1.1'
      ? Buffer.concat(interim.map((item) => this.standardizeInterim(version, item)))
      : Buffer.alloc(0);
    if (result.chunkDelays && result.chunks && request.method !== 'HEAD') {
      const headers = cloneHeaders(result.headers);
      setHeader(headers, 'Date', httpDate());
      setHeader(headers, 'Server', this.serverName);
      setHeader(headers, 'Connection', close ? 'close' : 'keep-alive');
      if (!close) setHeader(headers, 'Keep-Alive', `timeout=${Math.floor(this.keepAliveTimeoutMs / 1000)}, max=${this.maxRequestsPerConnection}`);
      setHeader(headers, 'Transfer-Encoding', 'chunked');
      if (!headers.some((item) => item.name.toLowerCase() === 'content-type')) setHeader(headers, 'Content-Type', 'text/plain; charset=utf-8');
      const head = Buffer.from(`${version} ${result.statusCode} ${result.reason ?? reasonPhrase(result.statusCode)}\r\n${headers.map((item) => `${item.name}: ${item.value}\r\n`).join('')}\r\n`, 'latin1');
      socket.write(Buffer.concat([interimBytes, head]));
      const sent: Buffer[] = [head];
      for (let index = 0; index < result.chunks.length; index += 1) {
        const delay = result.chunkDelays[index] ?? 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const chunkData = result.chunks[index].data;
        const data = typeof chunkData === 'string' ? bytes(chunkData) : Buffer.from(chunkData);
        const chunk = Buffer.concat([Buffer.from(`${data.length.toString(16)}${result.chunks[index].extension ? `; ${result.chunks[index].extension}` : ''}\r\n`, 'latin1'), data, Buffer.from('\r\n', 'latin1')]);
        socket.write(chunk);
        sent.push(chunk);
      }
      const final = Buffer.concat([Buffer.from('0\r\n', 'latin1'), Buffer.from((result.trailers ?? []).map((item) => `${item.name}: ${item.value}\r\n`).join(), 'latin1'), Buffer.from('\r\n', 'latin1')]);
      socket.write(final);
      sent.push(final);
      if (close) socket.end();
      return Buffer.concat([interimBytes, ...sent]);
    }
    const raw = Buffer.concat([interimBytes, this.standardize(version, result, close, request.method === 'HEAD')]);
    socket.write(raw);
    if (close) socket.end();
    return raw;
  }

  private standardizeInterim(version: string, interim: { statusCode: number; reason?: string; headers?: Header[] }): Buffer {
    const headers = cloneHeaders(interim.headers);
    setHeader(headers, 'Date', httpDate());
    setHeader(headers, 'Server', this.serverName);
    return Buffer.from(`${version} ${interim.statusCode} ${interim.reason ?? reasonPhrase(interim.statusCode)}\r\n${headers.map((item) => `${item.name}: ${item.value}\r\n`).join()}\r\n`, 'latin1');
  }

  private async route(request: ParsedRequest): Promise<OriginResult> {
    if (!KNOWN_METHODS.has(request.method)) return responseText(501, '501 Not Implemented\n');
    if (!/^HTTP\/(1\.0|1\.1)$/.test(request.version)) return responseText(505, '505 HTTP Version Not Supported\n');
    if (request.version === 'HTTP/1.1' && !getHeader(request.headers, 'Host')) return responseText(400, '400 Bad Request: Host is required in HTTP/1.1\n');
    if (request.method === 'TRACE') return { statusCode: 200, headers: [header('Content-Type', 'message/http')], body: request.raw };
    if (request.method === 'CONNECT') return methodNotAllowed('GET, HEAD, POST, PUT, PATCH, DELETE, TRACE');

    const url = routeUrl(request.target);
    const pathname = url.pathname;
    if (pathname === '/admin') return responseText(403, '403 Forbidden: /admin is disabled\n');

    if (pathname === '/login.cgi') {
      const notAllowed = allowedMethod(request.method, 'POST');
      if (notAllowed) return notAllowed;
      const form = formBody(request.body);
      if (form.get('username') !== LOGIN_USERNAME || form.get('password') !== LOGIN_PASSWORD) return responseText(401, '401 Unauthorized\n', [header('WWW-Authenticate', 'Basic realm="isims"')]);
      const sessionId = randomUUID().replaceAll('-', '');
      this.sessions.set(sessionId, { username: LOGIN_USERNAME, createdAt: Date.now() });
      const expires = httpDate(Date.now() + 60 * 60 * 1000);
      return { statusCode: 201, headers: [header('Location', '/private/home'), header('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; Expires=${expires}`), header('Content-Type', 'text/html; charset=utf-8')], body: bytes('<p>Login successful. <a href="/private/home">Continue</a></p>\n') };
    }

    if (pathname === '/private/home') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const sessionId = cookieValue(request.headers, SESSION_COOKIE);
      if (!sessionId || !this.sessions.has(sessionId)) return responseText(401, '401 Unauthorized: login required\n', [header('WWW-Authenticate', 'Basic realm="isims"')]);
      return representation(request, bytes('<!doctype html><html><body><h1>Private home</h1><p>Cookie accepted.</p></body></html>\n'), 'text/html; charset=utf-8', this.pageModified, '"private-home-v1"', 15);
    }

    if (pathname === '/protected' || pathname.startsWith('/protected/')) {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const credentials = basicCredentials(getHeader(request.headers, 'Authorization'));
      if (!credentials || credentials.username !== LOGIN_USERNAME || credentials.password !== LOGIN_PASSWORD) return responseText(401, '401 Unauthorized: Basic authentication required\n', [header('WWW-Authenticate', 'Basic realm="isims"')]);
      return representation(request, bytes('<!doctype html><html><body><h1>Protected resource</h1><p>Basic credentials accepted.</p></body></html>\n'), 'text/html; charset=utf-8', this.pageModified, '"protected-v1"', 15);
    }

    if (pathname === '/items' || pathname.startsWith('/items/')) return this.itemsRoute(request, pathname);

    if (pathname === '/old' || pathname === '/temp' || pathname === '/see-other' || pathname === '/loop' || pathname === '/multiple') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      if (pathname === '/old') return responseText(301, '301 Moved Permanently\n', [header('Location', '/')]);
      if (pathname === '/temp') return responseText(302, '302 Found\n', [header('Location', '/')]);
      if (pathname === '/see-other') return responseText(303, '303 See Other\n', [header('Location', '/')]);
      if (pathname === '/loop') return responseText(301, '301 redirect loop\n', [header('Location', '/loop')]);
      return responseText(300, '300 Multiple Choices\n', [header('Location', '/?choice=one'), header('Content-Type', 'text/html; charset=utf-8')]);
    }

    if (pathname === '/chunked') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      return { statusCode: 200, headers: [header('Content-Type', 'text/plain; charset=utf-8')], chunks: [{ data: 'ZYXWVT', extension: 'bonjour' }, { data: '0123456789ABCDEF' }] };
    }

    if (pathname === '/stream') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      return { statusCode: 200, headers: [header('Content-Type', 'text/plain; charset=utf-8')], chunks: [{ data: 'first\n' }, { data: 'second\n' }, { data: 'third\n' }], chunkDelays: [0, 250, 250], trailers: [header('X-Stream-Trailer', 'complete')] };
    }

    if (pathname === '/negotiate') return this.negotiateRoute(request);

    if (pathname === '/gzip') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const plain = bytes('This representation can be compressed by the HTTP Lab server.\n');
      const accepts = getHeader(request.headers, 'Accept-Encoding') ?? '';
      if (/(^|,|\s)gzip(?:\s*;|\s|,|$)/i.test(accepts) && !/gzip\s*;\s*q=0(?:\.0*)?(?:\s|,|$)/i.test(accepts)) return { statusCode: 200, headers: [header('Content-Type', 'text/plain; charset=utf-8'), header('Content-Encoding', 'gzip'), header('Vary', 'Accept-Encoding')], body: gzipSync(plain) };
      return { statusCode: 200, headers: [header('Content-Type', 'text/plain; charset=utf-8'), header('Vary', 'Accept-Encoding')], body: plain };
    }

    if (pathname.startsWith('/status/')) {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const code = Number(pathname.slice('/status/'.length));
      if (!Number.isInteger(code) || code < 100 || code > 599) return responseText(400, '400 invalid status code\n');
      return statusResult(code, request);
    }

    if (pathname === '/slow') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const delay = Math.min(30_000, Math.max(0, Number(queryValue(url, 'ms') ?? 1000) || 0));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return responseText(200, `Delayed for ${delay} ms\n`);
    }

    if (pathname === '/timeout') {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      const code = queryValue(url, 'code') === '504' ? 504 : 408;
      return responseText(code, `${code} ${reasonPhrase(code)}\n`, code === 504 ? [header('Retry-After', '5')] : []);
    }

    const resource = this.resources.get(pathname);
    if (resource) {
      const notAllowed = allowedMethod(request.method, 'GET, HEAD');
      if (notAllowed) return notAllowed;
      return representation(request, resource.body, resource.type, resource.modified, resource.etag, resource.maxAge);
    }
    if (pathname.startsWith('/static/')) return notFound();
    return notFound();
  }

  private async itemsRoute(request: ParsedRequest, pathname: string): Promise<OriginResult> {
    const id = pathname === '/items' ? undefined : pathname.slice('/items/'.length);
    if (!id) {
      if (request.method === 'GET' || request.method === 'HEAD') return representation(request, jsonBody([...this.items.values()]), 'application/json; charset=utf-8', this.pageModified, '"items-list-v1"', 5);
      if (request.method !== 'POST') return methodNotAllowed('GET, HEAD, POST');
      const value = parseJson(request.body);
      if (!value || typeof value.title !== 'string' || typeof value.body !== 'string') return responseText(400, '400 items require JSON {"title": string, "body": string}\n', [header('Content-Type', 'application/json')]);
      const itemId = typeof value.id === 'string' && value.id ? value.id : String(this.itemSequence++);
      if (this.items.has(itemId) || this.deletedItems.has(itemId)) return responseText(409, '409 Conflict: duplicate item id\n');
      const item: Item = { id: itemId, title: value.title, body: value.body, updatedAt: new Date().toISOString() };
      this.items.set(itemId, item);
      return { statusCode: 201, headers: [header('Location', `/items/${itemId}`), header('Content-Type', 'application/json; charset=utf-8')], body: jsonBody(item) };
    }
    if (this.deletedItems.has(id)) return responseText(410, '410 Gone: item was deleted\n');
    if (request.method === 'GET' || request.method === 'HEAD') {
      const item = this.items.get(id);
      return item ? representation(request, jsonBody(item), 'application/json; charset=utf-8', this.pageModified, entityTag(jsonBody(item)), 5) : notFound();
    }
    if (request.method === 'DELETE') {
      if (!this.items.has(id)) return notFound();
      this.items.delete(id);
      this.deletedItems.add(id);
      return { statusCode: 204, headers: [header('Content-Type', 'application/json')], body: Buffer.alloc(0) };
    }
    if (request.method === 'PUT' || request.method === 'PATCH') {
      const parsed = parseJson(request.body);
      if (!parsed) return responseText(400, '400 invalid JSON\n', [header('Content-Type', 'application/json')]);
      const existing = this.items.get(id);
      if (request.method === 'PUT' && (!parsed.title || !parsed.body) && !existing) return responseText(400, '400 PUT requires title and body\n');
      const item: Item = {
        id,
        title: typeof parsed.title === 'string' ? parsed.title : existing?.title ?? '',
        body: typeof parsed.body === 'string' ? parsed.body : existing?.body ?? '',
        updatedAt: new Date().toISOString(),
      };
      this.items.set(id, item);
      return { statusCode: existing ? 200 : 201, headers: [header('Location', `/items/${id}`), header('Content-Type', 'application/json; charset=utf-8')], body: jsonBody(item) };
    }
    return methodNotAllowed('GET, HEAD, POST, PUT, PATCH, DELETE');
  }

  private negotiateRoute(request: ParsedRequest): OriginResult {
    const notAllowed = allowedMethod(request.method, 'GET, HEAD');
    if (notAllowed) return notAllowed;
    const accept = (getHeader(request.headers, 'Accept') ?? '*/*').toLowerCase();
    const language = (getHeader(request.headers, 'Accept-Language') ?? 'en').toLowerCase();
    const charset = (getHeader(request.headers, 'Accept-Charset') ?? 'utf-8').toLowerCase();
    if (!/(\*|text\/html|text\/\*|application\/json|text\/plain)/.test(accept) || !/(\*|fr|en)/.test(language) || !/(\*|utf-8|iso-8859-1)/.test(charset)) return responseText(406, '406 Not Acceptable\n');
    const chosenLanguage = language.includes('fr') ? 'fr' : 'en';
    if (accept.includes('application/json')) return { statusCode: 200, headers: [header('Content-Type', 'application/json; charset=utf-8'), header('Content-Language', chosenLanguage), header('Vary', 'Accept, Accept-Language, Accept-Charset')], body: jsonBody({ message: chosenLanguage === 'fr' ? 'Négociation réussie' : 'Content negotiation succeeded', format: 'json' }) };
    if (accept.includes('text/plain') && !accept.includes('text/html')) return { statusCode: 200, headers: [header('Content-Type', 'text/plain; charset=utf-8'), header('Content-Language', chosenLanguage), header('Vary', 'Accept, Accept-Language, Accept-Charset')], body: bytes(chosenLanguage === 'fr' ? 'Négociation réussie (texte)\n' : 'Content negotiation succeeded (text)\n') };
    return { statusCode: 200, headers: [header('Content-Type', 'text/html; charset=utf-8'), header('Content-Language', chosenLanguage), header('Vary', 'Accept, Accept-Language, Accept-Charset')], body: bytes(chosenLanguage === 'fr' ? '<p>Négociation réussie (HTML)</p>\n' : '<p>Content negotiation succeeded (HTML)</p>\n') };
  }
}

export function createOriginServer(options: OriginOptions = {}): Server {
  return new OriginApplication(options).createServer();
}

