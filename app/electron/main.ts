import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { HttpClient, resolveRecords, type Exchange, type RequestOptions, type TunnelSession } from '@http-lab/client-core';
import { startLabServices, type LabServices } from '@http-lab/server';

type RendererBuffer = { base64: string; length: number };

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

function serializableExchange(exchange: Exchange): unknown {
  const encodeResponse = (response: any) => response ? ({
    ...response,
    raw: buffer(response.raw),
    rawHeaders: buffer(response.rawHeaders),
    body: buffer(response.body),
    compressedBody: buffer(response.compressedBody),
    decodedBody: buffer(response.decodedBody),
    chunks: response.chunks.map((chunk: any) => ({ ...chunk, data: buffer(chunk.data) })),
  }) : undefined;
  return {
    ...exchange,
    request: { ...exchange.request, bytes: buffer(exchange.request.bytes), body: buffer(exchange.request.body) },
    response: encodeResponse(exchange.response),
    cacheResponse: encodeResponse(exchange.cacheResponse),
    attempts: exchange.attempts.map((attempt) => ({ ...attempt, request: { ...attempt.request, bytes: buffer(attempt.request.bytes), body: buffer(attempt.request.body) }, response: encodeResponse(attempt.response) })),
  };
}

let windowRef: BrowserWindow | undefined;
let services: LabServices | undefined;
let client: HttpClient;
const tunnels = new Map<string, TunnelSession>();
const eventHistory: unknown[] = [];

function broadcast(channel: string, payload: unknown): void {
  eventHistory.push({ channel, payload });
  if (eventHistory.length > 500) eventHistory.shift();
  windowRef?.webContents.send(channel, payload);
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
  ipcMain.handle('lab:request', async (_event, options: RequestOptions) => serializableExchange(await client.request(options)));
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
  ipcMain.handle('lab:pipeline', async (_event, options: RequestOptions[]) => (await client.pipeline(options)).map(serializableExchange));
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
