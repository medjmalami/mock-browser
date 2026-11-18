import type { ChunkRecord, Header, ParsedRequest, ParsedResponse } from './types.js';
import { ProtocolError, getHeader } from './serializer.js';

const CRLF = Buffer.from('\r\n', 'latin1');
const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf(HEADER_END);
}

function parseHeaderBlock(buffer: Buffer): { lines: string[]; headerBytes: number } {
  const end = findHeaderEnd(buffer);
  if (end < 0) throw new ProtocolError('incomplete headers', 'INCOMPLETE');
  const text = buffer.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  return { lines, headerBytes: end + HEADER_END.length };
}

function parseHeaders(lines: string[]): Header[] {
  const headers: Header[] = [];
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new ProtocolError(`malformed header: ${line}`, 'MALFORMED_HEADER');
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw new ProtocolError(`invalid header name: ${name}`, 'MALFORMED_HEADER');
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return headers;
}

function parseContentLength(headers: Header[]): number | undefined {
  const values = headers.filter((header) => header.name.toLowerCase() === 'content-length').map((header) => header.value.trim());
  if (values.length === 0) return undefined;
  if (values.some((value) => !/^\d+$/.test(value))) throw new ProtocolError('invalid Content-Length', 'MALFORMED_LENGTH');
  const lengths = values.map(Number);
  if (lengths.some((length) => !Number.isSafeInteger(length))) throw new ProtocolError('Content-Length is too large', 'MALFORMED_LENGTH');
  if (!lengths.every((length) => length === lengths[0])) throw new ProtocolError('conflicting Content-Length headers', 'MALFORMED_LENGTH');
  return lengths[0];
}

function isChunked(headers: Header[]): boolean {
  return headers
    .filter((header) => header.name.toLowerCase() === 'transfer-encoding')
    .flatMap((header) => header.value.toLowerCase().split(','))
    .map((value) => value.trim())
    .includes('chunked');
}

function parseChunked(
  buffer: Buffer,
  start: number,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): { body: Buffer; chunks: ChunkRecord[]; trailers: Header[]; consumed: number } | null {
  let offset = start;
  const chunks: ChunkRecord[] = [];
  const bodies: Buffer[] = [];
  let bodyLength = 0;
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
    if (sizeDecimal === 0) {
      const trailerLines: string[] = [];
      offset = dataStart;
      while (true) {
        const trailerLineEnd = buffer.indexOf(CRLF, offset);
        if (trailerLineEnd < 0) return null;
        if (trailerLineEnd === offset) {
          const trailers = parseHeaders(trailerLines);
          chunks.push({ sizeHex, sizeDecimal, data: Buffer.alloc(0), extension });
          return { body: Buffer.concat(bodies), chunks, trailers, consumed: trailerLineEnd + CRLF.length };
        }
        trailerLines.push(buffer.subarray(offset, trailerLineEnd).toString('latin1'));
        offset = trailerLineEnd + CRLF.length;
      }
    }
    const dataEnd = dataStart + sizeDecimal;
    if (buffer.length < dataEnd + CRLF.length) return null;
    if (!buffer.subarray(dataEnd, dataEnd + CRLF.length).equals(CRLF)) throw new ProtocolError('chunk is missing CRLF', 'MALFORMED_CHUNK');
    const data = buffer.subarray(dataStart, dataEnd);
    chunks.push({ sizeHex, sizeDecimal, data, extension });
    bodyLength += sizeDecimal;
    if (bodyLength > maxBodyBytes) throw new ProtocolError('response body is too large', 'BODY_TOO_LARGE');
    bodies.push(data);
    offset = dataEnd + CRLF.length;
  }
}

function parseStartLine(buffer: Buffer): { line: string; headerBytes: number } {
  const firstLineEnd = buffer.indexOf(CRLF);
  if (firstLineEnd < 0) throw new ProtocolError('incomplete start line', 'INCOMPLETE');
  return { line: buffer.subarray(0, firstLineEnd).toString('latin1'), headerBytes: firstLineEnd + CRLF.length };
}

export function parseHttpRequest(buffer: Buffer, maxBodyBytes = 10 * 1024 * 1024): ParsedRequest | null {
  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd < 0) return null;
  const { lines, headerBytes } = parseHeaderBlock(buffer);
  const parts = lines[0]?.split(' ') ?? [];
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new ProtocolError('malformed request line', 'MALFORMED_REQUEST');
  const [method, target, version] = parts;
  if (!/^HTTP\/\d\.\d$/.test(version)) throw new ProtocolError('unsupported request version', 'UNSUPPORTED_VERSION');
  const headers = parseHeaders(lines.slice(1));
  const transferChunked = isChunked(headers);
  const contentLength = parseContentLength(headers);
  if (transferChunked && contentLength !== undefined) throw new ProtocolError('both chunked and Content-Length present', 'MALFORMED_LENGTH');
  if (contentLength !== undefined && contentLength > maxBodyBytes) throw new ProtocolError('request body too large', 'BODY_TOO_LARGE');
  let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let consumed = headerBytes;
  let chunks: ChunkRecord[] = [];
  let trailers: Header[] = [];
  if (transferChunked) {
    const parsed = parseChunked(buffer, headerBytes, maxBodyBytes);
    if (!parsed) return null;
    ({ body, chunks, trailers } = parsed);
    consumed = parsed.consumed;
  } else if (contentLength !== undefined) {
    if (buffer.length < headerBytes + contentLength) return null;
    body = buffer.subarray(headerBytes, headerBytes + contentLength);
    consumed += contentLength;
  }
  return {
    method,
    target,
    version,
    headers,
    body,
    raw: buffer.subarray(0, consumed),
    consumed,
    chunks,
    trailers,
  };
}

