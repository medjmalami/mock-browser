import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { HttpClient, resolveRecords, type Exchange, type RequestOptions, type SerializedRequest, type TunnelSession } from '@http-lab/client-core';
import { startLabServices, type LabServices } from '@http-lab/server';

type RendererBuffer = { base64: string; length: number; truncated?: boolean };

const MAX_RENDERER_WIRE_BYTES = 512 * 1024;
const MAX_RENDERER_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_PREVIEW_CHARS = 4_096;
const MAX_STORED_LARGE_EXCHANGES = 10;
const RAW_DETAIL_FIELDS = ['raw', 'rawRequest', 'rawResponse'] as const;

function buffer(value: unknown): RendererBuffer {
  const bytes = Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? Buffer.from(value)
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : Buffer.alloc(0);
  return { base64: bytes.toString('base64'), length: bytes.length };
}

function omittedBuffer(length: number): RendererBuffer {
  return { base64: '', length, truncated: true };
}

function requestPreview(request: SerializedRequest): string {
  const separator = request.raw.indexOf('\r\n\r\n');
  const headers = separator >= 0 ? request.raw.slice(0, separator + 4) : request.raw.slice(0, MAX_EVENT_PREVIEW_CHARS);
  return `${headers}[${request.body.length} body bytes omitted from the renderer; load the full wire on demand]`;
}

function serializableRequest(request: SerializedRequest, includeFullWire = false): unknown {
  const omitWire = !includeFullWire && request.bytes.length > MAX_RENDERER_WIRE_BYTES;
  return {
    ...request,
    raw: omitWire ? requestPreview(request) : request.raw,
    bytes: omitWire ? omittedBuffer(request.bytes.length) : buffer(request.bytes),
    body: omitWire ? omittedBuffer(request.body.length) : buffer(request.body),
    largeBody: omitWire,
  };
}

function serializableExchange(exchange: Exchange, includeFullWire = false): unknown {
  const encodeResponse = (response: any) => response ? (() => {
    const bodyLength = response.body.length;
    const decodedLength = response.decodedBody.length;
    const omitWire = !includeFullWire && Math.max(response.raw.length, bodyLength, response.compressedBody.length) > MAX_RENDERER_WIRE_BYTES;
    const omitDecoded = !includeFullWire && decodedLength > MAX_RENDERER_BINARY_BYTES;
    return {
      ...response,
      raw: omitWire ? omittedBuffer(response.raw.length) : buffer(response.raw),
      rawHeaders: buffer(response.rawHeaders),
      body: omitWire ? omittedBuffer(bodyLength) : buffer(response.body),
      compressedBody: omitWire ? omittedBuffer(response.compressedBody.length) : buffer(response.compressedBody),
      decodedBody: omitDecoded ? omittedBuffer(decodedLength) : buffer(response.decodedBody),
      chunks: response.chunks.map((chunk: any) => ({ ...chunk, data: !includeFullWire && chunk.data.length > MAX_RENDERER_WIRE_BYTES ? omittedBuffer(chunk.data.length) : buffer(chunk.data) })),
      largeBody: omitWire || omitDecoded,
    };
  })() : undefined;
  return {
    ...exchange,
    request: serializableRequest(exchange.request, includeFullWire),
    response: encodeResponse(exchange.response),
    cacheResponse: encodeResponse(exchange.cacheResponse),
    attempts: exchange.attempts.map((attempt) => ({ ...attempt, request: serializableRequest(attempt.request, includeFullWire), response: encodeResponse(attempt.response) })),
  };
}

function compactRawFields(value: Record<string, unknown>): Record<string, unknown> {
  const compact = { ...value };
  for (const field of RAW_DETAIL_FIELDS) {
    const raw = compact[field];
    if (typeof raw !== 'string' || raw.length <= MAX_EVENT_PREVIEW_CHARS) continue;
    compact[`${field}Bytes`] = Buffer.byteLength(raw, 'latin1');
    compact[field] = `${raw.slice(0, MAX_EVENT_PREVIEW_CHARS)}\n… [large wire detail truncated for the renderer]`;
  }
  return compact;
}

function compactPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const value = compactRawFields(payload as Record<string, unknown>);
  if (value.details && typeof value.details === 'object' && !Array.isArray(value.details)) value.details = compactRawFields(value.details as Record<string, unknown>);
  return value;
}

let windowRef: BrowserWindow | undefined;
let services: LabServices | undefined;
let client: HttpClient;
const tunnels = new Map<string, TunnelSession>();
const eventHistory: unknown[] = [];
const largeExchangeStore = new Map<string, Exchange>();

function rememberExchange(exchange: Exchange): void {
  const response = exchange.response;
  const responseIsLarge = response && Math.max(response.raw.length, response.body.length, response.compressedBody.length, response.decodedBody.length) > MAX_RENDERER_WIRE_BYTES;
  if (exchange.request.bytes.length <= MAX_RENDERER_WIRE_BYTES && !responseIsLarge) return;
  largeExchangeStore.set(exchange.id, exchange);
  while (largeExchangeStore.size > MAX_STORED_LARGE_EXCHANGES) {
    const oldest = largeExchangeStore.keys().next().value as string | undefined;
    if (!oldest) break;
    largeExchangeStore.delete(oldest);
  }
}

