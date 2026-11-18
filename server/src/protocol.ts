import { randomUUID } from 'node:crypto';
import type { ChunkRecord, Header, ParsedRequest, ParsedWireResponse, ResponseSpec } from './types.js';

const CRLF = Buffer.from('\r\n', 'latin1');
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class ProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PROTOCOL_ERROR') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function header(name: string, value: string): Header {
  return { name, value };
}

export function cloneHeaders(headers: Header[] = []): Header[] {
  return headers.map((item) => ({ ...item }));
}

export function getHeader(headers: Header[], name: string): string | undefined {
  return headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

export function getHeaders(headers: Header[], name: string): string[] {
  return headers.filter((item) => item.name.toLowerCase() === name.toLowerCase()).map((item) => item.value);
}

export function hasHeader(headers: Header[], name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

export function setHeader(headers: Header[], name: string, value: string): Header[] {
  const existing = headers.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = value;
  else headers.push({ name, value });
  return headers;
}

export function removeHeader(headers: Header[], name: string): Header[] {
  const lower = name.toLowerCase();
  return headers.filter((item) => item.name.toLowerCase() !== lower);
}

export function removeHeaders(headers: Header[], names: string[]): Header[] {
  const lower = new Set(names.map((name) => name.toLowerCase()));
  return headers.filter((item) => !lower.has(item.name.toLowerCase()));
}

export function isChunked(headers: Header[]): boolean {
  return (getHeader(headers, 'Transfer-Encoding') ?? '')
    .split(',')
    .some((value) => value.trim().toLowerCase() === 'chunked');
}

export function parseContentLength(headers: Header[]): number | undefined {
  const values = getHeaders(headers, 'Content-Length').map((value) => value.trim());
  if (!values.length) return undefined;
  if (values.some((value) => !/^\d+$/.test(value))) throw new ProtocolError('invalid Content-Length', 'MALFORMED_LENGTH');
  const lengths = values.map(Number);
  if (!lengths.every((value) => value === lengths[0])) throw new ProtocolError('conflicting Content-Length headers', 'MALFORMED_LENGTH');
  return lengths[0];
}

function parseHeaders(lines: string[]): Header[] {
  const result: Header[] = [];
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new ProtocolError(`malformed header: ${line}`, 'MALFORMED_HEADER');
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw new ProtocolError(`invalid header name: ${name}`, 'MALFORMED_HEADER');
    if (/^[ \t]/.test(line)) throw new ProtocolError('obsolete folded headers are not supported', 'MALFORMED_HEADER');
    result.push({ name, value: line.slice(colon + 1).trim() });
  }
  return result;
}

function parseChunked(buffer: Buffer, start: number): { body: Buffer; chunks: ChunkRecord[]; trailers: Header[]; consumed: number } | null {
  let offset = start;
  const chunks: ChunkRecord[] = [];
  const pieces: Buffer[] = [];
  while (true) {
    const lineEnd = buffer.indexOf(CRLF, offset);
    if (lineEnd < 0) return null;
    const line = buffer.subarray(offset, lineEnd).toString('latin1');
    const semicolon = line.indexOf(';');
    const sizeHex = (semicolon < 0 ? line : line.slice(0, semicolon)).trim();
    const extension = semicolon < 0 ? undefined : line.slice(semicolon + 1).trim();
    if (!/^[0-9A-Fa-f]+$/.test(sizeHex)) throw new ProtocolError(`invalid chunk size: ${sizeHex}`, 'MALFORMED_CHUNK');
    const sizeDecimal = Number.parseInt(sizeHex, 16);
    if (!Number.isSafeInteger(sizeDecimal)) throw new ProtocolError('chunk is too large', 'MALFORMED_CHUNK');
    const dataStart = lineEnd + CRLF.length;
    const dataEnd = dataStart + sizeDecimal;
    if (sizeDecimal === 0) {
      const trailersEnd = buffer.indexOf(HEADER_END, dataStart);
      if (trailersEnd >= 0) {
        const trailerText = buffer.subarray(dataStart, trailersEnd).toString('latin1');
        chunks.push({ sizeHex, sizeDecimal, data: Buffer.alloc(0), extension });
        return { body: Buffer.concat(pieces), chunks, trailers: trailerText ? parseHeaders(trailerText.split('\r\n')) : [], consumed: trailersEnd + HEADER_END.length };
      }
      if (buffer.length < dataStart + CRLF.length) return null;
      if (!buffer.subarray(dataStart, dataStart + CRLF.length).equals(CRLF)) throw new ProtocolError('final chunk is missing the trailer terminator', 'MALFORMED_CHUNK');
      chunks.push({ sizeHex, sizeDecimal, data: Buffer.alloc(0), extension });
      return { body: Buffer.concat(pieces), chunks, trailers: [], consumed: dataStart + CRLF.length };
    }
    if (buffer.length < dataEnd + CRLF.length) return null;
    if (!buffer.subarray(dataEnd, dataEnd + CRLF.length).equals(CRLF)) throw new ProtocolError('chunk data is missing CRLF', 'MALFORMED_CHUNK');
    const data = Buffer.from(buffer.subarray(dataStart, dataEnd));
    chunks.push({ sizeHex, sizeDecimal, data, extension });
    if (sizeDecimal > 0) pieces.push(data);
    offset = dataEnd + CRLF.length;
  }
}

export function parseHttpRequest(buffer: Buffer, maxBodyBytes = 10 * 1024 * 1024): ParsedRequest | null {
  const headerEnd = buffer.indexOf(HEADER_END);
  if (headerEnd < 0) return null;
  const headerBytes = headerEnd + HEADER_END.length;
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const start = lines.shift() ?? '';
  const parts = start.split(' ');
  if (parts.length !== 3 || !parts.every(Boolean)) throw new ProtocolError('malformed request line', 'MALFORMED_REQUEST');
  const [method, target, version] = parts;
  if (!/^[A-Z][A-Z0-9-]*$/.test(method)) throw new ProtocolError('invalid method token', 'MALFORMED_REQUEST');
  if (!/^HTTP\/\d+\.\d+$/.test(version)) throw new ProtocolError('malformed HTTP version', 'MALFORMED_REQUEST');
  const headers = parseHeaders(lines);
  const chunked = isChunked(headers);
  const length = parseContentLength(headers);
  if (chunked && length !== undefined) throw new ProtocolError('both chunked and Content-Length are present', 'MALFORMED_LENGTH');
  if (length !== undefined && length > maxBodyBytes) throw new ProtocolError('request body too large', 'BODY_TOO_LARGE');
  let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let consumed = headerBytes;
  let chunks: ChunkRecord[] = [];
  let trailers: Header[] = [];
  if (chunked) {
    const parsed = parseChunked(buffer, headerBytes);
    if (!parsed) return null;
    ({ body, chunks, trailers, consumed } = parsed);
  } else if (length !== undefined) {
    if (buffer.length < headerBytes + length) return null;
    body = Buffer.from(buffer.subarray(headerBytes, headerBytes + length));
    consumed += length;
  }
  return { method, target, version, headers, body, raw: Buffer.from(buffer.subarray(0, consumed)), consumed, chunks, trailers };
}

function statusLine(buffer: Buffer): { version: string; statusCode: number; reason: string; headerBytes: number } {
  const lineEnd = buffer.indexOf(CRLF);
  if (lineEnd < 0) throw new ProtocolError('incomplete response status line', 'INCOMPLETE');
  const line = buffer.subarray(0, lineEnd).toString('latin1');
  const match = line.match(/^(HTTP\/\d+\.\d+) (\d{3})(?: (.*))?$/);
  if (!match) throw new ProtocolError('malformed response status line', 'MALFORMED_STATUS');
  return { version: match[1], statusCode: Number(match[2]), reason: match[3] ?? '', headerBytes: lineEnd + CRLF.length };
}

export function parseCompleteResponse(buffer: Buffer, requestMethod?: string, connectionEnded = true): ParsedWireResponse {
  const interim: Array<{ version: string; statusCode: number; reason: string; headers: Header[] }> = [];
  let offset = 0;
  while (true) {
    const headerEnd = buffer.indexOf(HEADER_END, offset);
    if (headerEnd < 0) throw new ProtocolError('incomplete response headers', 'INCOMPLETE');
    const { version, statusCode, reason, headerBytes: statusBytes } = statusLine(buffer.subarray(offset));
    const absoluteStatusBytes = offset + statusBytes;
    const lines = buffer.subarray(absoluteStatusBytes, headerEnd).toString('latin1').split('\r\n');
    const headers = parseHeaders(lines);
    const start = headerEnd + HEADER_END.length;
    if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
      interim.push({ version, statusCode, reason, headers });
      offset = start;
      continue;
    }
    const noBody = requestMethod?.toUpperCase() === 'HEAD' || statusCode === 204 || statusCode === 205 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);
    const chunked = isChunked(headers);
    const length = parseContentLength(headers);
    let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let chunks: ChunkRecord[] = [];
    let trailers: Header[] = [];
    let consumed = start;
    if (!noBody && chunked) {
      const parsed = parseChunked(buffer, start);
      if (!parsed) throw new ProtocolError('incomplete chunked response', 'INCOMPLETE');
      ({ body, chunks, trailers, consumed } = parsed);
    } else if (!noBody && length !== undefined) {
      if (buffer.length < start + length) throw new ProtocolError('incomplete Content-Length response', 'INCOMPLETE');
      body = Buffer.from(buffer.subarray(start, start + length));
      consumed = start + length;
    } else if (!noBody) {
      if (!connectionEnded) throw new ProtocolError('response has no message framing', 'INCOMPLETE');
      body = Buffer.from(buffer.subarray(start));
      consumed = buffer.length;
    }
    const connection = (getHeader(headers, 'Connection') ?? '').toLowerCase();
    const connectionClose = connection.includes('close') || (version === 'HTTP/1.0' && !connection.includes('keep-alive'));
    return { version, statusCode, reason, headers, body, raw: Buffer.from(buffer.subarray(0, consumed)), chunks, trailers, usedChunked: chunked, connectionClose, interim: interim.length ? interim : undefined };
  }
}