function responseHasNoBody(statusCode: number, requestMethod?: string): boolean {
  return requestMethod?.toUpperCase() === 'HEAD' || (requestMethod?.toUpperCase() === 'CONNECT' && statusCode >= 200 && statusCode < 300) || statusCode === 204 || statusCode === 205 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);
}

export class ResponseParser {
  private buffer = Buffer.alloc(0);
  private done = false;
  private interim: ParsedResponse[] = [];
  private rawPrefix = Buffer.alloc(0);
  private requestMethod?: string;
  private readonly maxBodyBytes: number;

  constructor(requestMethod?: string, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
    this.requestMethod = requestMethod;
    this.maxBodyBytes = maxBodyBytes;
  }

  feed(chunk: Buffer): ParsedResponse | null {
    if (this.done) return null;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    return this.tryParse(false);
  }

  end(): ParsedResponse | null {
    if (this.done) return null;
    return this.tryParse(true);
  }

  get interimResponses(): ParsedResponse[] {
    return this.interim;
  }

  takeRemaining(): Buffer {
    if (!this.done) return Buffer.alloc(0);
    const remaining = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remaining;
  }

  private tryParse(connectionEnded: boolean): ParsedResponse | null {
    while (true) {
      const headerEnd = findHeaderEnd(this.buffer);
      if (headerEnd < 0) {
        if (connectionEnded) throw new ProtocolError('connection ended before response headers', 'INCOMPLETE');
        return null;
      }
      const { lines, headerBytes } = parseHeaderBlock(this.buffer);
      const statusParts = lines[0]?.match(/^(HTTP\/\d\.\d) (\d{3})(?: (.*))?$/);
      if (!statusParts) throw new ProtocolError('malformed response status line', 'MALFORMED_STATUS');
      const version = statusParts[1];
      const statusCode = Number(statusParts[2]);
      const reason = statusParts[3] ?? '';
      const headers = parseHeaders(lines.slice(1));
      if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
        this.rawPrefix = Buffer.concat([this.rawPrefix, this.buffer.subarray(0, headerBytes)]);
        const interim: ParsedResponse = {
          version, statusCode, reason, headers, body: Buffer.alloc(0), raw: this.buffer.subarray(0, headerBytes), rawHeaders: this.buffer.subarray(0, headerBytes), chunks: [], trailers: [], complete: true, connectionClose: false, usedChunked: false, compressedBody: Buffer.alloc(0), decodedBody: Buffer.alloc(0),
        };
        this.interim.push(interim);
        this.buffer = this.buffer.subarray(headerBytes);
        continue;
      }
      const noBody = responseHasNoBody(statusCode, this.requestMethod);
      const transferChunked = isChunked(headers);
      const contentLength = parseContentLength(headers);
      if (transferChunked && contentLength !== undefined) throw new ProtocolError('both chunked and Content-Length present', 'MALFORMED_LENGTH');
      if (contentLength !== undefined && contentLength > this.maxBodyBytes) throw new ProtocolError('response body is too large', 'BODY_TOO_LARGE');
      let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let consumed = headerBytes;
      let chunks: ChunkRecord[] = [];
      let trailers: Header[] = [];
      if (!noBody && transferChunked) {
        const parsed = parseChunked(this.buffer, headerBytes, this.maxBodyBytes);
        if (!parsed) {
          if (connectionEnded) throw new ProtocolError('connection ended in chunked response', 'INCOMPLETE');
          return null;
        }
        ({ body, chunks, trailers } = parsed);
        consumed = parsed.consumed;
      } else if (!noBody && contentLength !== undefined) {
        if (this.buffer.length < headerBytes + contentLength) {
          if (connectionEnded) throw new ProtocolError('connection ended before Content-Length body completed', 'INCOMPLETE');
          return null;
        }
        body = this.buffer.subarray(headerBytes, headerBytes + contentLength);
        consumed += contentLength;
      } else if (!noBody) {
        if (!connectionEnded) return null;
        body = this.buffer.subarray(headerBytes);
        consumed = this.buffer.length;
      }
      const raw = Buffer.concat([this.rawPrefix, this.buffer.subarray(0, consumed)]);
      const rawHeaders = this.buffer.subarray(0, headerBytes);
      const connection = (getHeader(headers, 'Connection') ?? '').toLowerCase();
      const connectionClose = connection.includes('close') || (version === 'HTTP/1.0' && !connection.includes('keep-alive'));
      this.buffer = this.buffer.subarray(consumed);
      this.done = true;
      return {
        version,
        statusCode,
        reason,
        headers,
        body,
        raw,
        rawHeaders,
        chunks,
        trailers,
        complete: true,
        connectionClose,
        usedChunked: transferChunked,
        compressedBody: body,
        decodedBody: body,
      };
    }
  }
}

export function parseCompleteResponse(buffer: Buffer, requestMethod?: string, connectionEnded = true): ParsedResponse {
  const parser = new ResponseParser(requestMethod);
  const parsed = parser.feed(buffer) ?? parser.end();
  if (!parsed) throw new ProtocolError('response is incomplete', 'INCOMPLETE');
  return parsed;
}

export function splitHeaderAndBody(raw: Buffer): { headers: Buffer; body: Buffer } {
  const end = findHeaderEnd(raw);
  if (end < 0) return { headers: raw, body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, end + HEADER_END.length), body: raw.subarray(end + HEADER_END.length) };
}
