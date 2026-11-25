import { BrowserWindow, WebContentsView, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { serveLiveRequest, renderLiveResponse } from './live-transport';
import { CookieJar, HttpClient, type Exchange, type HttpVersion, type ParsedResponse } from '@http-lab/client-core';

export type PreviewBounds = { x: number; y: number; width: number; height: number };

export class LivePage {
  private view?: WebContentsView;
  private parent?: BrowserWindow;
  private token?: string;
  constructor(private client: HttpClient, private capture: (exchange: Exchange) => void, private reportError: (message: string) => void) {}

  async open(url: string, version: HttpVersion, parent: BrowserWindow, bounds: PreviewBounds, token: string, seed?: ParsedResponse): Promise<void> {
    const target = new URL(url);
    target.hash = '';
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Enter an HTTP or HTTPS URL without embedded credentials');
    if (version !== 'HTTP/1.0' && version !== 'HTTP/1.1') throw new Error('Unsupported HTTP version');
    this.close();
    this.token = token;
    this.parent = parent;
    let initialResponse = seed;
    const isolated = session.fromPartition(`live-page-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(https?:|data:|blob:)/.test(details.url) });
    });
    const handler = async (request: Request) => {
      try {
        const headers = new Headers(request.headers);
        if (/^https?:/.test(request.referrer)) headers.set('Referer', request.referrer);
        // Never treat an opaque/no-referrer initiator as same-origin.
        const initiator = (request as Request & { initiatorOrigin?: string | null }).initiatorOrigin;
        const origin = initiator ?? (request.referrer && /^https?:/.test(request.referrer) ? new URL(request.referrer).origin : undefined);
        const sameOrigin = origin === new URL(request.url).origin;
        const credentialsAllowed = request.credentials !== 'omit' && (request.credentials === 'include' || sameOrigin || request.mode === 'navigate');
        if (credentialsAllowed) {
          const cookies = await isolated.cookies.get({ url: request.url });
          const allowed = cookies.filter(cookie => sameOrigin || cookie.sameSite === 'no_restriction' || (cookie.sameSite !== 'strict' && request.mode === 'navigate' && request.method === 'GET'));
          if (allowed.length && !headers.has('cookie')) headers.set('Cookie', allowed.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
        }
        const initial = request.url === target.toString() ? initialResponse : undefined;
        if (initial) initialResponse = undefined;
        const rendered = initial ? renderLiveResponse(initial, 'GET', true) : await serveLiveRequest(new Request(request, { headers }), this.client, version, this.capture);
        if (credentialsAllowed) {
          for (const value of rendered.headers.getSetCookie()) {
            const parsed = new CookieJar().setFromHeader(value, request.url);
            if (!parsed) continue;
            const sameSiteValue = /;\s*samesite=(strict|lax|none)/i.exec(value)?.[1].toLowerCase();
            try {
              await isolated.cookies.set({ url: request.url, name: parsed.name, value: parsed.value,
                domain: parsed.hostOnly ? undefined : parsed.domain, path: parsed.path,
                secure: parsed.secure, httpOnly: parsed.httpOnly,
                expirationDate: parsed.expiresAt === undefined ? undefined : parsed.expiresAt / 1000,
                sameSite: sameSiteValue === 'none' ? 'no_restriction' : sameSiteValue === 'strict' ? 'strict' : 'lax' });
            } catch { /* Chromium rejects invalid domain, secure, or prefix attributes. */ }
          }
        }
        return rendered;
      }
      catch (error) {
        const message = `${request.url}: ${error instanceof Error ? error.message : String(error)}`;
        this.reportError(message);
        return new Response('HTTP Lab could not load this resource. See the lab error panel.', { status: 502, headers: { 'Content-Type': 'text/plain' } });
      }
    };
    isolated.protocol.handle('http', handler);
    isolated.protocol.handle('https', handler);
    const page = new WebContentsView({
      webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false },
    });
    this.view = page;
    parent.contentView.addChildView(page);
    this.setBounds(token, bounds);
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.webContents.on('will-navigate', (event, destination) => {
      if (!/^https?:/.test(destination)) event.preventDefault();
    });
    page.webContents.on('will-attach-webview', event => event.preventDefault());
    page.webContents.on('destroyed', () => {
      isolated.protocol.unhandle('http');
      isolated.protocol.unhandle('https');
      void isolated.clearStorageData();
    });
    try { await page.webContents.loadURL(target.toString()); }
    catch (error) { if (this.view === page) throw error; }
  }

  setBounds(token: string, bounds: PreviewBounds): void {
    if (token !== this.token || !this.view || !this.parent || this.parent.isDestroyed()) return;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return;
    const zoom = this.parent.webContents.getZoomFactor();
    bounds = { x: bounds.x * zoom, y: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom };
    const [width, height] = this.parent.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
    this.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) });
    this.view.setVisible(bounds.width > 0 && bounds.height > 0);
  }

  close(token?: string): void {
    if (token && token !== this.token) return;
    if (this.view) {
      if (this.parent && !this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    }
    this.view = undefined;
    this.parent = undefined;
    this.token = undefined;
  }
}
