import { contextBridge, ipcRenderer } from 'electron';
import type { RequestOptions } from '@http-lab/client-core';

export type LabApi = {
  request(options: RequestOptions): Promise<unknown>;
  openTunnel(options: RequestOptions): Promise<{ id: string; connectionId: string; statusCode: number; reason: string }>;
  sendTunnel(id: string, data: string): Promise<boolean>;
  closeTunnel(id: string): Promise<boolean>;
  pipeline(requests: RequestOptions[]): Promise<unknown>;
  dns(name: string): Promise<unknown>;
  state(): Promise<unknown>;
  deleteCookie(name: string, domain?: string, path?: string): Promise<unknown>;
  editCookie(name: string, value: string, domain?: string, path?: string): Promise<unknown>;
  clearCache(): Promise<unknown>;
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
  stop(): Promise<unknown>;
};

const api: LabApi = {
  request: (options) => ipcRenderer.invoke('lab:request', options),
  openTunnel: (options) => ipcRenderer.invoke('lab:tunnel:open', options),
  sendTunnel: (id, data) => ipcRenderer.invoke('lab:tunnel:send', { id, data }),
  closeTunnel: (id) => ipcRenderer.invoke('lab:tunnel:close', id),
  pipeline: (requests) => ipcRenderer.invoke('lab:pipeline', requests),
  dns: (name) => ipcRenderer.invoke('lab:dns', name),
  state: () => ipcRenderer.invoke('lab:state'),
  deleteCookie: (name, domain, path) => ipcRenderer.invoke('lab:cookie:delete', { name, domain, path }),
  editCookie: (name, value, domain, path) => ipcRenderer.invoke('lab:cookie:edit', { name, value, domain, path }),
  clearCache: () => ipcRenderer.invoke('lab:cache:clear'),
  subscribe: (event, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  stop: () => ipcRenderer.invoke('lab:stop'),
};

contextBridge.exposeInMainWorld('httpLab', api);