export function serializeHeaders(headers: Header[]): Buffer {
  return Buffer.from(headers.map((item) => `${item.name}: ${item.value}\r\n`).join(''), 'latin1');
}

export function serializeResponse(version: string, spec: ResponseSpec, defaultContentType = 'text/plain; charset=utf-8'): Buffer {
  const body = spec.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body);
  const headers = cloneHeaders(spec.headers);
  if (!hasHeader(headers, 'Content-Type')) headers.push(header('Content-Type', defaultContentType));
  const statusHasNoBody = (spec.statusCode >= 100 && spec.statusCode < 200) || spec.statusCode === 204 || spec.statusCode === 205 || spec.statusCode === 304;
  const statusHasNoContentLength = (spec.statusCode >= 100 && spec.statusCode < 200) || spec.statusCode === 204 || spec.statusCode === 304;
  if (!hasHeader(headers, 'Content-Length') && !hasHeader(headers, 'Transfer-Encoding') && !statusHasNoContentLength) headers.push(header('Content-Length', String(statusHasNoBody ? 0 : body.length)));
  const reason = spec.reason ?? reasonPhrase(spec.statusCode);
  return Buffer.concat([Buffer.from(`${version} ${spec.statusCode} ${reason}\r\n`, 'latin1'), serializeHeaders(headers), Buffer.from('\r\n', 'latin1'), statusHasNoBody ? Buffer.alloc(0) : body]);
}