function broadcast(channel: string, payload: unknown): void {
  const safePayload = compactPayload(payload);
  eventHistory.push({ channel, payload: safePayload });
  if (eventHistory.length > 500) eventHistory.shift();
  windowRef?.webContents.send(channel, safePayload);
}

function createWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) browserWindow.loadURL(devUrl);
  else browserWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  return browserWindow;
}

async function registerIpc(): Promise<void> {
  ipcMain.handle('lab:request', async (_event, options: RequestOptions) => {
    const exchange = await client.request(options);
    rememberExchange(exchange);
    return serializableExchange(exchange);
  });
  ipcMain.handle('lab:request-wire', async (_event, id: string) => {
    const exchange = largeExchangeStore.get(id);
    if (!exchange) throw new Error('The large request wire is no longer available');
    return serializableRequest(exchange.request, true);
  });
  ipcMain.handle('lab:exchange-wire', async (_event, id: string) => {
    const exchange = largeExchangeStore.get(id);
    if (!exchange) throw new Error('The large exchange wire is no longer available');
    return serializableExchange(exchange, true);
  });
  ipcMain.handle('lab:tunnel:open', async (_event, options: RequestOptions) => {
    const tunnel = await client.openTunnel(options);
    tunnels.set(tunnel.id, tunnel);
    broadcast('lab:event', { id: `event-${Date.now()}`, type: 'tunnel-open', at: new Date().toISOString(), elapsedMs: 0, connectionId: tunnel.connectionId, message: `CONNECT established (${tunnel.response.statusCode} ${tunnel.response.reason})`, details: { tunnelId: tunnel.id } });
    tunnel.onData((data) => broadcast('lab:tunnel-data', { id: tunnel.id, base64: data.toString('base64'), length: data.length }));
    return { id: tunnel.id, connectionId: tunnel.connectionId, statusCode: tunnel.response.statusCode, reason: tunnel.response.reason };
  });
  ipcMain.handle('lab:tunnel:send', async (_event, value: { id: string; data: string }) => {
    const tunnel = tunnels.get(value.id);
    if (!tunnel) return false;
    tunnel.send(value.data);
    broadcast('lab:event', { type: 'tunnel-data', at: new Date().toISOString(), connectionId: tunnel.connectionId, message: `Sent ${Buffer.byteLength(value.data)} tunnel bytes` });
    return true;
  });
  ipcMain.handle('lab:tunnel:close', async (_event, id: string) => {
    const tunnel = tunnels.get(id);
    if (!tunnel) return false;
    tunnel.close();
    tunnels.delete(id);
    return true;
  });
  ipcMain.handle('lab:pipeline', async (_event, options: RequestOptions[]) => {
    const exchanges = await client.pipeline(options);
    exchanges.forEach(rememberExchange);
    return exchanges.map((exchange) => serializableExchange(exchange));
  });
  ipcMain.handle('lab:dns', async (_event, name: string) => resolveRecords(name));
  ipcMain.handle('lab:state', async () => ({ connections: client.listConnections(), cookies: client.cookies.list(), cache: client.cache.list(), events: eventHistory }));
  ipcMain.handle('lab:cookie:delete', async (_event, value: { name: string; domain?: string; path?: string }) => client.cookies.delete(value.name, value.domain, value.path ?? '/'));
  ipcMain.handle('lab:cookie:edit', async (_event, value: { name: string; value: string; domain?: string; path?: string }) => client.cookies.edit(value.name, value.value, value.domain, value.path ?? '/'));
  ipcMain.handle('lab:cache:clear', async () => client.cache.clear());
  ipcMain.handle('lab:stop', async () => {
    client.closeAll();
    for (const tunnel of tunnels.values()) tunnel.close();
    tunnels.clear();
    await services?.stop();
  });
}

async function boot(): Promise<void> {
  await app.whenReady();
  client = new HttpClient({ onEvent: (event) => broadcast('lab:event', event) });
  services = await startLabServices({
    origin: { port: Number(process.env.HTTP_LAB_ORIGIN_PORT ?? 8080) },
    proxy: {
      port: Number(process.env.HTTP_LAB_PROXY_PORT ?? 8888),
      auth: {
        username: process.env.HTTP_LAB_PROXY_USER ?? 'proxy',
        password: process.env.HTTP_LAB_PROXY_PASSWORD ?? 'proxy',
      },
    },
    // The standalone server keeps the course's default 9000. Electron uses
    // 9001 by default so it can coexist with common Docker/dev services.
    echo: { port: Number(process.env.HTTP_LAB_ECHO_PORT ?? 9001) },
    onEvent: (log: unknown) => broadcast('lab:server-log', log),
  });
  await registerIpc();
  windowRef = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windowRef = createWindow();
  });
}

void boot().catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    client?.closeAll();
    void services?.stop();
    app.quit();
  }
});
