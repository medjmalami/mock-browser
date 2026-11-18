import type { Header, HttpVersion, SerializedRequest } from './types.js';

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class ProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PROTOCOL_ERROR') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function normalizeHeaders(input?: Header[] | Record<string, string>): Header[] {
  if (!input) return [];
  const headers = Array.isArray(input)
    ? input.map((header) => ({ name: header.name, value: String(header.value) }))
    : Object.entries(input).map(([name, value]) => ({ name, value: String(value) }));
  for (const header of headers) validateHeader(header);
  return headers;
}

function validateHeader(header: Header): void {
  if (!TOKEN.test(header.name)) throw new ProtocolError(`invalid header name: ${header.name}`, 'INVALID_HEADER_NAME');
  if (/[\r\n]/.test(header.value)) throw new ProtocolError(`header value contains CR/LF: ${header.name}`, 'INVALID_HEADER_VALUE');
}

export function getHeader(headers: Header[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

export function hasHeader(headers: Header[], name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

export function setHeader(headers: Header[], name: string, value: string): Header[] {
  validateHeader({ name, value });
  const existing = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.value = value;
    return headers;
  }
  headers.push({ name, value });
  return headers;
}

export function removeHeader(headers: Header[], name: string): Header[] {
  const lower = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() !== lower);
}

export function headersToText(headers: Header[]): string {
  return headers.map((header) => {
    validateHeader(header);
    return `${header.name}: ${header.value}\r\n`;
  }).join('');
}

export function visibleCrLf(value: string | Buffer): string {
  const text = typeof value === 'string' ? value : value.toString('latin1');
  return text.replace(/\r/g, '␍').replace(/\n/g, '␊\n');
}

export function serializeRequest(
  method: string,
  target: string,
  version: HttpVersion | string,
  inputHeaders: Header[] | Record<string, string> | undefined,
  inputBody?: string | Buffer,
): SerializedRequest {
  if (!TOKEN.test(method)) throw new ProtocolError(`invalid request method: ${method}`, 'INVALID_METHOD');
  if (!target || /[\r\n \t]/.test(target)) throw new ProtocolError('invalid request target', 'INVALID_TARGET');
  const headers = normalizeHeaders(inputHeaders);
  const body = inputBody === undefined ? Buffer.alloc(0) : typeof inputBody === 'string' ? Buffer.from(inputBody) : inputBody;
  if (!hasHeader(headers, 'Content-Length') && !hasHeader(headers, 'Transfer-Encoding')) {
    setHeader(headers, 'Content-Length', String(body.length));
  }
  const requestLine = `${method} ${target} ${version}`;
  const rawHead = `${requestLine}\r\n${headersToText(headers)}\r\n`;
  return {
    bytes: Buffer.concat([Buffer.from(rawHead, 'latin1'), body]),
    raw: Buffer.concat([Buffer.from(rawHead, 'latin1'), body]).toString('latin1'),
    requestLine,
    headers,
    body,
  };
}

export function serializeResponse(
  version: HttpVersion | string,
  statusCode: number,
  reason: string,
  inputHeaders: Header[] | Record<string, string>,
  inputBody?: string | Buffer,
): Buffer {
  const headers = normalizeHeaders(inputHeaders);
  const body = inputBody === undefined ? Buffer.alloc(0) : typeof inputBody === 'string' ? Buffer.from(inputBody) : inputBody;
  if (!hasHeader(headers, 'Content-Length') && !hasHeader(headers, 'Transfer-Encoding')) {
    setHeader(headers, 'Content-Length', String(body.length));
  }
  return Buffer.concat([Buffer.from(`${version} ${statusCode} ${reason}\r\n${headersToText(headers)}\r\n`, 'latin1'), body]);
}

export function serializeChunkedResponse(
  version: HttpVersion | string,
  statusCode: number,
  reason: string,
  inputHeaders: Header[] | Record<string, string>,
  chunks: Array<{ data: string | Buffer; extension?: string }>,
  trailers: Header[] = [],
): Buffer {
  const headers = normalizeHeaders(inputHeaders);
  removeHeader(headers, 'Content-Length');
  setHeader(headers, 'Transfer-Encoding', 'chunked');
  const payload: Buffer[] = [Buffer.from(`${version} ${statusCode} ${reason}\r\n${headersToText(headers)}\r\n`, 'latin1')];
  for (const chunk of chunks) {
    const data = typeof chunk.data === 'string' ? Buffer.from(chunk.data) : chunk.data;
    const extension = chunk.extension ? `; ${chunk.extension}` : '';
    payload.push(Buffer.from(`${data.length.toString(16)}${extension}\r\n`, 'latin1'), data, Buffer.from('\r\n', 'latin1'));
  }
  payload.push(Buffer.from(`0\r\n${headersToText(trailers)}\r\n`, 'latin1'));
  return Buffer.concat(payload);
}