export function serializeChunkedResponse(version: string, spec: ResponseSpec, defaultContentType = 'text/plain; charset=utf-8'): Buffer {
  const headers = cloneHeaders(spec.headers);
  removeHeader(headers, 'Content-Length');
  setHeader(headers, 'Transfer-Encoding', 'chunked');
  if (!hasHeader(headers, 'Content-Type')) headers.push(header('Content-Type', defaultContentType));
  const chunks = spec.chunks ?? [];
  const bytes: Buffer[] = [Buffer.from(`${version} ${spec.statusCode} ${spec.reason ?? reasonPhrase(spec.statusCode)}\r\n`, 'latin1'), serializeHeaders(headers), Buffer.from('\r\n', 'latin1')];
  for (const chunk of chunks) {
    const data = Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data);
    bytes.push(Buffer.from(`${data.length.toString(16)}${chunk.extension ? `; ${chunk.extension}` : ''}\r\n`, 'latin1'), data, CRLF);
  }
  bytes.push(Buffer.from(`0\r\n`, 'latin1'), serializeHeaders(spec.trailers ?? []), CRLF);
  return Buffer.concat(bytes);
}

export function reasonPhrase(statusCode: number): string {
  const reasons: Record<number, string> = {
    100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
    200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
    300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy',
    400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a teapot", 429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
  };
  return reasons[statusCode] ?? 'Status';
}

export function requestKeepAlive(version: string, headers: Header[]): boolean {
  const connection = (getHeader(headers, 'Connection') ?? '').toLowerCase();
  return version === 'HTTP/1.1' ? !connection.split(',').map((value) => value.trim()).includes('close') : connection.includes('keep-alive');
}

export function visibleCrLf(value: Buffer | string): string {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value);
  return bytes.toString('latin1').replace(/\r/g, '␍').replace(/\n/g, '␊\n');
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

