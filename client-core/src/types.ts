import type { Socket } from 'node:net';

export type HttpVersion = 'HTTP/1.0' | 'HTTP/1.1';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'CONNECT' | 'TRACE';
export type Header = { name: string; value: string };

export type ChunkRecord = {
  sizeHex: string;
  sizeDecimal: number;
  data: Buffer;
  extension?: string;
};

export type ProtocolEventType =
  | 'dns-lookup'
  | 'tcp-connect'
  | 'request-sent'
  | 'first-byte'
  | 'headers-received'
  | 'body-complete'
  | 'connection-reused'
  | 'connection-kept-alive'
  | 'connection-closed'
  | 'redirect-followed'
  | 'cache-hit'
  | 'cache-store'
  | 'cache-conditional'
  | 'cache-304'
  | 'cookie-stored'
  | 'cookie-sent'
  | 'auth-challenge'
  | 'auth-retry'
  | 'proxy-auth-challenge'
  | 'proxy-auth-retry'
  | 'tunnel-open'
  | 'tunnel-data'
  | 'error';

export type TimelineEvent = {
  id: string;
  type: ProtocolEventType;
  at: string;
  elapsedMs: number;
  connectionId?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SerializedRequest = {
  bytes: Buffer;
  raw: string;
  requestLine: string;
  headers: Header[];
  body: Buffer;
};

export type ParsedRequest = {
  method: string;
  target: string;
  version: string;
  headers: Header[];
  body: Buffer;
  raw: Buffer;
  consumed: number;
  chunks: ChunkRecord[];
  trailers: Header[];
};

export type ParsedResponse = {
  version: string;
  statusCode: number;
  reason: string;
  headers: Header[];
  body: Buffer;
  raw: Buffer;
  rawHeaders: Buffer;
  chunks: ChunkRecord[];
  trailers: Header[];
  complete: boolean;
  connectionClose: boolean;
  usedChunked: boolean;
  compressedBody: Buffer;
  decodedBody: Buffer;
};

export type RequestOptions = {
  url: string;
  method?: HttpMethod | string;
  version?: HttpVersion;
  headers?: Header[] | Record<string, string>;
  body?: string | Buffer;
  cache?: boolean;
  cookies?: boolean;
  autoRedirect?: boolean;
  maxRedirects?: number;
  proxy?: ProxyOptions;
  auth?: AuthCredentials;
  signal?: AbortSignal;
};

export type AuthCredentials = { username: string; password: string };

export type ProxyOptions = {
  host: string;
  port: number;
  credentials?: AuthCredentials;
  enabled?: boolean;
};

export type ExchangeAttempt = {
  request: SerializedRequest;
  response?: ParsedResponse;
  error?: string;
  connectionId?: string;
};

export type Exchange = {
  id: string;
  request: SerializedRequest;
  response?: ParsedResponse;
  attempts: ExchangeAttempt[];
  timeline: TimelineEvent[];
  redirectChain: string[];
  fromCache: boolean;
  cacheRevalidated: boolean;
  connectionId?: string;
  connectionReuseCount?: number;
  error?: string;
};

export type TunnelSession = {
  id: string;
  connectionId: string;
  response: ParsedResponse;
  send(data: string | Buffer): void;
  onData(listener: (data: Buffer) => void): () => void;
  close(): void;
};

export type ConnectionInfo = {
  id: string;
  host: string;
  port: number;
  version: HttpVersion;
  reuseCount: number;
  requestCount: number;
  open: boolean;
  socket?: Socket;
};

export type CacheEntry = {
  key: string;
  url: string;
  statusCode: number;
  reason: string;
  headers: Header[];
  body: Buffer;
  storedAt: number;
  expiresAt?: number;
  lastModified?: string;
  etag?: string;
};

export type CacheLookup = { state: 'miss' | 'fresh' | 'stale'; entry?: CacheEntry; remainingMs?: number };

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt?: number;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
};

export type DnsRecord = {
  name: string;
  class: 'IN';
  ttl: number | null;
  type: string;
  data: string;
};

export type BodyView = {
  decoded: Buffer;
  compressed: Buffer;
  isGzip: boolean;
};
