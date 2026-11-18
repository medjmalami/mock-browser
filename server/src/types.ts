import type { Server as NetServer, Socket } from 'node:net';

export type Header = { name: string; value: string };

export type HttpVersion = 'HTTP/1.0' | 'HTTP/1.1';

export type ChunkRecord = {
  sizeHex: string;
  sizeDecimal: number;
  data: Buffer;
  extension?: string;
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

export type ParsedWireResponse = {
  version: string;
  statusCode: number;
  reason: string;
  headers: Header[];
  body: Buffer;
  raw: Buffer;
  chunks: ChunkRecord[];
  trailers: Header[];
  usedChunked: boolean;
  connectionClose: boolean;
};

export type ResponseSpec = {
  statusCode: number;
  reason?: string;
  headers?: Header[];
  body?: Buffer | string;
  chunks?: Array<{ data: Buffer | string; extension?: string }>;
  trailers?: Header[];
  close?: boolean;
  interim?: Array<{ statusCode: number; reason?: string; headers?: Header[] }>;
};

export type ServerEvent = {
  id: string;
  at: string;
  service: 'origin' | 'proxy' | 'echo';
  type: string;
  connectionId?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ServerEventSink = (event: ServerEvent) => void;

export type OriginOptions = {
  host?: string;
  port?: number;
  serverName?: string;
  keepAliveTimeoutMs?: number;
  maxRequestsPerConnection?: number;
  onEvent?: ServerEventSink;
};

export type ProxyOptions = {
  host?: string;
  port?: number;
  originHost?: string;
  originPort?: number;
  echoHost?: string;
  echoPort?: number;
  auth?: { username: string; password: string };
  upstreamTimeoutMs?: number;
  onEvent?: ServerEventSink;
};

export type EchoOptions = {
  host?: string;
  port?: number;
  onEvent?: ServerEventSink;
};

export type LabServiceAddresses = {
  origin: { host: string; port: number };
  proxy: { host: string; port: number };
  echo: { host: string; port: number };
};

export type LabServices = {
  addresses: LabServiceAddresses;
  originServer: NetServer;
  proxyServer: NetServer;
  echoServer: NetServer;
  stop(): Promise<void>;
};

export type ConnectionContext = {
  id: string;
  socket: Socket;
  requestCount: number;
  remoteAddress?: string;
  remotePort?: number;
};

